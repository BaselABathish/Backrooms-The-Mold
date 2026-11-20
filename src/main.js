// Backrooms (working title): entry point. Shows the start screen at once, builds the level behind it (with a progress
// bar), makes the noise the fire and the mold are drawn with, compiles every shader so play starts without a stall,
// wires input, and runs the 30 fps loop. The level is a graph of rooms made as you go (world/level.js), starting in the
// hall of the old test room. If the mold reaches you, it takes the camera: the end (die()); one death ends the run.
//   ?dev=1  nothing yet;  window.__br  debugging and measuring hooks (see the bottom of this file)
import * as THREE from 'three';
import { canvas, isTouch, renderer, scene, camera } from './core/context.js';
import { state, flags, fx } from './state.js';
import { world } from './world/world.js';
import { shared } from './world/materials.js';
import { buildLevel, updateLevel, SPAWN, rooms as levelRooms, insts as levelInsts, current as levelCurrent, reconcile, graphCfg, moldYou, moldContactAt, moldNearbyAt, moldSeedAt, DEPTH, gotoRoom, visitNew, levelStats } from './world/level.js';
import { P, keys, auto, updatePlayer, teleport } from './player/player.js';
import { initAudio, updateAudio, setAudioSuspended, setMold, cough, choke, setMuted } from './audio/audio.js';
import { initInput, lockPointer } from './input/input.js';
import { RES, resizePipeline, renderFrame, profilePasses, postUniforms, readExposure, fxLayer, fxCoverage, glitchDoorway } from './render/pipeline.js';
import { toast, layoutCanvas, setButtonOn, showHint } from './ui/hud.js';
import { overlayC } from './ui/overlay.js';
import { buildStart, hideStart, setStartProgress, startReady } from './ui/screens.js';
import { colliders } from './world/builder.js';
import { makeNoise3D } from './weapon/noise3d.js';
import { updateWeapon, weapon, wand } from './weapon/flamethrower.js';
import { updateInteract, doors } from './world/interact.js';
import { updateFire, fireStats, clearFire, clearFireIn, cfg as fireCfg, fires, nozzle, fireMat } from './weapon/fire.js';
import { updateScorch } from './weapon/scorch.js';
import { updateMold, stats as moldStats, colonies, cfg as moldCfg, clearMold, moldState } from './game/mold.js';
import { CELL } from './world/surfaces.js';
import { smooth } from './core/util.js';

const params = new URLSearchParams(location.search);
const bootLog = [['modules loaded', Math.round(performance.now())]];
document.body.classList.toggle('touch', isTouch);
state.qi = isTouch ? 0 : 1;   // phones record at 360 lines, desktops at 480 (NTSC's)

function setFlash(on, quiet) { state.flashOn = on; renderer.shadowMap.needsUpdate = true; setButtonOn('bLight', on); if (!quiet) toast(on ? 'Light on' : 'Light off'); }
function setFx(on) { state.fx = on; setButtonOn('bFx', on); resizePipeline(); toast(on ? 'Camcorder FX on' : 'FX off: plain game camera'); }
function setQuality(i) { state.qi = i; resizePipeline(); }
function cycleQuality() { setQuality((state.qi + 1) % RES.length); toast(`Recording at ${RES[state.qi][1]}p`); }
function setCrouch(on) { state.crouch = on; setButtonOn('bCrouch', on); }

let ready = false;
function start() {
  if (!ready || state.started) return;
  hideStart(); state.started = true; initAudio();
  document.body.classList.add('playing');
  if (!isTouch) { lockPointer(); showHint(true); }
}
buildStart({
  kicker: 'PROTOTYPE', title: 'THE MOLD',
  text: `The backrooms, and something growing in them. Black mold has filled the end of the dark corridor past the far doorway, and it's spreading. It creeps toward you; when you aren't watching, it rushes. Burn it back with the flamethrower.

The rooms go on. The way back isn't always the way you came. Don't let it reach your feet.

Your fuel is on the gauge. Safe rooms are lit and dry, behind a steel door: the mold can't grow there while the generator runs, and it runs on the same fuel you burn.`,
  onStart: start,
});
document.title = 'Backrooms — the mold';
layoutCanvas(canvas);
addEventListener('resize', () => layoutCanvas(canvas));
resizePipeline();

