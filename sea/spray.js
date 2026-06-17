/**
 * spray.js - Wave-strike particle layer (L3)
 *
 * A GPGPU particle pool that throws spray when the open-ocean swell (L0)
 * strikes the reefs scattered through the near-shore water. The pool is a
 * fixed-size grid of particles held in two ping-ponged textures:
 *   texturePosition = vec4(x, y, z, life)     world position + remaining life
 *   textureVelocity = vec4(vx, vy, vz, seed)  velocity + a constant identity seed
 *
 * Reefs are passed to the solver as a small uniform array of spheres
 * (centre.xyz + waterline radius). A dead particle attempts to respawn each
 * frame: it samples a point on a reef's waterline, reads the L0 surface there,
 * and erupts when a crest is breaking against that face. Live particles are
 * pure ballistic motion (gravity + light drag) and die when they fall back
 * below the surface, splatting a dab of foam into the shared foam texture.
 *
 * Coupling is strictly one-way (L0 -> particles); the pool never feeds back
 * into the height field beyond the cosmetic foam splat.
 *
 * Version: 0.2.0
 */

import * as THREE from 'three';
import { GPUComputationRenderer } from 'three/addons/misc/GPUComputationRenderer.js';
import { config } from './config.js';

// Upper bound on reef spheres uploaded to the spawn shader
const OBSTACLE_MAX = 8;

// Fixed reef layout in deep near-shore water on the wave-incoming side.
// (centre x, centre z, waterline radius, visual height above the bed)
const REEFS = [
    { x: -130, z: 20, r: 13, top: 7 },
    { x: -95, z: 95, r: 10, top: 6 },
    { x: -150, z: -60, r: 11, top: 6 },
];

export class SpraySystem {
    constructor(renderer, scene) {
        this.renderer = renderer;
        this.scene = scene;
        this.res = Math.max(32, Math.floor(config.sprayPoolRes));
        this.count = this.res * this.res;

        // Reef spheres as a padded uniform array
        this.obstacles = Array.from({ length: OBSTACLE_MAX }, () => new THREE.Vector4());
        this.obstacleCount = Math.min(REEFS.length, OBSTACLE_MAX);
        for (let i = 0; i < this.obstacleCount; i++) {
            const o = REEFS[i];
            this.obstacles[i].set(o.x, config.seaLevel, o.z, o.r);
        }

        this.waveDir = new THREE.Vector2(1, 0);

        this.initGPGPU();
        this.createObstacleMeshes();
        this.createBillboards();
        this.createFoamSplat();
    }

    initGPGPU() {
        this.gpu = new GPUComputationRenderer(this.res, this.res, this.renderer);

        const pos0 = this.gpu.createTexture();
        const vel0 = this.gpu.createTexture();
        this.seedTextures(pos0, vel0);

        this.posVar = this.gpu.addVariable('texturePosition', this.getPositionShader(), pos0);
        this.velVar = this.gpu.addVariable('textureVelocity', this.getVelocityShader(), vel0);

        this.gpu.setVariableDependencies(this.posVar, [this.posVar, this.velVar]);
        this.gpu.setVariableDependencies(this.velVar, [this.posVar, this.velVar]);

        const common = {
            uTime: { value: 0 },
            uDt: { value: 0 },
            uSeaLevel: { value: config.seaLevel },
            uGravity: { value: config.sprayGravity },
            uDrag: { value: 1.0 },
            uLife: { value: config.sprayLife },
            uBirthProb: { value: 0 },
            uSpawnThreshold: { value: config.spraySpawnThreshold },
            uHorizBurst: { value: 0 },
            uVertBurst: { value: 0 },
            uWaveDir: { value: this.waveDir },
            uObstacles: { value: this.obstacles },
            uObstacleCount: { value: this.obstacleCount },
            uDispMap: { value: null },
            uDispPrev: { value: null },
            uGridOffset: { value: new THREE.Vector2(0, 0) },
            uGridSize: { value: config.gridSize },
        };

        const pu = this.posVar.material.uniforms;
        const vu = this.velVar.material.uniforms;
        for (const key in common) {
            pu[key] = common[key];
            vu[key] = common[key];
        }
        this.uniforms = common;

        const error = this.gpu.init();
        if (error !== null) {
            console.error('Spray GPGPU Init Error:', error);
        }
    }

