// A tileable 3D noise texture (64^3, two independent channels of 4-octave gradient noise), made once at load.
// Fire and smoke read it for their turbulence, and the pilot flame and embers for their flicker.
import * as THREE from 'three';
import { mulberry32 } from '../core/util.js';

const N = 64;

// periodic gradient (Perlin-style) noise with `period` lattice cells across the texture
function gradField(period, rnd) {
  const g = new Float32Array(period * period * period * 3);
  for (let i = 0; i < g.length; i += 3) {
    let x, y, z, l;
    do { x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1; l = x * x + y * y + z * z; } while (l > 1 || l < 1e-3);
    l = Math.sqrt(l); g[i] = x / l; g[i + 1] = y / l; g[i + 2] = z / l;
  }
  return g;
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);

function octave(out, period, amp, rnd) {
  const g = gradField(period, rnd), s = period / N, P = period;
  const idx = (x, y, z) => (((z % P) * P + (y % P)) * P + (x % P)) * 3;
  for (let z = 0; z < N; z++) {
    const fz = z * s, zi = Math.floor(fz), tz = fz - zi, wz = fade(tz);
    for (let y = 0; y < N; y++) {
      const fy = y * s, yi = Math.floor(fy), ty = fy - yi, wy = fade(ty);
      for (let x = 0; x < N; x++) {
        const fx = x * s, xi = Math.floor(fx), tx = fx - xi, wx = fade(tx);
        let c000, c100, c010, c110, c001, c101, c011, c111, k;
        k = idx(xi, yi, zi); c000 = g[k] * tx + g[k + 1] * ty + g[k + 2] * tz;
        k = idx(xi + 1, yi, zi); c100 = g[k] * (tx - 1) + g[k + 1] * ty + g[k + 2] * tz;
        k = idx(xi, yi + 1, zi); c010 = g[k] * tx + g[k + 1] * (ty - 1) + g[k + 2] * tz;
        k = idx(xi + 1, yi + 1, zi); c110 = g[k] * (tx - 1) + g[k + 1] * (ty - 1) + g[k + 2] * tz;
        k = idx(xi, yi, zi + 1); c001 = g[k] * tx + g[k + 1] * ty + g[k + 2] * (tz - 1);
        k = idx(xi + 1, yi, zi + 1); c101 = g[k] * (tx - 1) + g[k + 1] * ty + g[k + 2] * (tz - 1);
        k = idx(xi, yi + 1, zi + 1); c011 = g[k] * tx + g[k + 1] * (ty - 1) + g[k + 2] * (tz - 1);
        k = idx(xi + 1, yi + 1, zi + 1); c111 = g[k] * (tx - 1) + g[k + 1] * (ty - 1) + g[k + 2] * (tz - 1);
        const x00 = c000 + (c100 - c000) * wx, x10 = c010 + (c110 - c010) * wx, x01 = c001 + (c101 - c001) * wx, x11 = c011 + (c111 - c011) * wx;
        const y0 = x00 + (x10 - x00) * wy, y1 = x01 + (x11 - x01) * wy;
        out[(z * N + y) * N + x] += (y0 + (y1 - y0) * wz) * amp;
      }
    }
  }
}

// Builds the texture; await between channels so the loading screen stays responsive.
export async function makeNoise3D(step = async () => {}) {
  const data = new Uint8Array(N * N * N * 2);
  for (let ch = 0; ch < 2; ch++) {
    const rnd = mulberry32(9001 + ch * 77), f = new Float32Array(N * N * N);
    octave(f, 4, 0.55, rnd); octave(f, 8, 0.28, rnd); octave(f, 16, 0.14, rnd); octave(f, 32, 0.07, rnd);
    let lo = Infinity, hi = -Infinity;
    for (const v of f) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let i = 0; i < f.length; i++) data[i * 2 + ch] = Math.round((f[i] - lo) / (hi - lo) * 255);
    await step((ch + 1) / 2);
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGFormat; tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  noiseUniform.value = tex;
  return tex;
}
// the texture, once made: materials share this uniform object and see it filled in
export const noiseUniform = { value: null };
