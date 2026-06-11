/**
 * sea.js - Infinite Ocean (camera-following grid)
 *
 * The grid snaps to the camera in whole-patch steps so vertex world
 * positions stay stable. Wave physics is evaluated in absolute world
 * coordinates; foam history is reprojected when the grid moves.
 *
 * The wave spectrum is synthesised on the CPU into three explicit bands
 * (macro swell / wind sea / chop) and uploaded as uniform arrays, so the
 * physics pass and the far-field skirt evaluate the exact same field.
 *
 * The deep-ocean field (L0) is an FFT spectral ocean (fft.js): a Phillips
 * spectrum evolved in time and inverse transformed into a periodic tile, then
 * tiled into a camera-centred displacement texture (RGB = world displacement,
 * A = Jacobian). That texture is the exact interface the rest of the pipeline
 * already expected, so the foam pass, surface mesh and downstream layers are
 * unaware of how it is produced.
 *
 * The near-shore shallow-water layer (L2) lives in swe.js; this class owns it,
 * feeds it the L0 displacement for boundary coupling, and blends its solution
 * into the surface mesh and the foam pass. The wave-strike particle layer (L3)
 * lives in spray.js; it samples this frame's L0 displacement to throw spray off
 * the reefs and stamps its foam splats into the same foam target.
 *
 * Version: 0.6.0
 */

import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { config, getters } from './config.js';
import { FFTOcean } from './fft.js';
import { ShallowWater } from './swe.js';
import { SpraySystem } from './spray.js';
import { SWE_ORIGIN, SWE_SIZE } from './terrain.js';

export class Ocean {
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.gridSize = config.gridSize;
        // World-space grid origin, snapped to whole patches each frame
        this.gridOffset = new THREE.Vector2(0, 0);

        // Reference crest height for the shading ramps, refreshed from config
        this.ampNorm = Math.max(config.waveHeight * 2.5, 0.5);
        // Last spectrum inputs, so the FFT seed is only rebuilt when they change
        this.spectrumKey = '';

