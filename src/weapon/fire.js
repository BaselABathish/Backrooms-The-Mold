// Fire and smoke: CPU-simulated particles drawn as soft, noisy, camera-facing quads into the half-resolution fire layer
// (render/pipeline.js fxLayer), which is composited over the scene before the camera simulation sees it.
//  - stream: burning fuel from the nozzle. A thin, fast rope that falls a little, then blooms into a rolling jet of
//    flame as the fuel burns, slows and rises. It is drawn as one continuous body (see "drawing" below), not as balls.
//    Where it hits something it splashes along the surface, leaves soot (scorch.js) and feeds a fire there.
//  - surface fires: fuel burning where it landed. Each draws one body of flame (tapering into tongues), plus licks
//    that break off it, smoke and sparks; it climbs walls and rolls along the ceiling.
//  - smoke: dark soot, lit orange from below by the flames; it rises and pools under the ceiling.
// Flames are emissive, many times brighter than the room, so the camera clips their cores and blooms them. Two point
// lights follow the fire and light the room with it.
import * as THREE from 'three';
import { camera, scene } from '../core/context.js';
import { fxLayer } from '../render/pipeline.js';
import { colliders } from '../world/builder.js';
import { world } from '../world/world.js';
import { fx } from '../state.js';
import { noiseUniform } from './noise3d.js';
import { shared, PORTAL_GLSL } from '../world/materials.js';
import { deposit } from './scorch.js';
import { setBurning, setSizzle } from '../audio/audio.js';

const MAX = 1100, MAX_FIRES = 36;
export const STREAM = 0, LICK = 1, SMOKE = 2, EMBER = 3;
const BODY = 4, SPLASH = 5;   // (drawing only) a surface fire's body of flame; stream fuel that has splashed
// The stream's pattern is indexed by when its fuel left the nozzle: KT noise units per second, wrapped at TAU_WRAP.
// Every scale applied to it in the shader times TAU_WRAP must be a whole number, or the wrap would show as a seam.
const KT = 7, TAU_WRAP = 10;
// tunables (window.__br.fire.cfg)
export const cfg = {
  rate: 190,          // stream particles per second at full flow
  speed: 14.5,        // m/s out of the nozzle
  spread: 0.018,      // radians
  // smoke (playtest: "the black smoke makes it impossible to see where you're going"): a stream particle's chance of
  // leaving a puff, and puffs a second from a surface fire at full strength (they were 0.3 and 3.2)
  smokeP: 0.12, smokeFire: 2.0,
  flame: 5,           // emission of the hottest flame, relative to the room's light
  lightK: 0.55,       // light per unit of visible flame
  // burning mold: it feeds the fire on it (seconds of burning per unit of mold burnt, at most moldFuelMax s per s), and
  // the fire creeps over thick mold (m > spreadMin): a new fire spreadDist m away about spreadRate times a second at
  // full strength, up to spreadGen steps from where the stream hit
  moldFuel: 0.014, moldFuelMax: 1.5, spreadMin: 0.45, spreadDist: 0.5, spreadRate: 1.3, spreadGen: 4,
  splash: 1.4,        // how far a splash reaches along the surface (and the mold it burns), relative to before
};

// ---------------------------------------------------------------- particle state (structure of arrays)
const F = n => new Float32Array(n);
const x = F(MAX), y = F(MAX), z = F(MAX), vx = F(MAX), vy = F(MAX), vz = F(MAX);
const age = F(MAX), life = F(MAX), rad = F(MAX), r0 = F(MAX), rmax = F(MAX), heat0 = F(MAX), heat = F(MAX), fuel = F(MAX);
const seed = F(MAX), op = F(MAX);
const tauE = F(MAX), dtE = F(MAX);   // stream: when it left the nozzle (game time), and the time to the next one then
// Stream: the jet's own direction here, as the gap to the fuel that left just after it (per second of emission). Straight
// out of a still nozzle it is just the jet's speed; when the nozzle swings, the jet bends away from the direction the
// fuel flies, and the windows that draw it (see "drawing") must follow the bend, not the flight, or a swung jet falls
// apart into blobs. Gap: sg (m per s of emission); how fast the gap grows: sgv (from the nozzle turning at launch).
const sgx = F(MAX), sgy = F(MAX), sgz = F(MAX), sgvx = F(MAX), sgvy = F(MAX), sgvz = F(MAX);
const kind = new Uint8Array(MAX), flag = new Uint8Array(MAX);   // flag bit 1: left smoke, bit 2: has hit a surface
const ARRS = [x, y, z, vx, vy, vz, age, life, rad, r0, rmax, heat0, heat, fuel, seed, op, tauE, dtE, sgx, sgy, sgz, sgvx, sgvy, sgvz, kind, flag];
let count = 0, clock = 0;

function spawn(k, px, py, pz, pvx, pvy, pvz, pr, plife, ph) {
  let i = count;
  if (count >= MAX) {   // full: take the place of the oldest smoke, or give up
    i = -1; let oldest = 0;
    for (let j = 0; j < count; j++) if (kind[j] === SMOKE && age[j] > oldest) { oldest = age[j]; i = j; }
    if (i < 0) return -1;
  } else count++;
  x[i] = px; y[i] = py; z[i] = pz; vx[i] = pvx; vy[i] = pvy; vz[i] = pvz;
  age[i] = 0; life[i] = plife; rad[i] = r0[i] = pr; heat[i] = heat0[i] = ph; fuel[i] = k === STREAM ? 1 : 0;
  seed[i] = Math.random(); op[i] = 0; kind[i] = k; flag[i] = 0; tauE[i] = clock; dtE[i] = 0.05;
  sgx[i] = -pvx; sgy[i] = -pvy; sgz[i] = -pvz; sgvx[i] = sgvy[i] = sgvz[i] = 0;
  rmax[i] = k === STREAM ? 0.55 + Math.random() * 0.05 : k === LICK ? pr * 3 : k === SMOKE ? 0.45 + Math.random() * 0.25 : pr;
  return i;
}
function kill(i) {
  const j = --count;
  if (i !== j) for (const a of ARRS) a[i] = a[j];
}

