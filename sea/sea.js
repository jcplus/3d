/**
 * sea.js - Static Large Ocean (No Infinite Scrolling)
 */

import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { config, getters } from './config.js';

export class Ocean {
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.gridSize = config.gridSize;
        
        this.initGPGPU();
        this.createMesh();
        this.createSpraySystem();
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
        physUniforms['uChoppiness'] = { value: config.choppiness };
        physUniforms['uWindDirection'] = { value: getters.windVector };
        physUniforms['uWindSpeed'] = { value: config.windSpeed };
        
        // === Foam Uniforms ===
        const foamUniforms = this.foamVariable.material.uniforms;
        foamUniforms['uTime'] = this.timeUniform;
        foamUniforms['uDecay'] = { value: config.foamDecay };
        foamUniforms['uThreshold'] = { value: config.foamThreshold };
        
        this.physUniforms = physUniforms;
        this.foamUniforms = foamUniforms;
    }
    
    getWaveComputeShader() {
        return `
            uniform float uTime;
            uniform float uGridSize; 
            uniform float uChoppiness;
            uniform vec2 uWindDirection;
            uniform float uWindSpeed;

            // Pseudo-random number
            vec2 hash22(vec2 p) {
                p = vec2(dot(p,vec2(127.1,311.7)), dot(p,vec2(269.5,183.3)));
                return -1.0 + 2.0*fract(sin(p)*43758.5453123);
            }

            // Rotation
            vec2 rotate(vec2 v, float a) {
                float s = sin(a);
                float c = cos(a);
                return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
            }

            void calculateGerstnerWave(
                vec2 worldPos, vec2 direction, float steepness, float wavelength, float speed, float phaseOffset, float stormIntensity, float waveIndex,
                inout vec3 positionOffset, inout float jacobianAccumulator
            ) {
                float k = 2.0 * 3.14159 / wavelength;
                float c = sqrt(9.8 / k);
                vec2 d = normalize(direction);
                
                float f = k * (dot(d, worldPos) - c * uTime * speed) + phaseOffset;
                float a = steepness / k; // base amplitude
                
                float sinf = sin(f);
                float cosf = cos(f);
                
                // Absolute cusp waveform
                // Uses 1.0 - abs(sin(x)) to produce mathematically sharp cusps (non-differentiable points)
                // Peaks reach 1.0 at f = 0, PI, 2π..., producing extremely sharp crests
                
                float baseShape = 1.0 - abs(sinf); 
                
                // Sharpening exponent: stronger wind = sharper crests (concave)
                // Range: 1.0 (linear triangle) → 3.0 (spiked cusp)
                float peakK = 1.0 + stormIntensity * 3.0; 
                
                float shaped = pow(baseShape, peakK);
                
                // Map amplitude: 
                // shaped ranges 0 (trough) to 1 (peak)
                // Troughs remain flat at the bottom, peaks are sharp and pointed
                float h = shaped * a; 
                
                // Horizontal displacement:
                // With this cusp algorithm, strong horizontal Gerstner displacement is not needed for peak formation
                // But keep slight horizontal displacement for liveliness, especially with large waves
                float horizontalFactor = cosf * steepness * 0.5; // halved to prevent clipping
                
                // High-frequency wave attenuation
                float weight = 1.0 - clamp(waveIndex / 10.0, 0.0, 1.0);
                weight = pow(weight, 2.0);
                
                positionOffset.x += d.x * horizontalFactor * a * weight;
                positionOffset.z += d.y * horizontalFactor * a * weight;
                
                // Vertical displacement: subtract mean height (0.3) to keep sea level balanced
                positionOffset.y += (h - 0.3 * a) * weight; 
                
                // Jacobian estimate (not required to be precise, only used for foam generation)
                jacobianAccumulator += steepness * k * baseShape * weight; 
            }

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec2 worldPos = (uv - 0.5) * uGridSize; 
                
                // Domain Warping
                vec2 warp = vec2(
                    sin(worldPos.y * 0.005 + uTime * 0.1),
                    cos(worldPos.x * 0.005 + uTime * 0.1)
                );
                worldPos += warp * 15.0;
                
                vec3 displacement = vec3(0.0);
                float jacobianSum = 0.0;
                
                float stormIntensity = clamp((uWindSpeed - 5.0) / 30.0, 0.0, 1.0);
                
                // Wavelength: exponential growth to simulate swell
                float wLen = 30.0 + pow(uWindSpeed, 1.55); 
                float steep = 0.25 * uChoppiness;
                vec2 mainWindDir = normalize(uWindDirection);
                float speed = 1.0 + stormIntensity * 0.6; 
                
                for(int i = 0; i < 12; i++) {
                    vec2 seed = vec2(float(i) * 13.0, float(i) * 7.0);
                    vec2 rnd = hash22(seed); 
                    
                    // Random direction
                    float chaos = 0.3 + float(i) * 0.1 + stormIntensity * 0.5; 
                    vec2 dir = rotate(mainWindDir, rnd.x * chaos * 2.5);
                    
                    // Random scale
                    float randomScale = 1.0 + rnd.y * 0.7 * stormIntensity;
                    
                    // Swell boost for large waves
                    float swellBoost = 1.0;
                    if (i < 3) swellBoost = 1.0 + stormIntensity * 1.8; 

                    // Steepness calculation (hard clamp at 0.85 to prevent flying vertices)
                    float currentSteepness = steep * randomScale * swellBoost;
                    currentSteepness *= (1.0 - float(i) * 0.06); 
                    currentSteepness = clamp(currentSteepness, 0.0, 0.85);

                    float phaseOffset = rnd.y * 100.0;

                    calculateGerstnerWave(
                        worldPos, dir, currentSteepness, wLen, speed, phaseOffset, stormIntensity, float(i),
                        displacement, jacobianSum
                    );
                    
                    // Iteration parameters
                    wLen *= 0.58;   
                    steep *= 0.82;
                    speed *= 1.07;
                }
                
                float jacobian = 1.0 - jacobianSum;
                gl_FragColor = vec4(displacement, jacobian);
            }
        `;
    }

    getFoamAccumulateShader() {
        return `
            uniform float uDecay;
            uniform float uThreshold;
            uniform float uTime;
            
            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                
                // 1. Read current physics state
                vec4 physics = texture2D(texturePhysics, uv);
                float jacobian = physics.a;
                
                // 2. Read previous frame foam
                // Since the grid is static, previous frame foam is at the same UV; no offset compensation needed
                float prevFoam = texture2D(textureFoam, uv).r;
                
                // 3. Generate and blend
                float generation = smoothstep(uThreshold, uThreshold - 0.2, jacobian);
                generation = clamp(generation, 0.0, 1.0) * 0.15;
                
                float foam = prevFoam * uDecay + generation;
                foam = clamp(foam, 0.0, 1.0);
                
                gl_FragColor = vec4(foam, 0.0, 0.0, 1.0);
            }
        `;
    }
    
    createMesh() {
        // Create static large grid
        const geometry = new THREE.PlaneGeometry(
            this.gridSize,
            this.gridSize,
            config.gridResolution,
            config.gridResolution
        );
        geometry.rotateX(-Math.PI / 2);
        
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
            },
            transparent: true,
        });
        
        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.position.set(0, config.seaLevel, 0); // fixed at origin
        // Ensure the mesh is not frustum-culled due to its size
        this.mesh.frustumCulled = false; 
        
        this.scene.add(this.mesh);
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
                    // UV calculation for static grid
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
        this.spraySystem.position.set(0, config.seaLevel, 0); // fixed position
        this.spraySystem.frustumCulled = false;
        this.scene.add(this.spraySystem);
    }
    
    update(deltaTime, camera) {
        this.timeUniform.value = config.time;
        
        if(this.physUniforms) {
            this.physUniforms.uChoppiness.value = config.choppiness;
            this.physUniforms.uWindSpeed.value = config.windSpeed;
            this.physUniforms.uWindDirection.value.copy(getters.windVector);
            this.foamUniforms.uDecay.value = config.foamDecay;
            this.foamUniforms.uThreshold.value = config.foamThreshold;
        }

        this.gpuCompute.compute();
        
        const physicsTexture = this.gpuCompute.getCurrentRenderTarget(this.physicsVariable).texture;
        const foamTexture = this.gpuCompute.getCurrentRenderTarget(this.foamVariable).texture;
        
        if (this.material) {
            this.material.uniforms.uDisplacementMap.value = physicsTexture;
            this.material.uniforms.uFoamTexture.value = foamTexture;
            this.material.uniforms.uCameraPosition.value.copy(camera.position);
            
            // Update visual uniforms
            this.material.uniforms.uWaterColorDeep.value.setHex(config.waterColorDeep);
            this.material.uniforms.uWaterColorShallow.value.setHex(config.waterColorShallow);
            this.material.uniforms.uSunPosition.value.copy(config.sunPosition);
        }
        
        if (this.spraySystem) {
            this.spraySystem.material.uniforms.uDisplacementMap.value = physicsTexture;
            this.spraySystem.material.uniforms.uFoamTexture.value = foamTexture;
        }
    }
    
    dispose() {
        this.scene.remove(this.mesh);
        this.scene.remove(this.spraySystem);
    }
}