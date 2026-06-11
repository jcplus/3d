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
 * Foam is advected: the displacement texture is double-buffered so the foam
 * pass can difference two frames into a horizontal surface velocity and drag
 * the accumulated foam along it. Convergent chop then gathers the foam into
 * the streaky downwind webbing of a worked sea instead of static blooms.
 *
 * Version: 0.8.0
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
        // Double-buffered so the foam pass can difference two consecutive
        // frames into a horizontal surface velocity for foam advection
        const makePhysicsTarget = () => new THREE.WebGLRenderTarget(config.gridResolution, config.gridResolution, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            stencilBuffer: false,
        });
        this.physicsTargets = [makePhysicsTarget(), makePhysicsTarget()];
        this.physicsIndex = 0;
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
        const key = [config.windSpeed, config.windDirection, config.waveHeight, config.choppiness,
            config.swellDirSpread, config.rippleSuppress].join(',');
        if (!force && key === this.spectrumKey) return;
        this.spectrumKey = key;

        const windRad = config.windDirection * Math.PI / 180;
        this.fft.setParams({
            windSpeed: config.windSpeed,
            windDir: new THREE.Vector2(Math.cos(windRad), Math.sin(windRad)),
            waveHeight: config.waveHeight,
            choppiness: config.choppiness,
            swellSpread: config.swellDirSpread,
            rippleCutoff: config.rippleSuppress,
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
        this.foamVariable.minFilter = THREE.LinearFilter;
        this.foamVariable.magFilter = THREE.LinearFilter;

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
        foamUniforms['uPhysics'] = { value: null };
        foamUniforms['uPhysicsPrev'] = { value: null };
        foamUniforms['uDt'] = { value: 0 };
        foamUniforms['uStreak'] = { value: config.foamStreak };
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
            uniform sampler2D uPhysicsPrev;
            uniform float uDt;
            uniform float uStreak;
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

                // 2. Horizontal surface velocity from the frame-to-frame choppy
                // displacement delta (the previous frame lives at uv + uUVOffset
                // because the grid may have snapped between frames)
                vec2 selfPrev = uv + uUVOffset;
                vec2 vel = vec2(0.0);
                if (uDt > 1e-4 && selfPrev.x >= 0.0 && selfPrev.x <= 1.0
                    && selfPrev.y >= 0.0 && selfPrev.y <= 1.0) {
                    vec2 dispPrev = texture2D(uPhysicsPrev, selfPrev).xz;
                    vel = (physics.xz - dispPrev) / uDt;
                }

                // 3. Read previous frame foam, reprojected by the grid movement
                // and advected upstream along the surface velocity. Convergent
                // chop gathers the foam into downwind streaks; areas newly
                // scrolled into view have no history and start at zero.
                vec2 prevUv = uv - vel * uDt * uStreak / uGridSize + uUVOffset;
                float prevFoam = 0.0;
                if (prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0) {
                    prevFoam = texture2D(textureFoam, prevUv).r;
                }

                // 4. Generate from the open-ocean crest compression: a soft
                // onset over the whole folding range plus a hard kick where the
                // surface truly overturns, so whitecaps read as events
                float fold = smoothstep(uThreshold, uThreshold - 0.35, jacobian);
                float generation = (fold * 0.05 + fold * fold * 0.07) * uGrowth;

                // 5. Near-shore foam: breakers (fast + shallow) and the wet/dry
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
                uWaterColorMid: { value: getters.waterColorMidColor },
                uWaterColorShallow: { value: getters.waterColorShallowColor },
                uWaterColorShadow: { value: getters.waterColorShadowColor },
                uFoamColor: { value: getters.foamColorColor },
                uSunPosition: { value: getters.sunPositionVector },
                uFoamThreshold: { value: config.foamThreshold },
                uCameraPosition: { value: new THREE.Vector3() },
                uGridSize: { value: this.gridSize },
                uGridResolution: { value: config.gridResolution },
                uSssColor: { value: getters.sssColorColor },
                uSssStrength: { value: config.sssStrength },
                uSpecPower: { value: config.specPower },
                uSpecIntensity: { value: config.specIntensity },
                uWaterContrast: { value: config.waterContrast },
                uWindDir: { value: getters.windVector },
                uCrestLean: { value: config.crestLean },
                uSkyHorizon: { value: getters.skyHorizonColor },
                uSkyZenith: { value: getters.skyZenithColor },
                uFogDensity: { value: config.fogDensity },
                uChopAmount: { value: config.chopAmount },
                uDetailPatchiness: { value: config.detailPatchiness },
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
                uWaterColorMid: { value: getters.waterColorMidColor },
                uWaterColorShallow: { value: getters.waterColorShallowColor },
                uWaterColorShadow: { value: getters.waterColorShadowColor },
                uFoamColor: { value: getters.foamColorColor },
                uWaterContrast: { value: config.waterContrast },
                uSunPosition: { value: getters.sunPositionVector },
                uCameraPosition: { value: new THREE.Vector3() },
                uSssColor: { value: getters.sssColorColor },
                uSssStrength: { value: config.sssStrength },
                uSkyHorizon: { value: getters.skyHorizonColor },
                uFogDensity: { value: config.fogDensity },
                uAmpNorm: { value: this.ampNorm },
                uFoamThreshold: { value: config.foamThreshold },
                uWindDir: { value: getters.windVector },
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
                return texture2D(uTile, fract(worldXZ / uPatch)).xyz;
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
            uniform sampler2D uTile;
            uniform float uPatch;
            uniform vec3 uWaterColorDeep;
            uniform vec3 uWaterColorMid;
            uniform vec3 uWaterColorShallow;
            uniform vec3 uWaterColorShadow;
            uniform vec3 uFoamColor;
            uniform float uWaterContrast;
            uniform vec3 uSunPosition;
            uniform vec3 uCameraPosition;
            uniform vec3 uSssColor;
            uniform float uSssStrength;
            uniform vec3 uSkyHorizon;
            uniform float uFogDensity;
            uniform float uAmpNorm;
            uniform float uFoamThreshold;
            uniform vec2 uWindDir;

            varying vec3 vWorldPosition;
            varying vec3 vNormal;
            varying float vDisplacement;

            // Cheap value noise; only shapes the far-field foam veining
            float hash21(vec2 p) {
                p = fract(p * vec2(234.34, 435.345));
                p += dot(p, p + 34.23);
                return fract(p.x * p.y);
            }
            float vnoise(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                float a = hash21(i);
                float b = hash21(i + vec2(1.0, 0.0));
                float c = hash21(i + vec2(0.0, 1.0));
                float d = hash21(i + vec2(1.0, 1.0));
                return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            }

            void main() {
                vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
                vec3 sunDir = normalize(uSunPosition);
                vec3 normal = normalize(vNormal);

                // Same swatch palette and cuts as the main surface, matte:
                // no sky mirror or warm specular, so the far field keeps the
                // exact art-directed cyans until the fog takes over
                float hT = clamp(vDisplacement / uAmpNorm * 0.5 + 0.5, 0.0, 1.0);
                float rampT = clamp(smoothstep(0.15, 0.95, hT), 0.0, 1.0);
                vec3 waterColor = mix(uWaterColorDeep, uWaterColorMid, smoothstep(0.30, 0.36, rampT));
                waterColor = mix(waterColor, uWaterColorShallow, smoothstep(0.62, 0.68, rampT));

                // Cel shadow flanks swing towards the shadow swatch
                float lamShade = max(dot(normal, sunDir), 0.0);
                float shadeBand = 1.0 - smoothstep(0.28, 0.4, lamShade);
                waterColor = mix(waterColor, uWaterColorShadow, shadeBand * uWaterContrast);

                // Distant backlit swell still lifts towards the SSS band
                float backlight = max(dot(viewDir, -sunDir), 0.0);
                float sss = pow(backlight, 2.5) * max(vDisplacement, 0.0) / uAmpNorm;
                waterColor = mix(waterColor, uSssColor, clamp(sss * uSssStrength * 0.4, 0.0, 1.0));

                vec3 finalColor = waterColor;

                float dist = length(vWorldPosition - uCameraPosition);

                // Far-field whitecaps: the periodic tile carries the Jacobian in
                // alpha, so folding crests keep flecking the sea out to the fog
                // line. A wind-stretched vein field breaks them into streaks and
                // a very low-frequency mask hides the tile repetition.
                float jac = texture2D(uTile, fract(vWorldPosition.xz / uPatch)).a;
                vec2 wDir = normalize(uWindDir);
                vec2 wuv = vec2(dot(vWorldPosition.xz, wDir) * 0.35,
                                dot(vWorldPosition.xz, vec2(-wDir.y, wDir.x)));
                float vein = vnoise(wuv * 0.06);
                float patchMask = vnoise(vWorldPosition.xz * 0.0035);
                float cap = smoothstep(uFoamThreshold, uFoamThreshold - 0.45, jac);
                float caps = cap * (0.4 + 0.6 * vein) * (0.45 + 0.75 * patchMask);
                // Unfiltered tile texels alias at extreme range; let the fog own it
                caps *= exp(-dist * 0.0008);
                float lam = smoothstep(0.42, 0.5, lamShade);
                vec3 foamColor = mix(mix(uFoamColor, uWaterColorShadow, 0.25), uFoamColor, lam);
                finalColor = mix(finalColor, foamColor, clamp(caps * 1.6, 0.0, 1.0));

                float fogAmt = 1.0 - exp(-dist * uFogDensity);
                finalColor = mix(finalColor, uSkyHorizon, fogAmt);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;
    }

    update(deltaTime, camera) {
        // Unbind active textures to prevent WebGL feedback loops
        if (this.renderer && this.renderer.state) {
            this.renderer.state.unbindTexture(this.fft.tileTexture);
            this.renderer.state.unbindTexture(this.physicsTargets[this.physicsIndex].texture);
            this.renderer.state.unbindTexture(this.physicsTargets[this.physicsIndex ^ 1].texture);
            if (this.swe) {
                this.renderer.state.unbindTexture(this.swe.getStateTexture());
            }
            const currentFoam = this.gpuCompute.getCurrentRenderTarget(this.foamVariable)?.texture;
            if (currentFoam) {
                this.renderer.state.unbindTexture(currentFoam);
            }
            const alternateFoam = this.gpuCompute.getAlternateRenderTarget(this.foamVariable)?.texture;
            if (alternateFoam) {
                this.renderer.state.unbindTexture(alternateFoam);
            }
        }

        this.timeUniform.value = config.time;

        // Reseed the FFT spectrum only when the wind / wave inputs change
        this.updateSpectrum();

        // Snap the grid to the camera in whole-patch steps so vertex world
        // positions stay stable (no swimming)
        const patch = getters.patchSize;
        const offsetX = Math.floor(camera.position.x / patch) * patch;
        const offsetZ = Math.floor(camera.position.z / patch) * patch;

        // Evolve the FFT field and tile it into the camera-centred displacement
        // texture the rest of the pipeline samples. The two targets alternate
        // so the foam pass can difference them into a surface velocity.
        this.physicsIndex ^= 1;
        this.fft.update(config.time);
        this.fft.resolveToPatch(this.physicsTargets[this.physicsIndex], new THREE.Vector2(offsetX, offsetZ), this.gridSize);
        const physicsTexture = this.physicsTargets[this.physicsIndex].texture;

        if (this.foamUniforms) {
            this.foamUniforms.uPhysics.value = physicsTexture;
            this.foamUniforms.uPhysicsPrev.value = this.physicsTargets[this.physicsIndex ^ 1].texture;
            this.foamUniforms.uDt.value = Math.min(config.deltaTime, 0.05) * config.timeScale;
            this.foamUniforms.uStreak.value = config.foamStreak;
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
            u.uWaterColorMid.value.setHex(config.waterColorMid);
            u.uWaterColorShallow.value.setHex(config.waterColorShallow);
            u.uWaterColorShadow.value.setHex(config.waterColorShadow);
            u.uFoamColor.value.setHex(config.foamColor);
            u.uSunPosition.value.copy(config.sunPosition);
            u.uFoamThreshold.value = config.foamThreshold;
            u.uSssColor.value.setHex(config.sssColor);
            u.uSssStrength.value = config.sssStrength;
            u.uSpecPower.value = config.specPower;
            u.uSpecIntensity.value = config.specIntensity;
            u.uWaterContrast.value = config.waterContrast;
            u.uWindDir.value.copy(getters.windVector);
            u.uCrestLean.value = config.crestLean;
            u.uSkyHorizon.value.setHex(config.skyColorHorizon);
            u.uSkyZenith.value.setHex(config.skyColorZenith);
            u.uFogDensity.value = config.fogDensity;
            u.uChopAmount.value = config.chopAmount;
            u.uDetailPatchiness.value = config.detailPatchiness;
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
            s.uWaterColorMid.value.setHex(config.waterColorMid);
            s.uWaterColorShallow.value.setHex(config.waterColorShallow);
            s.uWaterColorShadow.value.setHex(config.waterColorShadow);
            s.uFoamColor.value.setHex(config.foamColor);
            s.uWaterContrast.value = config.waterContrast;
            s.uSunPosition.value.copy(config.sunPosition);
            s.uSssColor.value.setHex(config.sssColor);
            s.uSssStrength.value = config.sssStrength;
            s.uSkyHorizon.value.setHex(config.skyColorHorizon);
            s.uFogDensity.value = config.fogDensity;
            s.uAmpNorm.value = this.ampNorm;
            s.uFoamThreshold.value = config.foamThreshold;
            s.uWindDir.value.copy(getters.windVector);
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
        if (this.physicsTargets) this.physicsTargets.forEach(t => t.dispose());
    }
}
