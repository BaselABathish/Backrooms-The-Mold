// Page-level UI: the letterboxed 16:9 frame, toasts, the controls hint, buttons.
// Kept minimal: real body camera footage has no HUD, so these sit outside the "recording" and fade away.
import { $ } from '../core/util.js';

// the frame is always 4:3 (90s video), centred with black bars
export function layoutCanvas(canvas) {
  const W = innerWidth, Hh = innerHeight;
  let w = W, h = W * 3 / 4;
  if (h > Hh) { h = Hh; w = Hh * 4 / 3; }
  w = Math.floor(w); h = Math.floor(h);
  Object.assign(canvas.style, { width: w + 'px', height: h + 'px', left: Math.floor((W - w) / 2) + 'px', top: Math.floor((Hh - h) / 2) + 'px' });
}

let toastTimer = 0;
export function toast(msg, seconds = 1.4) {
  const el = $('toast');
  el.textContent = msg; el.style.opacity = 1;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.style.opacity = 0; }, seconds * 1000);
}

export function showHint(show) { $('hint').style.display = show ? 'block' : 'none'; }
export function setButtonOn(id, on) { $(id)?.classList.toggle('on', on); }
