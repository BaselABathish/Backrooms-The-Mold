// What you can use in the rooms (E, or USE on a phone): doors, a safe room's generator, fuel cans.
//  - Doors (docs/ROOMS.md): heavy double doors in some doorways. A door belongs to one room's doorway (its owner),
//    swings into that room, and is drawn by every placed copy of it. A closed door stops you, the fire, light through
//    the doorway and the mold (it seeps under, slowly), and it hides what's behind it: world/level.js only swaps a room
//    out of view, so behind a closed door the room can change.
//  - The generator keeps a safe room lit, and the mold out, while it has fuel; it burns a second's worth each second
//    while the room is placed, and you pour your own fuel into it (hold E): staying costs what you'd fight with. Dry,
//    its lights die and the room is like any other.
//  - Fuel cans refill the flamethrower.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { doorSteelMat, doorWoodMat, pipeMat, canMat, litFor } from './materials.js';
import { DOOR_W, WALL } from './rooms.js';
import { world } from './world.js';
import { weapon, FUEL_MAX } from '../weapon/flamethrower.js';
import { doorSound, setGenerator, generatorStart, generatorStop, setPour, pickupSound } from '../audio/audio.js';

export const doors = [];
const LEAF_W = DOOR_W / 2 - 0.045, LEAF_T = 0.05, OPEN_AT = 0.55;   // (hinged 4 cm in from each side: the two leaves meet with a hair's gap)   // a door is in the way until it's this far open
export const doorShut = D => D.open < OPEN_AT;

