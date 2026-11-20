// Input: keyboard + mouse (pointer lock, or click-and-drag where pointer lock is blocked), and touch (left side =
// joystick, right side = look, a FIRE button that also looks while you hold and drag it). Touch works anywhere on
// screen, including the letterbox bars. While a panel is open (state.ui) look and move input is ignored.
//   Fire: left mouse button (once the pointer is locked), or Space. Where the pointer can't lock (dragging looks), the
//   right mouse button or Space fires. Use (doors, a generator, fuel cans): E, or the USE button on a phone.
import { canvas, isTouch } from '../core/context.js';
import { $, clamp } from '../core/util.js';
import { state } from '../state.js';
import { P, keys, stick, auto } from '../player/player.js';
import { showHint } from '../ui/hud.js';

export const lockPointer = () => { if (isTouch) return; try { const p = canvas.requestPointerLock?.(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not allowed here */ } };

export function initInput({ onFlash, onFx, onQuality, onCrouch }) {
  const inputEl = $('input');
  let dragging = false, mouseFire = false, keyFire = false, touchFire = false;
  const looking = () => state.started && !state.ui && !auto.on;
  const syncTrigger = () => { state.trigger = looking() && (mouseFire || keyFire || touchFire); };

  inputEl.addEventListener('mousedown', e => {
    if (e.button === 2 && looking()) { mouseFire = true; syncTrigger(); return; }
    dragging = true;
    if (looking() && !isTouch && document.pointerLockElement !== canvas) lockPointer();
  });
  inputEl.addEventListener('contextmenu', e => e.preventDefault());
  // with the pointer locked, mouse events go to the canvas
  document.addEventListener('mousedown', e => {
    if (document.pointerLockElement === canvas && (e.button === 0 || e.button === 2)) { mouseFire = true; syncTrigger(); }
  });
  addEventListener('mouseup', () => { dragging = false; mouseFire = false; syncTrigger(); });
  // right after the pointer locks, some browsers report one bogus, huge movement (the jump to the centre): skip it
  let skip = 0;
  document.addEventListener('pointerlockchange', () => {
    skip = 2; showHint(looking() && !isTouch && document.pointerLockElement !== canvas);
    if (document.pointerLockElement !== canvas) { mouseFire = false; syncTrigger(); }
  });
  document.addEventListener('mousemove', e => {
    if (!looking() || (document.pointerLockElement !== canvas && !dragging)) return;
    if (skip > 0 && document.pointerLockElement === canvas) { skip--; if (Math.abs(e.movementX) + Math.abs(e.movementY) > 40) return; }
    if (Math.abs(e.movementX) > 500 || Math.abs(e.movementY) > 500) return;
    P.aimYaw -= e.movementX * 0.0022; P.aimPitch = clamp(P.aimPitch - e.movementY * 0.0022, -1.25, 1.25);
  });

  addEventListener('keydown', e => {
    if (e.target?.tagName === 'INPUT') return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    if (!state.started || state.ui) return;
    keys[e.code] = true;
    if (e.code === 'Space') { keyFire = true; syncTrigger(); }
    if (e.code === 'KeyE') { if (!e.repeat) state.usePressed = true; state.use = true; }
    if (e.code === 'KeyF' && !e.repeat) onFlash();
    if (e.code === 'KeyV' && !e.repeat) onFx();
    if (e.code === 'KeyQ' && !e.repeat) onQuality();
    if (e.code === 'KeyC' && !e.repeat) onCrouch(!state.crouch);
    if ((e.code === 'ControlLeft' || e.code === 'ControlRight') && !e.repeat) onCrouch(true);
  });
  addEventListener('keyup', e => {
    keys[e.code] = false;
    if (e.code === 'Space') { keyFire = false; syncTrigger(); }
    if (e.code === 'KeyE') state.use = false;
    if (e.code === 'ControlLeft' || e.code === 'ControlRight') onCrouch(false);
  });
  addEventListener('blur', () => { for (const k in keys) keys[k] = false; mouseFire = keyFire = touchFire = false; state.use = false; syncTrigger(); });
  // USE (phones): shown while there's something to use; hold it to pour fuel
  const useEl = $('bUse');
  useEl?.addEventListener('touchstart', e => { e.preventDefault(); e.stopPropagation(); if (!looking()) return; state.use = true; state.usePressed = true; useEl.classList.add('on'); }, { passive: false });
  const endUse = () => { state.use = false; useEl.classList.remove('on'); };
  useEl?.addEventListener('touchend', endUse); useEl?.addEventListener('touchcancel', endUse);

  for (const [id, fn] of [['bLight', onFlash], ['bFx', onFx], ['bQ', onQuality], ['bCrouch', () => onCrouch(!state.crouch)]]) {
    const b = $(id);
    if (!b || !fn) continue;
    b.addEventListener('click', e => { e.stopPropagation(); fn(); b.blur(); });
    b.addEventListener('touchstart', e => e.stopPropagation(), { passive: true });
  }

  // touch: the joystick (left), looking (right), and FIRE: hold it to fire, drag it to aim while firing
  const stickEl = $('stick'), knob = $('knob'), fireEl = $('bFire');
  let moveId = null, lookId = null, fireId = null, mox = 0, moy = 0, lx = 0, ly = 0, fx = 0, fy = 0;
  const look = (dx, dy) => { P.aimYaw -= dx * 0.0055; P.aimPitch = clamp(P.aimPitch - dy * 0.0055, -1.25, 1.25); };
  fireEl.addEventListener('touchstart', e => {
    e.preventDefault(); e.stopPropagation();
    if (!looking() || fireId !== null) return;
    const t = e.changedTouches[0]; fireId = t.identifier; fx = t.clientX; fy = t.clientY;
    touchFire = true; syncTrigger(); fireEl.classList.add('on');
  }, { passive: false });
  fireEl.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === fireId && looking()) { look(t.clientX - fx, t.clientY - fy); fx = t.clientX; fy = t.clientY; }
  }, { passive: false });
  const endFire = e => {
    for (const t of e.changedTouches) if (t.identifier === fireId) { fireId = null; touchFire = false; syncTrigger(); fireEl.classList.remove('on'); }
  };
  fireEl.addEventListener('touchend', endFire);
  fireEl.addEventListener('touchcancel', endFire);
  inputEl.addEventListener('touchstart', e => {
    e.preventDefault();
    if (!looking()) return;
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.45 && moveId === null) {
        moveId = t.identifier; mox = t.clientX; moy = t.clientY;
        stickEl.style.left = mox + 'px'; stickEl.style.top = moy + 'px'; stickEl.style.display = 'block'; knob.style.transform = '';
      } else if (lookId === null) { lookId = t.identifier; lx = t.clientX; ly = t.clientY; }
    }
  }, { passive: false });
  inputEl.addEventListener('touchmove', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) {
        let dx = t.clientX - mox, dy = t.clientY - moy; const d = Math.hypot(dx, dy), m = 55;
        if (d > m) { dx *= m / d; dy *= m / d; }
        stick.x = dx / m; stick.y = dy / m; stick.mag = Math.min(d / m, 1);
        knob.style.transform = `translate(${dx}px,${dy}px)`;
      } else if (t.identifier === lookId && looking()) { look(t.clientX - lx, t.clientY - ly); lx = t.clientX; ly = t.clientY; }
    }
  }, { passive: false });
  const endTouch = e => {
    for (const t of e.changedTouches) {
      if (t.identifier === moveId) { moveId = null; stick.x = stick.y = stick.mag = 0; stickEl.style.display = 'none'; }
      if (t.identifier === lookId) lookId = null;
    }
  };
  inputEl.addEventListener('touchend', endTouch);
  inputEl.addEventListener('touchcancel', endTouch);
}