    /**
     * Start every particle dead (life < 0) and parked, with a fixed identity
     * seed so respawn decisions are stable and decorrelated per particle.
     */
    seedTextures(posTex, velTex) {
        const p = posTex.image.data;
        const v = velTex.image.data;
        for (let i = 0; i < this.count; i++) {
            const idx = i * 4;
            p[idx] = 0.0;
            p[idx + 1] = config.seaLevel - 50.0;
            p[idx + 2] = 0.0;
            p[idx + 3] = -1.0;             // dead
            v[idx] = 0.0;
            v[idx + 1] = 0.0;
            v[idx + 2] = 0.0;
            v[idx + 3] = Math.random();    // identity seed
        }
        posTex.needsUpdate = true;
        velTex.needsUpdate = true;
    }

    /**
     * Shared GLSL: hashes, the L0 surface lookup and the spawn decision.
     * Injected verbatim into both compute shaders so the position and
     * velocity passes make an identical respawn decision each frame.
     */
    commonGLSL() {
        return `
            uniform float uTime;
            uniform float uDt;
            uniform float uSeaLevel;
            uniform float uGravity;
            uniform float uDrag;
            uniform float uLife;
            uniform float uBirthProb;
            uniform float uSpawnThreshold;
            uniform float uHorizBurst;
            uniform float uVertBurst;
            uniform vec2 uWaveDir;
            uniform vec4 uObstacles[${OBSTACLE_MAX}];
            uniform float uObstacleCount;
            uniform sampler2D uDispMap;
            uniform sampler2D uDispPrev;
            uniform vec2 uGridOffset;
            uniform float uGridSize;

            float hash11(float p) {
                p = fract(p * 0.1031);
                p *= p + 33.33;
                p *= p + p;
                return fract(p);
            }

            // World-space height of the L0 surface, or sea level outside the grid
            float surfaceY(vec2 worldXZ) {
                vec2 uv = (worldXZ - uGridOffset) / uGridSize + 0.5;
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return uSeaLevel;
                return uSeaLevel + texture2D(uDispMap, uv).y;
            }

            vec4 surfaceData(vec2 worldXZ) {
                vec2 uv = (worldXZ - uGridOffset) / uGridSize + 0.5;
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec4(0.0, 0.0, 0.0, 1.0);
                return texture2D(uDispMap, uv);
            }

            vec2 surfaceVelocity(vec2 worldXZ) {
                vec2 uv = (worldXZ - uGridOffset) / uGridSize + 0.5;
                if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return vec2(0.0);
                vec3 now = texture2D(uDispMap, uv).xyz;
                vec3 prev = texture2D(uDispPrev, uv).xyz;
                return (now.xz - prev.xz) / max(uDt, 1e-4);
            }

            // Try to respawn a dead particle. Returns true and fills the out
            // params when a crest is breaking against a chosen reef face.
            bool spawn(float seed, out vec3 oPos, out vec3 oVel, out float oLife) {
                oPos = vec3(0.0);
                oVel = vec3(0.0);
                oLife = -1.0;
                if (uObstacleCount < 0.5) return false;

                // Per-frame Bernoulli trial; both passes read the same uTime
                if (hash11(seed * 13.137 + uTime * 53.0) > uBirthProb) return false;

                // Pick a reef (dynamic index via loop-select for GLSL ES 1.00)
                float pick = hash11(seed * 7.31 + uTime * 31.0) * uObstacleCount;
                int oi = int(min(floor(pick), uObstacleCount - 1.0));
                vec4 ob = vec4(0.0);
                for (int k = 0; k < ${OBSTACLE_MAX}; k++) {
                    if (k == oi) ob = uObstacles[k];
                }

                // Bias the spawn point toward the incoming-wave face of the reef
                float baseAng = atan(-uWaveDir.y, -uWaveDir.x);
                float ang = baseAng + (hash11(seed * 3.17 + uTime * 22.0) - 0.5) * 2.6;
                vec2 dir = vec2(cos(ang), sin(ang));
                vec2 hitXZ = vec2(ob.x, ob.z) + dir * ob.w;

                vec4 surf = surfaceData(hitXZ);
                float strength = surf.y;
                if (strength < uSpawnThreshold) return false;
                vec2 waveVel = surfaceVelocity(hitXZ) + uWaveDir * max(strength, 0.0) * 0.5;
                float impact = dot(waveVel, -dir);
                float compression = clamp(1.0 - surf.a, 0.0, 1.5);
                if (impact < 0.25 || compression < 0.03) return false;

                float energy = clamp((strength / max(uSpawnThreshold, 0.2)) * (0.7 + impact * 0.16) * (0.8 + compression), 0.5, 3.2);
                float up = 0.6 + 0.8 * hash11(seed * 5.9 + uTime * 17.0);
                vec3 jitter = vec3(
                    hash11(seed * 9.1 + uTime * 12.0) - 0.5,
                    hash11(seed * 4.3 + uTime * 14.0) * 0.4,
                    hash11(seed * 6.7 + uTime * 19.0) - 0.5
                );
                vec3 incoming = vec3(waveVel.x, 0.0, waveVel.y);
                vec3 normal = normalize(vec3(dir.x, 0.0, dir.y));
                vec3 reflected = reflect(incoming, normal);
                oVel = (normalize(reflected + normal * uHorizBurst * 0.35) * uHorizBurst
                        + vec3(0.0, 1.0, 0.0) * uVertBurst * up) * energy
                        + jitter * uHorizBurst * 0.4;
                oPos = vec3(hitXZ.x, uSeaLevel + strength * 0.6, hitXZ.y);
                oLife = uLife * (0.6 + 0.4 * hash11(seed * 2.7 + uTime * 9.0));
                return true;
            }
        `;
    }