// ---------------------------------------------------------------- surfaces
const H = () => world.ceiling;
// Moves particle i to its contact with the first surface it went into this step and returns the surface normal (in
// _nrm), or false. c: how far from a surface its centre stays.
const _nrm = [0, 0, 0];
function collide(i, ox, oy, oz, c) {
  let hit = false;
  if (y[i] < c) { y[i] = c; _nrm[0] = 0; _nrm[1] = 1; _nrm[2] = 0; hit = true; }
  else if (y[i] > H() - c) { y[i] = H() - c; _nrm[0] = 0; _nrm[1] = -1; _nrm[2] = 0; hit = true; }
  for (const b of colliders) {
    const px = x[i], py = y[i], pz = z[i];
    if (px < b.x0 - c || px > b.x1 + c || pz < b.z0 - c || pz > b.z1 + c || py < b.y0 - c || py > b.h + c) continue;
    // which face it came through: the one it was outside of last step (else the nearest one)
    if (ox < b.x0 - c) { x[i] = b.x0 - c; _nrm[0] = -1; _nrm[1] = 0; _nrm[2] = 0; }
    else if (ox > b.x1 + c) { x[i] = b.x1 + c; _nrm[0] = 1; _nrm[1] = 0; _nrm[2] = 0; }
    else if (oz < b.z0 - c) { z[i] = b.z0 - c; _nrm[0] = 0; _nrm[1] = 0; _nrm[2] = -1; }
    else if (oz > b.z1 + c) { z[i] = b.z1 + c; _nrm[0] = 0; _nrm[1] = 0; _nrm[2] = 1; }
    else if (oy < b.y0 - c && b.y0 > 0) { y[i] = b.y0 - c; _nrm[0] = 0; _nrm[1] = -1; _nrm[2] = 0; }
    else {
      const d = [px - (b.x0 - c), (b.x1 + c) - px, pz - (b.z0 - c), (b.z1 + c) - pz], m = Math.min(...d);
      if (m === d[0]) { x[i] = b.x0 - c; _nrm[0] = -1; _nrm[1] = 0; _nrm[2] = 0; }
      else if (m === d[1]) { x[i] = b.x1 + c; _nrm[0] = 1; _nrm[1] = 0; _nrm[2] = 0; }
      else if (m === d[2]) { z[i] = b.z0 - c; _nrm[0] = 0; _nrm[1] = 0; _nrm[2] = -1; }
      else { z[i] = b.z1 + c; _nrm[0] = 0; _nrm[1] = 0; _nrm[2] = 1; }
    }
    hit = true;
  }
  return hit;
}

// ---------------------------------------------------------------- surface fires: burning fuel stuck to something
export const fires = [];   // { x, y, z, nx, ny, nz, fuel (s of burning left), str (0-1), seed, acc, sacc, eacc, dacc, mass, gen (steps of spreading over mold from where fuel landed), spr }
function feed(px, py, pz, nx, ny, nz, amount) {
  let best = null, bd = 0.42 * 0.42;
  for (const f of fires) {
    if (f.nx * nx + f.ny * ny + f.nz * nz < 0.7) continue;
    const d2 = (f.x - px) ** 2 + (f.y - py) ** 2 + (f.z - pz) ** 2;
    if (d2 < bd) { bd = d2; best = f; }
  }
  if (best) {
    best.fuel = Math.min(best.fuel + amount * 14, 7);
    const k = amount * 0.5 / (best.mass + amount);   // the fire's centre drifts toward where fuel lands
    best.x += (px - best.x) * k; best.y += (py - best.y) * k; best.z += (pz - best.z) * k; best.mass += amount;
    return;
  }
  if (fires.length >= MAX_FIRES) {   // too many: drop the weakest
    let w = 0; for (let k = 1; k < fires.length; k++) if (fires[k].fuel < fires[w].fuel) w = k;
    fires.splice(w, 1);
  }
  fires.push({ x: px, y: py, z: pz, nx, ny, nz, fuel: amount * 14, str: 0, seed: Math.random(), acc: 0, sacc: 0, eacc: 0, dacc: 0, mass: amount, gen: 0, spr: Math.random() * 0.5 });
}
// Fire creeping over mold: from a burning fire, the thickest living mold about spreadDist away (round it on its surface,
// or round a corner onto the next: the cells know which way they face), not already burning, catches. Upward a little
// more readily (flames climb).
const DIRS = 7;
function spreadFrom(f, tx, ty, tz, bx, by, bz) {
  let best = null, bs = 0;
  const a0 = Math.random() * 6.283, d = cfg.spreadDist;
  for (let k = 0; k < DIRS; k++) {
    const a = a0 + k * 6.283 / DIRS, ca = Math.cos(a) * d, sa = Math.sin(a) * d;
    const px = f.x + tx * ca + bx * sa, py = f.y + ty * ca + by * sa, pz = f.z + tz * ca + bz * sa;
    const c = world.moldAt(px, py, pz, 0.26);
    if (!c || c.m < cfg.spreadMin) continue;
    let near = false;
    for (const o of fires) if ((o.x - c.x) ** 2 + (o.y - c.y) ** 2 + (o.z - c.z) ** 2 < 0.4 * 0.4) { near = true; break; }
    if (near) continue;
    const s = c.m + (c.y > f.y + 0.1 ? 0.25 : 0);
    if (s > bs) { bs = s; best = c; }
  }
  if (!best) return false;
  if (fires.length >= MAX_FIRES) return false;
  fires.push({ x: best.x, y: best.y, z: best.z, nx: best.nx, ny: best.ny, nz: best.nz, fuel: 0.9 + 1.4 * best.m, str: 0.15, seed: Math.random(), acc: 0, sacc: 0, eacc: 0, dacc: 0,
    mass: 0.01, gen: f.gen + 1, spr: 0 });
  return true;
}
let burnt = 0;   // mold burnt this frame (for the sizzle)
function updateFires(dt) {
  for (let k = fires.length - 1; k >= 0; k--) {
    const f = fires[k];
    f.fuel -= dt;
    if (f.fuel <= 0) { fires.splice(k, 1); continue; }
    const target = Math.min(1, f.fuel / 2.5);
    f.str += (target - f.str) * (1 - Math.exp(-dt * (target > f.str ? 10 : 2)));
    // the mold round it shrivels, and burns: it feeds the fire while there's mold left to eat
    const b = world.burn(f.x, f.y, f.z, 0.2 + 0.45 * f.str, dt * 1.6 * f.str);
    burnt += b;
    if (b > 0) f.fuel = Math.min(f.fuel + Math.min(b * cfg.moldFuel, dt * cfg.moldFuelMax), 7);
    // a tangent frame on the surface
    const ax = Math.abs(f.ny) > 0.9 ? 1 : 0, az = Math.abs(f.ny) > 0.9 ? 0 : 1;
    const tx = f.ny * az - f.nz * 0, ty = f.nz * ax - f.nx * az, tz = f.nx * 0 - f.ny * ax;   // n x a
    const bx = f.ny * tz - f.nz * ty, by = f.nz * tx - f.nx * tz, bz = f.nx * ty - f.ny * tx;   // n x t
    // and it creeps over the mold round it
    if (f.gen < cfg.spreadGen && f.str > 0.35) {
      f.spr += dt * cfg.spreadRate * f.str;
      if (f.spr >= 1) { f.spr -= 1; if (!spreadFrom(f, tx, ty, tz, bx, by, bz)) f.spr -= 0.5; }
    }
    // the body of the fire is drawn whole (see upload); these are the tongues that break away from it
    const spreadR = 0.05 + 0.25 * f.str;
    f.acc += dt * (4 + 12 * f.str);
    while (f.acc >= 1) {
      f.acc -= 1;
      const a = Math.random() * 6.283, d = spreadR * Math.sqrt(Math.random()), ca = Math.cos(a) * d, sa = Math.sin(a) * d;
      const px = f.x + tx * ca + bx * sa + f.nx * 0.05, py = f.y + ty * ca + by * sa + f.ny * 0.05 + 0.1 * f.str, pz = f.z + tz * ca + bz * sa + f.nz * 0.05;
      spawn(LICK, px, py, pz, f.nx * 0.3 + (Math.random() - 0.5) * 0.25, f.ny * 0.3 + 0.6 + Math.random() * 0.3, f.nz * 0.3 + (Math.random() - 0.5) * 0.25,
        0.05 + 0.06 * f.str * Math.random() + 0.02, 0.28 + Math.random() * 0.3, 0.5 + 0.3 * Math.random() * f.str);
    }
    f.sacc += dt * cfg.smokeFire * f.str;
    while (f.sacc >= 1) {
      f.sacc -= 1;
      spawn(SMOKE, f.x + f.nx * 0.2, f.y + f.ny * 0.2 + 0.25 + 0.3 * f.str, f.z + f.nz * 0.2, f.nx * 0.2, 0.5, f.nz * 0.2, 0.14, 2.4 + Math.random() * 1.2, 0);
    }
    f.dacc += dt * 4 * f.str;
    while (f.dacc >= 1) {
      f.dacc -= 1;
      const up = Math.abs(f.ny) < 0.5 ? 0.12 + Math.random() * 0.75 * f.str : 0, j = (Math.random() - 0.5) * (0.25 + 0.3 * f.str), j2 = (Math.random() - 0.5) * 0.3;
      deposit(f.x + tx * j + bx * j2 * (up ? 0 : 1), Math.min(f.y + up + ty * j, H() - 0.08), f.z + tz * j + bz * j2 * (up ? 0 : 1), f.nx, f.ny, f.nz, 0.04 + 0.04 * f.str, up ? 1.8 : 1);
    }
    f.eacc += dt * 3 * f.str * f.str;
    while (f.eacc >= 1) {
      f.eacc -= 1;
      spawn(EMBER, f.x + f.nx * 0.08, f.y + f.ny * 0.08 + 0.05, f.z + f.nz * 0.08,
        f.nx * 0.6 + (Math.random() - 0.5) * 1.6, 1.2 + Math.random() * 1.6, f.nz * 0.6 + (Math.random() - 0.5) * 1.6, 0.007, 0.7 + Math.random() * 1.1, 1);
    }
  }
}

