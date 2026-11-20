// The body camera's cover glass: the window in front of the lens, never quite clean. Oily smudges, a curved wipe where a
// sleeve once cleaned it, a fingerprint, and dust. They're out of focus (millimetres from the lens), so they never show
// as marks; they show only by scattering light, as a haze and smears around bright lights and fire, always in the same
// places on the picture. Drawn once at load into a small texture:
//   r: how much each part of the glass scatters light (smudges, fingerprint, dust)
//   g: the wipe, which scatters along its stroke (light smears into a streak there)
import * as THREE from 'three';
import { mulberry32 } from '../core/util.js';

export function makeCoverGlass() {
  const W = 320, H = 180, rnd = mulberry32(7731), R = (a, b) => a + (b - a) * rnd();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  // oily smudges: clusters of soft blobs, mostly toward the edges (where a thumb or glove touches it)
  for (let k = 0; k < 6; k++) {
    const edge = rnd() < 0.7, cx = edge ? (rnd() < 0.5 ? R(0, W * 0.3) : R(W * 0.7, W)) : R(W * 0.3, W * 0.7), cy = R(H * 0.15, H), s = R(18, 60);
    for (let j = 0; j < 7; j++) {
      const x = cx + R(-s, s), y = cy + R(-s * 0.6, s * 0.6), r = R(s * 0.3, s);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${Math.round(R(40, 90))},0,0,1)`); gr.addColorStop(1, 'rgba(0,0,0,1)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }
  // a fingerprint low on one side: faint concentric ridges
  {
    const x = R(W * 0.68, W * 0.85), y = R(H * 0.62, H * 0.85);
    g.filter = 'blur(1.5px)';
    for (let r = 4; r < 28; r += 2.2) {
      g.strokeStyle = `rgba(${Math.round(55 * (1 - r / 30))},0,0,1)`; g.lineWidth = 1;
      g.beginPath(); g.ellipse(x, y, r * 1.25, r, 0.5, 0.3, 5.9); g.stroke();
    }
    g.filter = 'none';
  }
  // the wipe: a long arc across a corner, scattering along its stroke
  g.filter = 'blur(5px)';
  for (let k = 0; k < 2; k++) {
    const x0 = R(-20, W * 0.35), y0 = R(H * 0.55, H + 10), x1 = x0 + R(W * 0.35, W * 0.6), y1 = R(-10, H * 0.35);
    g.strokeStyle = `rgba(0,${Math.round(R(90, 150))},0,1)`; g.lineWidth = R(10, 22);
    g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2 + R(-40, 40), (y0 + y1) / 2 + R(-30, 30), x1, y1); g.stroke();
  }
  g.filter = 'none';
  // dust: small specks, a little brighter
  g.filter = 'blur(0.8px)';
  for (let k = 0; k < 45; k++) { g.fillStyle = `rgba(${Math.round(R(60, 140))},0,0,1)`; g.beginPath(); g.arc(R(0, W), R(0, H), R(0.6, 1.8), 0, 6.3); g.fill(); }
  g.filter = 'none';
  // a faint film over everything (a camera worn on a vest is never clean)
  g.fillStyle = 'rgba(18,10,0,1)'; g.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  return t;
}