    getPositionShader() {
        return `
            ${this.commonGLSL()}

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec4 posData = texture2D(texturePosition, uv);
                vec4 velData = texture2D(textureVelocity, uv);
                vec3 pos = posData.xyz;
                float life = posData.w;
                float seed = velData.w;

                if (life > 0.0) {
                    pos += velData.xyz * uDt;
                    life -= uDt;
                    // Fall back below the surface -> die where it lands
                    if (pos.y < surfaceY(pos.xz)) life = -1.0;
                    gl_FragColor = vec4(pos, life);
                    return;
                }

                vec3 nPos, nVel;
                float nLife;
                if (spawn(seed, nPos, nVel, nLife)) {
                    gl_FragColor = vec4(nPos, nLife);
                } else {
                    gl_FragColor = vec4(pos, -1.0);
                }
            }
        `;
    }

    getVelocityShader() {
        return `
            ${this.commonGLSL()}

            void main() {
                vec2 uv = gl_FragCoord.xy / resolution.xy;
                vec4 posData = texture2D(texturePosition, uv);
                vec4 velData = texture2D(textureVelocity, uv);
                vec3 vel = velData.xyz;
                float life = posData.w;
                float seed = velData.w;

                if (life > 0.0) {
                    vel.y -= uGravity * uDt;
                    vel *= uDrag;
                    gl_FragColor = vec4(vel, seed);
                    return;
                }

                vec3 nPos, nVel;
                float nLife;
                if (spawn(seed, nPos, nVel, nLife)) {
                    gl_FragColor = vec4(nVel, seed);
                } else {
                    gl_FragColor = vec4(vel, seed);
                }
            }
        `;
    }