// ---------------------------------------------------------------- simulation
// One particle, one step. Returns false if it died.
function stepParticle(i, dt) {
  age[i] += dt;
  if (age[i] >= life[i]) return false;
  const k = kind[i], a = age[i], t = a / life[i];
  let drag, ay, turb;
  if (k === STREAM) {
    // the liquid core burns away: heavy and fast at first, then a buoyant, draggy cloud of flame. Its width follows
    // its age exactly (no randomness), so neighbours along the jet agree and it reads as one body.
    fuel[i] = flag[i] & 2 ? 0 : Math.exp(-a / 0.55);
    const fu = fuel[i];
    drag = 0.15 + 1.9 * (1 - fu);
    ay = -9.8 * 0.55 * fu + 3.2 * (1 - fu) * heat[i];
    turb = 0.5 + 2 * (1 - fu);
    rad[i] = Math.min(r0[i] + 0.45 * a + 2.0 * a * a + (flag[i] & 2 ? 0.2 : 0), rmax[i]);
    heat[i] = heat0[i] * (1 - Math.pow(t, 1.6));
    op[i] = Math.min(1, a / 0.025) * (1 - smooth01(0.72, 1, t));
    if (!(flag[i] & 1) && t > 0.5) {
      flag[i] |= 1;
      if (Math.random() < cfg.smokeP) spawn(SMOKE, x[i], y[i] + rad[i] * (flag[i] & 2 ? 0.9 : 0.5), z[i], vx[i] * 0.4, vy[i] * 0.4 + 0.3, vz[i] * 0.4, rad[i] * 0.6, 2.2 + Math.random() * 1.4, 0);
    }
  } else if (k === LICK) {
    drag = 2.6; ay = 6.5 * heat[i]; turb = 4.5;
    rad[i] = Math.min(r0[i] + 0.35 * a, rmax[i]);
    heat[i] = heat0[i] * (1 - Math.pow(t, 1.2));
    op[i] = Math.min(1, a / 0.05) * (1 - smooth01(0.6, 1, t));
  } else if (k === SMOKE) {
    // hot soot rises fast and pools under the ceiling, out of the way, instead of hanging at eye level
    drag = 1.25; ay = 2.2 * (1 - 0.7 * t); turb = 1.6;
    rad[i] = Math.min(rad[i] + dt * (0.38 * (1 - t) + 0.06), rmax[i]);
    op[i] = smooth01(0, 0.25, a) * (1 - smooth01(0.5, 1, t));
  } else {   // ember: light, lofted by the hot air, then falling
    drag = 0.9; ay = 1.8 - 4.5 * t; turb = 6;
    heat[i] = heat0[i] * (1 - t * t);
    op[i] = 1 - smooth01(0.75, 1, t);
  }
  const e = Math.exp(-drag * dt);
  if (k === STREAM) {
    sgx[i] = sgx[i] * e + sgvx[i] * dt; sgy[i] = sgy[i] * e + sgvy[i] * dt; sgz[i] = sgz[i] * e + sgvz[i] * dt;
  }
  vx[i] = vx[i] * e + (Math.random() - 0.5) * turb * dt;
  vy[i] = vy[i] * e + ay * dt + (Math.random() - 0.5) * turb * dt * 0.6;
  vz[i] = vz[i] * e + (Math.random() - 0.5) * turb * dt;
  const ox = x[i], oy = y[i], oz = z[i];
  x[i] += vx[i] * dt; y[i] += vy[i] * dt; z[i] += vz[i] * dt;
  const c = k === EMBER ? 0.01 : Math.min(rad[i] * 0.35, 0.12) + 0.02;
  if (collide(i, ox, oy, oz, c)) {
    const nx = _nrm[0], ny = _nrm[1], nz = _nrm[2];
    const vn = vx[i] * nx + vy[i] * ny + vz[i] * nz;
    if (k === STREAM && !(flag[i] & 2)) {
      // splash: the fuel spreads out along the surface, sticks, and burns there
      flag[i] |= 2;
      heat0[i] *= 0.8;
      const fu = fuel[i], sp = Math.abs(vn);
      if (fu > 0.12) { deposit(x[i] - nx * c, y[i] - ny * c, z[i] - nz * c, nx, ny, nz, 0.05 + 0.18 * fu); feed(x[i] - nx * c, y[i] - ny * c, z[i] - nz * c, nx, ny, nz, 0.012 * fu); }
      burnt += world.burn(x[i] - nx * c, y[i] - ny * c, z[i] - nz * c, (0.3 + 0.15 * fu) * cfg.splash, 0.35 + 0.5 * fu);
      if (vn < 0) { vx[i] -= vn * nx * 1.06; vy[i] -= vn * ny * 1.06; vz[i] -= vn * nz * 1.06; }
      vx[i] *= 0.28; vy[i] *= 0.28; vz[i] *= 0.28;
      const a2 = Math.random() * 6.283, s2 = sp * 0.2 * cfg.splash;   // fanning out
      vx[i] += Math.cos(a2) * s2 * (1 - Math.abs(nx)); vy[i] += Math.sin(a2) * s2 * (1 - Math.abs(ny)); vz[i] += Math.sin(a2 + 1.3) * s2 * (1 - Math.abs(nz));
      life[i] = Math.min(life[i], a + 0.35 + Math.random() * 0.25);
    } else if (vn < 0) {
      if (k === STREAM && Math.random() < 0.15) deposit(x[i] - nx * c, y[i] - ny * c, z[i] - nz * c, nx, ny, nz, 0.05 * heat[i]);
      if (k === STREAM && Math.random() < 0.3) burnt += world.burn(x[i] - nx * c, y[i] - ny * c, z[i] - nz * c, 0.22 * cfg.splash, 0.25 * heat[i]);
      const b = k === EMBER ? 1.4 : 1.0;   // embers bounce a little, the rest slides along
      vx[i] -= vn * nx * b; vy[i] -= vn * ny * b; vz[i] -= vn * nz * b;
      if (k === EMBER) { vx[i] *= 0.6; vz[i] *= 0.6; }
    }
  }
  return true;
}
const smooth01 = (a, b, v) => { const q = Math.min(Math.max((v - a) / (b - a), 0), 1); return q * q * (3 - 2 * q); };

