// All audio is synthesized with WebAudio (no files). Everything goes through a "body mic" chain: high-pass, hard
// compression, soft clipping, band limit, plus a short, dead room reverb (carpet and ceiling tiles soak it up).
// The place: the fluorescent hum and buzz, room tone, the ventilation. The flamethrower: the pilot's hiss, a thump
// as the stream lights, the roar and the fuel's hiss while it runs, the valve, and crackling from whatever burns.
// The mold: a faint wet crackle close to it, a dry rushing hiss when it rushes at you, a sizzle and pops as it burns,
// and the camera wearer coughing on its spores.
// Doors (latch, hinge creak, a slam), a safe room's generator (a small engine drumming, starting and dying), fuel
// poured into it, a fuel can picked up, and the flamethrower's trigger on an empty tank.
import { world } from '../world/world.js';
let actx = null, master, revIn, noiseBuf, humGain, buzzGain, breathGain, rustleGain;
let roarGain, roarLP, hissGain, rumbleGain, pilotGain, burnGain, burnLP, crackle = 0, nextCrackle = 0, muted = false;
let moldGain, rushGain, sizzleGain, nextWet = 0, nextPop = 0;
let genGain, genOsc, pourGain;

function makeIR(seconds, decay) {
  const rate = actx.sampleRate, len = Math.floor(rate * seconds), buf = actx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = Math.floor(rate * 0.004); i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    for (const [ms, a] of [[7, 0.45], [12, 0.3], [19, 0.24], [27, 0.16]]) { const k = Math.floor(rate * ms / 1000) + (ch ? 31 : 0); if (k < len) d[k] += a * (Math.random() < 0.5 ? -1 : 1); }
  }
  return buf;
}

