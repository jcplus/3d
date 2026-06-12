/**
 * fft.js - FFT spectral ocean (L0)
 *
 * A Tessendorf-style FFT ocean: a Phillips spectrum is seeded into a frequency
 * tile, evolved in time by the deep-water dispersion relation, then inverse
 * transformed with a butterfly-texture FFT to a periodic spatial tile carrying
 * horizontal choppy displacement, surface height and a folding Jacobian.
 *
 * The tile is periodic with physical side `patchSize`. A separate resolve step
 * (resolveToPatch) tiles it into the camera-centred displacement texture the
 * rest of the simulation already consumes (RGB = world displacement, A =
 * Jacobian), so L1/L2/L3 see exactly the same interface as the previous
 * Gerstner generator.
 *
 * Wave height is normalised on the CPU: the spectrum's RMS is integrated once
 * per parameter change, so `waveHeight` is a predictable metre-scale gain
 * independent of wind speed, patch size or the internal spectrum constant.
 *
 * On top of the FFT field sits an analytic macro swell: a few Gerstner
 * components far longer than the FFT patch can carry, added during the patch
 * resolve so the whole surface heaves and rolls instead of wrinkling a static
 * plane. The same GLSL is evaluated by the far-field skirt, so the seam
 * between grid and skirt cannot open.
 *
 * Version: 0.4.0
 */

import * as THREE from 'three';

const GRAVITY = 9.81;
const TWO_PI = Math.PI * 2.0;
// Internal Phillips constant; it cancels in the RMS normalisation, so its
// absolute value only needs to stay clear of float under/overflow.
const PHILLIPS_A = 1.0;
// Wind speed at which `waveHeight` equals the on-screen RMS height (m/s).
// The actual gain scales with (windSpeed / WIND_REF)^2, the fully developed
// sea relation, so a rising wind grows the waves instead of merely
// stretching the same RMS budget into longer, flatter modes. The clamp keeps
// a light breeze from flattening the sea to glass and a gale from blowing
// the half-float displacement range out.
export const WIND_REF = 22.0;
export function windGain(windSpeed) {
    const g = (windSpeed / WIND_REF) * (windSpeed / WIND_REF);
    return Math.min(Math.max(g, 0.12), 4.0);
}

/**
 * Analytic macro swell shared by the patch resolve and the skirt vertex
 * shader. Three deterministic Gerstner components are derived from one set
 * of primary uniforms (amplitude / wavelength / direction / steepness):
 * fixed wavelength and amplitude ratios plus small direction and phase
 * offsets, so a single crest never reads as a synthetic sine carpet.
 * Returns xyz = world displacement, w = Jacobian contribution (the trace
 * term of the horizontal-displacement gradient, negative on the crests).
 */
export const SWELL_GLSL = `
    uniform float uSwellAmp;
    uniform float uSwellLen;
    uniform vec2 uSwellDir;
    uniform float uSwellSteep;
    uniform float uTide;

    vec4 macroSwell(vec2 xz, float t) {
        // Tide: a uniform, slowly oscillating water level driven purely by
        // time on the CPU. Riding in the displacement field means the SWE
        // boundary coupling sees it too, so the shoreline floods and drains.
        vec3 disp = vec3(0.0, uTide, 0.0);
        float jac = 0.0;
        if (uSwellAmp < 1e-4) return vec4(disp, jac);
        // Per-component (wavelength ratio, amplitude share, direction offset
        // in radians, phase offset). Amplitude shares sum to 1 so uSwellAmp
        // is the metre-scale crest height of the combined swell.
        vec4 comp[3];
        comp[0] = vec4(1.00, 0.588,  0.00, 0.0);
        comp[1] = vec4(0.62, 0.265,  0.42, 2.1);
        comp[2] = vec4(0.41, 0.147, -0.31, 4.4);

        for (int i = 0; i < 3; i++) {
            float amp = uSwellAmp * comp[i].y;
            float k = ${TWO_PI.toFixed(8)} / max(uSwellLen * comp[i].x, 1.0);
            float ca = cos(comp[i].z);
            float sa = sin(comp[i].z);
            vec2 d = normalize(vec2(uSwellDir.x * ca - uSwellDir.y * sa,
                                    uSwellDir.x * sa + uSwellDir.y * ca));
            float w = sqrt(${GRAVITY.toFixed(4)} * k);
            float f = dot(d, xz) * k - w * t + comp[i].w;
            // Steepness budget split across components: q*k*amp = steep/3
            // per wave, so the summed trochoid never self-intersects.
            float q = uSwellSteep / (3.0 * k * max(amp, 1e-4));
            disp.y += amp * sin(f);
            disp.xz += d * (q * amp * cos(f));
            jac -= q * amp * k * sin(f);
        }
        return vec4(disp, jac);
    }
`;

