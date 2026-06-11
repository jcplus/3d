/**
 * main.js - Main Application Entry Point
 * * Responsibilities:
 * - WebGLRenderer initialization
 * - Scene setup (sky dome gradient unified with the ocean fog colour)
 * - Custom camera controller (Standard First-Person WASD)
 * - Render loop
 * - Input event handling
 *
 * Version: 0.3.0
 */

import * as THREE from 'three';
import { Ocean } from './sea.js';
import { Seabed } from './seabase.js';
import { UI } from './ui.js';
import { config, updateTime, getters } from './config.js';

/**
 * Custom Camera Controller
 * WASD for movement, Mouse for look, Scroll for zoom
 */
class CameraController {
    constructor(camera, domElement) {
        this.camera = camera;
        this.domElement = domElement;
        
        // State
        this.position = new THREE.Vector3(0, getters.cameraStartY, 200);
        this.yaw = 0;      // Horizontal rotation
        this.pitch = -Math.PI / 6;  // Vertical rotation (-30 degrees)
        
        // Input state
        this.keys = {
            w: false, a: false, s: false, d: false,
            ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false,
        };
        this.mouseDown = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        
        // Movement settings
        this.moveSpeed = config.cameraMoveSpeed;
        this.lookSpeed = config.cameraLookSpeed;
        
        // Initialize camera rotation immediately
        this.updateRotation();
        
        // Bind events
        this.bindEvents();
    }
    
    bindEvents() {
        const element = this.domElement;
        
        // Keyboard (attach to window for reliable focus)
        window.addEventListener('keydown', (e) => this.onKeyDown(e));
        window.addEventListener('keyup', (e) => this.onKeyUp(e));
        
        // Mouse
        element.addEventListener('mousedown', (e) => this.onMouseDown(e));
        window.addEventListener('mouseup', () => this.onMouseUp());
        window.addEventListener('mousemove', (e) => this.onMouseMove(e));
        element.addEventListener('wheel', (e) => this.onWheel(e));
        
        // Prevent context menu
        element.addEventListener('contextmenu', (e) => e.preventDefault());
        
        // Focus for keyboard input
        element.tabIndex = 0;
        element.focus();
    }
    
    onKeyDown(event) {
        switch(event.code) {
            case 'KeyW': this.keys.w = true; break;
            case 'KeyA': this.keys.a = true; break;
            case 'KeyS': this.keys.s = true; break;
            case 'KeyD': this.keys.d = true; break;
            case 'ArrowUp': this.keys.ArrowUp = true; break;
            case 'ArrowDown': this.keys.ArrowDown = true; break;
            case 'ArrowLeft': this.keys.ArrowLeft = true; break;
            case 'ArrowRight': this.keys.ArrowRight = true; break;
        }
    }
    
    onKeyUp(event) {
        switch(event.code) {
            case 'KeyW': this.keys.w = false; break;
            case 'KeyA': this.keys.a = false; break;
            case 'KeyS': this.keys.s = false; break;
            case 'KeyD': this.keys.d = false; break;
            case 'ArrowUp': this.keys.ArrowUp = false; break;
            case 'ArrowDown': this.keys.ArrowDown = false; break;
            case 'ArrowLeft': this.keys.ArrowLeft = false; break;
            case 'ArrowRight': this.keys.ArrowRight = false; break;
        }
    }
    
    onMouseDown(event) {
        if (event.button === 0 || event.button === 2) { // Left or right click
            this.mouseDown = true;
            this.lastMouseX = event.clientX;
            this.lastMouseY = event.clientY;
        }
    }
    
    onMouseUp() {
        this.mouseDown = false;
    }
    