const biq = (type, f, q = 0.7) => { const b = actx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
const gainN = v => { const g = actx.createGain(); g.gain.value = v; return g; };
function loop(filterType, freq, q, g0, dest = master) { const s = actx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; const gn = gainN(g0); s.connect(biq(filterType, freq, q)).connect(gn).connect(dest); s.start(0, Math.random() * 2); return gn; }
function env(g, t, peak, attack, dur) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); }
function noiseBurst(t, dur, gain, type, freq, q, dest = master, send = 0) {
  const s = actx.createBufferSource(); s.buffer = noiseBuf; s.playbackRate.value = 0.8 + Math.random() * 0.4;
  const f = biq(type, freq, q), g = actx.createGain(); env(g, t, gain, 0.006, dur);
  s.connect(f).connect(g).connect(dest);
  if (send) g.connect(gainN(send)).connect(revIn);
  s.start(t, Math.random() * 1.5, dur + 0.05);
}
function sweep(t, f0, f1, dur, gain, type = 'sine') {   // a falling (or rising) tone: thumps, knocks
  const o = actx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = actx.createGain(); env(g, t, gain, 0.008, dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
  return g;
}

// starts on the first tap/click (browsers block audio until then)
export function initAudio() {
  if (actx) { actx.resume(); return; }
  try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
  const sr = actx.sampleRate, len = sr * 2;
  noiseBuf = actx.createBuffer(1, len, sr);
  const ch = noiseBuf.getChannelData(0); for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
  master = gainN(muted ? 0 : 0.9);
  const comp = actx.createDynamicsCompressor(); comp.threshold.value = -32; comp.ratio.value = 8; comp.attack.value = 0.003; comp.release.value = 0.3;
  const shaper = actx.createWaveShaper(); const curve = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); } shaper.curve = curve;
  master.connect(biq('highpass', 110)).connect(comp).connect(shaper).connect(biq('lowpass', 6500)).connect(gainN(0.7)).connect(actx.destination);
  revIn = gainN(1);
  const conv = actx.createConvolver(); conv.buffer = makeIR(1.0, 3.6);
  revIn.connect(conv).connect(biq('lowpass', 3200)).connect(gainN(0.35)).connect(master);
  // the place
  loop('lowpass', 300, 0.7, 0.035);      // room tone
  loop('lowpass', 85, 0.7, 0.05);        // ventilation, somewhere above the tiles
  const hum = actx.createOscillator(); hum.type = 'sawtooth'; hum.frequency.value = 120;
  humGain = gainN(0); hum.connect(biq('lowpass', 420)).connect(humGain).connect(master); hum.start();
  const buzz = actx.createOscillator(); buzz.type = 'square'; buzz.frequency.value = 120;
  buzzGain = gainN(0); buzz.connect(biq('bandpass', 2600, 1.3)).connect(buzzGain).connect(master); buzz.start();
  breathGain = loop('bandpass', 950, 0.7, 0);
  rustleGain = loop('bandpass', 3800, 0.5, 0);
  // the flamethrower
  const roarSrc = actx.createBufferSource(); roarSrc.buffer = noiseBuf; roarSrc.loop = true; roarSrc.playbackRate.value = 0.7;
  roarLP = biq('lowpass', 700, 0.6); roarGain = gainN(0);
  roarSrc.connect(roarLP).connect(roarGain).connect(master); roarGain.connect(gainN(0.5)).connect(revIn); roarSrc.start();
  hissGain = loop('bandpass', 2900, 0.8, 0);
  rumbleGain = loop('lowpass', 110, 0.8, 0);
  pilotGain = loop('bandpass', 4300, 1.6, 0);
  const burnSrc = actx.createBufferSource(); burnSrc.buffer = noiseBuf; burnSrc.loop = true; burnSrc.playbackRate.value = 0.55;
  burnLP = biq('bandpass', 420, 0.5); burnGain = gainN(0);
  burnSrc.connect(burnLP).connect(burnGain).connect(master); burnGain.connect(gainN(0.6)).connect(revIn); burnSrc.start();
  // the mold
  moldGain = loop('bandpass', 1700, 0.9, 0);
  rushGain = gainN(0);
  const rushSrc = actx.createBufferSource(); rushSrc.buffer = noiseBuf; rushSrc.loop = true; rushSrc.playbackRate.value = 1.3;
  rushSrc.connect(biq('bandpass', 2600, 0.45)).connect(rushGain).connect(master); rushGain.connect(gainN(0.5)).connect(revIn); rushSrc.start();
  sizzleGain = loop('highpass', 3800, 0.7, 0);
  // a generator: a small single-cylinder engine drumming at ~28 firings a second, through its housing
  genGain = gainN(0);
  genOsc = actx.createOscillator(); genOsc.type = 'sawtooth'; genOsc.frequency.value = 28;
  const gLP = biq('lowpass', 240, 1.4);
  genOsc.connect(gLP).connect(genGain);
  const gOsc2 = actx.createOscillator(); gOsc2.type = 'square'; gOsc2.frequency.value = 56.3;
  gOsc2.connect(biq('bandpass', 180, 2)).connect(gainN(0.35)).connect(genGain);
  const gNoise = actx.createBufferSource(); gNoise.buffer = noiseBuf; gNoise.loop = true;
  gNoise.connect(biq('bandpass', 900, 0.8)).connect(gainN(0.25)).connect(genGain);
  genGain.connect(master); genGain.connect(gainN(0.4)).connect(revIn);
  genOsc.start(); gOsc2.start(); gNoise.start();
  pourGain = loop('bandpass', 650, 1.6, 0);   // fuel glugging from one tank into another
}

export function setAudioSuspended(hidden) { if (!actx) return; hidden ? actx.suspend() : actx.resume(); }
export function setMuted(on) { muted = on; if (master) master.gain.setValueAtTime(on ? 0 : 0.9, actx.currentTime); }

