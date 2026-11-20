// Procedural textures, all drawn into canvases at load (no image files to download). Everything tiles; the large-scale
// variation that would give the tiling away (damp patches, dirt near walls) comes from the baked AO/stain map instead.
import * as THREE from 'three';
import { R, rng, makeCanvas, canvasTex } from '../core/util.js';

// a soft radial blob, drawn again across the edges so the texture still tiles
function blob(g, x, y, rad, rgb, a, W, H) {
  for (const ox of [-W, 0, W]) for (const oy of [-H, 0, H]) {
    const cx = x + ox, cy = y + oy;
    if (cx + rad < 0 || cx - rad > W || cy + rad < 0 || cy - rad > H) continue;
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rad);
    gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr; g.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
  }
}
// per-pixel grain (monochrome, with a little chroma)
function grain(g, W, H, amt, chroma = 0) {
  const id = g.getImageData(0, 0, W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amt, c = (rng() - 0.5) * chroma;
    d[i] += n + c; d[i + 1] += n; d[i + 2] += n - c;
  }
  g.putImageData(id, 0, 0);
}

// ---------------------------------------------------------------- wallpaper
// 1024 x 1280 px = 2.12 m along the wall x 2.6 m (floor to ceiling), so height-dependent grime can be drawn in:
// rows map to height (row 0 = the ceiling). Four strips of paper 0.53 m wide, each hung a little out of line.
export const WALL_W = 2.12, WALL_H = 2.6;
export const wallpaperTex = canvasTex(1024, 1280, (g, W, H) => {
  g.fillStyle = '#d2b25c'; g.fillRect(0, 0, W, H);
  // big soft mottling: the paper has faded unevenly
  for (let k = 0; k < 60; k++) blob(g, R(0, W), R(0, H), R(80, 300), rng() < 0.55 ? '120,98,48' : '235,220,160', R(0.03, 0.07), W, H);
  // the print: per strip, pairs of thin stripes and a small diamond between them, a little out of line strip to strip
  const strip = W / 4;
  for (let s = 0; s < 4; s++) {
    const dy = R(-14, 14), x0 = s * strip;
    for (let k = 0; k < 4; k++) {
      const x = x0 + k * strip / 4 + 6;
      g.fillStyle = 'rgba(92,74,30,0.11)'; g.fillRect(x, 0, 2, H); g.fillRect(x + 5, 0, 1, H);
      g.fillStyle = 'rgba(255,245,200,0.07)'; g.fillRect(x + 2, 0, 3, H);
      for (let y = dy - 120; y < H + 120; y += 64) {   // the diamonds alternate height between columns
        const cx = x + strip / 8, cy = y + (k % 2) * 32;
        g.fillStyle = 'rgba(96,78,34,0.075)';
        g.beginPath(); g.moveTo(cx, cy - 9); g.lineTo(cx + 6, cy); g.lineTo(cx, cy + 9); g.lineTo(cx - 6, cy); g.closePath(); g.fill();
      }
    }
  }
  grain(g, W, H, 9, 3);
  for (let s = 0; s <= 4; s++) {   // seams: a dark hairline with the paper edge catching the light beside it
    const x = s * strip + R(-1, 1);
    g.fillStyle = 'rgba(70,56,24,0.28)'; g.fillRect(x - 1, 0, 1.5, H);
    g.fillStyle = 'rgba(255,248,214,0.12)'; g.fillRect(x + 0.5, 0, 2, H);
    if (rng() < 0.7) {   // a seam lifting near the ceiling or the floor
      const y0 = rng() < 0.5 ? R(0, 60) : R(H - 220, H - 60), len = R(30, 140);
      g.fillStyle = 'rgba(60,46,18,0.25)'; g.fillRect(x - 3, y0, 4, len);
    }
  }
  // ceiling: yellowed and browned along the top edge
  const top = g.createLinearGradient(0, 0, 0, 90);
  top.addColorStop(0, 'rgba(110,84,30,0.35)'); top.addColorStop(1, 'rgba(110,84,30,0)');
  g.fillStyle = top; g.fillRect(0, 0, W, 90);
  // water run-down streaks from the ceiling
  for (let k = 0; k < 9; k++) {
    let x = R(0, W); const len = R(120, 700), w = R(3, 14), a = R(0.03, 0.09);
    for (let y = 0; y < len; y += 4) {
      x += R(-0.6, 0.6);
      const f = 1 - y / len;
      g.fillStyle = `rgba(105,78,34,${a * f})`;
      for (const ox of [-W, 0, W]) g.fillRect(x + ox - w / 2, y, w * (0.6 + 0.4 * f), 4);
    }
  }
  // damp along the floor: wavy tide lines with darker paper below them
  const row = h => H * (1 - h / WALL_H);
  for (let k = 0; k < 3; k++) {
    const base = row(R(0.12, 0.42)), amp = R(6, 26), ph = R(0, 6.28), fr = R(2, 5);
    const wave = x => base + Math.sin(x / W * Math.PI * 2 * Math.round(fr) + ph) * amp + Math.sin(x / W * Math.PI * 2 * 7 + ph * 2) * amp * 0.25;
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, wave(x));
    g.lineTo(W, H); g.closePath();
    const gr = g.createLinearGradient(0, base - amp, 0, H);
    gr.addColorStop(0, 'rgba(98,72,28,0.13)'); gr.addColorStop(1, 'rgba(70,52,20,0.2)');
    g.fillStyle = gr; g.fill();
    g.strokeStyle = 'rgba(88,62,22,0.3)'; g.lineWidth = R(1.5, 3);
    g.beginPath(); for (let x = 0; x <= W; x += 8) (x ? g.lineTo(x, wave(x)) : g.moveTo(x, wave(x))); g.stroke();
  }
  // scuffs and small marks at hand and knee height
  for (let k = 0; k < 40; k++) {
    const x = R(0, W), y = row(R(0.2, 1.5)), len = R(4, 40);
    g.strokeStyle = `rgba(60,48,26,${R(0.05, 0.16)})`; g.lineWidth = R(0.8, 2);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + R(-4, 4)); g.stroke();
  }
});