// ---------------------------------------------------------------- the nozzle
// The flamethrower (flamethrower.js) fills this in every frame: how far the valve is open (flow), burning fuel still
// dribbling out after it closed (drip, 0-1), and where the nozzle was and pointed last frame (p0, d0) and now (p1, d1),
// and how fast it moves (v: the stream carries it along).
export const nozzle = { flow: 0, drip: 0, p0: new THREE.Vector3(), p1: new THREE.Vector3(), d0: new THREE.Vector3(0, 0, -1), d1: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3() };
// Emits this frame's share of the stream along the nozzle's path, each particle advanced by the part of the frame
// since it left, so the rope stays continuous however fast the nozzle swings. They leave at an even beat (the next
// one's time carries over from frame to frame): an uneven gap would show in the jet as a pulse.
let nextEmit = -1, dripAcc = 0;
function emitStream(dt, t0) {
  const { flow, p0, p1, d0, d1, v: nv } = nozzle;
  const period = 1 / (cfg.rate * Math.max(flow, 0.05));
  if (nextEmit < t0) nextEmit = t0 + period * 0.5;   // the valve has just opened
  for (; nextEmit < t0 + dt; nextEmit += period) {
    const f = (nextEmit - t0) / dt;
    let dx = d0.x + (d1.x - d0.x) * f, dy = d0.y + (d1.y - d0.y) * f, dz = d0.z + (d1.z - d0.z) * f;
    const s = cfg.spread;
    dx += (Math.random() + Math.random() - 1) * s; dy += (Math.random() + Math.random() - 1) * s; dz += (Math.random() + Math.random() - 1) * s;
    const l = Math.hypot(dx, dy, dz), sp = cfg.speed * (0.55 + 0.45 * flow) / l;
    const i = spawn(STREAM, p0.x + (p1.x - p0.x) * f, p0.y + (p1.y - p0.y) * f, p0.z + (p1.z - p0.z) * f,
      dx * sp + nv.x, dy * sp + nv.y, dz * sp + nv.z, 0.014, 0.85 + Math.random() * 0.35, (0.92 + 0.08 * Math.random()) * (0.9 + 0.1 * flow));
    if (i < 0) continue;
    tauE[i] = nextEmit; dtE[i] = period;
    const ks = cfg.speed * (0.55 + 0.45 * flow) / dt;
    sgx[i] = nv.x - vx[i]; sgy[i] = nv.y - vy[i]; sgz[i] = nv.z - vz[i];
    sgvx[i] = (d1.x - d0.x) * ks; sgvy[i] = (d1.y - d0.y) * ks; sgvz[i] = (d1.z - d0.z) * ks;
    if (!stepParticle(i, (1 - f) * dt)) kill(i);
  }
}
// after the valve shuts, a few drops of burning fuel run out of the nozzle and fall
function emitDrip(dt) {
  dripAcc += 12 * nozzle.drip * dt;
  while (dripAcc >= 1) {
    dripAcc -= 1;
    const { p1, d1, v } = nozzle, sp = 0.4 + Math.random() * 0.8;
    const i = spawn(STREAM, p1.x, p1.y, p1.z, d1.x * sp + v.x + (Math.random() - 0.5) * 0.2, d1.y * sp + v.y, d1.z * sp + v.z + (Math.random() - 0.5) * 0.2,
      0.008 + 0.006 * Math.random(), 0.5 + Math.random() * 0.4, 0.75);
    if (i >= 0) { flag[i] |= 1; dtE[i] = 1 / 12; }
  }
}

