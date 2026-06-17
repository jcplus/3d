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
 * Version: 0.2.0
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
        // Far-field seabed, kept well below the active near-shore shelf.
        float deep = -95.0 + tFbm(p * 0.009) * 10.0;

        // Organic island signed distance. Negative is dry island, positive is
        // water. Low-frequency boundary noise breaks the old square shoreline.
        vec2 islandC = vec2(115.0, -25.0);
        vec2 q = (p - islandC) / vec2(118.0, 178.0);
        float boundary = tFbm(p * 0.018 + vec2(4.1, 2.3)) * 0.16
                       + tFbm(p * 0.041 - vec2(1.7, 5.2)) * 0.055;
        float sd = length(q) - 1.0 + boundary;

        // Radial bathymetry: deep ocean -> reef shelf -> beach -> inland.
        // This gives gradual depth bands around the island instead of a flat
        // rectangular shallow patch.
        float shelfT = 1.0 - smoothstep(0.42, 1.55, sd);
        float beachT = 1.0 - smoothstep(-0.08, 0.20, sd);
        float inlandT = 1.0 - smoothstep(-0.62, -0.18, sd);
        float shelf = mix(-28.0, -2.2, shelfT);
        float beach = mix(shelf, 2.2, beachT);
        beach = mix(beach, 14.0, inlandT);

        // Alongshore bars, channels and small sand ripples.
        float bars = sin(sd * 34.0 + tFbm(p * 0.022) * 3.0) * 0.9 * (1.0 - smoothstep(0.05, 1.25, sd));
        float channels = -3.5 * (1.0 - smoothstep(0.10, 0.55, abs(tFbm(p * 0.015 + 9.0)))) * (1.0 - smoothstep(0.25, 1.35, sd)) * smoothstep(-0.08, 0.28, sd);
        beach += bars + channels + tFbm(p * 0.075) * mix(0.6, 2.2, inlandT);

        // Isolated tide pool on the upper beach: a bowl ringed by a raised rim.
        vec2 poolC = vec2(85.0, -70.0);
        float pr = length(p - poolC);
        beach += -12.0 * (1.0 - smoothstep(0.0, 28.0, pr)) * (1.0 - smoothstep(-0.08, 0.22, sd));
        beach += 4.0 * exp(-pow((pr - 33.0) / 7.0, 2.0));

        // Keep the authored island local; relax to the deep floor in the far
        // field so the camera-following seabed skirt remains cheap.
        float local = 1.0 - smoothstep(360.0, 620.0, length(p - islandC));
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
    const fract = (v) => v - Math.floor(v);
    const hash = (ix, iz) => {
        let px = fract(ix * 123.34);
        let pz = fract(iz * 345.45);
        const d = px * (px + 34.345) + pz * (pz + 34.345);
        px += d;
        pz += d;
        return fract(px * pz) * 2 - 1;
    };
    const noise = (px, pz) => {
        const ix = Math.floor(px);
        const iz = Math.floor(pz);
        const fx = px - ix;
        const fz = pz - iz;
        const ux = fx * fx * (3 - 2 * fx);
        const uz = fz * fz * (3 - 2 * fz);
        const a = hash(ix, iz);
        const b = hash(ix + 1, iz);
        const c = hash(ix, iz + 1);
        const d = hash(ix + 1, iz + 1);
        return (a * (1 - ux) + b * ux) * (1 - uz) + (c * (1 - ux) + d * ux) * uz;
    };
    const fbm = (px, pz) => {
        let v = 0;
        let a = 0.5;
        for (let i = 0; i < 4; i++) {
            v += a * noise(px, pz);
            px *= 2;
            pz *= 2;
            a *= 0.5;
        }
        return v;
    };

    const deep = -95.0 + fbm(x * 0.009, z * 0.009) * 10.0;
    const cx = 115.0;
    const cz = -25.0;
    const qx = (x - cx) / 118.0;
    const qz = (z - cz) / 178.0;
    const boundary = fbm(x * 0.018 + 4.1, z * 0.018 + 2.3) * 0.16
        + fbm(x * 0.041 - 1.7, z * 0.041 - 5.2) * 0.055;
    const sd = Math.hypot(qx, qz) - 1.0 + boundary;
    const shelfT = 1.0 - sm(0.42, 1.55, sd);
    const beachT = 1.0 - sm(-0.08, 0.20, sd);
    const inlandT = 1.0 - sm(-0.62, -0.18, sd);
    const shelf = -28.0 * (1 - shelfT) + -2.2 * shelfT;
    let beach = shelf * (1 - beachT) + 2.2 * beachT;
    beach = beach * (1 - inlandT) + 14.0 * inlandT;
    beach += Math.sin(sd * 34.0 + fbm(x * 0.022, z * 0.022) * 3.0) * 0.9 * (1.0 - sm(0.05, 1.25, sd));
    beach += -3.5 * (1.0 - sm(0.10, 0.55, Math.abs(fbm(x * 0.015 + 9.0, z * 0.015 + 9.0)))) * (1.0 - sm(0.25, 1.35, sd)) * sm(-0.08, 0.28, sd);
    beach += fbm(x * 0.075, z * 0.075) * (0.6 * (1 - inlandT) + 2.2 * inlandT);

    const pr = Math.hypot(x - 85.0, z + 70.0);
    beach += -12.0 * (1.0 - sm(0.0, 28.0, pr)) * (1.0 - sm(-0.08, 0.22, sd));
    beach += 4.0 * Math.exp(-Math.pow((pr - 33.0) / 7.0, 2.0));

    const local = 1.0 - sm(360.0, 620.0, Math.hypot(x - cx, z - cz));
    return deep * (1.0 - local) + beach * local;
}
