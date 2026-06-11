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
 * Version: 0.3.0
 */

import * as THREE from 'three';
import { config } from './config.js';
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
            },
        });
        
        this.mesh = new THREE.Mesh(geometry, this.material);
        // Vertex shader outputs absolute height (uSeabedLevel included),
        // so the mesh itself stays at y = 0
        this.mesh.position.set(0, 0, 0);
        this.mesh.frustumCulled = false;
        
        this.scene.add(this.mesh);
    }
    
    update(deltaTime, camera) {
        // Update uniforms
        this.material.uniforms.uTime.value = config.time;
        this.material.uniforms.uSeabedLevel.value = config.seabedLevel;
        this.material.uniforms.uCameraPosition.value.copy(camera.position);

        // Follow the camera, snapped to whole segments so vertices keep
        // stable world positions
        const patch = config.gridSize / this.segments;
        this.mesh.position.x = Math.floor(camera.position.x / patch) * patch;
        this.mesh.position.z = Math.floor(camera.position.z / patch) * patch;
    }
    
    dispose() {
        if (this.mesh) {
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.scene.remove(this.mesh);
        }
    }
}