// ---------------------------------------------------------------- geometry (shared between doors of a kind and height)
const noMold = g => { g.setAttribute('aMoldUv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2).fill(-1), 2)); return g; };
const box = (w, h, d, x, y, z) => { const g = new THREE.BoxGeometry(w, h, d).toNonIndexed(); g.translate(x, y, z); return g; };
const geoCache = new Map();
// a leaf hinged at x = 0, reaching along +x; its faces at z = +-LEAF_T/2. Steel: plain, with a push bar and a kick
// plate on both faces. Wood: two raised panels a face, and a round knob.
function leafGeos(kind, h) {
  const key = kind + h;
  if (geoCache.has(key)) return geoCache.get(key);
  const body = [box(LEAF_W, h - 0.02, LEAF_T, LEAF_W / 2, h / 2, 0)], fit = [];
  for (const s of [-1, 1]) {
    const z = s * (LEAF_T / 2 + 0.006);
    if (kind === 'steel') {
      body.push(box(LEAF_W - 0.1, 0.22, 0.008, LEAF_W / 2, 0.14, z));                             // kick plate
      fit.push(box(LEAF_W - 0.2, 0.035, 0.03, LEAF_W / 2 + 0.04, 1.02, s * (LEAF_T / 2 + 0.05)));   // push bar
      for (const x of [0.12, LEAF_W - 0.08]) fit.push(box(0.04, 0.06, 0.05, x, 1.02, s * (LEAF_T / 2 + 0.025)));
    } else {
      body.push(box(LEAF_W - 0.22, h * 0.36, 0.012, LEAF_W / 2, h * 0.27, z), box(LEAF_W - 0.22, h * 0.36, 0.012, LEAF_W / 2, h * 0.7, z));   // panels
      const knob = new THREE.SphereGeometry(0.03, 10, 8).toNonIndexed(); knob.translate(LEAF_W - 0.08, 0.98, s * (LEAF_T / 2 + 0.035)); fit.push(knob);
      fit.push(box(0.02, 0.02, 0.03, LEAF_W - 0.08, 0.98, s * (LEAF_T / 2 + 0.012)));
    }
  }
  const out = [noMold(mergeGeometries(body)), noMold(mergeGeometries(fit))];
  geoCache.set(key, out);
  return out;
}

// a door in owner room R's doorway d (kind 'steel' | 'wood'), open (1) or shut (0)
export function makeDoor(R, d, kind, open = 0) {
  const D = { owner: R, d, kind, open, target: open, h: R.plan.doors[d].h, moving: false };
  (R.ownDoors ??= [])[d] = D;
  doors.push(D);
  for (const I of R.inst) attachDoor(I, D);
  world.doorsChanged = true;
  return D;
}
const matFor = (I, base) => { if (!I.mats.has(base)) I.mats.set(base, litFor(base, I.u)); return I.mats.get(base); };
// draw door D in placed room I (its owner): a frame, and two leaves on pivots at the hinges
export function attachDoor(I, D) {
  const dd = I.room.plan.doors[D.d], nx = dd.nx, nz = dd.nz, tx = -nz, tz = nx;
  const cx = dd.x - nx * WALL / 2, cz = dd.z - nz * WALL / 2;   // in the middle of the owner's half of the wall
  const g = new THREE.Group(), mat = matFor(I, D.kind === 'steel' ? doorSteelMat : doorWoodMat), fitMat = matFor(I, pipeMat);
  // the frame: jambs and a head, a little proud of the wall on the room's side
  const fr = [], hw = DOOR_W / 2;
  for (const s of [-1, 1]) fr.push(box(0.05, D.h, WALL + 0.03, 0, D.h / 2, 0).translate(s * (hw - 0.01), 0, 0));
  fr.push(box(DOOR_W + 0.08, 0.06, WALL + 0.03, 0, D.h + 0.02, 0));
  const frame = new THREE.Mesh(noMold(mergeGeometries(fr)), mat);
  frame.position.set(cx - nx * 0.015, 0, cz - nz * 0.015);
  frame.rotation.y = Math.atan2(nx, nz);   // (its local x along the wall)
  frame.castShadow = true; frame.receiveShadow = true;
  g.add(frame);
  const [bodyGeo, fitGeo] = leafGeos(D.kind, D.h), leaves = [];
  for (const s of [-1, 1]) {   // s: the hinge's side along t
    const pivot = new THREE.Group();
    pivot.position.set(cx + tx * s * (hw - 0.04), 0, cz + tz * s * (hw - 0.04));
    // shut, the leaf reaches from its hinge toward the middle (-s t); open, it stands into the room (-n)
    const phi0 = Math.atan2(s * tz, -s * tx), phi1 = Math.atan2(nz, -nx);
    let dphi = phi1 - phi0;
    while (dphi > Math.PI) dphi -= 2 * Math.PI;
    while (dphi < -Math.PI) dphi += 2 * Math.PI;
    pivot.userData = { phi0, dphi };
    for (const [geo, m] of [[bodyGeo, mat], [fitGeo, fitMat]]) { const mesh = new THREE.Mesh(geo, m); mesh.castShadow = true; mesh.receiveShadow = true; pivot.add(mesh); }
    g.add(pivot); leaves.push(pivot);
  }
  I.group.add(g);
  (I.doors ??= []).push({ D, g, leaves });
  pose(I.doors[I.doors.length - 1]);
}
const ease = v => v * v * (3 - 2 * v);
function pose(m) { for (const p of m.leaves) p.rotation.y = p.userData.phi0 + p.userData.dphi * ease(m.D.open); }
// the door's collider while it's shut (world coordinates, through placed room I)
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
export function doorCollider(I, D) {
  const s = I.room.plan.doors[D.d].strip;
  _a.set(s.x0, 0, s.z0).applyMatrix4(I.group.matrixWorld); _b.set(s.x1, 0, s.z1).applyMatrix4(I.group.matrixWorld);
  return { x0: Math.min(_a.x, _b.x), z0: Math.min(_a.z, _b.z), x1: Math.max(_a.x, _b.x), z1: Math.max(_a.z, _b.z), y0: 0, h: D.h, door: true };
}

// ---------------------------------------------------------------- fuel cans (refill the flamethrower)
const CAN_FUEL = 225;   // seconds of fire in a fuel can: 45% of the tank, as it was with the old 100 s tank
let canGeos = null;
function canGeometry() {   // a jerrycan: a body, a handle, a spout
  if (canGeos) return canGeos;
  const body = mergeGeometries([box(0.17, 0.34, 0.27, 0, 0.17, 0), box(0.03, 0.04, 0.12, 0, 0.36, -0.02), box(0.03, 0.06, 0.03, 0, 0.37, 0.1)]);
  return (canGeos = noMold(body));
}
export function attachCans(I) {
  I.cans = [];
  for (const c of I.room.plan.cans ?? []) {
    const m = new THREE.Mesh(canGeometry(), matFor(I, canMat));
    m.position.set(c.x, 0, c.z); m.rotation.y = c.ry ?? 0; m.castShadow = true; m.receiveShadow = true;
    m.visible = !c.taken;
    I.group.add(m);
    I.cans.push({ c, m });
  }
}

// ---------------------------------------------------------------- per frame
const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _cam = new THREE.Vector3();
let target = null, pouring = false;
// insts: the placed rooms; cam: the camera; use: { held, pressed }; returns what the prompt should say ('' for none)
export function updateInteract(dt, insts, cam, use, touch) {
  // doors swing (heavy: about a second), and are posed in every placed copy
  for (const D of doors) {
    if (D.open === D.target) continue;
    const was = doorShut(D), sp = D.kind === 'steel' ? 0.9 : 1.3;
    D.open = D.target > D.open ? Math.min(D.target, D.open + dt * sp) : Math.max(D.target, D.open - dt * sp);
    if (D.open === D.target) doorSound(D.kind, D.target ? 'stop' : 'shut');
    if (was !== doorShut(D)) world.doorsChanged = true;
    for (const I of D.owner.inst) for (const m of I.doors ?? []) if (m.D === D) pose(m);
  }
  // generators: burn while their room is placed
  const live = new Set();
  let hum = 0;
  cam.getWorldPosition(_cam);
  for (const I of insts) {
    const R = I.room, pw = R.power;
    if (!pw || live.has(R)) continue;
    live.add(R);
    if (pw.on) {
      pw.fuel -= dt;
      if (pw.fuel <= 0) { pw.fuel = 0; pw.on = false; generatorStop(); }
    }
    if (pw.on && I.gen) { I.group.localToWorld(_p.set(I.gen.x, 0.5, I.gen.z)); hum = Math.max(hum, 1 / (1 + _p.distanceToSquared(_cam) * 0.08)); }
  }
  setGenerator(hum);
  // what you're facing, within reach
  cam.getWorldDirection(_d);
  let best = null, bd = Infinity;
  // (what you look at most squarely wins, then what's nearest: a can beside the generator is yours when you look at it)
  const consider = (kind, ref, I, x, y, z, reach) => {
    I.group.localToWorld(_p.set(x, y, z));
    const dx = _p.x - _cam.x, dy = _p.y - _cam.y, dz = _p.z - _cam.z, dist = Math.hypot(dx, dy, dz), dot = (dx * _d.x + dy * _d.y + dz * _d.z) / Math.max(dist, 1e-3);
    if (dist > reach || dot < 0.55) return;
    const score = (1 - dot) * 4 + dist * 0.25;
    if (score < bd) { bd = score; best = { kind, ref, I }; }
  };
  for (const I of insts) {
    for (const m of I.doors ?? []) { const dd = I.room.plan.doors[m.D.d]; consider('door', m.D, I, dd.x - dd.nx * 0.05, 1.05, dd.z - dd.nz * 0.05, 1.9); }
    if (I.gen && I.room.power) consider('gen', I.room.power, I, I.gen.x, 0.6, I.gen.z, 1.6);
    for (const k of I.cans ?? []) if (!k.c.taken) consider('can', k, I, k.c.x, 0.2, k.c.z, 1.85);   // (on the floor: measured from the chest, it's further)
  }
  target = best;
  // using it
  let pour = false;
  if (best && use.pressed) {
    if (best.kind === 'door') { const D = best.ref; D.target = D.target > 0.5 ? 0 : 1; doorSound(D.kind, D.target ? 'open' : 'close'); }
    if (best.kind === 'can') {
      const c = best.ref.c;
      c.taken = true;
      weapon.fuel = Math.min(FUEL_MAX, weapon.fuel + CAN_FUEL);
      for (const I of best.I.room.inst) for (const k of I.cans ?? []) if (k.c === c) k.m.visible = false;
      pickupSound();
    }
  }
  if (best?.kind === 'gen' && use.held && weapon.fuel > 0) {
    const pw = best.ref, tr = Math.min(dt * 18, weapon.fuel, pw.max - pw.fuel);
    if (tr > 0) {
      weapon.fuel -= tr; pw.fuel += tr; pour = true;
      if (!pw.on && pw.fuel > 3) { pw.on = true; generatorStart(); }
    }
  }
  if (pour !== pouring) { pouring = pour; setPour(pour); }
  // the prompt
  if (!best) return '';
  const key = touch ? 'USE' : 'E', hold = touch ? 'Hold USE' : 'Hold E';
  if (best.kind === 'door') return `${key} · ${best.ref.target > 0.5 ? 'close' : 'open'} the door`;
  if (best.kind === 'can') return `${key} · take the fuel can`;
  const pw = best.ref;
  if (weapon.fuel <= 0) return pw.on ? 'The generator is running' : 'The generator is dry, and so is your tank';
  if (pw.fuel >= pw.max - 0.5) return 'The generator is full';
  return `${hold} · pour fuel into the ${pw.on ? 'generator' : 'dry generator'}`;
}
export const interactTarget = () => target;
