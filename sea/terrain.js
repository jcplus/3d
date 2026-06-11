/**
 * terrain.js - Shared near-shore terrain field
 *
 * Single source of truth for the seabed elevation. The same analytic field
 * is injected into the seabed mesh (visual), the shallow-water solver (bed
 * for the SWE pass) and mirrored on the CPU to seed the initial water depth,
 * so the rendered floor and the simulated bed never disagree.
 *
 * The field is deep open ocean everywhere except a localised near-shore disc
 * centred on the world origin: a cross-shore beach that rises from below to
 * above sea level, plus an isolated tide pool that traps its own water body.
 *
 * Sea level is authored at world y = 0 (config.seaLevel sits the ocean there).
 *
 * Version: 0.1.0
 */

import * as THREE from 'three';

// Near-shore SWE domain: a fixed world-space square centred on the origin.
export const SWE_ORIGIN = new THREE.Vector2(0, 0);
export const SWE_SIZE = 400.0;

/**
 * GLSL terrain field. Injected verbatim wherever a shader needs the bed:
 * defines tHash / tNoise / tFbm / terrainHeight(vec2 worldXZ).
 */
export const TERRAIN_GLSL = `
    // --- Shared terrain field (keep in sync with terrainHeightJS) ---
    float tHash(vec2 p) {
        p = fract(p * vec2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
    }
    float tNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = tHash(i);
        float b = tHash(i + vec2(1.0, 0.0));
        float c = tHash(i + vec2(0.0, 1.0));
        float d = tHash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
    }
    float tFbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) { v += a * tNoise(p); p *= 2.0; a *= 0.5; }
        return v;
    }
    float terrainHeight(vec2 p) {
        // Far-field deep seabed
        float deep = -130.0 + tFbm(p * 0.012) * 16.0;
        // Cross-shore beach profile: deep on -x, rising to dry land on +x
        float beach = mix(-24.0, 17.0, smoothstep(-170.0, 150.0, p.x));
        beach += 1.6 * sin(p.z * 0.03) + 1.2 * sin(p.x * 0.05 + 1.7);
        beach += tFbm(p * 0.03) * 1.2;
        // Isolated tide pool on the upper beach: a bowl ringed by a raised rim
        vec2 poolC = vec2(85.0, -70.0);
        float pr = length(p - poolC);
        beach += -18.0 * (1.0 - smoothstep(0.0, 30.0, pr));
        beach += 5.0 * exp(-pow((pr - 34.0) / 7.0, 2.0));
        // Keep the shore local; relax back to the deep floor beyond the disc
        float local = 1.0 - smoothstep(200.0, 380.0, length(p));
        return mix(deep, beach, local);
    }
`;

/**
 * CPU mirror of terrainHeight, used only to seed the initial water depth.
 * The deep-field fbm is dropped (it lives below the active near-shore band
 * and is overwritten by boundary forcing), so only the deterministic beach
 * and pool features are reproduced.
 */
export function terrainHeightJS(x, z) {
    const sm = (a, b, t) => {
        t = Math.min(Math.max((t - a) / (b - a), 0), 1);
        return t * t * (3 - 2 * t);
    };
    const deep = -130.0;
    let beach = -24.0 + 41.0 * sm(-170.0, 150.0, x);
    beach += 1.6 * Math.sin(z * 0.03) + 1.2 * Math.sin(x * 0.05 + 1.7);
    const pr = Math.hypot(x - 85.0, z + 70.0);
    beach += -18.0 * (1.0 - sm(0.0, 30.0, pr));
    beach += 5.0 * Math.exp(-Math.pow((pr - 34.0) / 7.0, 2.0));
    const local = 1.0 - sm(200.0, 380.0, Math.hypot(x, z));
    return deep * (1.0 - local) + beach * local;
}
