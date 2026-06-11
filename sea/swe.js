/**
 * swe.js - Near-shore shallow-water layer (L2)
 *
 * A fixed world-space patch (see terrain.js) running a GPU shallow-water
 * solver on top of the analytic seabed. It produces run-up and back-wash on
 * the beach and an out-of-phase slosh in the isolated tide pool, coupled
 * one-way to the open ocean (L0) at its deep boundary.
 *
 * Solver: the virtual-pipe shallow-water model (Mei / St'ava). Two GPGPU
 * variables ping-pong each substep:
 *   textureFlux  = vec4(fE, fW, fN, fS)   outflow volume rate to 4 neighbours
 *   textureWater = vec4(depth, vx, vz, surfaceY)
 * The pipe model conserves mass, handles wetting/drying for free (dry cells
 * have zero depth and emit no flux), and is unconditionally non-negative
 * because outflow is scaled to the water actually available in a cell.
 *
 * Version: 0.1.3
 */

import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { config } from './config.js';
import { TERRAIN_GLSL, SWE_ORIGIN, SWE_SIZE, terrainHeightJS } from './terrain.js';

export class ShallowWater {
    constructor(renderer) {
        this.renderer = renderer;
        this.res = Math.max(64, Math.floor(config.sweResolution));
        this.size = SWE_SIZE;
        this.origin = SWE_ORIGIN.clone();
        this.cellSize = this.size / this.res;
        this.init();
    }

    init() {
        this.gpu = new GPUComputationRenderer(this.res, this.res, this.renderer);

        const flux0 = this.gpu.createTexture();   // zero-initialised
        const water0 = this.gpu.createTexture();
        this.fillInitialWater(water0);

        this.fluxVar = this.gpu.addVariable('textureFlux', this.getFluxShader(), flux0);
        this.waterVar = this.gpu.addVariable('textureWater', this.getWaterShader(), water0);
        this.waterVar.minFilter = THREE.LinearFilter;
        this.waterVar.magFilter = THREE.LinearFilter;

        this.gpu.setVariableDependencies(this.fluxVar, [this.fluxVar, this.waterVar]);
        this.gpu.setVariableDependencies(this.waterVar, [this.fluxVar, this.waterVar]);

        const fu = this.fluxVar.material.uniforms;
        fu['uDt'] = { value: 0.0 };
        fu['uG'] = { value: 9.8 };
        fu['uCellSize'] = { value: this.cellSize };
        fu['uDamp'] = { value: 1.0 };
        fu['uSweOrigin'] = { value: this.origin };
        fu['uSweSize'] = { value: this.size };

        const wu = this.waterVar.material.uniforms;
        wu['uDt'] = { value: 0.0 };
        wu['uCellSize'] = { value: this.cellSize };
        wu['uSweOrigin'] = { value: this.origin };
        wu['uSweSize'] = { value: this.size };
        wu['uSeaLevel'] = { value: config.seaLevel };
        wu['uCoupling'] = { value: config.sweCoupling };
        wu['uDispMap'] = { value: null };
        wu['uGridOffset'] = { value: new THREE.Vector2(0, 0) };
        wu['uGridSize'] = { value: config.gridSize };

        this.fu = fu;
        this.wu = wu;

        const error = this.gpu.init();
        if (error !== null) {
            console.error('SWE GPGPU Init Error:', error);
        }
    }