export class FFTOcean {
    constructor(renderer, { size = 256, patchSize = 400 } = {}) {
        this.renderer = renderer;
        this.size = size;
        this.patchSize = patchSize;
        this.stages = Math.round(Math.log2(size));
        if ((1 << this.stages) !== size) {
            throw new Error('FFT size must be a power of two');
        }

        this.heightScale = 1.0;
        this.choppiness = 1.0;

        // Full float for the frequency-domain passes where available; otherwise
        // fall back to half float (the project already requires a float-
        // renderable WebGL2 context for the GPGPU layers).
        this.workType = renderer.extensions.has('EXT_color_buffer_float')
            ? THREE.FloatType
            : THREE.HalfFloatType;

        // Fullscreen-quad rig reused for every pass
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quadScene = new THREE.Scene();
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
        this.quad.frustumCulled = false;
        this.quadScene.add(this.quad);

        this._initTargets();
        this._initButterflyTexture();
        this._initMaterials();
    }

    _makeTarget(w, h, { wrap = THREE.ClampToEdgeWrapping, filter = THREE.NearestFilter, type = this.workType } = {}) {
        return new THREE.WebGLRenderTarget(w, h, {
            type,
            format: THREE.RGBAFormat,
            minFilter: filter,
            magFilter: filter,
            wrapS: wrap,
            wrapT: wrap,
            depthBuffer: false,
            stencilBuffer: false,
        });
    }

    _initTargets() {
        const N = this.size;
        // Frequency-domain work stays full float: butterfly partial sums of the
        // low-wavenumber modes can exceed the half-float range at high sea states
        this.h0Target = this._makeTarget(N, N);     // RG = h0(k)
        this.pingA = this._makeTarget(N, N);        // RG = Dx|Dz spectrum, BA = height spectrum
        this.pingB = this._makeTarget(N, N);
        // Spatial tile carries metre-scale values; half float keeps core linear
        // filtering for the patch resolve and the skirt's vertex sampling
        this.tileTarget = this._makeTarget(N, N, {
            wrap: THREE.RepeatWrapping,
            filter: THREE.LinearFilter,
            type: THREE.HalfFloatType,
        });
    }

    /**
     * Precompute the butterfly lookup: for every (stage, index) it stores the
     * twiddle factor and the two input indices the butterfly reads. Stage 0
     * folds in the bit-reversal permutation.
     */
    _initButterflyTexture() {
        const N = this.size;
        const stages = this.stages;
        const data = new Float32Array(stages * N * 4);

        const reverseBits = (value) => {
            let r = 0;
            for (let i = 0; i < stages; i++) {
                r = (r << 1) | (value & 1);
                value >>= 1;
            }
            return r;
        };

        for (let stage = 0; stage < stages; stage++) {
            const span = 1 << stage;
            const groupSpan = 1 << (stage + 1);
            for (let y = 0; y < N; y++) {
                const k = (y * N / groupSpan) % N;
                const angle = TWO_PI * k / N;
                // Positive sign: this synthesises the inverse transform
                const twRe = Math.cos(angle);
                const twIm = Math.sin(angle);
                const upper = (y % groupSpan) < span;

                let top;
                let bottom;
                if (stage === 0) {
                    top = upper ? reverseBits(y) : reverseBits(y - 1);
                    bottom = upper ? reverseBits(y + 1) : reverseBits(y);
                } else {
                    top = upper ? y : y - span;
                    bottom = upper ? y + span : y;
                }

                const idx = (y * stages + stage) * 4;
                data[idx] = twRe;
                data[idx + 1] = twIm;
                data[idx + 2] = top;
                data[idx + 3] = bottom;
            }
        }

        const tex = new THREE.DataTexture(data, stages, N, THREE.RGBAFormat, THREE.FloatType);
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.needsUpdate = true;
        this.butterflyTexture = tex;
    }