    onMouseMove(event) {
        if (!this.mouseDown) return;
        
        const deltaX = event.clientX - this.lastMouseX;
        const deltaY = event.clientY - this.lastMouseY;
        
        this.yaw -= deltaX * this.lookSpeed;
        this.pitch -= deltaY * this.lookSpeed;
        
        // Clamp pitch to prevent camera flip
        this.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this.pitch));
        
        this.lastMouseX = event.clientX;
        this.lastMouseY = event.clientY;
        
        // Update rotation immediately for smooth look
        this.updateRotation();
    }
    
    onWheel(event) {
        // Adjust camera height directly
        // Scroll UP (negative deltaY) -> Lower height (Zoom In)
        // Scroll DOWN (positive deltaY) -> Raise height (Zoom Out)
        const heightSpeed = 0.1;
        this.position.y += event.deltaY * heightSpeed;
    }
    
    updateRotation() {
        // Calculate rotation quaternion from yaw and pitch
        const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
        const pitchQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch);
        
        this.camera.quaternion.copy(yawQuat).multiply(pitchQuat);
    }
    
    update(deltaTime) {
        const speed = this.moveSpeed * deltaTime;
        const panSpeed = config.cameraPanSpeed * deltaTime;
        
        // === Camera-relative movement based on current view direction ===
        
        // 1. Get the camera's current forward direction
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0; // lock to horizontal plane, prevent flying through terrain
        forward.normalize();
        
        // 2. Get the camera's current right direction
        // Cross product: Forward × Up = Right
        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0));
        right.normalize();
        
        // 3. Apply movement
        if (this.keys.w || this.keys.ArrowUp) {
            this.position.addScaledVector(forward, speed);
        }
        if (this.keys.s || this.keys.ArrowDown) {
            this.position.addScaledVector(forward, -speed);
        }
        if (this.keys.a || this.keys.ArrowLeft) {
            this.position.addScaledVector(right, -panSpeed);
        }
        if (this.keys.d || this.keys.ArrowRight) {
            this.position.addScaledVector(right, panSpeed);
        }
        
        // Enforce minimum height
        const minHeight = config.seaLevel + config.cameraMinHeight;
        if (this.position.y < minHeight) {
            this.position.y = minHeight;
        }
        
        // Apply position
        this.camera.position.copy(this.position);
    }
    
    getPosition() {
        return this.position;
    }
}

/**
 * Main Application Class
 */
class OceanSimulation {
    constructor() {
        this.container = document.getElementById('canvas-container');
        this.loadingElement = document.getElementById('loading');
        
        // FPS calculation
        this.lastTime = 0;
        this.frameCount = 0;
        this.fps = 60;
        this.fpsUpdateInterval = 0.5; // Update FPS display every 0.5 seconds
        this.lastFpsUpdate = 0;
        
        this.init();
    }
    
    init() {
        try {
            this.setupRenderer();
            this.setupScene();
            this.setupLights();
            this.setupCamera();
            this.setupComponents();
            this.setupUI();
            this.setupResizeHandler();
            
            // Hide loading
            this.loadingElement.style.opacity = '0';
            setTimeout(() => this.loadingElement.remove(), 500);
            
            // Start loop
            this.animate(0);
            
        } catch (error) {
            console.error('Initialization error:', error);
            this.loadingElement.textContent = 'Error: ' + error.message;
            this.loadingElement.style.color = 'red';
        }
    }
    
