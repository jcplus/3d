/**
 * ui.js - Native WebGPU water controls
 *
 * Version: 1.0.0
 */

import { config, saveConfigToStorage, clearSavedConfig } from './config.js';
import { createPanel, updateParamValue, refreshPanel, destroyPanel } from './panel.js';

export class UI {
    constructor() {
        this.stats = { time: '0.00', fps: '0', gpu: 'Starting' };
        this.panel = createPanel({
            title: 'WebGPU Water',
            sections: [
                {
                    title: 'Scene', target: config, params: [
                        { key: 'webgpuScene', label: 'Scene', type: 'select', options: [{ value: 'shore', label: 'Island Shore' }, { value: 'open', label: 'Open Ocean' }], description: 'Island enables wet/dry shoreline and depth-aware refraction' },
                        { key: 'webgpuView', label: 'View', type: 'select', options: [{ value: 'surface', label: 'Surface' }, { value: 'underwater', label: 'Underwater' }], description: 'Switches the optical path and camera water-side state' },
                        { key: 'webgpuFixedTime', label: 'Fixed Time', type: 'number', min: -1, max: 120, step: 0.25, description: '-1 uses live time; non-negative values provide repeatable review frames' },
                    ],
                },
                {
                    title: 'Quality', target: config, params: [
                        { key: 'webgpuQuality', label: 'Profile', type: 'select', options: [{ value: 'balanced', label: 'Balanced' }, { value: 'dense', label: 'Dense' }, { value: 'wide', label: 'Wide Ocean' }], description: 'Changes mesh and nearshore simulation resolution' },
                        { key: 'webgpuRenderScale', label: 'Render Scale', type: 'number', min: 0.5, max: 1.25, step: 0.05, description: 'Output resolution multiplier' },
                    ],
                },
                {
                    title: 'Camera', target: config, params: [
                        { key: 'cameraMoveSpeed', label: 'Move Speed', type: 'number', min: 5, max: 150, step: 1, description: 'WASD movement speed in metres per second' },
                        { key: 'cameraLookSpeed', label: 'Look Speed', type: 'number', min: 0.0005, max: 0.01, step: 0.0005, description: 'Mouse look sensitivity' },
                    ],
                },
                {
                    title: 'Info', path: 'stats', target: this.stats, params: [
                        { key: 'time', label: 'Sim Time', type: 'info' },
                        { key: 'fps', label: 'FPS', type: 'info' },
                        { key: 'gpu', label: 'Adapter', type: 'info' },
                    ],
                },
            ],
            buttons: [
                { label: 'Save', primary: true, onClick: () => saveConfigToStorage() },
                { label: 'Reset', onClick: () => { clearSavedConfig(); location.reload(); } },
            ],
        });
    }

    update(metrics) {
        updateParamValue('stats.time', config.time.toFixed(2));
        updateParamValue('stats.fps', Number.isFinite(metrics?.fps) ? metrics.fps.toFixed(0) : '0');
        updateParamValue('stats.gpu', metrics?.adapter || 'Starting');
    }

    refresh() { refreshPanel(); }
    dispose() { destroyPanel(); }
}