        // Deep-ocean FFT field (L0) and the camera-centred displacement texture
        // it resolves into (the interface the rest of the pipeline consumes)
        this.fft = new FFTOcean(this.renderer, {
            size: config.fftResolution,
            patchSize: config.fftPatchSize,
        });
        this.physicsTarget = new THREE.WebGLRenderTarget(config.gridResolution, config.gridResolution, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            stencilBuffer: false,
        });
        this.updateSpectrum(true);

        this.initGPGPU();
        // Near-shore shallow-water layer (fixed patch at the world origin)
        this.swe = new ShallowWater(renderer);
        this.sweTexel = 1.0 / this.swe.res;
        this.createMesh();
        this.createSkirt();
        // Wave-strike particle layer (L3): GPGPU spray off the reefs
        this.spray = new SpraySystem(renderer, scene);
    }

    /**
     * Reseed the FFT spectrum when the wind / wave-height settings change and
     * refresh the shading reference amplitude.
     */
    updateSpectrum(force = false) {
        const key = [config.windSpeed, config.windDirection, config.waveHeight, config.choppiness].join(',');
        if (!force && key === this.spectrumKey) return;
        this.spectrumKey = key;

        const windRad = config.windDirection * Math.PI / 180;
        this.fft.setParams({
            windSpeed: config.windSpeed,
            windDir: new THREE.Vector2(Math.cos(windRad), Math.sin(windRad)),
            waveHeight: config.waveHeight,
            choppiness: config.choppiness,
        });
        this.ampNorm = Math.max(config.waveHeight * 2.5, 0.5);
    }

    initGPGPU() {
        this.gpuCompute = new GPUComputationRenderer(config.gridResolution, config.gridResolution, this.renderer);

        if (this.renderer.capabilities.isWebGL2 === false) {
            throw new Error('WebGL 2.0 is required');
        }

        const foamTexture = this.gpuCompute.createTexture();

        // The displacement field is produced by the FFT layer (fft.js) and fed
        // in through the uPhysics uniform; only foam accumulates here.
        this.foamVariable = this.gpuCompute.addVariable('textureFoam',
            this.getFoamAccumulateShader(),
            foamTexture
        );

        this.gpuCompute.setVariableDependencies(this.foamVariable, [this.foamVariable]);

        const error = this.gpuCompute.init();
        if (error !== null) {
            console.error('GPGPU Init Error:', error);
        }

        this.setupUniforms();
    }

    setupUniforms() {
        this.timeUniform = { value: 0 };

        // === Foam Uniforms ===
        const foamUniforms = this.foamVariable.material.uniforms;
        foamUniforms['uTime'] = this.timeUniform;
        foamUniforms['uPhysics'] = { value: this.physicsTarget.texture };
        foamUniforms['uDecay'] = { value: config.foamDecay };
        foamUniforms['uThreshold'] = { value: config.foamThreshold };
        foamUniforms['uGrowth'] = { value: config.foamGrowth };
        foamUniforms['uUVOffset'] = { value: new THREE.Vector2(0, 0) };
        // Near-shore foam: the foam pass samples the SWE state in world space
        // and adds breaker / shore-wash generation into the shared foam texture
        foamUniforms['uGridOffset'] = { value: new THREE.Vector2(0, 0) };
        foamUniforms['uGridSize'] = { value: this.gridSize };
        foamUniforms['uSweTexture'] = { value: null };
        foamUniforms['uSweOrigin'] = { value: SWE_ORIGIN };
        foamUniforms['uSweSize'] = { value: SWE_SIZE };
        foamUniforms['uSweEnabled'] = { value: config.sweEnabled ? 1.0 : 0.0 };
        foamUniforms['uSweFoam'] = { value: config.sweFoam };

        this.foamUniforms = foamUniforms;
    }

    getFoamAccumulateShader() {
        return `
            uniform sampler2D uPhysics;
            uniform float uDecay;
            uniform float uThreshold;
            uniform float uGrowth;
            uniform float uTime;
            uniform vec2 uUVOffset;
            uniform vec2 uGridOffset;
            uniform float uGridSize;
            uniform sampler2D uSweTexture;
            uniform vec2 uSweOrigin;
            uniform float uSweSize;
            uniform float uSweEnabled;
            uniform float uSweFoam;

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;

                // 1. Read the current displacement field (from the FFT layer)
                vec4 physics = texture2D(uPhysics, uv);
                float jacobian = physics.a;

                // 2. Read previous frame foam, reprojected by the grid movement
                // so accumulated foam stays pinned to world positions.
                // Areas newly scrolled into view have no history and start at zero.
                vec2 prevUv = uv + uUVOffset;
                float prevFoam = 0.0;
                if (prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0) {
                    prevFoam = texture2D(textureFoam, prevUv).r;
                }

                // 3. Generate from the open-ocean crest compression
                float generation = smoothstep(uThreshold, uThreshold - 0.2, jacobian);
                generation = clamp(generation, 0.0, 1.0) * 0.075 * uGrowth;

                // 4. Near-shore foam: breakers (fast + shallow) and the wet/dry
                // swash line, sampled from the SWE state at this world position
                if (uSweEnabled > 0.5) {
                    vec2 worldPos = (uv - 0.5) * uGridSize + uGridOffset;
                    vec2 sUv = (worldPos - uSweOrigin) / uSweSize + 0.5;
                    if (sUv.x > 0.0 && sUv.x < 1.0 && sUv.y > 0.0 && sUv.y < 1.0) {
                        vec4 sw = texture2D(uSweTexture, sUv);
                        float depth = sw.x;
                        float speed = length(sw.yz);
                        float breaking = smoothstep(0.6, 1.8, speed) * smoothstep(2.5, 0.2, depth);
                        float swash = smoothstep(0.02, 0.18, depth) * smoothstep(0.6, 0.18, depth);
                        generation += clamp(breaking + swash * 0.5, 0.0, 1.0) * 0.12 * uSweFoam;
                    }
                }

                float foam = prevFoam * uDecay + generation;
                foam = clamp(foam, 0.0, 1.0);

                gl_FragColor = vec4(foam, 0.0, 0.0, 1.0);
            }
        `;
    }

    createMesh() {
        const geometry = new THREE.PlaneGeometry(
            this.gridSize,
            this.gridSize,
            config.gridResolution,
            config.gridResolution
        );
        geometry.rotateX(-Math.PI / 2);

        // Flip V so texture space matches the physics shader convention
        // (local z = (v - 0.5) * gridSize); rotateX alone leaves V mirrored
        const uvAttr = geometry.attributes.uv;
        for (let i = 0; i < uvAttr.count; i++) {
            uvAttr.setY(i, 1.0 - uvAttr.getY(i));
        }

        const vertexShader = document.getElementById('ocean-vertex').textContent;
        const fragmentShader = document.getElementById('ocean-fragment').textContent;

        this.material = new THREE.ShaderMaterial({
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            uniforms: {
                uDisplacementMap: { value: null },
                uFoamTexture: { value: null },
                uTime: { value: 0 },
                uWaterColorDeep: { value: getters.waterColorDeepColor },
                uWaterColorShallow: { value: getters.waterColorShallowColor },
                uSunPosition: { value: getters.sunPositionVector },
                uFoamThreshold: { value: config.foamThreshold },
                uCameraPosition: { value: new THREE.Vector3() },
                uGridSize: { value: this.gridSize },
                uGridResolution: { value: config.gridResolution },
                uSssColor: { value: getters.sssColorColor },
                uSssStrength: { value: config.sssStrength },
                uSpecPower: { value: config.specPower },
                uSpecIntensity: { value: config.specIntensity },
                uGlitterStrength: { value: config.glitterStrength },
                uLacingScale: { value: config.foamLacingScale },
                uSkyHorizon: { value: getters.skyHorizonColor },
                uSkyZenith: { value: getters.skyZenithColor },
                uFogDensity: { value: config.fogDensity },
                uChopAmount: { value: config.chopAmount },
                uAmpNorm: { value: this.ampNorm },
                uSweTexture: { value: null },
                uSweOrigin: { value: SWE_ORIGIN },
                uSweSize: { value: SWE_SIZE },
                uSweTexel: { value: this.sweTexel },
                uSweEnabled: { value: config.sweEnabled ? 1.0 : 0.0 },
                uSeaLevel: { value: config.seaLevel },
            },
            transparent: true,
        });

        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.position.set(0, config.seaLevel, 0); // snapped to camera each frame
        // Ensure the mesh is not frustum-culled due to its size
        this.mesh.frustumCulled = false;

        this.scene.add(this.mesh);
    }

    /**
     * Far-field skirt: a camera-following ring from the grid edge out to the
     * horizon. It evaluates only the swell band of the same spectrum, so it
     * joins the grid (whose short bands fade to zero at the rim) seamlessly.
     * Radial vertex spacing grows exponentially: dense near the grid edge,
     * coarse in the fog-dominated distance.
     */
    createSkirt() {
        const inner = this.gridSize * 0.5 * 0.99;
        const outer = 9000;
        const geometry = new THREE.RingGeometry(inner, outer, 160, 28);
        geometry.rotateX(-Math.PI / 2);

        const pos = geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
            const x = pos.getX(i);
            const z = pos.getZ(i);
            const r = Math.hypot(x, z);
            if (r < 1e-3) continue;
            const t = (r - inner) / (outer - inner);
            const rNew = inner * Math.pow(outer / inner, t);
            const s = rNew / r;
            pos.setX(i, x * s);
            pos.setZ(i, z * s);
        }

        this.skirtMaterial = new THREE.ShaderMaterial({
            vertexShader: this.getSkirtVertexShader(),
            fragmentShader: this.getSkirtFragmentShader(),
            uniforms: {
                uTime: this.timeUniform,
                uTile: { value: this.fft.tileTexture },
                uPatch: { value: this.fft.patchSize },
                uWaterColorDeep: { value: getters.waterColorDeepColor },
                uWaterColorShallow: { value: getters.waterColorShallowColor },
                uSunPosition: { value: getters.sunPositionVector },
                uCameraPosition: { value: new THREE.Vector3() },
                uSssColor: { value: getters.sssColorColor },
                uSssStrength: { value: config.sssStrength },
                uSpecPower: { value: config.specPower },
                uSpecIntensity: { value: config.specIntensity },
                uSkyHorizon: { value: getters.skyHorizonColor },
                uSkyZenith: { value: getters.skyZenithColor },
                uFogDensity: { value: config.fogDensity },
                uAmpNorm: { value: this.ampNorm },
            },
        });

        this.skirt = new THREE.Mesh(geometry, this.skirtMaterial);
        // Sit slightly below the main grid so the overlap never z-fights
        this.skirt.position.set(0, config.seaLevel - 0.4, 0);
        this.skirt.frustumCulled = false;
        this.scene.add(this.skirt);
    }

    getSkirtVertexShader() {
        return `
            uniform sampler2D uTile;
            uniform float uPatch;

            varying vec3 vWorldPosition;
            varying vec3 vNormal;
            varying float vDisplacement;

            // Sample the periodic FFT tile (RGB = Dx, height, Dz) by world
            // position; the same tile feeds the main grid, so the seam matches.
            vec3 sampleDisp(vec2 worldXZ) {
                return texture2D(uTile, worldXZ / uPatch).xyz;
            }

            void main() {
                vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
                vec3 off = sampleDisp(base.xz);

                // Finite-difference normal from the displaced field
                float e = 4.0;
                vec3 offX = sampleDisp(base.xz + vec2(e, 0.0));
                vec3 offZ = sampleDisp(base.xz + vec2(0.0, e));
                vec3 p0 = vec3(base.x + off.x, off.y, base.z + off.z);
                vec3 pX = vec3(base.x + e + offX.x, offX.y, base.z + offX.z);
                vec3 pZ = vec3(base.x + offZ.x, offZ.y, base.z + e + offZ.z);
                vNormal = normalize(cross(pZ - p0, pX - p0));

                vWorldPosition = p0;
                vDisplacement = off.y;
                gl_Position = projectionMatrix * viewMatrix * vec4(p0, 1.0);
            }
        `;
    }

    getSkirtFragmentShader() {
        return `
            uniform vec3 uWaterColorDeep;
            uniform vec3 uWaterColorShallow;
            uniform vec3 uSunPosition;
            uniform vec3 uCameraPosition;
            uniform vec3 uSssColor;
            uniform float uSssStrength;
            uniform float uSpecPower;
            uniform float uSpecIntensity;
            uniform vec3 uSkyHorizon;
            uniform vec3 uSkyZenith;
            uniform float uFogDensity;
            uniform float uAmpNorm;

            varying vec3 vWorldPosition;
            varying vec3 vNormal;
            varying float vDisplacement;

            void main() {
                vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
                vec3 sunDir = normalize(uSunPosition);
                vec3 normal = normalize(vNormal);

                float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 5.0);
                fresnel = mix(0.03, 1.0, fresnel);

                // Same stylised height ramp as the main surface
                float hT = clamp(vDisplacement / uAmpNorm * 0.5 + 0.5, 0.0, 1.0);
                float rampT = smoothstep(0.15, 0.95, hT);
                vec3 waterColor = mix(uWaterColorDeep, uWaterColorShallow, rampT);

                // Distant backlit swell still glows faintly
                float backlight = max(dot(viewDir, -sunDir), 0.0);
                float sss = pow(backlight, 2.5) * max(vDisplacement, 0.0) / uAmpNorm;
                waterColor += uSssColor * sss * uSssStrength * 0.5;

                vec3 reflDir = reflect(-viewDir, normal);
                vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, clamp(reflDir.y * 1.6, 0.0, 1.0));

                vec3 halfDir = normalize(viewDir + sunDir);
                float spec = pow(max(dot(normal, halfDir), 0.0), uSpecPower) * uSpecIntensity;

                vec3 finalColor = mix(waterColor, skyRefl, fresnel * 0.55);
                finalColor += spec * vec3(1.0, 0.98, 0.9);

                float dist = length(vWorldPosition - uCameraPosition);
                float fogAmt = 1.0 - exp(-dist * uFogDensity);
                finalColor = mix(finalColor, uSkyHorizon, fogAmt);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;
    }

    update(deltaTime, camera) {
        this.timeUniform.value = config.time;

        // Reseed the FFT spectrum only when the wind / wave inputs change
        this.updateSpectrum();

        // Snap the grid to the camera in whole-patch steps so vertex world
        // positions stay stable (no swimming)
        const patch = getters.patchSize;
        const offsetX = Math.floor(camera.position.x / patch) * patch;
        const offsetZ = Math.floor(camera.position.z / patch) * patch;

        // Evolve the FFT field and tile it into the camera-centred displacement
        // texture the rest of the pipeline samples
        this.fft.update(config.time);
        this.fft.resolveToPatch(this.physicsTarget, new THREE.Vector2(offsetX, offsetZ), this.gridSize);
        const physicsTexture = this.physicsTarget.texture;

        if (this.foamUniforms) {
            this.foamUniforms.uDecay.value = config.foamDecay;
            this.foamUniforms.uThreshold.value = config.foamThreshold;
            this.foamUniforms.uGrowth.value = config.foamGrowth;
            // Reprojection delta: where this frame's texel lived in last frame's UV space
            this.foamUniforms.uUVOffset.value.set(
                (offsetX - this.gridOffset.x) / this.gridSize,
                (offsetZ - this.gridOffset.y) / this.gridSize
            );
            // Foam pass samples the SWE state from last frame (the foam pass
            // runs inside this compute(), before the SWE step below)
            this.foamUniforms.uGridOffset.value.set(offsetX, offsetZ);
            this.foamUniforms.uSweTexture.value = this.swe.getStateTexture();
            this.foamUniforms.uSweEnabled.value = config.sweEnabled ? 1.0 : 0.0;
            this.foamUniforms.uSweFoam.value = config.sweFoam;
        }

        this.gridOffset.set(offsetX, offsetZ);
        this.mesh.position.set(offsetX, config.seaLevel, offsetZ);
        this.skirt.position.set(offsetX, config.seaLevel - 0.4, offsetZ);

        this.gpuCompute.compute();

        const foamTexture = this.gpuCompute.getCurrentRenderTarget(this.foamVariable).texture;

        // Advance the near-shore shallow-water layer, coupled to this frame's
        // L0 displacement at its deep boundary
        if (config.sweEnabled) {
            const frameDt = Math.min(config.deltaTime, 0.05) * config.timeScale;
            const substeps = Math.max(1, Math.floor(config.sweSubsteps));
            const dtSub = Math.min(frameDt / substeps, 0.08);
            this.swe.update(physicsTexture, this.gridOffset, this.gridSize, dtSub, substeps);
        }

        if (this.material) {
            const u = this.material.uniforms;
            u.uDisplacementMap.value = physicsTexture;
            u.uFoamTexture.value = foamTexture;
            u.uCameraPosition.value.copy(camera.position);
            u.uTime.value = config.time;

            // Update visual uniforms
            u.uWaterColorDeep.value.setHex(config.waterColorDeep);
            u.uWaterColorShallow.value.setHex(config.waterColorShallow);
            u.uSunPosition.value.copy(config.sunPosition);
            u.uFoamThreshold.value = config.foamThreshold;
            u.uSssColor.value.setHex(config.sssColor);
            u.uSssStrength.value = config.sssStrength;
            u.uSpecPower.value = config.specPower;
            u.uSpecIntensity.value = config.specIntensity;
            u.uGlitterStrength.value = config.glitterStrength;
            u.uLacingScale.value = config.foamLacingScale;
            u.uSkyHorizon.value.setHex(config.skyColorHorizon);
            u.uSkyZenith.value.setHex(config.skyColorZenith);
            u.uFogDensity.value = config.fogDensity;
            u.uChopAmount.value = config.chopAmount;
            u.uAmpNorm.value = this.ampNorm;
            // Freshest SWE state for the surface blend
            u.uSweTexture.value = this.swe.getStateTexture();
            u.uSweEnabled.value = config.sweEnabled ? 1.0 : 0.0;
            u.uSeaLevel.value = config.seaLevel;
        }

        if (this.skirtMaterial) {
            const s = this.skirtMaterial.uniforms;
            s.uCameraPosition.value.copy(camera.position);
            s.uWaterColorDeep.value.setHex(config.waterColorDeep);
            s.uWaterColorShallow.value.setHex(config.waterColorShallow);
            s.uSunPosition.value.copy(config.sunPosition);
            s.uSssColor.value.setHex(config.sssColor);
            s.uSssStrength.value = config.sssStrength;
            s.uSpecPower.value = config.specPower;
            s.uSpecIntensity.value = config.specIntensity;
            s.uSkyHorizon.value.setHex(config.skyColorHorizon);
            s.uSkyZenith.value.setHex(config.skyColorZenith);
            s.uFogDensity.value = config.fogDensity;
            s.uAmpNorm.value = this.ampNorm;
        }

        // Advance the wave-strike spray pool and splat its foam into the shared
        // foam target (additively, persisting through the foam accumulation)
        if (this.spray) {
            const sprayDt = Math.min(config.deltaTime, 0.05) * config.timeScale;
            const foamTarget = this.gpuCompute.getCurrentRenderTarget(this.foamVariable);
            this.spray.update(sprayDt, physicsTexture, this.gridOffset, this.gridSize, foamTarget);
        }
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.scene.remove(this.skirt);
        if (this.spray) this.spray.dispose();
        if (this.swe) this.swe.dispose();
        if (this.fft) this.fft.dispose();
        if (this.physicsTarget) this.physicsTarget.dispose();
    }
}
