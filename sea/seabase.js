/**
 * seabase.js - Seabed
 * Large-area seabed terrain following the camera in whole-patch steps.
 * Terrain height is a function of world coordinates, so the mesh can
 * translate freely without the terrain swimming.
 *
 * The terrain field comes from terrain.js (shared with the shallow-water
 * solver), injected into the vertex shader at the //__TERRAIN__ marker so the
 * rendered floor and the simulated bed are identical.
 *
 * The floor reads as infinite: a dense near plane carries the near-shore
 * detail while a coarse far skirt ring (exponential radial spacing) extends
 * the deep flat bed out to the horizon, both fading into the sky-horizon
 * colour exactly as the ocean surface does.
 *
 * Version: 0.4.0
 */

import * as THREE from 'three';
import { config, getters } from './config.js';
import { TERRAIN_GLSL } from './terrain.js';

export class Seabed {
    constructor(scene) {
        this.scene = scene;
        this.createMesh();
    }
    
    createMesh() {
        // Create seabed matching (or exceeding) the ocean size
        const size = config.gridSize;
        // Denser than the open-sea need so the near-shore beach and tide pool
        // read cleanly through the seabed mesh
        this.segments = 320;
        const geometry = new THREE.PlaneGeometry(
            size,
            size,
            this.segments,
            this.segments
        );
        geometry.rotateX(-Math.PI / 2);
        
        const vertexShader = document.getElementById('seabed-vertex')
            .textContent.replace('//__TERRAIN__', TERRAIN_GLSL);
        const fragmentShader = document.getElementById('seabed-fragment').textContent;
        
        this.material = new THREE.ShaderMaterial({
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            uniforms: {
                uSeabedLevel: { value: config.seabedLevel },
                uCameraPosition: { value: new THREE.Vector3() },
                uSeaLevel: { value: config.seaLevel },
                uTime: { value: 0 },
                uSkyHorizon: { value: getters.skyHorizonColor },
                uFogDensity: { value: config.fogDensity },
            },
        });

        this.mesh = new THREE.Mesh(geometry, this.material);
        // Vertex shader outputs absolute height (uSeabedLevel included),
        // so the mesh itself stays at y = 0
        this.mesh.position.set(0, 0, 0);
        this.mesh.frustumCulled = false;

        this.scene.add(this.mesh);

        this.createSkirt();
    }

    /**
     * Far-field skirt: a camera-following ring from the near plane's edge out
     * to the horizon, carrying the deep flat bed (beyond the near-shore disc
     * terrainHeight relaxes to the deep floor, so the seam matches). Radial
     * vertex spacing grows exponentially: dense at the seam, coarse where the
     * fog owns the image. The deep floor is near-flat, so the coarse far rings
     * cost nothing visually.
     */
    createSkirt() {
        const inner = config.gridSize * 0.5 * 0.99;
        const outer = 9000;
        const geometry = new THREE.RingGeometry(inner, outer, 96, 24);
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

        // Share the near plane's material: same terrain field, same fog, same
        // uniforms, so the two meshes are visually one surface.
        this.skirt = new THREE.Mesh(geometry, this.material);
        // Sit slightly below the near plane so the overlap band never z-fights
        this.skirt.position.set(0, -0.4, 0);
        this.skirt.frustumCulled = false;
        this.scene.add(this.skirt);
    }

    update(deltaTime, camera) {
        // Update uniforms
        this.material.uniforms.uTime.value = config.time;
        this.material.uniforms.uSeabedLevel.value = config.seabedLevel;
        this.material.uniforms.uCameraPosition.value.copy(camera.position);
        this.material.uniforms.uFogDensity.value = config.fogDensity;

        // Follow the camera, snapped to whole segments so vertices keep
        // stable world positions
        const patch = config.gridSize / this.segments;
        const snapX = Math.floor(camera.position.x / patch) * patch;
        const snapZ = Math.floor(camera.position.z / patch) * patch;
        this.mesh.position.x = snapX;
        this.mesh.position.z = snapZ;
        this.skirt.position.x = snapX;
        this.skirt.position.z = snapZ;
    }

    dispose() {
        if (this.skirt) {
            this.skirt.geometry.dispose();
            this.scene.remove(this.skirt);
        }
        if (this.mesh) {
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.scene.remove(this.mesh);
        }
    }
}