// footsteps on damp carpet: a dull thud, and now and then a soft squelch. Wading (a flooded room): a slap and a slosh
// of water, and drops falling back
export function stepSound(sf, wet = false) {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime;
  if (wet) {
    noiseBurst(t, 0.09, 0.3 + sf * 0.3, 'bandpass', 650 + Math.random() * 300, 0.9, master, 0.2);
    noiseBurst(t + 0.02, 0.24, 0.18 + sf * 0.25, 'lowpass', 850, 0.7, master, 0.35);
    noiseBurst(t + 0.01, 0.12, 0.08 + sf * 0.08, 'highpass', 2200, 0.8);
    for (let k = 0, n = 2 + ((Math.random() * 3) | 0); k < n; k++) noiseBurst(t + 0.08 + Math.random() * 0.22, 0.025, 0.03 + Math.random() * 0.03, 'bandpass', 1800 + Math.random() * 1600, 4);
    return;
  }
  noiseBurst(t, 0.1 + Math.random() * 0.04, 0.22 + sf * 0.35, 'lowpass', 340 + Math.random() * 120, 0.8, master, 0.25);
  sweep(t, 85, 42, 0.12, 0.35 + sf * 0.4);
  noiseBurst(t + 0.02, 0.16, 0.025 + sf * 0.035, 'highpass', 2500, 0.7);   // clothing against the mic
  if (Math.random() < 0.18) noiseBurst(t + 0.03, 0.07, 0.06 + sf * 0.05, 'bandpass', 900 + Math.random() * 500, 2.2);
}

// the valve opens: a click, then the stream lights with a soft, heavy thump
export function flameStart() {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.01;
  noiseBurst(t, 0.012, 0.35, 'highpass', 2600, 0.8);
  sweep(t + 0.03, 78, 34, 0.32, 0.9);
  noiseBurst(t + 0.03, 0.4, 0.75, 'lowpass', 380, 0.7, master, 0.8);
  noiseBurst(t + 0.05, 0.25, 0.3, 'bandpass', 1200, 0.6, master, 0.4);
}
// the valve shuts: a clack, the flame chokes off with a sputter or two
export function flameStop() {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.01;
  noiseBurst(t, 0.02, 0.4, 'bandpass', 1800, 1.4);
  sweep(t, 160, 90, 0.05, 0.25, 'triangle');
  for (let k = 0; k < 3; k++) noiseBurst(t + 0.06 + k * (0.06 + Math.random() * 0.08), 0.06, 0.25 * (1 - k * 0.25), 'lowpass', 600, 0.7, master, 0.4);
}
// per frame from the flamethrower: valve flow 0-1. The roar's level and colour wander, as turbulent burning does.
export function setFlame(flow, t) {
  if (!actx || actx.state !== 'running') return;
  const now = actx.currentTime, wob = 0.75 + 0.25 * Math.random() + 0.1 * Math.sin(t * 13);
  roarGain.gain.setTargetAtTime(flow * 0.55 * wob, now, 0.03);
  roarLP.frequency.setTargetAtTime(550 + 450 * flow * (0.7 + 0.6 * Math.random()), now, 0.04);
  hissGain.gain.setTargetAtTime(flow * 0.07, now, 0.03);
  rumbleGain.gain.setTargetAtTime(flow * 0.5, now, 0.05);
  pilotGain.gain.setTargetAtTime(0.004 + 0.002 * Math.random(), now, 0.05);
}
// per frame from the fire: how much is burning near the camera (0-1+). Low flutter, plus crackles.
export function setBurning(level) {
  if (!actx || actx.state !== 'running') return;
  const now = actx.currentTime;
  burnGain.gain.setTargetAtTime(Math.min(level, 1.5) * 0.22 * (0.7 + 0.3 * Math.random()), now, 0.06);
  burnLP.frequency.setTargetAtTime(320 + 260 * Math.random(), now, 0.05);
  crackle = level;
  if (crackle > 0.02 && now > nextCrackle) {
    const g = Math.min(crackle, 1);
    noiseBurst(now + Math.random() * 0.02, 0.006 + Math.random() * 0.012, (0.15 + 0.35 * Math.random()) * g, 'highpass', 1800 + Math.random() * 2500, 0.7, master, 0.3);
    if (Math.random() < 0.3) noiseBurst(now + 0.01, 0.03, 0.2 * g, 'bandpass', 700 + Math.random() * 600, 1.5);   // a pop
    nextCrackle = now + (0.02 + Math.random() * 0.12) / Math.max(g, 0.15);
  }
}

