/**
 * config.js - Central State Management
 *
 * Uses Proxy-based reactive state management.
 * All modules read from this single source of truth.
 *
 * Version: 0.6.0
 */

import * as THREE from 'three';

// Default configuration
const defaultConfig = {
    // Geometry settings
    seaLevel: 0.0,
    seabedLevel: -200.0,
    
    // Wave physics (FFT spectral ocean parameters)
    windDirection: 15.0, // Degrees (0-360)
    windSpeed: 22.0,     // Drives the Phillips spectrum shape (peak wavelength)
    choppiness: 1.7,     // Horizontal displacement scale; pinches crests into sharp cusps (>~2.0 over-folds)
    timeScale: 0.75,

    // FFT spectrum
    waveHeight: 2.4,        // RMS surface height in metres (master wave-height gain)
    chopAmount: 1.0,        // High-frequency normal detail injected in the fragment shader
    fftPatchSize: 420.0,    // Physical side of the periodic FFT tile (m); longest wave it can hold
    fftResolution: 256,     // FFT grid is fftResolution^2 (power of two; refresh to apply)

    // Foam physics
    foamDecay: 0.96,
    foamThreshold: 0.8, // Range: 0.6 - 0.9 (Higher = more foam generated but higher cutoff for display)
    foamGrowth: 2.0,

    // Stylised shading
    sssStrength: 1.6,        // Directional translucency through backlit crests
    sssColor: 0x1ba692,      // Colour transmitted through thin wave tops
    specPower: 40.0,         // Specular exponent; lower = wider highlight band
    specIntensity: 0.55,     // Specular brightness
    glitterStrength: 0.55,   // Sun glitter micro-sparkle on top of the wide highlight
    foamLacingScale: 0.06,   // World-space frequency of residual foam lacing pattern

    // Atmosphere
    skyColorZenith: 0x5d86ad,
    skyColorHorizon: 0xbccdd6,
    fogDensity: 0.0011,

    // Near-shore shallow water (L2): a fixed patch at the world origin with a
    // beach and an isolated tide pool (see terrain.js / swe.js)
    sweEnabled: true,
    sweSubsteps: 4,        // Pipe-model substeps per frame (CFL stability)
    sweDrag: 0.6,          // Velocity damping; higher = water settles faster
    sweCoupling: 1.0,      // Open-ocean swell injected at the deep boundary
    sweFoam: 1.2,          // Shore wash / breaker foam strength
    sweResolution: 256,    // SWE grid resolution (refresh to apply)

    // Wave-strike spray (L3): GPGPU particle pool thrown off the reefs when
    // the open-ocean swell breaks against them (see spray.js)
    sprayEnabled: true,
    sprayBirthRate: 8.0,        // Respawn attempts per dead particle per second
    spraySpawnThreshold: 1.2,   // Crest height over sea level needed to erupt (m)
    spraySpeed: 9.0,            // Burst speed at birth (horizontal; vertical x1.6)
    sprayGravity: 22.0,         // Downward acceleration on airborne droplets
    sprayDrag: 0.25,           // Air drag; higher = droplets slow faster
    sprayLife: 1.6,            // Maximum droplet lifetime (seconds)
    spraySize: 7.0,            // Billboard point size
    sprayFoam: 1.0,            // Foam left where spray takes off and lands
    sprayPoolRes: 128,         // Particle pool is sprayPoolRes^2 (refresh to apply)

    // Visual settings
    waterColorDeep: 0x0d4d5e,
    waterColorShallow: 0x3fa8b0,
    sunPosition: { x: 100, y: 200, z: 100 },
    
    // Grid settings
    gridSize: 1000,
    gridResolution: 512,
    
    // Camera settings
    cameraStartHeight: 100,
    cameraMinHeight: 1.0,
    cameraMoveSpeed: 200.0,
    cameraPanSpeed: 200.0,
    cameraLookSpeed: 0.002,
    
    // Internal state (not exposed to UI)
    time: 0,
    deltaTime: 0,
};

// Listeners for reactive updates
const listeners = new Map();

// The reactive config object
// (deep clone so nested objects like sunPosition don't share references with defaults)
export const config = new Proxy(structuredClone(defaultConfig), {
    set(target, property, value) {
        const oldValue = target[property];
        target[property] = value;
        
        // Notify listeners
        if (listeners.has(property)) {
            const callbacks = listeners.get(property);
            callbacks.forEach(cb => cb(value, oldValue));
        }
        
        return true;
    },
    
    get(target, property) {
        return target[property];
    }
});