    setupRenderer() {
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
        });
        
        // Enable WebGL 2.0 features
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setClearColor(config.skyColorHorizon, 1);
        
        this.container.appendChild(this.renderer.domElement);
        
        // Check WebGL 2.0 support
        const gl = this.renderer.getContext();
        if (!gl instanceof WebGL2RenderingContext) {
            throw new Error('WebGL 2.0 is required for this simulation');
        }
    }
    
    setupScene() {
        this.scene = new THREE.Scene();
        this.setupSky();
    }

    /**
     * Sky dome: horizon-to-zenith gradient plus a soft sun glow. The horizon
     * colour doubles as the fog colour in the water shaders, so the ocean
     * dissolves into the sky with no visible boundary.
     */
    setupSky() {
        const geometry = new THREE.SphereGeometry(9200, 32, 16);
        this.skyMaterial = new THREE.ShaderMaterial({
            side: THREE.BackSide,
            depthWrite: false,
            uniforms: {
                uHorizonColor: { value: getters.skyHorizonColor },
                uZenithColor: { value: getters.skyZenithColor },
                uSunPosition: { value: getters.sunPositionVector },
            },
            vertexShader: `
                varying vec3 vDir;
                void main() {
                    vDir = normalize(position);
                    // Render behind everything regardless of dome radius
                    vec4 pos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                    gl_Position = pos.xyww;
                }
            `,
            fragmentShader: `
                uniform vec3 uHorizonColor;
                uniform vec3 uZenithColor;
                uniform vec3 uSunPosition;
                varying vec3 vDir;
                void main() {
                    vec3 dir = normalize(vDir);
                    // Below the horizon stays at the horizon colour so the
                    // ocean fog always finds a matching backdrop
                    float t = pow(clamp(dir.y, 0.0, 1.0), 0.55);
                    vec3 sky = mix(uHorizonColor, uZenithColor, t);

                    // Soft sun disc and wide glow
                    vec3 sunDir = normalize(uSunPosition);
                    float sunDot = max(dot(dir, sunDir), 0.0);
                    sky += vec3(1.0, 0.95, 0.85) * pow(sunDot, 350.0) * 1.2;
                    sky += vec3(1.0, 0.97, 0.9) * pow(sunDot, 12.0) * 0.18;

                    gl_FragColor = vec4(sky, 1.0);
                }
            `,
        });
        this.sky = new THREE.Mesh(geometry, this.skyMaterial);
        this.sky.frustumCulled = false;
        this.scene.add(this.sky);
    }
    
    setupLights() {
        // Ambient light
        const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
        this.scene.add(ambientLight);
        
        // Directional light (sun)
        this.sunLight = new THREE.DirectionalLight(0xffffff, 1.5);
        this.sunLight.position.copy(config.sunPosition);
        this.sunLight.castShadow = true;
        this.scene.add(this.sunLight);
        
        // Hemisphere light for sky/ground bounce
        const hemiLight = new THREE.HemisphereLight(0x87CEEB, 0x006994, 0.5);
        this.scene.add(hemiLight);
    }
    
    setupCamera() {
        // Use perspective camera
        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            10000
        );
        
        // Setup custom controller
        this.controller = new CameraController(this.camera, this.container);
    }
    
    setupComponents() {
        // Create seabed first (renders behind)
        this.seabed = new Seabed(this.scene);
        
        // Create ocean
        this.ocean = new Ocean(this.renderer, this.scene);
    }
    
    setupUI() {
        this.ui = new UI();
    }
    
    setupResizeHandler() {
        window.addEventListener('resize', () => {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }
    
    animate(currentTime) {
        requestAnimationFrame((time) => this.animate(time));
        
        // Calculate delta time
        const deltaTime = Math.min((currentTime - this.lastTime) / 1000, 0.1); // Cap at 100ms
        this.lastTime = currentTime;
        
        // Update FPS
        this.frameCount++;
        if (currentTime - this.lastFpsUpdate > this.fpsUpdateInterval * 1000) {
            this.fps = this.frameCount / ((currentTime - this.lastFpsUpdate) / 1000);
            this.frameCount = 0;
            this.lastFpsUpdate = currentTime;
        }
        
        // Update config time
        updateTime(deltaTime);
        
        // Update sun position
        this.sunLight.position.copy(config.sunPosition);

        // Keep the sky dome centred on the camera and in sync with config
        this.sky.position.copy(this.camera.position);
        this.skyMaterial.uniforms.uHorizonColor.value.setHex(config.skyColorHorizon);
        this.skyMaterial.uniforms.uZenithColor.value.setHex(config.skyColorZenith);
        this.skyMaterial.uniforms.uSunPosition.value.copy(config.sunPosition);
        this.renderer.setClearColor(config.skyColorHorizon, 1);

        // Update controller
        this.controller.update(deltaTime);
        
        // Update ocean and seabed
        // Note: camera no longer needs to be passed to ocean.update unless reflections are needed
        this.ocean.update(deltaTime, this.camera);
        this.seabed.update(deltaTime, this.camera);
        
        // Update UI
        this.ui.update(this.fps);
        
        // Render
        this.renderer.render(this.scene, this.camera);
    }
    
    dispose() {
        this.ocean.dispose();
        this.seabed.dispose();
        this.ui.dispose();
        this.renderer.dispose();
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.app = new OceanSimulation();
});

// Handle page unload
window.addEventListener('beforeunload', () => {
    if (window.app) {
        window.app.dispose();
    }
});