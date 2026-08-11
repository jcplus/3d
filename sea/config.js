/**
 * config.js - Native WebGPU water configuration
 *
 * Version: 1.0.0
 */

const defaultConfig = {
    webgpuScene: 'shore',
    webgpuView: 'surface',
    webgpuQuality: 'balanced',
    webgpuRenderScale: 1.0,
    webgpuFixedTime: -1,
    cameraMoveSpeed: 42.0,
    cameraLookSpeed: 0.002,
    time: 0,
    deltaTime: 0,
};

const listeners = new Map();

export const config = new Proxy(structuredClone(defaultConfig), {
    set(target, property, value) {
        const oldValue = target[property];
        target[property] = value;
        listeners.get(property)?.forEach((callback) => callback(value, oldValue));
        return true;
    },
});

export function subscribe(property, callback) {
    if (!listeners.has(property)) listeners.set(property, new Set());
    listeners.get(property).add(callback);
    return () => listeners.get(property)?.delete(callback);
}

export function batchUpdate(updates) {
    Object.entries(updates).forEach(([key, value]) => { config[key] = value; });
}

const STORAGE_KEY = 'sea_webgpu_config';
const CONFIG_VERSION = '1.0.0';

export function saveConfigToStorage() {
    try {
        const out = { __version: CONFIG_VERSION };
        Object.keys(defaultConfig).forEach((key) => {
            if (key !== 'time' && key !== 'deltaTime') out[key] = config[key];
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (error) {
        console.warn('Failed to save configuration:', error);
    }
}

export function clearSavedConfig() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
        console.warn('Failed to clear configuration:', error);
    }
}

(function loadSavedConfig() {
    if (typeof localStorage === 'undefined') return;
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        if (saved?.__version !== CONFIG_VERSION) return;
        Object.keys(defaultConfig).forEach((key) => {
            if (key in saved && key !== 'time' && key !== 'deltaTime') config[key] = saved[key];
        });
    } catch (error) {
        console.warn('Failed to load configuration:', error);
    }
}());

export function updateTime(deltaTime) {
    config.deltaTime = deltaTime;
    config.time += deltaTime;
}

export { defaultConfig };
