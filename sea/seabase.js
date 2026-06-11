/**
 * seabase.js - Static Seabed
 * Stationary large-area seabed terrain
 */

import * as THREE from 'three';
import { config } from './config.js';

export class Seabed {
    constructor(scene) {
        this.scene = scene;
        this.createMesh();
    }
    
    createMesh() {
        // Create seabed matching (or exceeding) the ocean size
        const size = config.gridSize; 
        const geometry = new THREE.PlaneGeometry(
            size,
            size,
            256,
            256
        );
        geometry.rotateX(-Math.PI / 2);
        
        const vertexShader = document.getElementById('seabed-vertex').textContent;
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
        this.mesh.position.set(0, config.seabedLevel, 0); // fixed position
        this.mesh.frustumCulled = false;
        
        this.scene.add(this.mesh);
    }
    
    update(deltaTime, camera) {
        // Update uniforms
        this.material.uniforms.uTime.value = config.time;
        this.material.uniforms.uSeabedLevel.value = config.seabedLevel;
        this.material.uniforms.uCameraPosition.value.copy(camera.position);
        
        // Camera-following code removed
        // this.mesh.position.x = ... (deleted)
    }
    
    dispose() {
        if (this.mesh) {
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
            this.scene.remove(this.mesh);
        }
    }
}