    _passVertexShader() {
        // RawShaderMaterial: declare the geometry attributes explicitly
        return `
            in vec3 position;
            in vec2 uv;
            out vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position.xy, 0.0, 1.0);
            }
        `;
    }

    _initMaterials() {
        const N = this.size;
        const glsl3 = THREE.GLSL3;
        const vertexShader = this._passVertexShader();

        // h0(k): Phillips spectrum seeded with a per-texel Gaussian
        this.h0Material = new THREE.RawShaderMaterial({
            glslVersion: glsl3,
            vertexShader,
            fragmentShader: `
                precision highp float;
                precision highp int;
                precision highp sampler2D;
                out vec4 fragColor;
                uniform float uN;
                uniform float uPatch;
                uniform float uWindSpeed;
                uniform vec2 uWindDir;
                uniform float uSwellSpread;
                uniform float uRipple;

                float hash(vec2 p) {
                    p = fract(p * vec2(123.34, 456.21));
                    p += dot(p, p + 45.32);
                    return fract(p.x * p.y);
                }
                vec2 gaussian(vec2 c) {
                    float u1 = max(1e-6, hash(c));
                    float u2 = hash(c + 11.13);
                    float r = sqrt(-2.0 * log(u1));
                    float a = ${TWO_PI.toFixed(8)} * u2;
                    return vec2(r * cos(a), r * sin(a));
                }

                void main() {
                    ivec2 ic = ivec2(gl_FragCoord.xy);
                    vec2 n = vec2(ic) - uN * 0.5;
                    vec2 k = ${TWO_PI.toFixed(8)} * n / uPatch;
                    float kk = dot(k, k);
                    if (kk < 1e-12) { fragColor = vec4(0.0); return; }
                    float kl = sqrt(kk);

                    float L = uWindSpeed * uWindSpeed / ${GRAVITY.toFixed(4)};
                    float kL = kl * L;
                    float ph = ${PHILLIPS_A.toFixed(4)} * exp(-1.0 / (kL * kL)) / (kk * kk);
                    // Frequency-dependent directional spread: waves near the
                    // spectral peak stay long-crested (high exponent), while
                    // bands octaves above it fan out into broad chop. This is
                    // what separates a readable dominant swell from an
                    // isotropic crosshatch of identical ripples.
                    float kdotw = dot(k / kl, uWindDir);
                    float octave = clamp(log2(max(kL * 1.4142136, 1.0)) * 0.25, 0.0, 1.0);
                    float spread = mix(uSwellSpread, 2.0, octave);
                    ph *= pow(abs(kdotw), spread);
                    if (kdotw < 0.0) ph *= 0.07;         // damp waves against the wind
                    // Metre-scale ripple cutoff: the k^-4 spectrum carries near
                    // constant slope variance per octave, so without a real
                    // rolloff the normals are dominated by the smallest
                    // resolvable waves everywhere at once
                    ph *= exp(-kk * uRipple * uRipple);

                    float h0 = sqrt(max(ph, 0.0) * 0.5);
                    fragColor = vec4(gaussian(vec2(ic)) * h0, 0.0, 0.0);
                }
            `,
            uniforms: {
                uN: { value: N },
                uPatch: { value: this.patchSize },
                uWindSpeed: { value: 10.0 },
                uWindDir: { value: new THREE.Vector2(1, 0) },
                uSwellSpread: { value: 6.0 },
                uRipple: { value: 0.8 },
            },
        });

        // Time evolution: h~(k,t) and the packed Dx|Dz | height spectra
        this.spectrumMaterial = new THREE.RawShaderMaterial({
            glslVersion: glsl3,
            vertexShader,
            fragmentShader: `
                precision highp float;
                precision highp int;
                precision highp sampler2D;
                out vec4 fragColor;
                uniform sampler2D uH0;
                uniform float uN;
                uniform float uPatch;
                uniform float uTime;

                vec2 cmul(vec2 a, vec2 b) {
                    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
                }

                void main() {
                    ivec2 ic = ivec2(gl_FragCoord.xy);
                    vec2 n = vec2(ic) - uN * 0.5;
                    vec2 k = ${TWO_PI.toFixed(8)} * n / uPatch;
                    float kl = length(k);

                    vec2 h0 = texelFetch(uH0, ic, 0).rg;
                    ivec2 mir = ivec2(mod(uN - vec2(ic), vec2(uN)));
                    vec2 h0m = texelFetch(uH0, mir, 0).rg;
                    vec2 h0mc = vec2(h0m.x, -h0m.y);     // conj(h0(-k))

                    float w = sqrt(${GRAVITY.toFixed(4)} * max(kl, 1e-6));
                    float wt = w * uTime;
                    vec2 e1 = vec2(cos(wt), sin(wt));    // e^{+i w t}
                    vec2 e2 = vec2(cos(wt), -sin(wt));   // e^{-i w t}
                    vec2 h = cmul(h0, e1) + cmul(h0mc, e2);

                    vec2 kn = kl > 1e-6 ? k / kl : vec2(0.0);
                    vec2 negiH = vec2(h.y, -h.x);        // -i * h
                    vec2 dx = kn.x * negiH;
                    vec2 dz = kn.y * negiH;
                    vec2 idz = vec2(-dz.y, dz.x);        // i * dz
                    vec2 ca = dx + idz;                  // iFFT real -> Dx, imag -> Dz

                    fragColor = vec4(ca, h);             // BA: iFFT real -> height
                }
            `,
            uniforms: {
                uH0: { value: this.h0Target.texture },
                uN: { value: N },
                uPatch: { value: this.patchSize },
                uTime: { value: 0 },
            },
        });

        // One butterfly stage, transforming the two packed complex fields
        this.butterflyMaterial = new THREE.RawShaderMaterial({
            glslVersion: glsl3,
            vertexShader,
            fragmentShader: `
                precision highp float;
                precision highp int;
                precision highp sampler2D;
                out vec4 fragColor;
                uniform sampler2D uButterfly;
                uniform sampler2D uInput;
                uniform int uStage;
                uniform int uDirection;

                vec2 cmul(vec2 a, vec2 b) {
                    return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
                }

                void main() {
                    ivec2 px = ivec2(gl_FragCoord.xy);
                    vec4 bf;
                    ivec2 ca;
                    ivec2 cb;
                    if (uDirection == 0) {
                        bf = texelFetch(uButterfly, ivec2(uStage, px.x), 0);
                        ca = ivec2(int(bf.z), px.y);
                        cb = ivec2(int(bf.w), px.y);
                    } else {
                        bf = texelFetch(uButterfly, ivec2(uStage, px.y), 0);
                        ca = ivec2(px.x, int(bf.z));
                        cb = ivec2(px.x, int(bf.w));
                    }
                    vec2 tw = bf.xy;
                    vec4 a = texelFetch(uInput, ca, 0);
                    vec4 b = texelFetch(uInput, cb, 0);
                    vec2 fieldA = a.rg + cmul(tw, b.rg);
                    vec2 fieldB = a.ba + cmul(tw, b.ba);
                    fragColor = vec4(fieldA, fieldB);
                }
            `,
            uniforms: {
                uButterfly: { value: this.butterflyTexture },
                uInput: { value: null },
                uStage: { value: 0 },
                uDirection: { value: 0 },
            },
        });

        // Resolve the transformed spectrum to a spatial tile: undo the centred
        // spectrum with the (-1)^(x+y) sign, scale to metres and derive the
        // folding Jacobian from neighbouring choppy displacements.
        this.resolveMaterial = new THREE.RawShaderMaterial({
            glslVersion: glsl3,
            vertexShader,
            fragmentShader: `
                precision highp float;
                precision highp int;
                precision highp sampler2D;
                out vec4 fragColor;
                uniform sampler2D uInput;
                uniform float uN;
                uniform float uPatch;
                uniform float uHeightScale;
                uniform float uChoppiness;

                vec3 spatial(ivec2 p) {
                    int M = int(uN);
                    ivec2 q = ((p % M) + M) % M;
                    float psign = ((q.x + q.y) & 1) == 0 ? 1.0 : -1.0;
                    return texelFetch(uInput, q, 0).rgb * psign;  // (Dx, Dz, height)
                }

                void main() {
                    ivec2 px = ivec2(gl_FragCoord.xy);
                    vec3 c = spatial(px);
                    vec3 xp = spatial(px + ivec2(1, 0));
                    vec3 xm = spatial(px - ivec2(1, 0));
                    vec3 zp = spatial(px + ivec2(0, 1));
                    vec3 zm = spatial(px - ivec2(0, 1));

                    float ds = uPatch / uN;
                    // Tessendorf's choppy displacement uses x' = x + lambda*D with
                    // lambda NEGATIVE: points draw toward the crests, giving sharp
                    // crests and broad troughs. A positive sign inverts the
                    // trochoid (sharp troughs, flat crests). The same sign feeds
                    // the Jacobian so folding stays on the crests where it belongs.
                    float hc = -uHeightScale * uChoppiness;
                    float dDxdx = (xp.x - xm.x) * hc / (2.0 * ds);
                    float dDzdz = (zp.y - zm.y) * hc / (2.0 * ds);
                    float dDxdz = (zp.x - zm.x) * hc / (2.0 * ds);
                    float dDzdx = (xp.y - xm.y) * hc / (2.0 * ds);
                    float jacobian = (1.0 + dDxdx) * (1.0 + dDzdz) - dDxdz * dDzdx;

                    fragColor = vec4(c.x * hc, c.z * uHeightScale, c.y * hc, jacobian);
                }
            `,
            uniforms: {
                uInput: { value: null },
                uN: { value: N },
                uPatch: { value: this.patchSize },
                uHeightScale: { value: 1.0 },
                uChoppiness: { value: 1.0 },
            },
        });

        // Tile the periodic spatial tile into a camera-centred patch, matching
        // the displacement texture the rest of the pipeline samples. The
        // analytic macro swell is layered in here, so every consumer of the
        // displacement texture (mesh, foam, SWE coupling, spray) inherits the
        // large-scale heave without knowing it exists.
        this.patchMaterial = new THREE.RawShaderMaterial({
            glslVersion: glsl3,
            vertexShader,
            fragmentShader: `
                precision highp float;
                precision highp sampler2D;
                in vec2 vUv;
                out vec4 fragColor;
                uniform sampler2D uTile;
                uniform vec2 uGridOffset;
                uniform float uGridSize;
                uniform float uPatch;
                uniform float uTime;
                ${SWELL_GLSL}

                void main() {
                    vec2 worldPos = (vUv - 0.5) * uGridSize + uGridOffset;
                    vec4 field = texture(uTile, worldPos / uPatch);
                    vec4 swell = macroSwell(worldPos, uTime);
                    fragColor = vec4(field.rgb + swell.xyz, field.a + swell.w);
                }
            `,
            uniforms: {
                uTile: { value: this.tileTarget.texture },
                uGridOffset: { value: new THREE.Vector2(0, 0) },
                uGridSize: { value: 1000 },
                uPatch: { value: this.patchSize },
                uTime: { value: 0 },
                uSwellAmp: { value: 0 },
                uSwellLen: { value: 300 },
                uSwellDir: { value: new THREE.Vector2(1, 0) },
                uSwellSteep: { value: 0.6 },
                uTide: { value: 0 },
            },
        });
    }