    /**
     * Per-particle reference attribute: the texel each vertex reads from.
     */
    buildReferenceGeometry() {
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(this.count * 3);
        const refs = new Float32Array(this.count * 2);
        for (let j = 0; j < this.res; j++) {
            for (let i = 0; i < this.res; i++) {
                const n = j * this.res + i;
                refs[n * 2] = (i + 0.5) / this.res;
                refs[n * 2 + 1] = (j + 0.5) / this.res;
            }
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aRef', new THREE.BufferAttribute(refs, 2));
        return geometry;
    }

    createBillboards() {
        const geometry = this.buildReferenceGeometry();

        this.billboardMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uPosTex: { value: null },
                uLife: { value: config.sprayLife },
                uSize: { value: config.spraySize },
            },
            vertexShader: `
                uniform sampler2D uPosTex;
                uniform float uLife;
                uniform float uSize;
                attribute vec2 aRef;
                varying float vAlpha;

                void main() {
                    vec4 p = texture2D(uPosTex, aRef);
                    float life = p.w;
                    if (life <= 0.0) {
                        // Park dead particles at the camera clip origin
                        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                        vAlpha = 0.0;
                        return;
                    }
                    float lifeT = clamp(life / uLife, 0.0, 1.0);
                    // Fade in on birth, fade out on death
                    vAlpha = smoothstep(0.0, 0.15, lifeT) * smoothstep(0.0, 0.4, 1.0 - lifeT) + lifeT * 0.4;
                    vAlpha = clamp(vAlpha, 0.0, 1.0);

                    vec4 mvPosition = modelViewMatrix * vec4(p.xyz, 1.0);
                    gl_Position = projectionMatrix * mvPosition;
                    gl_PointSize = uSize * (300.0 / -mvPosition.z) * (0.6 + 0.4 * lifeT);
                }
            `,
            fragmentShader: `
                varying float vAlpha;
                void main() {
                    if (vAlpha < 0.02) discard;
                    vec2 c = gl_PointCoord - 0.5;
                    float d = length(c);
                    if (d > 0.5) discard;
                    float soft = smoothstep(0.5, 0.05, d);
                    gl_FragColor = vec4(vec3(1.0, 1.0, 1.0), vAlpha * soft * 0.8);
                }
            `,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        this.billboards = new THREE.Points(geometry, this.billboardMaterial);
        this.billboards.frustumCulled = false;
        this.scene.add(this.billboards);
    }