// ---------------------------------------------------------------- carpet: 1024 px = 2 m, low-pile, damp
export const CARPET_M = 2;
export const carpetTex = canvasTex(1024, 1024, (g, W, H) => {
  g.fillStyle = '#86714a'; g.fillRect(0, 0, W, H);
  for (let k = 0; k < 90; k++) blob(g, R(0, W), R(0, H), R(40, 220), rng() < 0.6 ? '62,50,28' : '170,150,100', R(0.04, 0.1), W, H);
  // tufted rows, barely there
  g.fillStyle = 'rgba(40,32,18,0.05)';
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
  // fibres: speckle at two sizes, then soften so it reads as pile, not noise
  for (let k = 0; k < 60000; k++) {
    const dark = rng() < 0.55;
    g.fillStyle = dark ? `rgba(48,38,20,${R(0.1, 0.35)})` : `rgba(200,180,128,${R(0.08, 0.25)})`;
    g.fillRect(R(0, W), R(0, H), R(1, 2.5), R(1, 2.5));
  }
  const c2 = makeCanvas(W, H), g2 = c2.getContext('2d');
  g2.filter = 'blur(0.7px)'; g2.drawImage(g.canvas, 0, 0); g.clearRect(0, 0, W, H); g.drawImage(c2, 0, 0);
  grain(g, W, H, 14, 4);
  for (let k = 0; k < 14; k++) blob(g, R(0, W), R(0, H), R(20, 70), '40,30,14', R(0.08, 0.2), W, H);   // old spills
});

