// What a 90s camcorder burns into the picture: a red ● REC in the top left, and the date stamp in the bottom left (out of
// the flamethrower's way)
// (month, day and year, the time with AM/PM, in the camera's blocky character generator). Redrawn once per second.
// The tape pass composites it before the tape's damage, so it smears, bleeds and jitters with the picture.
// What it shows comes from overlay.source (a story clock, or a clip's own recording time); interference garbles it.
// (Round 7 tried a 5×7 dot font instead, sharper through the tape; the user preferred this one.)
import * as THREE from 'three';
import { makeCanvas } from '../core/util.js';

export const overlayC = makeCanvas(640, 480);
export const overlayTex = new THREE.CanvasTexture(overlayC);
overlayTex.generateMipmaps = false;
overlayTex.minFilter = THREE.LinearFilter;

export const overlay = {
  source: null,   // () => ({ ms, year }); null shows the camcorder's own clock (today's date and time, in 1996)
  glitch: 0,      // 0-1: interference garbles and shakes the text
  rec: true,      // the REC sign
};
const YEAR = 1996;
const realClock = () => ({ ms: Date.now(), year: YEAR });
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const GLYPHS = '0123456789:.APM';
const garble = (s, k) => [...s].map(ch => ch !== ' ' && Math.random() < k ? GLYPHS[Math.random() * GLYPHS.length | 0] : ch).join('');

let lastKey = '';

export function resizeOverlay(w, h) {
  overlayC.width = w; overlayC.height = h;
  overlayTex.dispose(); // GPU storage is fixed-size; reallocate at the new canvas size
  drawOverlay(true);
}

export function drawOverlay(force) {
  const s = (overlay.source || realClock)(), gl = overlay.glitch;
  const key = Math.floor(s.ms / 1000) + (overlay.rec ? 'r' : '') + (gl > 0.04 ? '#' + Math.floor(performance.now() / 70) : '');
  if (!force && key === lastKey) return;
  lastKey = key;
  const g = overlayC.getContext('2d'), W = overlayC.width, Hh = overlayC.height;
  g.clearRect(0, 0, W, Hh);
  // a character generator's blocky capitals: a heavy monospace, a dark edge round each letter
  const fs = Math.max(10, Math.round(Hh * 0.05)), padX = Math.round(W * 0.055), padY = Math.round(Hh * 0.06);
  g.font = `700 ${fs}px "Courier New", Courier, Consolas, monospace`;
  g.textBaseline = 'top'; g.lineJoin = 'miter'; g.lineWidth = Math.max(2, fs * 0.2);
  const d = new Date(s.ms), h12 = d.getHours() % 12 || 12, pm = d.getHours() >= 12;
  let date = `${MON[d.getMonth()]}.${String(d.getDate()).padStart(2, ' ')} ${s.year ?? YEAR}`;
  let time = `${String(h12).padStart(2, ' ')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${pm ? 'PM' : 'AM'}`;
  if (gl > 0.04) { date = garble(date, gl * 0.3); time = garble(time, gl * 0.3); }
  const put = (txt, x, y, fill, align) => {
    if (gl > 0.04 && Math.random() < gl * 0.25) return;   // a line drops out
    const dx = gl > 0.04 ? (Math.random() - 0.5) * gl * fs * 2 : 0;
    g.textAlign = align;
    g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(txt, x + dx, y);
    g.fillStyle = fill; g.fillText(txt, x + dx, y);
  };
  if (overlay.rec) {   // ● REC
    const r = fs * 0.36, cx = padX + r, cy = padY + fs * 0.5;
    g.beginPath(); g.arc(cx, cy, r + g.lineWidth * 0.5, 0, Math.PI * 2); g.fillStyle = 'rgba(0,0,0,0.75)'; g.fill();
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = 'rgb(232,24,18)'; g.fill();
    put('REC', padX + r * 2 + fs * 0.3, padY, 'rgb(232,24,18)', 'left');
  }
  put(time, padX, Hh - padY - fs * 2.3, 'rgba(255,255,255,0.95)', 'left');
  put(date, padX, Hh - padY - fs * 1.15, 'rgba(255,255,255,0.95)', 'left');
  overlayTex.needsUpdate = true;
}
