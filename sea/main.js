/**
 * main.js - Native WebGPU sea application
 *
 * Version: 1.0.1
 */

import { WebGpuWaterEngine } from './webgpu-water.js?v=1.0.1';
import { WATER_PROFILES } from './water-profiles.js';
import { config, subscribe, updateTime } from './config.js';
import { UI } from './ui.js';

class FreeCamera {
    constructor(canvas) {
        this.canvas = canvas;
        this.position = { x: 0, y: 12, z: 96 };
        this.yaw = 0;
        this.pitch = -0.14;
        this.keys = new Set();
        this.dragging = false;
        this.last = { x: 0, y: 0 };
        window.addEventListener('keydown', (event) => this.keys.add(event.code));
        window.addEventListener('keyup', (event) => this.keys.delete(event.code));
        canvas.addEventListener('pointerdown', (event) => {
            this.dragging = true;
            this.last = { x: event.clientX, y: event.clientY };
            canvas.setPointerCapture(event.pointerId);
        });
        canvas.addEventListener('pointerup', () => { this.dragging = false; });
        canvas.addEventListener('pointermove', (event) => this.look(event));
        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            this.position.y = Math.max(-14, Math.min(120, this.position.y + event.deltaY * 0.03));
        }, { passive: false });
        canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    look(event) {
        if (!this.dragging) return;
        const dx = event.clientX - this.last.x;
        const dy = event.clientY - this.last.y;
        this.last = { x: event.clientX, y: event.clientY };
        this.yaw += dx * config.cameraLookSpeed;
        this.pitch = Math.max(-1.48, Math.min(1.48, this.pitch - dy * config.cameraLookSpeed));
    }

    update(deltaTime) {
        const forwardX = Math.sin(this.yaw);
        const forwardZ = -Math.cos(this.yaw);
        const rightX = Math.cos(this.yaw);
        const rightZ = Math.sin(this.yaw);
        const speed = config.cameraMoveSpeed * deltaTime;
        if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) { this.position.x += forwardX * speed; this.position.z += forwardZ * speed; }
        if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) { this.position.x -= forwardX * speed; this.position.z -= forwardZ * speed; }
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) { this.position.x -= rightX * speed; this.position.z -= rightZ * speed; }
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) { this.position.x += rightX * speed; this.position.z += rightZ * speed; }
    }
}

class SeaApplication {
    async init() {
        const container = document.getElementById('canvas-container');
        const loading = document.getElementById('loading');
        if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a current Chromium or Safari browser with hardware acceleration enabled.');
        this.canvas = document.createElement('canvas');
        this.canvas.setAttribute('aria-label', 'Native WebGPU ocean simulation');
        container.replaceChildren(this.canvas);
        this.camera = new FreeCamera(this.canvas);
        this.ui = new UI();
        const profile = this.profile();
        this.engine = new WebGpuWaterEngine(this.canvas, {
            mode: 'optimized', view: config.webgpuView, scene: config.webgpuScene,
            meshResolution: profile.meshResolution, simulationResolution: profile.simulationResolution,
            renderScale: config.webgpuRenderScale, fixedTime: this.fixedTime(),
        });
        this.bindConfig();
        await this.engine.init();
        loading.remove();
        this.lastTime = performance.now();
        requestAnimationFrame((time) => this.tick(time));
    }

    profile() { return WATER_PROFILES.find((profile) => profile.id === config.webgpuQuality) || WATER_PROFILES[0]; }
    fixedTime() { return config.webgpuFixedTime >= 0 ? config.webgpuFixedTime : undefined; }

    bindConfig() {
        subscribe('webgpuScene', (value) => this.engine.setScene(value));
        subscribe('webgpuView', (value) => this.engine.setView(value));
        subscribe('webgpuRenderScale', (value) => this.engine.setRenderScale(value));
        subscribe('webgpuFixedTime', () => { this.engine.options.fixedTime = this.fixedTime(); });
        subscribe('webgpuQuality', () => {
            const profile = this.profile();
            this.engine.setMeshResolution(profile.meshResolution);
            this.engine.setSimulationResolution(profile.simulationResolution);
            this.engine.setRenderScale(config.webgpuRenderScale);
        });
    }

    tick(now) {
        const deltaTime = Math.min((now - this.lastTime) / 1000, 0.05);
        this.lastTime = now;
        updateTime(deltaTime);
        this.camera.update(deltaTime);
        this.engine.setCameraPose({ ...this.camera.position, yaw: this.camera.yaw, pitch: this.camera.pitch });
        this.ui.update(this.engine.getMetrics());
        requestAnimationFrame((time) => this.tick(time));
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const application = new SeaApplication();
        window.app = application;
        await application.init();
    } catch (error) {
        const loading = document.getElementById('loading');
        loading.textContent = error.message;
        loading.style.color = '#ff8585';
        console.error(error);
    }
});