// ---------------------------------------------------------------- drop ceiling: 1024 px = 2.4 m, 4 x 4 tiles of 0.6 m
export const CEIL_M = 2.4;
export const ceilTex = canvasTex(1024, 1024, (g, W) => {
  const s = 256;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const v = R(-6, 6), yel = R(0, 8);
    g.fillStyle = `rgb(${222 + v | 0},${214 + v | 0},${186 + v - yel | 0})`; g.fillRect(i * s, j * s, s, s);
  }
  for (let k = 0; k < 14000; k++) { g.fillStyle = `rgba(104,96,76,${R(0.12, 0.4)})`; g.fillRect(R(0, W), R(0, W), R(1, 2.2), R(1, 2.2)); }
  for (let k = 0; k < 900; k++) {   // fissures
    g.strokeStyle = `rgba(110,102,84,${R(0.15, 0.3)})`; g.lineWidth = 1;
    const x = R(0, W), y = R(0, W); g.beginPath(); g.moveTo(x, y); g.lineTo(x + R(-7, 7), y + R(-7, 7)); g.stroke();
  }
  // water-stained tiles: a brown ring with a paler inside
  for (let k = 0; k < 3; k++) {
    const i = (rng() * 4) | 0, j = (rng() * 4) | 0, cx = i * s + R(70, 186), cy = j * s + R(70, 186), r = R(40, 100);
    g.save(); g.beginPath(); g.rect(i * s, j * s, s, s); g.clip();
    blob(g, cx, cy, r * 1.1, '150,110,40', 0.22, W, W);
    g.strokeStyle = 'rgba(120,82,30,0.35)'; g.lineWidth = R(2, 4);
    g.beginPath(); for (let a = 0; a <= 6.3; a += 0.15) { const rr = r * (0.85 + 0.2 * Math.sin(a * 3 + k) + R(-0.04, 0.04)); g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } g.stroke();
    g.restore();
  }
  for (let i = 0; i <= 4; i++) {   // the T-bar grid and the shadow line along it
    g.fillStyle = '#d9d3bd'; g.fillRect(i * s - 5, 0, 10, W); g.fillRect(0, i * s - 5, W, 10);
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(i * s + 5, 0, 2, W); g.fillRect(0, i * s + 5, W, 2);
  }
});

// Troffer lens (prismatic diffuser) with its frame round it. The lens glows brighter over the two tubes behind it; the
// frame is white-painted steel, much dimmer than the lens but not dark (a dark border drew a black outline round every
// light once the lens blew out to white).
export const diffTex = canvasTex(128, 256, (g, W, H) => {
  g.fillStyle = '#e4e0d4'; g.fillRect(0, 0, W, H);
  for (const x of [W * 0.3, W * 0.7]) {
    const gr = g.createLinearGradient(x - 26, 0, x + 26, 0);
    gr.addColorStop(0, 'rgba(255,255,248,0)'); gr.addColorStop(0.5, 'rgba(255,255,248,1)'); gr.addColorStop(1, 'rgba(255,255,248,0)');
    g.fillStyle = gr; g.fillRect(x - 26, 0, 52, H);
  }
  g.fillStyle = 'rgba(0,0,0,0.06)';
  for (let y = 0; y < H; y += 4) for (let x = ((y / 4) % 2) * 2; x < W; x += 4) g.fillRect(x, y, 2, 2);
  g.strokeStyle = 'rgb(28,28,26)'; g.lineWidth = 7; g.strokeRect(0, 0, W, H);   // the frame: dim against the lens's glow
}, { repeat: false });

