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
 * The near-shore shallow-water layer (L2) lives in swe.js; this class owns it,
 * feeds it the L0 displacement for boundary coupling, and blends its solution
 * into the surface mesh and the foam pass.
 *
 * Version: 0.4.0
 */

import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { config, getters } from './config.js';
import { ShallowWater } from './swe.js';
import { SWE_ORIGIN, SWE_SIZE } from './terrain.js';

const WAVE_COUNT = 12;
const SWELL_COUNT = 3;

// Fixed per-layer pseudo-random values so the spectrum is deterministic
// across sessions (direction jitter in [-1, 1], phase in [0, 100])
const DIR_RAND = [0.0, 0.0, 0.0, 0.31, -0.74, 0.52, -0.18, 0.88, -0.61, 0.43, -0.95, 0.69];
const PHASE_RAND = [12.4, 71.3, 38.9, 5.7, 93.2, 47.6, 81.1, 23.8, 66.4, 14.9, 58.2, 30.5];

export class Ocean {
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.gridSize = config.gridSize;
        // World-space grid origin, snapped to whole patches each frame
        this.gridOffset = new THREE.Vector2(0, 0);

        // Spectrum uniform storage, rebuilt each frame from config
        this.waveA = Array.from({ length: WAVE_COUNT }, () => new THREE.Vector4());
        this.waveB = Array.from({ length: WAVE_COUNT }, () => new THREE.Vector4());
        this.waveC = Array.from({ length: WAVE_COUNT }, () => new THREE.Vector2());
        this.ampNorm = 1.0;
        this.buildSpectrum();