// per frame from the fire: how fast mold is burning (amount per second). A fat sizzle, and pops.
export function setSizzle(rate) {
  if (!actx || actx.state !== 'running') return;
  const now = actx.currentTime, lv = Math.min(1, rate * 0.12);
  sizzleGain.gain.setTargetAtTime(lv * 0.16 * (0.55 + 0.45 * Math.random()), now, 0.03);
  if (lv > 0.05 && now > nextPop) {
    noiseBurst(now + Math.random() * 0.03, 0.02 + Math.random() * 0.03, (0.15 + 0.3 * Math.random()) * lv, 'bandpass', 900 + Math.random() * 1400, 2.5, master, 0.3);
    nextPop = now + (0.03 + Math.random() * 0.15) / Math.max(lv, 0.2);
  }
}
// per frame: how much mold is close to the mic (0-1), and how close a colony rushing at you is (0-1)
export function setMold(near, rush) {
  if (!actx || actx.state !== 'running') return;
  const now = actx.currentTime;
  moldGain.gain.setTargetAtTime(near * 0.025 * (0.4 + 0.6 * Math.random()), now, 0.05);
  rushGain.gain.setTargetAtTime(rush * 0.16, now, rush > 0.01 ? 0.08 : 0.4);
  if (near > 0.05 && now > nextWet) {   // something wet giving way, now and then
    noiseBurst(now, 0.012 + Math.random() * 0.02, 0.08 * near, 'bandpass', 1200 + Math.random() * 1800, 3, master, 0.4);
    nextWet = now + (0.2 + Math.random() * 1.2) / Math.max(near, 0.1);
  }
}
// a cough on the spores: two or three, rough and close to the mic
export function cough() {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.02, k = 2 + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < k; i++) {
    const tt = t + i * (0.32 + Math.random() * 0.12), g = 0.5 * (1 - i * 0.2);
    noiseBurst(tt, 0.16, g, 'bandpass', 650 + Math.random() * 300, 1.4, master, 0.3);
    noiseBurst(tt + 0.01, 0.08, g * 0.6, 'lowpass', 300, 0.8, master);
    sweep(tt, 170 + Math.random() * 40, 110, 0.12, g * 0.35, 'sawtooth');
  }
}
// the end: a choked gasp, then the signal goes
export function choke() {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.02;
  const src = actx.createBufferSource(); src.buffer = noiseBuf;
  const f = biq('bandpass', 900, 1.2), g = gainN(0);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.6, t + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  f.frequency.setValueAtTime(700, t); f.frequency.linearRampToValueAtTime(1500, t + 0.4);
  src.connect(f).connect(g).connect(master); src.start(t, Math.random()); src.stop(t + 1);
  for (let i = 0; i < 4; i++) noiseBurst(t + 0.9 + i * 0.25 + Math.random() * 0.1, 0.12, 0.25, 'lowpass', 400, 0.7, master);
}