// soot left by burning fuel: white, with the darkness in alpha. A dense middle fading out through a ragged, blotchy
// edge, so overlapping marks merge into one char instead of reading as separate splats.
export const sootTex = canvasTex(256, 256, (g, W) => {
  const grid = n => Float32Array.from({ length: n * n }, () => rng());
  const g1 = grid(6), g2 = grid(14), g3 = grid(30);
  const sm = t => t * t * (3 - 2 * t);
  const vn = (gr, n, u, v) => {
    const x = u * n, y = v * n, xi = Math.floor(x), yi = Math.floor(y), fx = sm(x - xi), fy = sm(y - yi);
    const at = (i, j) => gr[((j % n + n) % n) * n + ((i % n + n) % n)];
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const id = g.createImageData(W, W), d = id.data;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / W, v = (y + 0.5) / W, r = Math.hypot(u - 0.5, v - 0.5) * 2;
    const n = vn(g1, 6, u, v) * 0.55 + vn(g2, 14, u, v) * 0.3 + vn(g3, 30, u, v) * 0.15;
    const rn = r * (0.7 + 0.7 * n);
    const t = Math.min(Math.max((rn - 0.2) / 0.8, 0), 1);
    const a = (1 - sm(t)) * (0.72 + 0.28 * vn(g3, 30, u * 2 % 1, v * 2 % 1));
    const i = (y * W + x) * 4;
    d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = Math.round(255 * a);
  }
  g.putImageData(id, 0, 0);
}, { repeat: false, srgb: false });

// perforated heat shield round the flamethrower barrel: u goes round it, v along it (v = 1 at the nozzle end).
// Staggered holes, worn black paint, and heat tint (straw, brown, blue) toward the nozzle.
export const shieldTex = canvasTex(256, 512, (g, W, H) => {
  g.fillStyle = '#2a2b2c'; g.fillRect(0, 0, W, H);
  const heat = g.createLinearGradient(0, 0, 0, H);   // canvas top = v 1 = the nozzle end
  heat.addColorStop(0, 'rgba(60,70,110,0.55)'); heat.addColorStop(0.12, 'rgba(110,70,50,0.5)'); heat.addColorStop(0.3, 'rgba(150,120,70,0.25)'); heat.addColorStop(0.55, 'rgba(0,0,0,0)');
  g.fillStyle = heat; g.fillRect(0, 0, W, H);
  for (let k = 0; k < 300; k++) { g.fillStyle = `rgba(150,150,150,${R(0.05, 0.18)})`; g.fillRect(R(0, W), R(0, H), R(1, 8), R(1, 3)); }   // paint worn to bare steel
  g.fillStyle = '#050505';
  for (let row = 0, y = 14; y < H - 10; y += 22, row++) for (let x = (row % 2) * 16 + 8; x < W; x += 32) { g.beginPath(); g.arc(x, y, 6.5, 0, 6.3); g.fill(); }
  grain(g, W, H, 10);
});

// pressure gauge face: 0-300 psi with a red band at the top end
export const gaugeTex = canvasTex(128, 128, (g, W) => {
  const c = W / 2;
  g.fillStyle = '#e9e6dc'; g.beginPath(); g.arc(c, c, c - 2, 0, 6.3); g.fill();
  g.strokeStyle = '#b02a20'; g.lineWidth = 7; g.beginPath(); g.arc(c, c, c - 14, -0.15 * Math.PI, 0.25 * Math.PI); g.stroke();
  g.strokeStyle = '#151515';
  for (let i = 0; i <= 30; i++) {
    const a = Math.PI * (0.75 + 1.5 * i / 30), r0 = i % 5 ? c - 14 : c - 20;
    g.lineWidth = i % 5 ? 1.5 : 3; g.beginPath(); g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0); g.lineTo(c + Math.cos(a) * (c - 8), c + Math.sin(a) * (c - 8)); g.stroke();
  }
  g.fillStyle = '#151515'; g.font = '700 15px Arial'; g.textAlign = 'center'; g.fillText('PSI', c, c + 30);
  g.strokeStyle = '#555'; g.lineWidth = 4; g.beginPath(); g.arc(c, c, c - 2, 0, 6.3); g.stroke();
}, { repeat: false });