// ---------------------------------------------------------------- lights
// One follows the stream, one the fires it started. A light is kept clear of surfaces so a wall doesn't flare white.
export const streamLight = new THREE.PointLight(0xff9448, 0, 11, 2);
export const fireLight = new THREE.PointLight(0xff8a3c, 0, 10, 2);
scene.add(streamLight, fireLight);
const L = { sx: 0, sy: 1, sz: 0, si: 0, fx: 0, fy: 1, fz: 0, fi: 0, flick: 0, pilot: null };
function clearOfWalls(p, m) {
  p.y = Math.min(Math.max(p.y, m), H() - m);
  for (const b of colliders) {
    if (p.x < b.x0 - m || p.x > b.x1 + m || p.z < b.z0 - m || p.z > b.z1 + m || p.y < b.y0 - m || p.y > b.h + m) continue;
    const d = [p.x - (b.x0 - m), (b.x1 + m) - p.x, p.z - (b.z0 - m), (b.z1 + m) - p.z], q = Math.min(...d);
    if (q === d[0]) p.x = b.x0 - m; else if (q === d[1]) p.x = b.x1 + m; else if (q === d[2]) p.z = b.z0 - m; else p.z = b.z1 + m;
  }
}
const _lp = { x: 0, y: 0, z: 0 };
function updateLights(dt, t) {
  let sw = 0, sx = 0, sy = 0, sz = 0;
  for (let i = 0; i < count; i++) {
    if (kind[i] !== STREAM) continue;
    const w = heat[i] * heat[i] * Math.min(rad[i], 0.4) * op[i];
    sw += w; sx += x[i] * w; sy += y[i] * w; sz += z[i] * w;
  }
  let fw = 0, fx2 = 0, fy = 0, fz = 0;
  for (const f of fires) { const w = f.str; fw += w; fx2 += (f.x + f.nx * 0.3) * w; fy += (f.y + f.ny * 0.3 + 0.25) * w; fz += (f.z + f.nz * 0.3) * w; }
  const kk = 1 - Math.exp(-dt * 14);
  L.flick = 0.82 + 0.18 * Math.sin(t * 31) * Math.sin(t * 17.3 + 1) + 0.08 * Math.sin(t * 53);
  if (sw > 1e-4) {
    _lp.x = sx / sw; _lp.y = sy / sw; _lp.z = sz / sw; clearOfWalls(_lp, 0.6);
    if (L.si < 0.01) { L.sx = _lp.x; L.sy = _lp.y; L.sz = _lp.z; }
    L.sx += (_lp.x - L.sx) * kk; L.sy += (_lp.y - L.sy) * kk; L.sz += (_lp.z - L.sz) * kk;
  }
  L.si = Math.min(sw * cfg.lightK, 10);
  if (fw > 1e-4) {
    _lp.x = fx2 / fw; _lp.y = fy / fw; _lp.z = fz / fw; clearOfWalls(_lp, 0.7);
    if (L.fi < 0.01) { L.fx = _lp.x; L.fy = _lp.y; L.fz = _lp.z; }
    L.fx += (_lp.x - L.fx) * kk * 0.5; L.fy += (_lp.y - L.fy) * kk * 0.5; L.fz += (_lp.z - L.fz) * kk * 0.5;
  }
  L.fi = Math.min(fw * cfg.lightK * 2.2, 6);
  const flick2 = 0.75 + 0.25 * Math.sin(t * 23.7 + 2) * Math.sin(t * 9.1);
  if (L.si > 0.02 || !L.pilot) { streamLight.position.set(L.sx, L.sy, L.sz); streamLight.intensity = L.si * L.flick; }
  else { streamLight.position.copy(L.pilot.p); streamLight.intensity = L.pilot.i * (0.85 + 0.15 * Math.sin(t * 40)); }   // just the pilot flame
  fireLight.position.set(L.fx, L.fy, L.fz); fireLight.intensity = L.fi * flick2;
  fx.heat = Math.min(1, sw * 0.6 + fw * 0.25);
  // what the mic hears burning: the fires, by how close they are
  let near = 0;
  for (const f of fires) near += f.str / (1 + ((f.x - camera.position.x) ** 2 + (f.y - camera.position.y) ** 2 + (f.z - camera.position.z) ** 2) * 0.12);
  setBurning(near + sw * 0.01);
}
// the pilot flame lights the nozzle when nothing else burns: { p: Vector3, i }
export function setPilotLight(p) { L.pilot = p; }

// ---------------------------------------------------------------- drawing
// Each particle is a camera-facing quad. How it is shaped and shaded depends on what it is:
//  - stream (in flight): the jet is one continuous body. Each particle stands for a short stretch of a tube (the jet,
//    narrow at the nozzle, swelling as it burns), a soft window along the jet as long as the gap to the next particle,
//    so the stretches add up to one. Each is drawn over where that stretch projects (in perspective: right after the
//    nozzle the jet heads almost straight away from the camera, and perspective, not its slant, spreads it across the
//    screen), and each pixel intersects its own ray with the tube: it gets as much flame as the ray passes through,
//    across the jet when seen side on, along it when seen end on.
//    The flame is carved by turbulence read in the fuel's own coordinates (across the jet, and along it by when that
//    fuel left the nozzle), so neighbours agree and the pattern flows out with the fuel; it churns as it ages.
//    Before this, each particle was its own ball with its own pattern, and the jet read as a string of balls.
//  - a surface fire's body, its licks, and splashed fuel: one shared field rising through the room, so where they
//    overlap their flames line up instead of piling up as separate blobs. The body is drawn whole, wide at the base
//    and tapering into tongues; licks are tongues breaking away from it.
//  - smoke: the same rising field, slower and coarser; dark, lit by the room and the fires.
//  - embers: hot points, smeared by their motion.
const VS = PORTAL_GLSL + `
  attribute vec3 iPos, iVel; attribute vec4 iA, iB, iC;
  uniform float uStretchT, uPxPerRad; uniform vec3 uGlowA, uGlowB; uniform float uGlowAI, uGlowBI;
  varying vec2 vUv, vExt; varying vec4 vA, vB, vC; varying float vZ, vH, vGain, vAmbK, vSig, vSpeed, vPxR;
  varying vec3 vGlow, vWorld, vVP, vCv, vDv;
  void main(){
    vAmbK = envZone(iPos);   // the room's light on the smoke: none deep in the dark corridor
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    float kind = iB.x, r = iA.x, gain = 1.0;
    // never smaller than about a pixel and a half of the fire layer: smaller would twinkle; what is enlarged gets
    // fainter to keep its brightness right
    float rMin = (kind < 0.5 ? 2.5 : 1.5) * max(-mv.z, 0.05) / uPxPerRad;
    if (kind < 3.5 && r < rMin) { gain = (r * r) / (rMin * rMin); r = rMin; }
    vPxR = r * uPxPerRad / max(-mv.z, 0.05);   // its radius in fire-layer pixels
    vec2 ax = vec2(1.0, 0.0), shift = vec2(0.0);
    float ea = r, eb = r, h = 0.0;
    vSig = 1.0; vSpeed = 1.0; vVP = vec3(0.0); vCv = vec3(0.0); vDv = vec3(0.0, 0.0, -1.0);
    vec3 da = iPos - uGlowA, db = iPos - uGlowB;
    vGlow = vec3(1.0, 0.5, 0.2) * (uGlowAI / (1.0 + dot(da, da) * 1.5) + uGlowBI / (1.0 + dot(db, db) * 1.5));
    vA = vec4(r, iA.yzw); vB = iB; vC = iC; vUv = position.xy; vH = 0.0;
    if (kind < 0.5) {
      // a stretch of the jet: from 2.5 window-widths behind its centre to 2.5 ahead, as wide as the jet. The quad is
      // built over that segment's projection (both ends in perspective, the radius all round, the ends kept in front
      // of the camera); the fragment shader intersects each pixel's ray with the tube.
      float sp = length(iVel);
      vec3 dir = sp > 0.05 ? iVel / sp : vec3(0.0, 0.0, -1.0);
      float spacing = clamp(sp * iC.y, 0.004, 0.6);
      float sig = max(spacing * 1.1, r * 0.3);
      vec3 cV = mv.xyz, dV = normalize((viewMatrix * vec4(dir, 0.0)).xyz);
      vec3 E0 = cV - dV * 2.5 * sig, E1 = cV + dV * 2.5 * sig;
      const float ZN = -0.06;
      if (cV.z < ZN) {
        if (E0.z > ZN) E0 = cV + (E0 - cV) * ((ZN - cV.z) / (E0.z - cV.z));
        if (E1.z > ZN) E1 = cV + (E1 - cV) * ((ZN - cV.z) / (E1.z - cV.z));
      }
      vec2 s0 = E0.xy / -min(E0.z, ZN), s1 = E1.xy / -min(E1.z, ZN), sd = s1 - s0;
      float sl = length(sd);
      vec2 u2 = sl > 1e-5 ? sd / sl : vec2(1.0, 0.0);
      vec3 t3 = vec3(u2, 0.0), n3 = vec3(-u2.y, u2.x, 0.0);
      float w = r * 1.15;
      vec3 vp = (position.x < 0.0 ? E0 - t3 * w : E1 + t3 * w) + n3 * position.y * w;
      gl_Position = projectionMatrix * vec4(vp, 1.0);
      vVP = vp; vCv = cV; vDv = dV; vZ = -vp.z;
      vSig = sig; vSpeed = sp;
      vGain = gain * spacing / (sig * 1.7725);   // the windows of a run of particles add up to one
      vWorld = vec3(0.0); vExt = vec2(1.0);
      return;
    } else if (kind < 1.5 || (kind > 3.5 && kind < 4.5)) {
      // upright on screen: a tongue of flame (tall), or a surface fire's body (iA.x half-width, iA.y half-height)
      vec2 up = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xy;
      ax = length(up) > 1e-3 ? normalize(up) : vec2(0.0, 1.0);
      if (kind < 1.5) { ea = r * 1.8; eb = r; shift = ax * r * 0.6; }
      else { ea = iA.y; eb = iA.x; }
    } else {
      // round, smeared along its motion during the exposure
      vec2 s = (viewMatrix * vec4(iVel, 0.0)).xy * uStretchT;
      float sl = length(s);
      ax = sl > 1e-5 ? s / sl : vec2(1.0, 0.0); h = sl * 0.5 / r;
      ea = r * (1.0 + h); eb = r;
      gain /= 1.0 + 2.0 * h;   // the same light, spread over the streak
    }
    vec2 ay = vec2(-ax.y, ax.x);
    vec2 off = shift + ax * position.x * ea + ay * position.y * eb;
    mv.xy += off;
    gl_Position = projectionMatrix * mv;
    vWorld = iPos + vec3(off, 0.0) * mat3(viewMatrix);   // this corner in the world: the view's rotation, inverted
    vExt = vec2(ea, eb); vZ = -mv.z; vH = h; vGain = gain;
  }`;
