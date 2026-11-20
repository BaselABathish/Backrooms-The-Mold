// The start screen: shown at once, its Start button waits for loading to finish.
import { $ } from '../core/util.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

let loadEl = null, playBtn = null;
export function buildStart({ kicker, title, text, onStart }) {
  const card = $('startCard');
  card.replaceChildren();
  card.append(el('div', 'kicker', kicker), el('h1', null, title));
  for (const p of text.split(/\n\s*\n/)) card.append(el('p', 'brief', p.trim()));
  const row = el('div', 'go-row');
  playBtn = el('button', 'go', 'Start'); playBtn.onclick = onStart; playBtn.disabled = true;
  row.append(playBtn);
  card.append(row);
  loadEl = el('div', 'load');
  const bar = el('div', 'bar'); bar.append(el('i'));
  loadEl.append(bar, el('p', null, 'Loading…'));
  card.append(loadEl);
  card.append(el('p', 'keys desk', 'WASD move · mouse look · Shift run · hold left mouse or Space: fire\nE use (doors, generators, fuel) · F weapon light · C crouch (or hold Ctrl) · V camcorder FX on/off · Q resolution'));
  card.append(el('p', 'keys mob', 'Left thumb: move (push to the edge to run) · Right thumb: look\nHold FIRE to fire (drag it to aim) · USE (doors, generators, fuel) · LIGHT · CROUCH'));
}
export const hideStart = () => { $('start').style.display = 'none'; };
export function setStartProgress(f, text) {
  if (!loadEl) return;
  loadEl.querySelector('i').style.width = `${Math.round(Math.min(Math.max(f, 0), 1) * 100)}%`;
  if (text) loadEl.querySelector('p').textContent = text;
}
export function startReady() {
  if (playBtn) playBtn.disabled = false;
  if (loadEl) { setStartProgress(1, 'Ready'); loadEl.classList.add('done'); }
}
