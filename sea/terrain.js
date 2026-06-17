/**
 * terrain.js - Shared near-shore terrain field
 *
 * Single source of truth for the seabed elevation. The same analytic field
 * is injected into the seabed mesh (visual), the shallow-water solver (bed
 * for the SWE pass) and mirrored on the CPU to seed the initial water depth,
 * so the rendered floor and the simulated bed never disagree.
 *
 * The field is deep open ocean everywhere except a localised procedural island
 * built from a deterministic greyscale elevation field. The island shape is
 * irregular rather than rectangular, with shallow reef shelves, beaches,
 * inland relief and an isolated tide pool that traps its own water body.
 *
 * Sea level is authored at world y = 0 (config.seaLevel sits the ocean there).
 *
 * Version: 0.3.1
 */

import * as THREE from 'three';

// Near-shore SWE domain: a fixed world-space simulation area. Rendering masks it back to the island shelf.
export const SWE_ORIGIN = new THREE.Vector2(0, 0);
export const SWE_SIZE = 520.0;

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
        for (int i = 0; i < 5; i++) { v += a * tNoise(p); p *= 2.03; a *= 0.5; }
        return v;
    }
    float tRidged(vec2 p) {
        float v = 0.0;
        float a = 0.52;
        for (int i = 0; i < 4; i++) {
            v += (1.0 - abs(tNoise(p))) * a;
            p *= 2.11;
            a *= 0.5;
        }
        return v;
    }
    vec2 islandCentre() { return vec2(78.0, -22.0); }
    float islandCoast(vec2 p) {
        vec2 d = p - islandCentre();
        float a = atan(d.y, d.x);
        float lobe = sin(a * 2.0 + 0.6) * 0.16
                   + sin(a * 3.0 - 1.8) * 0.11
                   + sin(a * 5.0 + 2.4) * 0.07
                   + tFbm(vec2(cos(a), sin(a)) * 2.7 + vec2(6.4, 1.9)) * 0.23;
        vec2 q = d / vec2(145.0 * (1.0 + lobe), 118.0 * (1.0 - lobe * 0.35));
        float coast = length(q) - 1.0;
        coast += tFbm(p * 0.025 + vec2(2.1, 7.4)) * 0.11;
        coast += tFbm(p * 0.058 - vec2(8.2, 1.5)) * 0.035;
        return coast;
    }
    float islandGrey(vec2 p) {
        float coast = islandCoast(p);
        float inland = 1.0 - smoothstep(-0.84, 0.16, coast);
        float core = 1.0 - smoothstep(-0.88, -0.50, coast);
        float low = tFbm(p * 0.018 + vec2(14.0, -3.0)) * 0.18;
        float mid = tFbm(p * 0.047 - vec2(5.0, 11.0)) * 0.14;
        float ridges = tRidged(p * 0.032 + vec2(1.4, 9.1)) * 0.26;
        return clamp(inland * (0.18 + core * 0.42 + low + mid + ridges), 0.0, 1.0);
    }
    float terrainHeight(vec2 p) {
        float deep = -95.0 + tFbm(p * 0.009) * 10.0;
        float coast = islandCoast(p);
        float grey = islandGrey(p);

        float shelfT = 1.0 - smoothstep(0.34, 1.48, coast);
        float reefT = 1.0 - smoothstep(0.04, 0.72, coast);
        float beachT = 1.0 - smoothstep(-0.06, 0.17, coast);
        float landT = smoothstep(0.08, 0.24, grey);

        float shelf = mix(-34.0, -4.8, shelfT);
        shelf = mix(shelf, -1.2, reefT * (1.0 - smoothstep(-0.04, 0.13, coast)));

        float beach = mix(shelf, 2.2 + tFbm(p * 0.072) * 0.85, beachT);
        float highland = 1.3 + pow(grey, 1.55) * 28.0;
        float h = mix(beach, highland, landT);

        float nearCoast = 1.0 - smoothstep(-0.20, 0.90, coast);
        float bars = sin(coast * 38.0 + tFbm(p * 0.020) * 4.0) * 0.85 * nearCoast;
        float channelMask = 1.0 - smoothstep(0.08, 0.48, abs(tFbm(p * 0.014 + vec2(9.0))));
        float channels = -3.8 * channelMask * smoothstep(-0.06, 0.30, coast) * (1.0 - smoothstep(0.32, 1.20, coast));
        h += bars + channels;
        h += tFbm(p * 0.095 + vec2(3.5)) * mix(0.42, 2.3, landT);

        vec2 poolC = islandCentre() + vec2(-18.0, -54.0);
        float pr = length(p - poolC);
        float upperBeach = smoothstep(0.18, 0.44, grey) * (1.0 - smoothstep(0.56, 0.82, grey));
        h += -11.5 * (1.0 - smoothstep(0.0, 28.0, pr)) * upperBeach;
        h += 3.9 * exp(-pow((pr - 33.0) / 7.0, 2.0)) * upperBeach;

        float local = 1.0 - smoothstep(390.0, 680.0, length(p - islandCentre()));
        return mix(deep, h, local);
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
    const fbm = (px, pz, octaves = 5) => {
        let v = 0;
        let a = 0.5;
        for (let i = 0; i < octaves; i++) {
            v += a * noise(px, pz);
            px *= 2.03;
            pz *= 2.03;
            a *= 0.5;
        }
        return v;
    };
    const ridged = (px, pz) => {
        let v = 0;
        let a = 0.52;
        for (let i = 0; i < 4; i++) {
            v += (1 - Math.abs(noise(px, pz))) * a;
            px *= 2.11;
            pz *= 2.11;
            a *= 0.5;
        }
        return v;
    };
    const cx = 78.0;
    const cz = -22.0;
    const coastAt = (px, pz) => {
        const dx = px - cx;
        const dz = pz - cz;
        const a = Math.atan2(dz, dx);
        const lobe = Math.sin(a * 2.0 + 0.6) * 0.16
            + Math.sin(a * 3.0 - 1.8) * 0.11
            + Math.sin(a * 5.0 + 2.4) * 0.07
            + fbm(Math.cos(a) * 2.7 + 6.4, Math.sin(a) * 2.7 + 1.9) * 0.23;
        const qx = dx / (145.0 * (1.0 + lobe));
        const qz = dz / (118.0 * (1.0 - lobe * 0.35));
        let coast = Math.hypot(qx, qz) - 1.0;
        coast += fbm(px * 0.025 + 2.1, pz * 0.025 + 7.4) * 0.11;
        coast += fbm(px * 0.058 - 8.2, pz * 0.058 - 1.5) * 0.035;
        return coast;
    };
    const greyAt = (px, pz) => {
        const coast = coastAt(px, pz);
        const inland = 1.0 - sm(-0.84, 0.16, coast);
        const core = 1.0 - sm(-0.88, -0.50, coast);
        const low = fbm(px * 0.018 + 14.0, pz * 0.018 - 3.0) * 0.18;
        const mid = fbm(px * 0.047 - 5.0, pz * 0.047 + 11.0) * 0.14;
        const ridges = ridged(px * 0.032 + 1.4, pz * 0.032 + 9.1) * 0.26;
        return Math.min(Math.max(inland * (0.18 + core * 0.42 + low + mid + ridges), 0.0), 1.0);
    };

    const deep = -95.0 + fbm(x * 0.009, z * 0.009) * 10.0;
    const coast = coastAt(x, z);
    const grey = greyAt(x, z);
    const shelfT = 1.0 - sm(0.34, 1.48, coast);
    const reefT = 1.0 - sm(0.04, 0.72, coast);
    const beachT = 1.0 - sm(-0.06, 0.17, coast);
    const landT = sm(0.08, 0.24, grey);

    let shelf = -34.0 * (1 - shelfT) + -4.8 * shelfT;
    shelf = shelf * (1 - reefT * (1.0 - sm(-0.04, 0.13, coast))) + -1.2 * (reefT * (1.0 - sm(-0.04, 0.13, coast)));
    let beach = shelf * (1 - beachT) + (2.2 + fbm(x * 0.072, z * 0.072) * 0.85) * beachT;
    const highland = 1.3 + Math.pow(grey, 1.55) * 28.0;
    let h = beach * (1 - landT) + highland * landT;

    const nearCoast = 1.0 - sm(-0.20, 0.90, coast);
    h += Math.sin(coast * 38.0 + fbm(x * 0.020, z * 0.020) * 4.0) * 0.85 * nearCoast;
    const channelMask = 1.0 - sm(0.08, 0.48, Math.abs(fbm(x * 0.014 + 9.0, z * 0.014 + 9.0)));
    h += -3.8 * channelMask * sm(-0.06, 0.30, coast) * (1.0 - sm(0.32, 1.20, coast));
    h += fbm(x * 0.095 + 3.5, z * 0.095 + 3.5) * (0.42 * (1 - landT) + 2.3 * landT);

    const pr = Math.hypot(x - (cx - 18.0), z - (cz - 54.0));
    const upperBeach = sm(0.18, 0.44, grey) * (1.0 - sm(0.56, 0.82, grey));
    h += -11.5 * (1.0 - sm(0.0, 28.0, pr)) * upperBeach;
    h += 3.9 * Math.exp(-Math.pow((pr - 33.0) / 7.0, 2.0)) * upperBeach;

    const local = 1.0 - sm(390.0, 680.0, Math.hypot(x - cx, z - cz));
    return deep * (1.0 - local) + h * local;
}