const FS = `
  precision highp sampler3D;
  uniform highp sampler3D tNoise; uniform sampler2D tDepth;
  uniform vec2 uInvRes; uniform float uNear, uFar, uTime, uFlame, uAmb, uDbg;
  varying vec2 vUv, vExt; varying vec4 vA, vB, vC; varying float vZ, vH, vGain, vAmbK, vSig, vSpeed, vPxR;
  varying vec3 vGlow, vWorld, vVP, vCv, vDv;
  #define KT ${KT.toFixed(1)}
  float linZ(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
  // light from burning soot as this camera sees it (white-balanced for fluorescent light): deep red when cooler,
  // through orange and yellow to a pale core; the brightness climbs steeply with temperature
  vec3 ramp(float t){
    vec3 c = mix(vec3(0.6, 0.05, 0.0), vec3(1.0, 0.26, 0.02), smoothstep(0.0, 0.35, t));
    c = mix(c, vec3(1.0, 0.5, 0.08), smoothstep(0.3, 0.65, t));
    c = mix(c, vec3(1.0, 0.8, 0.45), smoothstep(0.62, 1.0, t));
    return c * (0.01 + 1.2 * pow(t, 2.6));
  }
  float erfA(float x){ float x2 = x * x; return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732 + 0.147 * x2) / (1.0 + 0.147 * x2))); }
  // two octaves of warped noise at c (0-1, mean about 0.5)
  float turb(vec3 c, vec3 cw){
    vec2 w = texture(tNoise, cw).rg - 0.5;
    float n1 = texture(tNoise, c + vec3(w * 0.9, 0.31)).r;
    float n2 = texture(tNoise, c * vec3(2.2, 2.2, 2.0) + vec3(w * 1.5, 0.77)).g;
    return n1 * 0.62 + n2 * 0.38;
  }
  void main(){
    float kind = vB.x, opac = vB.y, age = vB.z;
    float r = vA.x, t = vA.y, heat = vA.z;
    float rs = kind > 3.5 && kind < 4.5 ? min(vA.x, vA.y) : r;
    // soft where it meets the room, hidden behind walls, faded as it passes through the lens
    float sceneZ = linZ(texture2D(tDepth, gl_FragCoord.xy * uInvRes).r);
    float soft = clamp((sceneZ - vZ) / (rs * 0.6 + 0.03), 0.0, 1.0) * smoothstep(0.08, 0.32, vZ);
    if (soft <= 0.002) discard;

    if (kind < 0.5) {   // the jet: this pixel's ray against this stretch of tube (view space, the camera at the origin)
      vec3 rd = normalize(vVP), c = vCv, d = vDv;
      float bb = dot(rd, d), dc = dot(rd, c), ec = dot(d, c), D = max(1.0 - bb * bb, 1e-6);
      float tR = (dc - bb * ec) / D, a0 = (bb * dc - ec) / D;   // closest approach: along the ray, along the axis
      float h = length(tR * rd - c - a0 * d);
      if (h >= r) discard;
      float cosT = max(abs(bb), 0.02), q = sqrt(r * r - h * h);
      float cax = q * abs(bb) / sqrt(D);   // how far along the axis the ray stays inside the tube, either way
      // the ray's path inside the tube (m), weighted by the window: side on, the jet's thickness here; end on, its length
      float I = vSig * 0.8862 / cosT * (erfA((a0 + cax) / vSig) - erfA((a0 - cax) / vSig));
      float amt = I / (2.0 * r) * vGain * opac * soft;
      if (amt < 0.003) discard;
      if (uDbg > 0.5) { gl_FragColor = vec4(vec3(amt * 0.25), 0.0); return; }   // (debugging: the density alone)
      // The flame and its turbulence are read at the point of that path, within this window's core, nearest the jet's
      // axis. (At the window's middle instead, a ray down the jet met each window's core only near its own crossing
      // point, so the windows lit up one at a time along it: a string of beads.)
      float aR = clamp(clamp(a0, -1.2 * vSig, 1.2 * vSig), a0 - cax, a0 + cax);
      vec3 pR = (tR + (aR - a0) / (abs(bb) > 1e-4 ? bb : 1e-4)) * rd - c - aR * d;   // from the axis out to that point
      vec3 side = normalize(cross(d, abs(d.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec2 lat = vec2(dot(pR, side), dot(pR, cross(side, d)));   // across the jet
      float an = clamp(aR, -1.5 * vSig, 1.5 * vSig), sp = max(vSpeed, 0.3);
      float tau = vC.x - an / sp * KT;   // when this fuel left the nozzle (noise units): the pattern flows out with it
      float ageP = age + an / sp;        // how long it has burned: the pattern churns as it ages
      vec2 lc = lat / (0.12 + r);        // eddies grow as the jet swells
      float n = turb(vec3(lc * 0.8, tau + ageP * 0.35), vec3(lc * 0.45, tau * 0.5 + ageP * 0.6));
      float field = (1.0 - min(dot(lat, lat) / (r * r), 1.0)) * 1.05 + (n - 0.5) * 2.3;
      // Where the jet is only a few pixels wide (just out of the nozzle, far away), its flame front is softened: a sharp
      // edge sampled pixel by pixel along a thin diagonal line breaks it up into a string of beads.
      float thin = clamp(4.0 / vPxR, 0.0, 1.0);
      float burn = 0.12 + t * 0.62 - thin * 0.15;   // burning out: less and less of it is flame
      float body = smoothstep(burn, burn + 0.22 + thin * 0.6, field);
      float core = smoothstep(burn + 0.25, burn + 0.8 + thin * 0.4, field);
      float tt = heat * (0.42 + 0.58 * core);
      // soot around the flame front: unlit and dark, more of it as the flame cools
      float soot = smoothstep(burn - 0.3, burn + 0.05, field) * (1.0 - body) * 0.3 * smoothstep(0.35, 0.9, t);
      gl_FragColor = vec4(ramp(tt) * uFlame * body, max(body * 0.1 * (1.0 - 0.5 * heat), soot)) * amt;
      return;
    }
    if (kind > 2.5 && kind < 3.5) {   // ember: a hot point, smeared by its motion
      vec2 q = vec2(max(abs(vUv.x) * (1.0 + vH) - vH, 0.0), vUv.y);
      float e = (1.0 - smoothstep(0.2, 1.0, length(q))) * vGain * opac * soft;
      gl_FragColor = vec4(ramp(heat) * uFlame * 1.6 * e, 0.0);
      return;
    }
    if (kind > 1.5 && kind < 2.5) {   // smoke: billowing, darker in its thick middle, lit orange from below by the flames
      vec2 q = vec2(max(abs(vUv.x) * (1.0 + vH) - vH, 0.0), vUv.y);
      float dd = dot(q, q);
      if (dd >= 1.0) discard;
      vec3 c = vWorld * 0.45 - vec3(0.0, uTime * 0.135, 0.0) + vec3(0.0, 0.0, uTime * 0.04);
      float n = turb(c, c * 0.6);
      float dens = smoothstep(0.22, 0.7, (1.0 - dd) * 1.05 + (n - 0.5) * 2.3);
      // a thin haze rather than a wall (0.78 hid half the frame after a few seconds of fire), thinner still right in
      // front of the lens, so standing under the smoke doesn't black out the picture
      float a = dens * opac * 0.34 * soft * smoothstep(0.25, 1.3, vZ);
      vec3 lit = vec3(0.055, 0.05, 0.046) * (uAmb * vAmbK * (0.45 + 0.55 * n) + vGlow * (0.3 + 1.0 * n));
      gl_FragColor = vec4(lit * a, a);
      return;
    }
    // flames on and off surfaces: licks (1), a fire's body (4), splashed fuel (5), in one field rising through the room
    vec3 c = vWorld * 1.25 - vec3(0.0, uTime * 1.9, 0.0) + vec3(0.0, 0.0, uTime * 0.35);
    float n = turb(c, c * 0.6);
    float env, burn, tt0;
    if (kind > 4.5) {   // splashed fuel: a soft blob that burns out
      vec2 q = vec2(max(abs(vUv.x) * (1.0 + vH) - vH, 0.0), vUv.y);
      float dd = dot(q, q);
      if (dd >= 1.0) discard;
      env = (1.0 - dd) * 1.1; burn = 0.2 + t * 0.6; tt0 = heat;
    } else {            // upright: wide at the base, tapering into tongues at the top
      float yy = vUv.x * 0.5 + 0.5;
      float hw = sqrt(max(1.0 - yy, 0.0)) * smoothstep(-0.12, 0.2, yy);
      env = (1.0 - smoothstep(hw * 0.3, hw, abs(vUv.y))) * (kind > 3.5 ? 1.2 : 1.0);
      burn = kind > 3.5 ? 0.14 + yy * 0.6 : 0.2 + t * 0.6 + yy * 0.25;   // the top breaks up into tongues
      tt0 = heat * (1.0 - yy * 0.35);
    }
    float field = env + (n - 0.5) * (kind > 3.5 ? 2.8 : 2.4);
    // White at the heart, through yellow and orange to a dull red rim: the hot core only starts well inside the flame's
    // edge. (When it started right at the edge, a fire on a wall clipped to one flat colour with a cut-out outline.)
    float body = smoothstep(burn, burn + 0.28, field);
    float core = smoothstep(burn + 0.3, burn + 1.2, field);
    float tt = clamp(tt0 * (0.3 + 0.7 * core), 0.0, 1.0);
    float soot = smoothstep(burn - 0.3, burn + 0.05, field) * (1.0 - body) * 0.25;
    // fuel burning on a surface is less fierce than the jet: orange and yellow, white only where it's thickest
    gl_FragColor = vec4(ramp(tt) * uFlame * (kind > 3.5 ? 0.6 : 1.0) * body, max(body * 0.08, soot)) * (opac * vGain * soft);
  }`;