    /**
     * Seed the water column: fill the basin to sea level, and give the
     * isolated tide pool a lopsided initial surface so it starts sloshing at
     * its own natural frequency (visibly out of phase with the open sea).
     */
    fillInitialWater(texture) {
        const data = texture.image.data;
        const N = this.res;
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const u = (i + 0.5) / N;
                const v = (j + 0.5) / N;
                const x = this.origin.x + (u - 0.5) * this.size;
                const z = this.origin.y + (v - 0.5) * this.size;
                const b = terrainHeightJS(x, z);

                let surf = config.seaLevel;
                const pr = Math.hypot(x - 85.0, z + 70.0);
                if (pr < 30.0) surf += 0.8 * ((x - 85.0) / 30.0);

                const d = Math.max(0.0, surf - b);
                const idx = (j * N + i) * 4;
                data[idx] = d;
                data[idx + 1] = 0.0;
                data[idx + 2] = 0.0;
                data[idx + 3] = b + d;
            }
        }
        texture.needsUpdate = true;
    }

    getFluxShader() {
        return `
            uniform float uDt;
            uniform float uG;
            uniform float uCellSize;
            uniform float uDamp;
            uniform vec2 uSweOrigin;
            uniform float uSweSize;

            ${TERRAIN_GLSL}

            float surfaceAt(vec2 uv) {
                vec4 st = texture2D(textureWater, uv);
                vec2 wp = uSweOrigin + (uv - 0.5) * uSweSize;
                return terrainHeight(wp) + st.x;
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                float texel = 1.0 / resolution.x;

                vec4 flux = texture2D(textureFlux, uv);
                float dC = texture2D(textureWater, uv).x;

                // Clamp at the domain border so the missing neighbour reads as
                // self (zero surface gradient): a reflective wall. The deep sea
                // edge is overridden by Dirichlet forcing in the water pass.
                float hi = 1.0 - 0.5 * texel;
                float lo = 0.5 * texel;
                vec2 uvE = vec2(min(uv.x + texel, hi), uv.y);
                vec2 uvW = vec2(max(uv.x - texel, lo), uv.y);
                vec2 uvN = vec2(uv.x, min(uv.y + texel, hi));
                vec2 uvS = vec2(uv.x, max(uv.y - texel, lo));

                vec2 wp = uSweOrigin + (uv - 0.5) * uSweSize;
                float Hc = terrainHeight(wp) + dC;

                float k = uDt * uG * uCellSize;
                float fE = max(0.0, flux.x * uDamp + k * (Hc - surfaceAt(uvE)));
                float fW = max(0.0, flux.y * uDamp + k * (Hc - surfaceAt(uvW)));
                float fN = max(0.0, flux.z * uDamp + k * (Hc - surfaceAt(uvN)));
                float fS = max(0.0, flux.w * uDamp + k * (Hc - surfaceAt(uvS)));

                // Scale outflow so a cell never drains more than it holds
                float total = (fE + fW + fN + fS) * uDt;
                float avail = max(dC, 0.0) * uCellSize * uCellSize;
                float K = total > 1e-6 ? min(1.0, avail / total) : 1.0;

                gl_FragColor = vec4(fE, fW, fN, fS) * K;
            }
        `;
    }

    getWaterShader() {
        return `
            uniform float uDt;
            uniform float uCellSize;
            uniform vec2 uSweOrigin;
            uniform float uSweSize;
            uniform float uSeaLevel;
            uniform float uCoupling;
            uniform sampler2D uDispMap;
            uniform vec2 uGridOffset;
            uniform float uGridSize;

            ${TERRAIN_GLSL}

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                float texel = 1.0 / resolution.x;

                float hi = 1.0 - 0.5 * texel;
                float lo = 0.5 * texel;
                vec2 uvE = vec2(min(uv.x + texel, hi), uv.y);
                vec2 uvW = vec2(max(uv.x - texel, lo), uv.y);
                vec2 uvN = vec2(uv.x, min(uv.y + texel, hi));
                vec2 uvS = vec2(uv.x, max(uv.y - texel, lo));

                vec4 st = texture2D(textureWater, uv);
                float d = st.x;
                vec2 wp = uSweOrigin + (uv - 0.5) * uSweSize;
                float b = terrainHeight(wp);

                vec4 fC = texture2D(textureFlux, uv);          // our outflow
                float fE_fromW = texture2D(textureFlux, uvW).x; // west cell -> us
                float fW_fromE = texture2D(textureFlux, uvE).y; // east cell -> us
                float fN_fromS = texture2D(textureFlux, uvS).z; // south cell -> us
                float fS_fromN = texture2D(textureFlux, uvN).w; // north cell -> us

                float inflow = fE_fromW + fW_fromE + fN_fromS + fS_fromN;
                float outflow = fC.x + fC.y + fC.z + fC.w;
                float dNew = max(0.0, d + uDt * (inflow - outflow) / (uCellSize * uCellSize));

                // Velocity estimate (net flux through the cell), for foam/shading
                float denom = uCellSize * max(dNew, 0.3);
                float vx = (fE_fromW + fC.x - fC.y - fW_fromE) * 0.5 / denom;
                float vz = (fN_fromS + fC.z - fC.w - fS_fromN) * 0.5 / denom;

                // Dirichlet forcing on the deep outer ring: push the open-ocean
                // surface in as the near-shore boundary condition.
                float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
                float ring = smoothstep(3.0 * texel, 0.0, edge);
                if (ring > 0.001 && b < uSeaLevel - 4.0) {
                    vec2 ouv = (wp - uGridOffset) / uGridSize + 0.5;
                    float dispY = 0.0;
                    if (ouv.x > 0.0 && ouv.x < 1.0 && ouv.y > 0.0 && ouv.y < 1.0) {
                        dispY = texture2D(uDispMap, ouv).y;
                    }
                    float forced = max(0.0, (uSeaLevel + dispY * uCoupling) - b);
                    dNew = mix(dNew, forced, ring);
                    vx = mix(vx, 0.0, ring);
                    vz = mix(vz, 0.0, ring);
                }

                gl_FragColor = vec4(dNew, vx, vz, b + dNew);
            }
        `;
    }

    /**
     * Advance the solver by `substeps` pipe-model steps of length `dt`.
     */
    update(dispMap, gridOffset, gridSize, dt, substeps) {
        if (dt <= 0.0) return;
        this.fu.uDt.value = dt;
        this.fu.uDamp.value = Math.exp(-config.sweDrag * dt);
        this.wu.uDt.value = dt;
        this.wu.uSeaLevel.value = config.seaLevel;
        this.wu.uCoupling.value = config.sweCoupling;
        this.wu.uDispMap.value = dispMap;
        this.wu.uGridOffset.value.copy(gridOffset);
        this.wu.uGridSize.value = gridSize;

        for (let s = 0; s < substeps; s++) {
            this.gpu.compute();
        }
    }

    getStateTexture() {
        return this.gpu.getCurrentRenderTarget(this.waterVar).texture;
    }

    dispose() {
        if (this.gpu) this.gpu.dispose();
    }
}
