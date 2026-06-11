/**
 * ui.js - User Interface for Ocean Simulation
 *
 * Uses the custom parameter panel (panel.js, migrated from sea_surface).
 * All controls bind directly to the reactive config Proxy, so writes from
 * the panel propagate to the simulation automatically. Every change is
 * persisted to localStorage; "Refresh" reloads to apply grid-level changes,
 * "Reset" clears saved values and restores defaults.
 */

import { config, saveConfigToStorage, clearSavedConfig } from './config.js';
import { createPanel, updateParamValue, refreshPanel, destroyPanel } from './panel.js';

export class UI {
    constructor() {
        this.stats = { time: '0.00', fps: '60' };

        this.panel = createPanel({
            title: 'Ocean Simulation',
            sections: [
                {
                    title: 'Geometry',
                    target: config,
                    params: [
                        { key: 'seaLevel', label: 'Sea Level', type: 'number', min: -10, max: 50, step: 1, description: 'Height of the water plane' },
                        { key: 'seabedLevel', label: 'Seabed Depth', type: 'number', min: -500, max: -10, step: 5, description: 'Height of the seabed plane below the water' },
                    ],
                },
                {
                    title: 'Wave Physics',
                    target: config,
                    params: [
                        { key: 'windSpeed', label: 'Wind Speed', type: 'number', min: 1, max: 50, step: 0.5, description: 'Drives wavelength, storm intensity and peak sharpening' },
                        { key: 'windDirection', label: 'Wind Direction', type: 'number', min: 0, max: 360, step: 1, description: 'Main wave travel direction in degrees' },
                        { key: 'choppiness', label: 'Choppiness', type: 'number', min: 0, max: 3, step: 0.05, description: 'Wave steepness multiplier; higher = sharper crests' },
                        { key: 'timeScale', label: 'Time Scale', type: 'number', min: 0, max: 3, step: 0.05, description: 'Simulation speed; 0 freezes the ocean' },
                    ],
                },
                {
                    title: 'Foam',
                    target: config,
                    params: [
                        { key: 'foamThreshold', label: 'Threshold', type: 'number', min: 0, max: 1, step: 0.01, description: 'Jacobian threshold for foam generation; higher = more foam' },
                        { key: 'foamDecay', label: 'Decay', type: 'number', min: 0.8, max: 0.999, step: 0.001, description: 'Per-frame foam persistence; closer to 1 = longer-lived foam' },
                    ],
                },
                {
                    title: 'Visual',
                    target: config,
                    params: [
                        { key: 'waterColorDeep', label: 'Deep Color', type: 'color', description: 'Water color in deep areas / wave troughs' },
                        { key: 'waterColorShallow', label: 'Shallow Color', type: 'color', description: 'Water color in shallow areas / wave crests' },
                    ],
                },
                {
                    title: 'Sun Position',
                    path: 'sunPosition',
                    target: config.sunPosition,
                    params: [
                        { key: 'x', label: 'Sun X', type: 'number', min: -500, max: 500, step: 10 },
                        { key: 'y', label: 'Sun Y', type: 'number', min: 0, max: 500, step: 10 },
                        { key: 'z', label: 'Sun Z', type: 'number', min: -500, max: 500, step: 10 },
                    ],
                },
                {
                    title: 'Grid (refresh to apply)',
                    target: config,
                    params: [
                        { key: 'gridSize', label: 'Grid Size', type: 'number', min: 250, max: 4000, step: 50, description: 'World size of the ocean patch in meters; applied after Refresh' },
                        { key: 'gridResolution', label: 'Resolution', type: 'number', min: 64, max: 1024, step: 64, description: 'GPGPU texture and mesh resolution; applied after Refresh' },
                    ],
                },
                {
                    title: 'Presets',
                    target: {},
                    params: [
                        { key: 'calm', label: 'Calm Seas', type: 'button', onClick: () => this.applyPreset({ windSpeed: 5, choppiness: 0.9, foamThreshold: 0.5 }) },
                        { key: 'stormy', label: 'Stormy Seas', type: 'button', onClick: () => this.applyPreset({ windSpeed: 20, choppiness: 1.4, foamThreshold: 0.85 }) },
                        { key: 'randomize', label: 'Randomize', type: 'button', onClick: () => this.applyPreset({
                            windSpeed: 5 + Math.random() * 30,
                            choppiness: 0.5 + Math.random() * 2,
                            windDirection: Math.random() * 360,
                            foamThreshold: 0.2 + Math.random() * 0.5,
                        }) },
                    ],
                },
                {
                    title: 'Info',
                    path: 'stats',
                    target: this.stats,
                    params: [
                        { key: 'time', label: 'Sim Time', type: 'info' },
                        { key: 'fps', label: 'FPS', type: 'info' },
                    ],
                },
            ],
            buttons: [
                {
                    label: 'Refresh',
                    primary: true,
                    onClick: () => {
                        saveConfigToStorage();
                        location.reload();
                    },
                },
                {
                    label: 'Reset',
                    onClick: () => {
                        clearSavedConfig();
                        location.reload();
                    },
                },
            ],
            onChange: () => saveConfigToStorage(),
        });
    }

    /**
     * Write a set of config values, then sync panel and storage
     */
    applyPreset(values) {
        Object.assign(config, values);
        refreshPanel();
        saveConfigToStorage();
    }

    /**
     * Update info displays (called each frame)
     */
    update(fps) {
        updateParamValue('stats.time', config.time.toFixed(2));
        updateParamValue('stats.fps', fps.toFixed(0));
    }

    /**
     * Refresh panel to reflect current config values
     */
    refresh() {
        refreshPanel();
    }

    /**
     * Dispose UI
     */
    dispose() {
        destroyPanel();
    }
}