const NI = MAX + MAX_FIRES;   // instances: every particle, and every surface fire's body
const quad = new THREE.InstancedBufferGeometry();
quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
quad.setIndex([0, 1, 2, 0, 2, 3]);
const inst = (n) => new THREE.InstancedBufferAttribute(new Float32Array(NI * n), n).setUsage(THREE.DynamicDrawUsage);
const iPos = inst(3), iVel = inst(3), iA = inst(4), iB = inst(4), iC = inst(4);
quad.setAttribute('iPos', iPos); quad.setAttribute('iVel', iVel); quad.setAttribute('iA', iA); quad.setAttribute('iB', iB); quad.setAttribute('iC', iC);
quad.instanceCount = 0;
export const fireMat = new THREE.ShaderMaterial({
  uniforms: Object.assign({
    tNoise: noiseUniform, uTime: { value: 0 }, uFlame: { value: cfg.flame }, uAmb: { value: 0.1 }, uDbg: { value: 0 }, uStretchT: { value: 1 / 150 }, uPxPerRad: { value: 200 },
    uGlowA: { value: new THREE.Vector3() }, uGlowB: { value: new THREE.Vector3() }, uGlowAI: { value: 0 }, uGlowBI: { value: 0 },
    uPortal: shared.uPortal, uEnvZ: shared.uEnvZ,
  }, fxLayer.uniforms),
  vertexShader: VS, fragmentShader: FS, transparent: true, depthTest: false, depthWrite: false,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
});
const mesh = new THREE.Mesh(quad, fireMat);
mesh.frustumCulled = false;
fxLayer.scene.add(mesh);