/**
 * Subscribe to config changes
 * @param {string} property - Config property to watch
 * @param {Function} callback - Callback(newValue, oldValue)
 * @returns {Function} Unsubscribe function
 */
export function subscribe(property, callback) {
    if (!listeners.has(property)) {
        listeners.set(property, new Set());
    }
    listeners.get(property).add(callback);
    
    return () => {
        const callbacks = listeners.get(property);
        if (callbacks) {
            callbacks.delete(callback);
        }
    };
}

/**
 * Batch update multiple config values
 * @param {Object} updates - Object with property:value pairs
 */
export function batchUpdate(updates) {
    Object.entries(updates).forEach(([key, value]) => {
        config[key] = value;
    });
}

/**
 * Reset config to defaults
 */
export function resetConfig() {
    Object.keys(defaultConfig).forEach(key => {
        if (key !== 'time' && key !== 'deltaTime') {
            config[key] = structuredClone(defaultConfig[key]);
        }
    });
}

// === localStorage persistence (migrated from sea_surface) ===

const STORAGE_KEY = 'sea_gpu_config';

/**
 * Save current config to localStorage (time/deltaTime excluded)
 */
export function saveConfigToStorage() {
    try {
        const out = {};
        Object.keys(defaultConfig).forEach(key => {
            if (key !== 'time' && key !== 'deltaTime') {
                out[key] = config[key];
            }
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (e) {
        console.warn('Failed to save config:', e);
    }
}

/**
 * Remove saved config so defaults apply on next load
 */
export function clearSavedConfig() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        console.warn('Failed to clear saved config:', e);
    }
}

// Apply saved overrides on startup. Runs at module load, before other
// modules attach listeners, so no spurious notifications fire.
(function loadSavedConfig() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return;
        const parsed = JSON.parse(saved);
        Object.keys(parsed).forEach(key => {
            if (key in defaultConfig && key !== 'time' && key !== 'deltaTime') {
                config[key] = parsed[key];
            }
        });
    } catch (e) {
        console.warn('Failed to load saved config:', e);
    }
})();

/**
 * Update time-related config values
 * Call this each frame
 * @param {number} deltaTime - Time since last frame in seconds
 */
export function updateTime(deltaTime) {
    config.deltaTime = deltaTime;
    config.time += deltaTime * config.timeScale;
}

/**
 * Get uniform-compatible object for shaders
 * This creates a snapshot of config values suitable for uniforms
 */
export function getUniforms() {
    return {
        uSeaLevel: { value: config.seaLevel },
        uSeabedLevel: { value: config.seabedLevel },
        uChoppiness: { value: config.choppiness },
        uTime: { value: config.time },
        uWindSpeed: { value: config.windSpeed },
        uWindDirection: { value: getters.windVector },
        uWaterColorDeep: { value: getters.waterColorDeepColor },
        uWaterColorShallow: { value: getters.waterColorShallowColor },
        uSunPosition: { value: getters.sunPositionVector },
        uFoamThreshold: { value: config.foamThreshold },
        uCameraPosition: { value: new THREE.Vector3() },
    };
}

// Export default config for reference
export { defaultConfig };

// Convenience getters
export const getters = {
    get effectiveSeabedLevel() {
        return config.seabedLevel;
    },
    
    get cameraStartY() {
        return config.seaLevel + config.cameraStartHeight;
    },
    
    get gridWorldSize() {
        return config.gridSize;
    },
    
    get patchSize() {
        return config.gridSize / config.gridResolution;
    },

    get windVector() {
        const rad = config.windDirection * Math.PI / 180;
        return new THREE.Vector2(Math.cos(rad), Math.sin(rad));
    },

    get waterColorDeepColor() {
        return new THREE.Color(config.waterColorDeep);
    },

    get waterColorShallowColor() {
        return new THREE.Color(config.waterColorShallow);
    },

    get sunPositionVector() {
        return new THREE.Vector3(config.sunPosition.x, config.sunPosition.y, config.sunPosition.z);
    },

    get sssColorColor() {
        return new THREE.Color(config.sssColor);
    },

    get skyZenithColor() {
        return new THREE.Color(config.skyColorZenith);
    },

    get skyHorizonColor() {
        return new THREE.Color(config.skyColorHorizon);
    }
};