// A tube that's flickering throws electrical noise; the camera picks it up close by as faint interference (a few torn
// rows, the gain pumping): the only static in the picture until something worse comes along.
function tubeInterference() {
  let emi = 0;
  for (const f of world.fixtures) if (f.burst > 0) emi = Math.max(emi, 0.14 / (1 + ((f.x - P.x) ** 2 + (f.z - P.z) ** 2) * 0.35));
  return emi * (0.6 + 0.4 * Math.random());
}

// ---------------------------------------------------------------- the mold, and the end
// Close to mold you breathe its spores (coughing); if it reaches your feet and stays there for a moment, it takes you:
// it grows over the lens from the edges, the signal breaks up and the footage ends.
const camDir = new THREE.Vector3();
let touch = 0, coughT = 4, end = null;
function moldAround(dt) {
  updateMold(dt, moldYou(P.x, P.z));
  const near = moldNearbyAt(P.x, 1.0, P.z, 2.2);
  let rush = 0;
  for (let k = 1; k < colonies.length; k++) if (colonies[k].mode === 'rush') rush = Math.max(rush, 1 - Math.min(1, colonies[k].lastTipDist * CELL / 9));
  setMold(near, rush);
  if (near > 0.3 && !end && (coughT -= dt) <= 0) { cough(); coughT = 5 + Math.random() * 7 - near * 3; P.exert = Math.min(1, P.exert + 0.3); }
  if (end) return;
  touch = moldContactAt(P.x, P.z) > 0.5 ? touch + dt : Math.max(0, touch - dt * 2);
  if (touch > 0.7) die();
}
function die() {
  end = { t: 0, cut: false, card: false };
  state.ui = 'dead'; state.trigger = false;
  for (const k in keys) keys[k] = false;
  choke();
}
function updateEnd(dt) {
  end.t += dt;
  fx.lens = smooth(0, 3.0, end.t);
  fx.interf = Math.max(fx.interf, 0.12 + 0.85 * smooth(1.6, 3.2, end.t));
  fx.corrupt = smooth(2.5, 3.3, end.t);
  if (end.t > 3.3 && !end.cut) { end.cut = true; document.getElementById('nosig').style.display = 'flex'; setMuted(true); }
  if (end.t > 4.6 && !end.card) {
    end.card = true; document.getElementById('end').style.display = 'flex'; document.getElementById('nosig').style.display = 'none';
    document.body.classList.remove('playing');   // (hides the touch FIRE button)
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
document.getElementById('again').onclick = () => location.reload();
const promptEl = document.getElementById('prompt');
let promptText = '';

// one step of the world
function update(dt) {
  updatePlayer(dt);
  updateLevel(dt, P.x, P.z);
  // water: reflections only while a flooded room is near; the rings round your feet as you wade
  flags.ssr = world.wetNear;
  shared.uTimeW.value = P.t;
  shared.uRipple.value.set(P.x, P.z, world.inWater ? smooth(0.2, 1.4, P.speed) : 0, 0);
  fx.interf = tubeInterference();
  updateWeapon(dt);
  // what you're facing and can use: a door, a generator, a fuel can (the prompt sits outside the picture)
  const said = end ? '' : updateInteract(dt, levelInsts, camera, { held: state.use, pressed: state.usePressed }, isTouch);
  state.usePressed = false;
  if (said !== promptText) { promptText = said; promptEl.textContent = said; document.body.classList.toggle('near', !!said); }
  updateFire(dt, P.t);
  updateScorch(dt);
  moldAround(dt);
  if (end) updateEnd(dt);
  updateAudio(P, world.fixtures, state.yawRate);
}
const step = dt => { update(dt); renderFrame(dt, P); };

// 30 frames a second, like NTSC video
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (window.__br?.paused) { last = now; renderFrame(1 / 30, P); return; }   // debug: hold the world still
  const el = (now - last) / 1000;
  if (el < 1 / 30 - 0.004) return;
  last = now;
  const dt = Math.min(el, 0.1);
  update(dt);
  if (state.fx && state.started && Math.random() < fx.drop) return;   // (tape doesn't drop frames; only damage does)
  renderFrame(dt, P);
}

// ---------------------------------------------------------------- loading
// Build in steps (the page stays responsive and the bar moves), then compile every shader the level can need, the fire
// layer's included, and draw a couple of frames behind the start screen: no stall when play starts or fire first shows.
// Waits between steps use scheduler.yield or a MessageChannel, never timers (throttled in a background tab).
const yieldToPage = () => globalThis.scheduler?.yield ? globalThis.scheduler.yield()
  : new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
async function progress(f, text) {
  setStartProgress(f, text);
  bootLog.push([text || `${Math.round(f * 100)}%`, Math.round(performance.now())]);
  await yieldToPage();
}
async function warmUp() {
  for (const s of [scene, fxLayer.scene]) { try { await renderer.compileAsync(s, camera); } catch (e) { renderer.compile(s, camera); } }
  fxLayer.count = 1;   // run the fire layer's passes once too (nothing is drawn in it yet), so they're compiled now
  renderer.shadowMap.needsUpdate = true;   // and the weapon light's shadow map (its shader compiled on the first F press)
  flags.ssr = true;   // (and the water's reflection pass, which only runs near a flooded room)
  for (let i = 0; i < 2; i++) renderFrame(1 / 30, P);
  flags.ssr = false;
  fxLayer.count = 0;
}
async function boot() {
  await progress(0.02, 'Loading the backrooms…');
  await makeNoise3D(f => progress(0.02 + 0.15 * f));
  world.onRemoveRoom = clearFireIn;   // (what burned in a room that's no longer placed isn't there any more)
  world.onSpaceShift = (x, z, nx, nz, h) => glitchDoorway(x, z, nx, nz, 1.5, h + 0.1);   // a room appeared in a doorway in view
  await buildLevel(f => progress(0.2 + 0.55 * f, 'Wandering…'));
  postUniforms.camera.uExpoMax.value = 2.4;
  teleport(SPAWN.x, SPAWN.z, SPAWN.yaw);
  await progress(0.8, 'Preparing the camera…');
  update(0.016);
  await warmUp();
  initInput({ onFlash: () => setFlash(!state.flashOn), onFx: () => setFx(!state.fx), onQuality: cycleQuality, onCrouch: setCrouch });
  document.addEventListener('visibilitychange', () => setAudioSuspended(document.hidden));
  requestAnimationFrame(frame);
  ready = true;
  startReady();
  bootLog.push(['ready', Math.round(performance.now())]);
}
const booted = boot().catch(e => { console.error('loading failed:', e); setStartProgress(1, `Loading failed: ${e.message}`); });

// debug + benchmark hooks for the browser console, e.g. `await __br.profile()`
window.__br = {
  THREE, scene, P, camera, renderer, world, flags, fx, overlayC, post: postUniforms, keys, auto, colliders, state, fxLayer,
  fire: { cfg: fireCfg, stats: fireStats, clear: clearFire, fires, nozzle, density: on => { fireMat.uniforms.uDbg.value = on ? 1 : 0; }, coverage: fxCoverage },
  // the mold: colonies (mode 'creep' / 'rush'), cfg, stats; seed(colony, x, y, z, r) and burn(x, y, z, r, amount) in the
  // world, clear(), rush(colony, seconds) to set one off now, contact() at your feet, die() to test the end
  mold: { colonies, cfg: moldCfg, stats: moldStats, seed: moldSeedAt, burn: (x, y, z, r, a) => world.burn(x, y, z, r, a), clear: clearMold, state: moldState,
    rush: (k, s = 2) => { colonies[k].mode = 'rush'; colonies[k].t = s; }, contact: () => moldContactAt(P.x, P.z), die: () => die(), touch: () => touch },
  // the rooms: every room made so far, the placed copies, the one you're in; cfg (how often a doorway leads back, or
  // loops); reconcile() to place again now
  level: { rooms: levelRooms, insts: levelInsts, current: levelCurrent, cfg: graphCfg, reconcile, depth: DEPTH, stats: levelStats,
    goto: (id = 0) => { const R = levelRooms[id], r = R.plan.rects[0]; gotoRoom(R); teleport(id ? (r.x0 + r.x1) / 2 : SPAWN.x, id ? (r.z0 + r.z1) / 2 : SPAWN.z, SPAWN.yaw); },
    // a new room of a kind ('hall', 'corridor', 'pillars', 'maze', 'closet', 'crawl', 'void', 'service', 'office',
    // 'selfloop'), placed at the origin, with you in the middle of it
    visit: (kind, depth = 3) => { const R = visitNew(kind, depth), r = R.plan.rects[0]; teleport((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2, 0); return R; } },
  weapon, wand, doors,
  ready: booted, boot: bootLog,
  setFx, setFlash, setQuality, setCrouch, teleport,
  // mean / 10th / 90th-percentile brightness (0-1) of the frame on screen after `frames` simulated frames
  brightness: (frames = 150) => {
    for (let i = 0; i < frames; i++) step(1 / 30);
    const gl = renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ys = []; let sum = 0;
    for (let i = 0; i < px.length; i += 16) { const y = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255; ys.push(y); sum += y; }
    ys.sort((a, b) => a - b);
    return { mean: +(sum / ys.length).toFixed(3), p10: +ys[ys.length * 0.1 | 0].toFixed(3), p90: +ys[ys.length * 0.9 | 0].toFixed(3) };
  },
  start: () => start(),
  // simulate n frames with keys held (e.g. { KeyW: true }), then draw one; fire: true holds the trigger
  sim: (n = 30, input = {}, dt = 1 / 30) => {
    const fire = !!input.fire; Object.assign(keys, input); delete keys.fire; state.trigger = fire;
    for (let i = 0; i < n; i++) update(dt);
    renderFrame(dt, P);
    for (const k in input) keys[k] = false; state.trigger = false;
  },
  run: async (seconds = 1, input = {}, dt = 1 / 30) => {
    const fire = !!input.fire; Object.assign(keys, input); delete keys.fire; state.trigger = fire;
    for (let i = 0, n = Math.round(seconds / dt); i < n; i++) { update(dt); renderFrame(dt, P); await null; }
    for (const k in input) keys[k] = false; state.trigger = false;
  },
  aim: (yaw, pitch = 0) => { P.aimYaw = yaw; P.aimPitch = pitch; },
  profile: (n = 40) => profilePasses(n, step),
  // render a frame and post it as a JPEG to tools/shot-server.py (port 8798), which writes .shots/<name>.jpg
  shot: async (name = 'shot', width = 960, render = true) => {
    if (render) step(1 / 30);
    const cv = document.createElement('canvas'); cv.width = width; cv.height = Math.round(width * canvas.height / canvas.width);
    cv.getContext('2d').drawImage(canvas, 0, 0, cv.width, cv.height);
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.85));
    return (await fetch(`http://127.0.0.1:8798/${name}.jpg`, { method: 'POST', body: blob })).status;
  },
  exposure: readExposure,
  bench: (n = 40) => {
    const gl = renderer.getContext(), px = new Uint8Array(4);
    const run = () => { step(1 / 30); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); };
    for (let i = 0; i < 6; i++) run();
    const t0 = performance.now(); for (let i = 0; i < n; i++) run();
    return +((performance.now() - t0) / n).toFixed(2);
  },
  programs: () => renderer.info.programs.length,
};