        this.initGPGPU();
        // Near-shore shallow-water layer (fixed patch at the world origin)
        this.swe = new ShallowWater(renderer);
        this.sweTexel = 1.0 / this.swe.res;
        this.createMesh();
        this.createSkirt();
        this.createSpraySystem();
    }

    /**
     * Build the three-band spectrum into the uniform arrays.
     *
     * Band layout (index / fade weight):
     *   0-2   macro swell  (fade 0: survives to the horizon, narrow spread)
     *   3-8   wind sea     (fade grows with frequency, spread widens)
     *   9-11  chop         (fade 1: near-field only; geometry share reduced,
     *                       the rest of the detail lives in fragment normals)
     *
     * waveA = (dir.x, dir.y, wavenumber k, angular speed omega)
     * waveB = (amplitude, phase, distance-fade weight, horizontal factor Q)
     * waveC = (crest sharpening exponent, unused)
     */
    buildSpectrum() {
        const storm = THREE.MathUtils.clamp((config.windSpeed - 5.0) / 30.0, 0, 1);
        const windRad = config.windDirection * Math.PI / 180;
        const speedScale = 1.0 + storm * 0.5;
        const layers = [];

        // Macro swell: long period, low steepness, direction spread within ~10 degrees
        const swellLambda = [1.0, 1.75, 0.8];
        const swellDirOff = [-0.14, 0.09, -0.05];
        const swellSteepMul = [1.0, 0.7, 0.55];
        const swellSteep = (0.05 + 0.18 * storm) * config.swellAmount;
        for (let j = 0; j < SWELL_COUNT; j++) {
            layers.push({
                wavelength: Math.max(config.swellWavelength * swellLambda[j], 40.0),
                dir: windRad + swellDirOff[j],
                steep: swellSteep * swellSteepMul[j],
                ampScale: 1.0,
                fade: 0.0,
                sharp: 1.0 + storm * 0.8,
            });
        }

        // Wind sea: mid frequencies, spread widens towards short waves
        // (long waves stay close to the wind direction, as in real spectra)
        const windLambda0 = 18.0 + Math.pow(config.windSpeed, 1.45);
        const windSteep0 = (0.06 + 0.13 * storm) * config.choppiness * config.windSeaAmount;
        for (let j = 0; j < 6; j++) {
            const spread = 0.18 + 0.55 * (j / 5);
            layers.push({
                wavelength: Math.max(windLambda0 * Math.pow(0.62, j), 9.0),
                dir: windRad + DIR_RAND[SWELL_COUNT + j] * spread,
                steep: windSteep0 * Math.pow(0.9, j),
                ampScale: 1.0,
                fade: 0.55 + 0.45 * (j / 5),
                sharp: 1.0 + storm * 2.5,
            });
        }

        // Chop: high frequencies with reduced geometric share
        const chopLambda = [7.5, 4.8, 3.1];
        for (let j = 0; j < 3; j++) {
            layers.push({
                wavelength: chopLambda[j],
                dir: windRad + DIR_RAND[9 + j] * 0.9,
                steep: 0.16 * config.choppiness * config.chopAmount,
                ampScale: 0.35,
                fade: 1.0,
                sharp: 1.0 + storm * 3.0,
            });
        }

        // Normalise the summed horizontal factor so stacked layers
        // cannot self-intersect at the crests
        let qSum = 0;
        layers.forEach(l => {
            l.steep = Math.min(l.steep, 0.85);
            qSum += l.steep;
        });
        const qScale = qSum > 1.1 ? 1.1 / qSum : 1.0;

        layers.forEach((l, i) => {
            const k = 2 * Math.PI / l.wavelength;
            const c = Math.sqrt(9.8 / k);
            const amp = (l.steep / k) * l.ampScale;
            this.waveA[i].set(Math.cos(l.dir), Math.sin(l.dir), k, k * c * speedScale);
            this.waveB[i].set(amp, PHASE_RAND[i], l.fade, l.steep * qScale);
            this.waveC[i].set(l.sharp, 0);
        });

        // Reference amplitude for shading ramps (typical crest height)
        this.ampNorm = Math.max(
            (this.waveB[0].x + this.waveB[1].x + this.waveB[2].x) * 0.7 + this.waveB[3].x * 0.5,
            0.5
        );
    }

    initGPGPU() {
        this.gpuCompute = new GPUComputationRenderer(config.gridResolution, config.gridResolution, this.renderer);

        if (this.renderer.capabilities.isWebGL2 === false) {
            throw new Error('WebGL 2.0 is required');
        }

        const displacementTexture = this.gpuCompute.createTexture();
        const foamTexture = this.gpuCompute.createTexture();

        // Variable: Physics
        this.physicsVariable = this.gpuCompute.addVariable('texturePhysics',
            this.getWaveComputeShader(),
            displacementTexture
        );

        // Variable: Foam
        this.foamVariable = this.gpuCompute.addVariable('textureFoam',
            this.getFoamAccumulateShader(),
            foamTexture
        );

        this.gpuCompute.setVariableDependencies(this.physicsVariable, []);
        this.gpuCompute.setVariableDependencies(this.foamVariable, [this.foamVariable, this.physicsVariable]);

        const error = this.gpuCompute.init();
        if (error !== null) {
            console.error('GPGPU Init Error:', error);
        }

        this.setupUniforms();
    }

    setupUniforms() {
        this.timeUniform = { value: 0 };

        // === Physics Uniforms ===
        const physUniforms = this.physicsVariable.material.uniforms;
        physUniforms['uTime'] = this.timeUniform;
        physUniforms['uGridSize'] = { value: this.gridSize };
        physUniforms['uGridOffset'] = { value: new THREE.Vector2(0, 0) };
        physUniforms['uCrestSkew'] = { value: config.crestSkew };
        physUniforms['uFadeStart'] = { value: config.detailFadeStart * this.gridSize };
        physUniforms['uWaveA'] = { value: this.waveA };
        physUniforms['uWaveB'] = { value: this.waveB };
        physUniforms['uWaveC'] = { value: this.waveC };

        // === Foam Uniforms ===
        const foamUniforms = this.foamVariable.material.uniforms;
        foamUniforms['uTime'] = this.timeUniform;
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

        this.physUniforms = physUniforms;
        this.foamUniforms = foamUniforms;
    }

    getWaveComputeShader() {
        return `
            uniform float uTime;
            uniform float uGridSize;
            uniform vec2 uGridOffset;
            uniform float uCrestSkew;
            uniform float uFadeStart;
            uniform vec4 uWaveA[${WAVE_COUNT}];
            uniform vec4 uWaveB[${WAVE_COUNT}];
            uniform vec2 uWaveC[${WAVE_COUNT}];

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                // Absolute world coordinates: the wave field is a function of
                // world position, so the grid can translate without seams
                vec2 worldPos = (uv - 0.5) * uGridSize + uGridOffset;

                // Distance from the grid centre (~camera). Short bands fade
                // with distance so the far field keeps only the coherent
                // macro swell rhythm, and the outer rim matches the skirt.
                float r = length((uv - 0.5) * uGridSize);
                float halfSize = uGridSize * 0.5;
                float distFade = smoothstep(uFadeStart, halfSize * 0.95, r);
                float edgeCut = smoothstep(halfSize * 0.8, halfSize * 0.95, r);

                // Gentle domain warp for the short bands only; the swell
                // keeps its direction coherence
                vec2 warp = vec2(
                    sin(worldPos.y * 0.005 + uTime * 0.1),
                    cos(worldPos.x * 0.005 + uTime * 0.1)
                ) * 12.0;

                vec3 displacement = vec3(0.0);
                float jacobianSum = 0.0;

                for (int i = 0; i < ${WAVE_COUNT}; i++) {
                    vec2 d = uWaveA[i].xy;
                    float k = uWaveA[i].z;
                    float omega = uWaveA[i].w;
                    float amp = uWaveB[i].x;
                    float phase = uWaveB[i].y;
                    float fadeAmt = uWaveB[i].z;
                    float q = uWaveB[i].w;
                    float sharp = uWaveC[i].x;

                    float atten = 1.0 - distFade * fadeAmt;
                    if (fadeAmt > 0.001) atten *= 1.0 - edgeCut;
                    if (atten < 0.002) continue;

                    vec2 p = worldPos + warp * fadeAmt;
                    float f = k * dot(d, p) - omega * uTime + phase;
                    // Phase warp: compresses the front face and stretches the
                    // back, so crests lean forward along the travel direction
                    f -= uCrestSkew * cos(f);

                    float sinf = sin(f);
                    float cosf = cos(f);

                    // Cusp waveform: flat troughs, sharp crests
                    float baseShape = 1.0 - abs(sinf);
                    float shaped = pow(baseShape, sharp);

                    float a = amp * atten;
                    // Subtract approximate waveform mean to keep sea level balanced
                    displacement.y += (shaped - 0.3) * a;
                    // Full Gerstner horizontal displacement: sharpens crests
                    // and hollows the leaning front faces
                    displacement.x += d.x * cosf * q * a;
                    displacement.z += d.y * cosf * q * a;

                    // Foam source estimate: crest compression, weighted
                    // towards the short bands (swell alone should not foam)
                    jacobianSum += q * shaped * (0.35 + 0.65 * fadeAmt) * atten;
                }

                float jacobian = 1.0 - jacobianSum * 1.2;
                gl_FragColor = vec4(displacement, jacobian);
            }
        `;
    }

    getFoamAccumulateShader() {
        return `
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

                // 1. Read current physics state
                vec4 physics = texture2D(texturePhysics, uv);
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
                uCrestSkew: { value: config.crestSkew },
                uWaveA: { value: this.waveA.slice(0, SWELL_COUNT) },
                uWaveB: { value: this.waveB.slice(0, SWELL_COUNT) },
                uWaveC: { value: this.waveC.slice(0, SWELL_COUNT) },
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
            uniform float uTime;
            uniform float uCrestSkew;
            uniform vec4 uWaveA[${SWELL_COUNT}];
            uniform vec4 uWaveB[${SWELL_COUNT}];
            uniform vec2 uWaveC[${SWELL_COUNT}];

            varying vec3 vWorldPosition;
            varying vec3 vNormal;
            varying float vDisplacement;

            // Same cusp Gerstner formulation as the physics pass, swell band only
            vec3 swellOffset(vec2 p) {
                vec3 off = vec3(0.0);
                for (int i = 0; i < ${SWELL_COUNT}; i++) {
                    vec2 d = uWaveA[i].xy;
                    float k = uWaveA[i].z;
                    float omega = uWaveA[i].w;
                    float amp = uWaveB[i].x;
                    float phase = uWaveB[i].y;
                    float q = uWaveB[i].w;
                    float sharp = uWaveC[i].x;

                    float f = k * dot(d, p) - omega * uTime + phase;
                    f -= uCrestSkew * cos(f);
                    float shaped = pow(1.0 - abs(sin(f)), sharp);
                    float cosf = cos(f);

                    off.y += (shaped - 0.3) * amp;
                    off.x += d.x * cosf * q * amp;
                    off.z += d.y * cosf * q * amp;
                }
                return off;
            }

            void main() {
                vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
                vec3 off = swellOffset(base.xz);

                // Finite-difference normal from the swell field
                float e = 4.0;
                vec3 offX = swellOffset(base.xz + vec2(e, 0.0));
                vec3 offZ = swellOffset(base.xz + vec2(0.0, e));
                vec3 tx = vec3(e, 0.0, 0.0) + (offX - off);
                vec3 tz = vec3(0.0, 0.0, e) + (offZ - off);
                vNormal = normalize(cross(tz, tx));

                vec3 wp = base + off;
                vWorldPosition = wp;
                vDisplacement = off.y;
                gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
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

    createSpraySystem() {
        const particleCount = 10000;
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(particleCount * 3);
        const randoms = new Float32Array(particleCount);

        for (let i = 0; i < particleCount; i++) {
            // Particles distributed across the entire grid
            positions[i * 3] = (Math.random() - 0.5) * this.gridSize;
            positions[i * 3 + 1] = 0;
            positions[i * 3 + 2] = (Math.random() - 0.5) * this.gridSize;
            randoms[i] = Math.random();
        }

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aRandom', new THREE.BufferAttribute(randoms, 1));

        const material = new THREE.ShaderMaterial({
            uniforms: {
                uDisplacementMap: { value: null },
                uFoamTexture: { value: null },
                uTime: { value: 0 },
                uGridSize: { value: this.gridSize }
            },
            vertexShader: `
                uniform sampler2D uDisplacementMap;
                uniform sampler2D uFoamTexture;
                uniform float uGridSize;
                uniform float uTime;
                attribute float aRandom;
                varying float vAlpha;

                void main() {
                    vec3 pos = position;
                    // Grid-local coordinates map to texture UV; the Points
                    // object itself follows the grid offset
                    vec2 uv = (pos.xz / uGridSize) + 0.5;

                    vec4 disp = texture2D(uDisplacementMap, uv);
                    pos.x += disp.x;
                    pos.y += disp.y;
                    pos.z += disp.z;

                    float foam = texture2D(uFoamTexture, uv).r;
                    float foamIntensity = smoothstep(0.6, 0.9, foam);

                    float life = fract(uTime * 0.8 + aRandom);
                    pos.y += sin(life * 3.14) * 8.0 * foamIntensity;

                    vAlpha = foamIntensity * (1.0 - life);

                    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                    gl_PointSize = 6.0 * (300.0 / -mvPosition.z);
                }
            `,
            fragmentShader: `
                varying float vAlpha;
                void main() {
                    if (vAlpha < 0.05) discard;
                    vec2 coord = gl_PointCoord - 0.5;
                    if(length(coord) > 0.5) discard;
                    gl_FragColor = vec4(1.0, 1.0, 1.0, vAlpha * 0.5);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        this.spraySystem = new THREE.Points(geometry, material);
        this.spraySystem.position.set(0, config.seaLevel, 0); // snapped to camera each frame
        this.spraySystem.frustumCulled = false;
        this.scene.add(this.spraySystem);
    }

    update(deltaTime, camera) {
        this.timeUniform.value = config.time;

        // Rebuild the spectrum from config (cheap: 12 layers on the CPU).
        // The skirt shares the same Vector4 instances for its swell band.
        this.buildSpectrum();

        // Snap the grid to the camera in whole-patch steps so vertex world
        // positions stay stable (no swimming)
        const patch = getters.patchSize;
        const offsetX = Math.floor(camera.position.x / patch) * patch;
        const offsetZ = Math.floor(camera.position.z / patch) * patch;

        if (this.physUniforms) {
            this.physUniforms.uGridOffset.value.set(offsetX, offsetZ);
            this.physUniforms.uCrestSkew.value = config.crestSkew;
            this.physUniforms.uFadeStart.value = config.detailFadeStart * this.gridSize;
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
        this.spraySystem.position.set(offsetX, config.seaLevel, offsetZ);
        this.skirt.position.set(offsetX, config.seaLevel - 0.4, offsetZ);

        this.gpuCompute.compute();

        const physicsTexture = this.gpuCompute.getCurrentRenderTarget(this.physicsVariable).texture;
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
            s.uCrestSkew.value = config.crestSkew;
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

        if (this.spraySystem) {
            this.spraySystem.material.uniforms.uDisplacementMap.value = physicsTexture;
            this.spraySystem.material.uniforms.uFoamTexture.value = foamTexture;
            this.spraySystem.material.uniforms.uTime.value = config.time;
        }
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.scene.remove(this.skirt);
        this.scene.remove(this.spraySystem);
        if (this.swe) this.swe.dispose();
    }
}