    _runPass(material, target) {
        this.quad.material = material;
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.quadScene, this.quadCamera);
    }

    /**
     * Rebuild the seed spectrum and renormalise the height gain. Cheap to call,
     * but only needs to run when wind, patch or wave-height settings change.
     */
    setParams({ windSpeed, windDir, waveHeight, choppiness, swellSpread, rippleCutoff }) {
        this.choppiness = choppiness;

        const u = this.h0Material.uniforms;
        u.uWindSpeed.value = windSpeed;
        u.uWindDir.value.copy(windDir);
        u.uSwellSpread.value = swellSpread;
        u.uRipple.value = rippleCutoff;
        this._runPass(this.h0Material, this.h0Target);

        // Integrate the spectrum RMS so waveHeight maps to metres of RMS height
        // at the reference wind, then grow it with the square of the wind so
        // a stronger wind raises the sea instead of flattening it
        const rms = this._spectrumRms(windSpeed, windDir, swellSpread, rippleCutoff);
        this.heightScale = waveHeight * windGain(windSpeed) / Math.max(rms, 1e-6);
        this.resolveMaterial.uniforms.uHeightScale.value = this.heightScale;
        this.resolveMaterial.uniforms.uChoppiness.value = choppiness;

        this.renderer.setRenderTarget(null);
    }

    /** Update the analytic macro-swell uniforms on the patch resolve. */
    setSwell({ amplitude, wavelength, dir, steepness }) {
        const u = this.patchMaterial.uniforms;
        u.uSwellAmp.value = amplitude;
        u.uSwellLen.value = wavelength;
        u.uSwellDir.value.copy(dir);
        u.uSwellSteep.value = steepness;
    }

    /** Per-frame tidal water-level offset baked into the displacement field. */
    setTide(offset) {
        this.patchMaterial.uniforms.uTide.value = offset;
    }

    _spectrumRms(windSpeed, windDir, swellSpread, rippleCutoff) {
        const N = this.size;
        const L = windSpeed * windSpeed / GRAVITY;
        const wx = windDir.x;
        const wy = windDir.y;
        let sum = 0;
        for (let j = 0; j < N; j++) {
            const ny = j - N / 2;
            for (let i = 0; i < N; i++) {
                const nx = i - N / 2;
                const kx = TWO_PI * nx / this.patchSize;
                const ky = TWO_PI * ny / this.patchSize;
                const kk = kx * kx + ky * ky;
                if (kk < 1e-12) continue;
                const kl = Math.sqrt(kk);
                const kL = kl * L;
                let ph = PHILLIPS_A * Math.exp(-1.0 / (kL * kL)) / (kk * kk);
                const kdotw = (kx * wx + ky * wy) / kl;
                const octave = Math.min(Math.max(
                    Math.log2(Math.max(kL * Math.SQRT2, 1.0)) * 0.25, 0.0), 1.0);
                const spread = swellSpread + (2.0 - swellSpread) * octave;
                ph *= Math.pow(Math.abs(kdotw), spread);
                if (kdotw < 0) ph *= 0.07;
                ph *= Math.exp(-kk * rippleCutoff * rippleCutoff);
                sum += ph;
            }
        }
        return Math.sqrt(sum);
    }

    /** Evolve the spectrum and inverse-transform it to the spatial tile. */
    update(time) {
        this.spectrumMaterial.uniforms.uTime.value = time;
        this._runPass(this.spectrumMaterial, this.pingA);

        let src = this.pingA;
        let dst = this.pingB;
        this.butterflyMaterial.uniforms.uDirection.value = 0;
        for (let stage = 0; stage < this.stages; stage++) {
            this.butterflyMaterial.uniforms.uStage.value = stage;
            this.butterflyMaterial.uniforms.uInput.value = src.texture;
            this._runPass(this.butterflyMaterial, dst);
            [src, dst] = [dst, src];
        }
        this.butterflyMaterial.uniforms.uDirection.value = 1;
        for (let stage = 0; stage < this.stages; stage++) {
            this.butterflyMaterial.uniforms.uStage.value = stage;
            this.butterflyMaterial.uniforms.uInput.value = src.texture;
            this._runPass(this.butterflyMaterial, dst);
            [src, dst] = [dst, src];
        }

        this.resolveMaterial.uniforms.uInput.value = src.texture;
        this._runPass(this.resolveMaterial, this.tileTarget);
        this.renderer.setRenderTarget(null);
    }

    /** Tile the spatial tile into the camera-centred displacement patch. */
    resolveToPatch(target, gridOffset, gridSize, time) {
        const u = this.patchMaterial.uniforms;
        u.uGridOffset.value.copy(gridOffset);
        u.uGridSize.value = gridSize;
        u.uTime.value = time;
        this._runPass(this.patchMaterial, target);
        this.renderer.setRenderTarget(null);
    }

    get tileTexture() {
        return this.tileTarget.texture;
    }

    dispose() {
        this.h0Target.dispose();
        this.pingA.dispose();
        this.pingB.dispose();
        this.tileTarget.dispose();
        this.butterflyTexture.dispose();
        this.quad.geometry.dispose();
        [this.h0Material, this.spectrumMaterial, this.butterflyMaterial,
            this.resolveMaterial, this.patchMaterial].forEach(m => m.dispose());
    }
}