// a door: 'open' (the latch, the hinges start to groan), 'close' (the same, shutting), 'stop' (it swings to the end),
// 'shut' (it slams into the frame: steel rings, wood thuds)
export function doorSound(kind, phase) {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.01, steel = kind === 'steel';
  if (phase === 'open' || phase === 'close') {
    noiseBurst(t, 0.03, steel ? 0.5 : 0.3, 'bandpass', steel ? 1500 : 1100, 1.6, master, 0.3);   // the latch or push bar
    sweep(t, steel ? 120 : 160, steel ? 70 : 100, 0.06, 0.3, 'triangle');
    const o = actx.createOscillator(); o.type = 'sawtooth';
    const f = biq('bandpass', steel ? 520 : 760, 6), g = gainN(0);
    o.frequency.setValueAtTime(steel ? 31 : 44, t + 0.12); o.frequency.linearRampToValueAtTime(steel ? 23 : 37, t + 0.9);   // the hinge groans
    g.gain.setValueAtTime(0.0001, t + 0.12); g.gain.exponentialRampToValueAtTime(steel ? 0.22 : 0.12, t + 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.95);
    o.connect(f).connect(g).connect(master); g.connect(gainN(0.5)).connect(revIn); o.start(t + 0.12); o.stop(t + 1);
  } else if (phase === 'shut') {
    sweep(t, steel ? 95 : 110, 38, 0.3, 1.0);
    noiseBurst(t, 0.25, steel ? 0.6 : 0.5, 'lowpass', 420, 0.7, master, 0.9);
    if (steel) for (const fq of [930, 1410, 2210]) sweep(t, fq, fq * 0.98, 0.6, 0.05, 'sine');   // the steel rings
    noiseBurst(t + 0.05, 0.05, 0.25, 'bandpass', 2400, 2, master, 0.4);                          // the latch catches
  } else noiseBurst(t, 0.12, steel ? 0.25 : 0.18, 'lowpass', 500, 0.8, master, 0.4);
}
// per frame: how close a running generator is (0-1)
export function setGenerator(level) {
  if (!actx || actx.state !== 'running') return;
  const now = actx.currentTime;
  genGain.gain.setTargetAtTime(Math.min(level, 1) * 0.16, now, 0.2);
  genOsc.frequency.setTargetAtTime(27.5 + Math.random() * 1.2, now, 0.3);   // (an old engine never holds its speed)
}
export function generatorStart() {   // a pull on the starter cord or two, then it catches
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.01;
  for (let k = 0; k < 2; k++) { noiseBurst(t + k * 0.5, 0.3, 0.35, 'bandpass', 700, 1.2, master, 0.3); sweep(t + k * 0.5, 60, 25, 0.35, 0.4, 'sawtooth'); }
  sweep(t + 1.0, 18, 28, 0.6, 0.5, 'sawtooth');
}
export function generatorStop() {   // it coughs, stumbles and stops
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.01;
  for (let k = 0; k < 4; k++) { noiseBurst(t + k * 0.22 + Math.random() * 0.08, 0.12, 0.35 * (1 - k * 0.2), 'lowpass', 300, 0.8, master, 0.4); sweep(t + k * 0.22, 40, 20, 0.15, 0.4 * (1 - k * 0.2), 'sawtooth'); }
}
export function setPour(on) { if (actx && actx.state === 'running') pourGain.gain.setTargetAtTime(on ? 0.12 : 0, actx.currentTime, 0.08); }
export function pickupSound() {   // a jerrycan lifted: a hollow knock and the fuel sloshing in it
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.01;
  sweep(t, 220, 140, 0.12, 0.35, 'triangle');
  noiseBurst(t + 0.05, 0.3, 0.2, 'bandpass', 500, 1.5, master, 0.3);
  noiseBurst(t + 0.28, 0.25, 0.14, 'bandpass', 420, 1.5, master, 0.3);
}
export function fuelDry() {   // the trigger on an empty tank: the valve clicks, a last breath of gas
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime + 0.01;
  noiseBurst(t, 0.015, 0.35, 'highpass', 2600, 0.8);
  noiseBurst(t + 0.03, 0.35, 0.06, 'bandpass', 3000, 0.8);
}

// per frame: fluorescent hum near the lights, buzzing while one flickers, breathing, the rustle of turning
export function updateAudio(P, fixtures, yawRate) {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime;
  const rate = 0.28 + P.exert * 0.4, envB = Math.pow(Math.max(0, Math.sin(P.t * Math.PI * 2 * rate)), 2);
  breathGain.gain.setTargetAtTime(envB * (0.012 + 0.09 * P.exert), t, 0.05);
  rustleGain.gain.setTargetAtTime(Math.min(0.06, Math.abs(yawRate) * 0.02), t, 0.05);
  let hum = 0, buzz = 0;
  for (const f of fixtures) {
    if (f.state === 'off') continue;
    const dd = (f.x - P.x) ** 2 + (f.z - P.z) ** 2 + 2;
    hum += f.val / (1 + dd * 0.35);
    if (f.burst > 0) buzz += f.val / (1 + dd * 0.25);
  }
  humGain.gain.setTargetAtTime(Math.min(hum * 0.03, 0.07), t, 0.05);
  buzzGain.gain.setTargetAtTime(Math.min(0.012 + buzz * 0.05, 0.06) * (world.fixtures.length ? 1 : 0), t, 0.01);
}