// the light's beam pattern (same as the bodycam flashlight's)
export const cookieTex = canvasTex(256, 256, (g, W) => {
  const c = W / 2;
  g.fillStyle = '#000'; g.fillRect(0, 0, W, W);
  const gr = g.createRadialGradient(c, c, 0, c, c, c);
  [[0, 255], [0.1, 248], [0.18, 170], [0.25, 122], [0.28, 127], [0.32, 100], [0.45, 72], [0.75, 42], [0.93, 14], [1, 0]].forEach(([p, v]) => gr.addColorStop(p, `rgb(${v},${v},${Math.round(v * 0.96)})`));
  g.fillStyle = gr; g.fillRect(0, 0, W, W);
  g.filter = 'blur(2px)';
  for (let k = 0; k < 5; k++) { g.strokeStyle = `rgba(255,255,255,${R(0.008, 0.02)})`; g.lineWidth = R(2, 5); g.beginPath(); g.arc(c + R(-3, 3), c + R(-3, 3), R(30, 110), 0, 7); g.stroke(); }
  g.filter = 'none';
}, { repeat: false });

// the reflection pass (render/pipeline.js) reads floor roughness; carpet is fully rough, so it never reflects
export const floorRough = canvasTex(4, 4, (g, W, H) => { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); }, { srgb: false });
export const blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
blackTex.needsUpdate = true;

// ---------------------------------------------------------------- painted concrete block: 1024 px = 2 m, 0.4 x 0.2 m blocks
// (service corridors, crawlspaces; darkened, the dark upper walls of a tall void)
export const BLOCK_M = 2;
export const concreteTex = canvasTex(1024, 1024, (g, W, H) => {
  g.fillStyle = '#b8b4a0'; g.fillRect(0, 0, W, H);
  for (let k = 0; k < 70; k++) blob(g, R(0, W), R(0, H), R(40, 260), rng() < 0.6 ? '96,92,76' : '226,222,204', R(0.03, 0.08), W, H);
  const bw = W / 5, bh = H / 10;
  for (let r = 0; r < 10; r++) {   // running bond; each block painted a little differently, its face pitted
    const off = (r % 2) * bw / 2;
    for (let c = -1; c < 6; c++) {
      const x = c * bw + off, v = R(-7, 7);
      g.fillStyle = `rgba(${120 + v | 0},${116 + v | 0},${98 + v | 0},0.08)`; g.fillRect(x + 3, r * bh + 3, bw - 6, bh - 6);
    }
  }
  for (let k = 0; k < 9000; k++) { g.fillStyle = `rgba(70,66,54,${R(0.08, 0.3)})`; g.fillRect(R(0, W), R(0, H), R(1, 2.4), R(1, 2.4)); }
  for (let r = 0; r <= 10; r++) {   // mortar joints: recessed, a shadow line under a lit edge
    const y = r * bh;
    g.fillStyle = 'rgba(64,60,48,0.35)'; g.fillRect(0, y - 2, W, 4);
    g.fillStyle = 'rgba(255,252,236,0.12)'; g.fillRect(0, y + 2, W, 2);
    const off = (r % 2) * bw / 2;
    for (let c = 0; c <= 5; c++) { const x = c * bw + off; g.fillStyle = 'rgba(64,60,48,0.35)'; g.fillRect(x - 2, y, 4, bh); }
  }
  grain(g, W, H, 10, 2);
  for (let k = 0; k < 7; k++) {   // rust and water run down from something above
    let x = R(0, W); const len = R(150, 800), w = R(4, 16), a = R(0.04, 0.1);
    for (let y = R(0, H); y < len; y += 4) { x += R(-0.5, 0.5); g.fillStyle = `rgba(110,74,36,${a * (1 - y / len)})`; for (const ox of [-W, 0, W]) g.fillRect(x + ox - w / 2, y, w, 4); }
  }
  for (let k = 0; k < 30; k++) { const x = R(0, W), y = R(0, H), len = R(6, 50); g.strokeStyle = `rgba(50,46,36,${R(0.06, 0.18)})`; g.lineWidth = R(0.8, 2.2); g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + R(-5, 5)); g.stroke(); }
});