// back to front: smoke in front hides the flames behind it, flames in front add their light
const order = new Uint32Array(NI), key = new Float32Array(NI);
const _cp = new THREE.Vector3(), _cf = new THREE.Vector3();
const bodies = Array.from({ length: MAX_FIRES }, () => ({ x: 0, y: 0, z: 0, w: 0, h: 0, heat: 0, op: 0, seed: 0 }));
function upload(t) {
  camera.getWorldPosition(_cp); camera.getWorldDirection(_cf);
  // a body of flame for each surface fire: it stands up from where the fuel burns (on a wall, out from it a little;
  // on the ceiling, low and wide, hanging down)
  const nb = fires.length;
  for (let k = 0; k < nb; k++) {
    const f = fires[k], b = bodies[k], s = f.str, ceil = f.ny < -0.5, wall = Math.abs(f.ny) <= 0.5;
    b.h = ceil ? 0.07 + 0.1 * s : (wall ? 0.2 : 0.16) + (wall ? 0.5 : 0.45) * s;
    b.w = ceil ? 0.2 + 0.3 * s : 0.11 + 0.25 * s;
    const out = ceil ? 0.1 : wall ? 0.1 : 0.02, lift = ceil ? -0.02 : b.h * (wall ? 0.75 : 0.9);
    b.x = f.x + f.nx * out; b.y = f.y + f.ny * out + lift; b.z = f.z + f.nz * out;
    b.heat = 0.42 + 0.3 * s; b.seed = f.seed;   // cooler than the jet: orange, its brightest only low down
    b.op = Math.min(1, s * 1.6) * (0.88 + 0.12 * Math.sin(t * (9 + 5 * f.seed) + f.seed * 40));
  }
  const n = count + nb;
  for (let i = 0; i < count; i++) { order[i] = i; key[i] = (x[i] - _cp.x) * _cf.x + (y[i] - _cp.y) * _cf.y + (z[i] - _cp.z) * _cf.z; }
  for (let k = 0; k < nb; k++) { const b = bodies[k]; order[count + k] = count + k; key[count + k] = (b.x - _cp.x) * _cf.x + (b.y - _cp.y) * _cf.y + (b.z - _cp.z) * _cf.z; }
  const ord = order.subarray(0, n).sort((a, b) => key[b] - key[a]);
  const P = iPos.array, V = iVel.array, A = iA.array, B = iB.array, C = iC.array;
  for (let j = 0; j < n; j++) {
    const i = ord[j];
    if (i >= count) {
      const b = bodies[i - count];
      P[j * 3] = b.x; P[j * 3 + 1] = b.y; P[j * 3 + 2] = b.z;
      V[j * 3] = V[j * 3 + 1] = V[j * 3 + 2] = 0;
      A[j * 4] = b.w; A[j * 4 + 1] = b.h; A[j * 4 + 2] = b.heat; A[j * 4 + 3] = b.seed;
      B[j * 4] = BODY; B[j * 4 + 1] = b.op; B[j * 4 + 2] = clock; B[j * 4 + 3] = 0;
      C[j * 4] = C[j * 4 + 1] = 0;
      continue;
    }
    P[j * 3] = x[i]; P[j * 3 + 1] = y[i]; P[j * 3 + 2] = z[i];
    if (kind[i] === STREAM && !(flag[i] & 2)) { V[j * 3] = -sgx[i]; V[j * 3 + 1] = -sgy[i]; V[j * 3 + 2] = -sgz[i]; }
    else { V[j * 3] = vx[i]; V[j * 3 + 1] = vy[i]; V[j * 3 + 2] = vz[i]; }
    A[j * 4] = rad[i]; A[j * 4 + 1] = age[i] / life[i]; A[j * 4 + 2] = heat[i]; A[j * 4 + 3] = seed[i];
    B[j * 4] = kind[i] === STREAM && (flag[i] & 2) ? SPLASH : kind[i]; B[j * 4 + 1] = op[i]; B[j * 4 + 2] = age[i]; B[j * 4 + 3] = 0;
    C[j * 4] = (tauE[i] * KT) % TAU_WRAP; C[j * 4 + 1] = dtE[i];
  }
  for (const [a, m] of [[iPos, 3], [iVel, 3], [iA, 4], [iB, 4], [iC, 4]]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * m); a.needsUpdate = true; }
  quad.instanceCount = n;
  fxLayer.count = n;
}

// per frame (after the flamethrower has set the nozzle)
export function updateFire(dt, t) {
  const t0 = clock;
  clock += dt;
  burnt = 0;
  updateFires(dt);
  for (let i = 0; i < count; i++) if (!stepParticle(i, dt)) { kill(i); i--; }
  if (nozzle.flow > 0.01) emitStream(dt, t0); else nextEmit = -1;
  if (nozzle.drip > 0.01) emitDrip(dt);
  updateLights(dt, t);
  setSizzle(burnt / Math.max(dt, 1e-3));
  const u = fireMat.uniforms;
  u.uTime.value = t; u.uFlame.value = cfg.flame; u.uAmb.value = world.ambient;
  u.uGlowA.value.copy(streamLight.position); u.uGlowAI.value = streamLight.intensity * 0.03;
  u.uGlowB.value.copy(fireLight.position); u.uGlowBI.value = fireLight.intensity * 0.03;
  // pixels of the fire layer per radian at the centre of the view (for the minimum puff size)
  u.uPxPerRad.value = (1 / fxLayer.uniforms.uInvRes.value.y) / (camera.fov * Math.PI / 180);
  upload(t);
}
export const fireStats = () => {
  const c = [0, 0, 0, 0]; for (let i = 0; i < count; i++) c[kind[i]]++;
  return { stream: c[0], licks: c[1], smoke: c[2], embers: c[3], fires: fires.length, total: count };
};
export function clearFire() { count = 0; fires.length = 0; nextEmit = -1; fxLayer.count = 0; quad.instanceCount = 0; }
// put out everything where test(x, z) is true (a room that's no longer placed: what burned there isn't there now)
export function clearFireIn(test) {
  for (let i = count - 1; i >= 0; i--) if (test(x[i], z[i])) kill(i);
  for (let k = fires.length - 1; k >= 0; k--) if (test(fires[k].x, fires[k].z)) fires.splice(k, 1);
}
