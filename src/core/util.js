// Small shared helpers: seeded randomness, math, and canvas-texture utilities.
import * as THREE from 'three';

export const $ = id => document.getElementById(id);

export function mulberry32(a) {
  return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export const rng = mulberry32(20261118);   // seeded: the level and its textures come out the same every load
export const R = (a, b) => a + (b - a) * rng();
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// cheap smooth noise for camera shake: a few incommensurate sines
export const shk = t => Math.sin(t * 1.7) * 0.5 + Math.sin(t * 2.9 + 1.3) * 0.3 + Math.sin(t * 5.3 + 2.1) * 0.2 + Math.sin(t * 11.1 + 0.4) * 0.08;

export function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
export function toTex(c, { srgb = true, repeat = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
export function canvasTex(w, h, draw, opts) { const c = makeCanvas(w, h); draw(c.getContext('2d'), w, h); return toTex(c, opts); }
export function fitText(g, text, maxW, size, weight = '700', family = 'Arial, Helvetica, sans-serif') {
  let s = size; do { g.font = `${weight} ${s}px ${family}`; s -= 1; } while (g.measureText(text).width > maxW && s > 6);
}