// ---------------------------------------------------------------- concrete floor: 1024 px = 3 m, sealed, stained, cracked
export const SLAB_M = 3;
export const concreteFloorTex = canvasTex(1024, 1024, (g, W, H) => {
  g.fillStyle = '#8e8b82'; g.fillRect(0, 0, W, H);
  for (let k = 0; k < 110; k++) blob(g, R(0, W), R(0, H), R(30, 260), rng() < 0.6 ? '70,68,60' : '170,166,152', R(0.04, 0.1), W, H);
  for (let k = 0; k < 16; k++) blob(g, R(0, W), R(0, H), R(15, 80), '38,34,28', R(0.12, 0.3), W, H);   // oil and old spills
  for (let k = 0; k < 26000; k++) { g.fillStyle = rng() < 0.5 ? `rgba(60,58,50,${R(0.08, 0.3)})` : `rgba(190,186,172,${R(0.06, 0.2)})`; g.fillRect(R(0, W), R(0, H), R(1, 2), R(1, 2)); }
  grain(g, W, H, 12, 2);
  g.fillStyle = 'rgba(40,38,32,0.45)';   // saw-cut joints every 1.5 m
  for (const p of [0, W / 2]) { g.fillRect(p - 1.5, 0, 3, H); g.fillRect(0, p - 1.5, W, 3); }
  for (let k = 0; k < 12; k++) {   // hairline cracks
    let x = R(0, W), y = R(0, H), a = R(0, 6.28);
    g.strokeStyle = `rgba(36,34,28,${R(0.25, 0.5)})`; g.lineWidth = R(0.7, 1.4); g.beginPath(); g.moveTo(x, y);
    for (let s = 0, n = R(8, 30); s < n; s++) { a += R(-0.6, 0.6); x += Math.cos(a) * R(4, 12); y += Math.sin(a) * R(4, 12); g.lineTo(x, y); }
    g.stroke();
  }
});

// ---------------------------------------------------------------- crawlspace ceiling: fibreglass batts between joists, 1024 px = 1.6 m
export const INSUL_M = 1.6;
export const insulationTex = canvasTex(1024, 1024, (g, W, H) => {
  g.fillStyle = '#d7b98a'; g.fillRect(0, 0, W, H);
  for (let k = 0; k < 60; k++) blob(g, R(0, W), R(0, H), R(30, 160), rng() < 0.5 ? '205,150,120' : '160,128,80', R(0.08, 0.2), W, H);
  for (let k = 0; k < 14000; k++) {   // the fibres: short tangled strokes, light and dark
    const x = R(0, W), y = R(0, H), a = R(0, 6.28), l = R(3, 12);
    g.strokeStyle = rng() < 0.5 ? `rgba(120,88,52,${R(0.08, 0.22)})` : `rgba(245,226,190,${R(0.08, 0.22)})`; g.lineWidth = R(0.6, 1.4);
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + R(-4, 4), y + R(-4, 4), x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  grain(g, W, H, 14, 5);
  for (let j = 0; j < 4; j++) {   // joists every 0.4 m: dark old timber, with the batts bulging against them
    const x = (j + 0.5) * W / 4;
    const gr = g.createLinearGradient(x - 40, 0, x + 40, 0);
    gr.addColorStop(0, 'rgba(60,44,24,0)'); gr.addColorStop(0.35, 'rgba(60,44,24,0.45)'); gr.addColorStop(0.5, 'rgba(60,44,24,0.6)'); gr.addColorStop(0.65, 'rgba(60,44,24,0.45)'); gr.addColorStop(1, 'rgba(60,44,24,0)');
    g.fillStyle = gr; g.fillRect(x - 40, 0, 80, H);
    g.fillStyle = '#5a4428'; g.fillRect(x - 12, 0, 24, H);
    for (let k = 0; k < 40; k++) { g.fillStyle = `rgba(30,20,10,${R(0.1, 0.3)})`; g.fillRect(x - 12, R(0, H), 24, R(1, 3)); }   // grain
  }
  for (let k = 0; k < 6; k++) { const x = R(0, W), y = R(0, H); blob(g, x, y, R(40, 120), '120,100,70', 0.25, W, H); }   // sagging, water-stained
});
