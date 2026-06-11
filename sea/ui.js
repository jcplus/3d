/**
 * ui.js - User Interface for Ocean Simulation
 *
 * Uses the custom parameter panel (panel.js, migrated from sea_surface).
 * All controls bind directly to the reactive config Proxy, so writes from
 * the panel propagate to the simulation automatically. Every change is
 * persisted to localStorage; "Refresh" reloads to apply grid-level changes,
 * "Reset" clears saved values and restores defaults.
 *
 * Version: 0.8.0
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
                        { key: 'windSpeed', label: 'Wind Speed', type: 'number', min: 1, max: 50, step: 0.5, description: 'Drives the Phillips spectrum shape and peak wavelength' },
                        { key: 'windDirection', label: 'Wind Direction', type: 'number', min: 0, max: 360, step: 1, description: 'Main wave travel direction in degrees' },
                        { key: 'choppiness', label: 'Choppiness', type: 'number', min: 0, max: 3, step: 0.05, description: 'Horizontal displacement scale; higher = sharper crests, over-folds past ~2.0' },
                        { key: 'crestLean', label: 'Crest Lean', type: 'number', min: 0, max: 1.5, step: 0.05, description: 'Stylised forward-lean: pitches crests downwind for a steep front face' },
                        { key: 'timeScale', label: 'Time Scale', type: 'number', min: 0, max: 3, step: 0.05, description: 'Simulation speed; 0 freezes the ocean' },
                    ],
                },
                {
                    title: 'Spectrum (FFT)',
                    target: config,
                    params: [
                        { key: 'waveHeight', label: 'Wave Height', type: 'number', min: 0, max: 8, step: 0.1, description: 'RMS surface height in metres; the master wave-height gain' },
                        { key: 'swellDirSpread', label: 'Crest Length', type: 'number', min: 1, max: 16, step: 0.5, description: 'Directional spread exponent at the spectral peak; higher = longer, more parallel swell crests' },
                        { key: 'rippleSuppress', label: 'Ripple Cutoff', type: 'number', min: 0, max: 3, step: 0.05, description: 'Metre-scale spectrum rolloff; higher removes more of the uniform micro-chop' },
                        { key: 'chopAmount', label: 'Detail', type: 'number', min: 0, max: 2, step: 0.05, description: 'High-frequency normal detail injected in the fragment shader' },
                        { key: 'detailPatchiness', label: 'Detail Patchiness', type: 'number', min: 0, max: 1, step: 0.05, description: 'Breaks the detail ripples into drifting wind lanes with glassy gaps; 0 = uniform' },
                    ],
                },
                {
                    title: 'Foam',
                    target: config,
                    params: [
                        { key: 'foamThreshold', label: 'Coverage', type: 'number', min: 0, max: 1, step: 0.01, description: 'Foam coverage; drives both crest generation and the display cut, higher = more foam' },
                        { key: 'foamDecay', label: 'Decay', type: 'number', min: 0.8, max: 0.999, step: 0.001, description: 'Per-frame foam persistence; closer to 1 = longer-lived foam' },
                        { key: 'foamGrowth', label: 'Growth', type: 'number', min: 0.2, max: 6, step: 0.1, description: 'Foam accumulation rate at the crests' },
                    ],
                },
                {
                    title: 'Shading',
                    target: config,
                    params: [
                        { key: 'waterColorDeep', label: 'Trough Color', type: 'color', description: 'Palette swatch for wave troughs and dark patches' },
                        { key: 'waterColorMid', label: 'Base Color', type: 'color', description: 'Dominant palette swatch covering most of the surface' },
                        { key: 'waterColorShallow', label: 'Lit Color', type: 'color', description: 'Palette swatch for sunlit upper slopes' },
                        { key: 'waterColorShadow', label: 'Shadow Color', type: 'color', description: 'Desaturated blue the shadowed wave faces swing towards' },
                        { key: 'foamColor', label: 'Foam Color', type: 'color', description: 'Flat fill for whitecaps, lacing and the sun streak' },
                        { key: 'waterContrast', label: 'Shade Contrast', type: 'number', min: 0, max: 1, step: 0.05, description: 'How far shadowed flanks swing towards the shadow swatch' },
                        { key: 'sssColor', label: 'SSS Color', type: 'color', description: 'Near-white band backlit crests snap towards' },
                        { key: 'sssStrength', label: 'SSS Strength', type: 'number', min: 0, max: 4, step: 0.05, description: 'Directional translucency intensity; the hero of the stylised look' },
                        { key: 'specPower', label: 'Spec Power', type: 'number', min: 4, max: 256, step: 2, description: 'Specular exponent; lower = wider highlight band' },
                        { key: 'specIntensity', label: 'Spec Intensity', type: 'number', min: 0, max: 2, step: 0.05, description: 'Sun-streak brightness' },
                    ],
                },
                {
                    title: 'Near Shore (SWE)',
                    target: config,
                    params: [
                        { key: 'sweEnabled', label: 'Enabled', type: 'boolean', description: 'Shallow-water near-shore layer: beach run-up and the isolated tide pool' },
                        { key: 'sweSubsteps', label: 'Substeps', type: 'number', min: 1, max: 8, step: 1, description: 'Solver substeps per frame; more = more stable but costlier' },
                        { key: 'sweDrag', label: 'Drag', type: 'number', min: 0, max: 3, step: 0.05, description: 'Velocity damping; higher = water settles faster' },
                        { key: 'sweCoupling', label: 'Swell Coupling', type: 'number', min: 0, max: 2, step: 0.05, description: 'Open-ocean swell pushed in at the deep boundary' },
                        { key: 'sweFoam', label: 'Shore Foam', type: 'number', min: 0, max: 3, step: 0.05, description: 'Breaker and swash foam strength along the shore' },
                    ],
                },
                {
                    title: 'Wave Spray (L3)',
                    target: config,
                    params: [
                        { key: 'sprayEnabled', label: 'Enabled', type: 'boolean', description: 'Wave-strike particle spray thrown off the reefs' },
                        { key: 'sprayBirthRate', label: 'Birth Rate', type: 'number', min: 0, max: 30, step: 0.5, description: 'Respawn attempts per dead particle per second' },
                        { key: 'spraySpawnThreshold', label: 'Trigger Height', type: 'number', min: 0.2, max: 4, step: 0.1, description: 'Crest height over sea level needed to erupt spray' },
                        { key: 'spraySpeed', label: 'Burst Speed', type: 'number', min: 1, max: 25, step: 0.5, description: 'Initial droplet speed off the reef face' },
                        { key: 'sprayGravity', label: 'Gravity', type: 'number', min: 5, max: 40, step: 0.5, description: 'Downward acceleration on airborne droplets' },
                        { key: 'sprayDrag', label: 'Air Drag', type: 'number', min: 0, max: 2, step: 0.05, description: 'Velocity damping in flight; higher = shorter arcs' },
                        { key: 'sprayLife', label: 'Lifetime', type: 'number', min: 0.4, max: 4, step: 0.1, description: 'Maximum droplet lifetime in seconds' },
                        { key: 'spraySize', label: 'Droplet Size', type: 'number', min: 2, max: 20, step: 0.5, description: 'Billboard point size' },
                        { key: 'sprayFoam', label: 'Splat Foam', type: 'number', min: 0, max: 3, step: 0.05, description: 'Foam left where spray takes off and lands' },
                    ],
                },
                {
                    title: 'Atmosphere',
                    target: config,
                    params: [
                        { key: 'skyColorHorizon', label: 'Horizon', type: 'color', description: 'Sky colour at the horizon; also the fog colour' },
                        { key: 'skyColorZenith', label: 'Zenith', type: 'color', description: 'Sky colour straight up' },
                        { key: 'fogDensity', label: 'Fog Density', type: 'number', min: 0.0001, max: 0.005, step: 0.0001, description: 'Exponential distance fog towards the horizon colour' },
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
                        { key: 'gridResolution', label: 'Resolution', type: 'number', min: 64, max: 1024, step: 64, description: 'Displacement texture and mesh resolution; applied after Refresh' },
                        { key: 'fftResolution', label: 'FFT Size', type: 'number', min: 64, max: 512, step: 64, description: 'FFT grid is this value squared (power of two); applied after Refresh' },
                        { key: 'fftPatchSize', label: 'FFT Patch', type: 'number', min: 100, max: 1200, step: 20, description: 'Physical side of the periodic FFT tile in metres; applied after Refresh' },
                        { key: 'sweResolution', label: 'SWE Resolution', type: 'number', min: 64, max: 512, step: 64, description: 'Near-shore shallow-water grid resolution; applied after Refresh' },
                        { key: 'sprayPoolRes', label: 'Spray Pool', type: 'number', min: 32, max: 256, step: 32, description: 'Spray particle pool is this value squared; applied after Refresh' },
                    ],
                },
                {
                    title: 'Presets',
                    target: {},
                    params: [
                        { key: 'calm', label: 'Calm Seas', type: 'button', onClick: () => this.applyPreset({
                            windSpeed: 6, choppiness: 0.9, waveHeight: 0.8,
                            foamThreshold: 0.85, fogDensity: 0.0008,
                            waterColorDeep: 0x1fa9ce, waterColorMid: 0x3fd2ea,
                            waterColorShallow: 0x8fe8f6, waterColorShadow: 0x66b8dc,
                            foamColor: 0xf6fcfe,
                            skyColorHorizon: 0x9febf7, skyColorZenith: 0x4fc0dd,
                            sssStrength: 1.8,
                        }) },
                        { key: 'sunny', label: 'Sunny Swell', type: 'button', onClick: () => this.applyPreset({
                            windSpeed: 16, choppiness: 1.2, waveHeight: 2.0,
                            foamThreshold: 0.75, foamDecay: 0.965, fogDensity: 0.0011,
                            waterColorDeep: 0x139ec7, waterColorMid: 0x27c9e7,
                            waterColorShallow: 0x76dff3, waterColorShadow: 0x52add6,
                            foamColor: 0xf4fbfe,
                            skyColorHorizon: 0x86e7f5, skyColorZenith: 0x37b1d3,
                            sssColor: 0xcaf7fd, sssStrength: 1.4, specPower: 36,
                        }) },
                        { key: 'overcast', label: 'Overcast Storm', type: 'button', onClick: () => this.applyPreset({
                            windSpeed: 30, choppiness: 1.5, waveHeight: 4.2,
                            foamThreshold: 0.6, foamDecay: 0.975, fogDensity: 0.0018,
                            waterColorDeep: 0x24343a, waterColorMid: 0x3d575c,
                            waterColorShallow: 0x5d7a76, waterColorShadow: 0x46606b,
                            foamColor: 0xdde6e8,
                            skyColorHorizon: 0xb9bdbd, skyColorZenith: 0x73797c,
                            sssColor: 0x7a9a92, sssStrength: 0.8, specPower: 24, specIntensity: 0.3,
                        }) },
                        { key: 'randomize', label: 'Randomize', type: 'button', onClick: () => this.applyPreset({
                            windSpeed: 5 + Math.random() * 30,
                            choppiness: 0.6 + Math.random() * 1.0,
                            windDirection: Math.random() * 360,
                            waveHeight: 0.6 + Math.random() * 3.5,
                            foamThreshold: 0.5 + Math.random() * 0.4,
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