    /**
     * Foam splat pass: live particles near the surface stamp a soft dab into
     * the shared foam texture (grid UV space), so spray leaves a wake where it
     * takes off and lands. Rendered separately into the foam render target.
     */
    createFoamSplat() {
        const geometry = this.buildReferenceGeometry();

        this.splatMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uPosTex: { value: null },
                uSeaLevel: { value: config.seaLevel },
                uGridOffset: { value: new THREE.Vector2(0, 0) },
                uGridSize: { value: config.gridSize },
                uStrength: { value: config.sprayFoam },
            },
            vertexShader: `
                uniform sampler2D uPosTex;
                uniform float uSeaLevel;
                uniform vec2 uGridOffset;
                uniform float uGridSize;
                attribute vec2 aRef;
                varying float vWeight;

                void main() {
                    vec4 p = texture2D(uPosTex, aRef);
                    float life = p.w;
                    if (life <= 0.0) {
                        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                        vWeight = 0.0;
                        return;
                    }
                    // Strongest splat as the particle nears the water
                    float dy = p.y - uSeaLevel;
                    vWeight = clamp(1.0 - dy / 6.0, 0.0, 1.0);

                    vec2 uv = (p.xz - uGridOffset) / uGridSize + 0.5;
                    gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
                    gl_PointSize = 3.0;
                }
            `,
            fragmentShader: `
                uniform float uStrength;
                varying float vWeight;
                void main() {
                    if (vWeight < 0.02) discard;
                    vec2 c = gl_PointCoord - 0.5;
                    float soft = smoothstep(0.5, 0.0, length(c));
                    gl_FragColor = vec4(vWeight * soft * uStrength * 0.06, 0.0, 0.0, 1.0);
                }
            `,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        this.splatPoints = new THREE.Points(geometry, this.splatMaterial);
        this.splatPoints.frustumCulled = false;
        // Rendered manually into the foam RT, with its own ortho camera
        this.splatScene = new THREE.Scene();
        this.splatScene.add(this.splatPoints);
        this.splatCamera = new THREE.Camera();
    }

    createObstacleMeshes() {
        this.reefGroup = new THREE.Group();
        const material = new THREE.MeshStandardMaterial({
            color: 0x4a4640,
            roughness: 1.0,
            metalness: 0.0,
            flatShading: true,
        });
        for (let i = 0; i < this.obstacleCount; i++) {
            const o = REEFS[i];
            const height = o.top + 19.0;
            const geometry = new THREE.ConeGeometry(o.r * 1.25, height, 7, 1);
            // Roughen the silhouette so it reads as rock, not a tent
            const pos = geometry.attributes.position;
            for (let k = 0; k < pos.count; k++) {
                const y = pos.getY(k);
                if (y < height * 0.4) {
                    pos.setX(k, pos.getX(k) * (0.8 + 0.4 * Math.random()));
                    pos.setZ(k, pos.getZ(k) * (0.8 + 0.4 * Math.random()));
                }
            }
            geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, material);
            mesh.position.set(o.x, config.seaLevel + o.top - height * 0.5, o.z);
            mesh.rotation.y = Math.random() * Math.PI;
            this.reefGroup.add(mesh);
        }
        this.scene.add(this.reefGroup);
    }

    /**
     * Advance the pool one frame and stamp foam splats into the foam target.
     *
     * @param dt          frame delta (seconds, already time-scaled)
     * @param dispMap     L0 displacement texture
     * @param dispPrev    previous L0 displacement texture
     * @param gridOffset  current camera-snapped grid origin
     * @param gridSize    grid world size
     * @param foamTarget  WebGLRenderTarget backing the shared foam texture
     */
    update(dt, dispMap, dispPrev, gridOffset, gridSize, foamTarget) {
        if (!config.sprayEnabled) {
            this.billboards.visible = false;
            this.reefGroup.visible = true;
            return;
        }
        this.billboards.visible = true;

        const windRad = config.windDirection * Math.PI / 180;
        this.waveDir.set(Math.cos(windRad), Math.sin(windRad));

        const u = this.uniforms;
        u.uTime.value = config.time;
        u.uDt.value = dt;
        u.uSeaLevel.value = config.seaLevel;
        u.uGravity.value = config.sprayGravity;
        u.uDrag.value = Math.exp(-config.sprayDrag * dt);
        u.uLife.value = config.sprayLife;
        u.uBirthProb.value = Math.min(1.0, config.sprayBirthRate * dt);
        u.uSpawnThreshold.value = config.spraySpawnThreshold;
        u.uHorizBurst.value = config.spraySpeed;
        u.uVertBurst.value = config.spraySpeed * 1.6;
        u.uObstacleCount.value = this.obstacleCount;
        u.uDispMap.value = dispMap;
        u.uDispPrev.value = dispPrev || dispMap;
        u.uGridOffset.value.copy(gridOffset);
        u.uGridSize.value = gridSize;
        for (let i = 0; i < this.obstacleCount; i++) {
            this.obstacles[i].y = config.seaLevel;
        }

        this.gpu.compute();
        const posTexture = this.gpu.getCurrentRenderTarget(this.posVar).texture;

        // Billboards
        const bu = this.billboardMaterial.uniforms;
        bu.uPosTex.value = posTexture;
        bu.uLife.value = config.sprayLife;
        bu.uSize.value = config.spraySize;

        // Foam splat into the shared foam target (additive, no clear)
        if (foamTarget) {
            const su = this.splatMaterial.uniforms;
            su.uPosTex.value = posTexture;
            su.uSeaLevel.value = config.seaLevel;
            su.uGridOffset.value.copy(gridOffset);
            su.uGridSize.value = gridSize;
            su.uStrength.value = config.sprayFoam;

            const prevTarget = this.renderer.getRenderTarget();
            const prevAutoClear = this.renderer.autoClear;
            this.renderer.autoClear = false;
            this.renderer.setRenderTarget(foamTarget);
            this.renderer.render(this.splatScene, this.splatCamera);
            this.renderer.setRenderTarget(prevTarget);
            this.renderer.autoClear = prevAutoClear;
        }
    }

    dispose() {
        if (this.gpu) this.gpu.dispose();
        if (this.billboards) {
            this.billboards.geometry.dispose();
            this.billboardMaterial.dispose();
            this.scene.remove(this.billboards);
        }
        if (this.splatPoints) {
            this.splatPoints.geometry.dispose();
            this.splatMaterial.dispose();
        }
        if (this.reefGroup) {
            this.reefGroup.traverse((c) => {
                if (c.geometry) c.geometry.dispose();
            });
            this.scene.remove(this.reefGroup);
        }
    }
}
