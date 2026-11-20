// The black mold: a living layer on the rooms' surfaces (world/surfaces.js: cells of about CELL m, linked across the
// corners where surfaces meet). Simulated on the CPU, per room (R.mold), in the room's own coordinates; each room's
// materials draw it from the room's texture (r: mold, g: char). Across a doorway it spreads into the room the doorway
// leads to (R.links, from world/level.js): mold follows the place's own impossible geometry.
//  - A colony spreads from its edge into neighbouring cells: faster toward you (by distance measured along the
//    surfaces and through doorways, refreshed a few times a second, so it comes round through doorways rather than
//    through walls), unevenly (each cell resists differently: a ragged, fractal front), and never where something is
//    burning or freshly burnt.
//  - Each colony has its own temper (docs/MOLD.md): CREEP is a slow, broad front; RUSH races out from the tips nearest
//    you in thin tendrils along the floor and walls, for a few seconds. When it rushes is the colony's rule: when you
//    aren't looking at it, on its own clock, or never.
//  - Newly taken cells thicken over a few seconds (a fast colony thickens fast).
//  - Fire burns it back (burn()), leaves char that nothing grows on for half a minute, and heat holds the front back.
//  - Lights it covers die (coverage()), and if it reaches your feet it takes you (contact()).
//  - Only rooms that are placed around you (active) grow; the rest wait.
import * as THREE from 'three';
import { CELL } from '../world/surfaces.js';

const INF = 65535;
let time = 0;
export const colonies = [null];   // index = colony id (0: none)
export const moldRooms = [];      // every built room with mold cells (R.mi: its index; null once the room is let go)
// tunables (window.__br.mold.cfg)
export const cfg = {
  toward: 4.0, side: 1.0, away: 0.2,          // how much a creeping colony prefers cells nearer you
  rushToward: 7.0, rushSide: 0.25, rushAway: 0.02,
  tipWidth: 4,                                // rush: cells this much further than a colony's nearest edge still race
  creepK: 0.5, rushK: 0.5,                    // calibration: the measured edge speed is the colony's creep / rush (m/s)
  charBlock: 0.25,                            // nothing grows on char above this
  charFade: 0.025,                            // char lost per second
  damp: 1.6,                                  // how much faster it spreads and thickens in a damp (flooded) room
  reach: 240,                                 // the distance search stops this many cells from you (about 29 m)
  seep: 0.04,                                 // how readily it gets under a shut door, against an open doorway
};
export const stats = { cells: 0, front: 0, rush: 0, nearest: INF, bfsMs: 0, rooms: 0 };

// ---------------------------------------------------------------- a room's cells
const BK = 0.3;
const bkey = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
function query(R, x, y, z, r, fn) {
  const C = R.C, B = R.mold.buckets;
  const i0 = Math.floor((x - r) / BK), i1 = Math.floor((x + r) / BK), j0 = Math.floor((y - r) / BK), j1 = Math.floor((y + r) / BK), k0 = Math.floor((z - r) / BK), k1 = Math.floor((z + r) / BK);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) {
    const list = B.get(bkey(i, j, k));
    if (!list) continue;
    for (const c of list) {
      const dx = C.px[c] - x, dy = C.py[c] - y, dz = C.pz[c] - z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= r * r) fn(c, Math.sqrt(d2));
    }
  }
}

// a built room's mold state, texture and colonies (from its plan); a generator, like the rest of a room's building
export function* initRoomMold(R) {
  const C = R.C, n = C.n;
  const M = R.mold = { n, m: new Float32Array(n), ch: new Float32Array(n), col: new Uint8Array(n), res: new Float32Array(n), hot: new Float32Array(n).fill(-99),
    dist: new Uint16Array(n).fill(INF), nextDist: new Uint16Array(n).fill(INF), inFront: new Uint8Array(n), inThick: new Uint8Array(n), inChar: new Uint8Array(n),
    front: [], thick: [], charred: [], buckets: new Map(), dirty: true, active: false, doorOf: new Int8Array(n).fill(-1), doorCells: [], pair: new Map() };
  // how readily each cell takes: patchy (smooth noise from a few random sines, offset per room), plus a little grain
  const ox = R.seed % 97, oz = (R.seed >> 7) % 89;
  for (let c = 0; c < n; c++) {
    const x = C.px[c] + ox, y = C.py[c], z = C.pz[c] + oz;
    const smoothN = Math.sin(x * 1.7 + z * 0.9) * Math.sin(z * 1.3 - y * 1.1 + 2) * 0.5 + Math.sin(x * 4.1 - z * 3.3 + y * 2.7) * 0.25;
    M.res[c] = Math.max(0.15, 1 + smoothN * 0.8 + (Math.random() - 0.5) * 0.6);
    if ((c & 16383) === 16383) yield 'moldResPart';
  }
  yield 'moldRes';
  for (let c = 0; c < n; c++) {
    const key = bkey(Math.floor(C.px[c] / BK), Math.floor(C.py[c] / BK), Math.floor(C.pz[c] / BK));
    if (!M.buckets.has(key)) M.buckets.set(key, []);
    M.buckets.get(key).push(c);
  }
  yield 'moldBuckets';
  // each doorway's threshold: the floor cells in its hole, by their offset s along it (t = the normal turned left)
  R.plan.doors.forEach((d, di) => {
    const list = [], tx = -d.nz, tz = d.nx;
    query(R, d.x, 0, d.z, 1.2, c => {
      if (C.ny[c] !== 1 || C.px[c] < d.strip.x0 || C.px[c] > d.strip.x1 || C.pz[c] < d.strip.z0 || C.pz[c] > d.strip.z1) return;
      M.doorOf[c] = di;
      list.push([c, (C.px[c] - d.x) * tx + (C.pz[c] - d.z) * tz]);
    });
    M.doorCells[di] = list;
  });
  M.data = new Uint8Array(C.W * C.H * 2);
  M.tex = new THREE.DataTexture(M.data, C.W, C.H, THREE.RGFormat, THREE.UnsignedByteType);
  M.tex.minFilter = M.tex.magFilter = THREE.LinearFilter;
  M.tex.needsUpdate = true;
  R.moldTex = M.tex;
  if (R.mi === undefined || moldRooms[R.mi]) R.mi = moldRooms.length;
  moldRooms[R.mi] = R;
  if (R.moldSave) restoreMold(R);   // built again after being let go: as it was
  else {
    R.colonyIds = [];
    for (const def of R.plan.colonies) {
      const k = addColony({ name: def.name, ...def.temper });
      R.colonyIds.push(k);
      for (const [x, y, z, r, d] of def.seeds) seed(k, R, x, y, z, r, d);
    }
  }
  upload(R);
}
// Letting a room go (world/level.js frees rooms far behind you): keep only its mold, sparsely (cells are numbered the
// same when it's built again from the same plan), and take its cells off its colonies' counts.
export function releaseMold(R) {
  const M = R.mold;
  if (!M) return;
  const idx = [], val = [];
  for (let c = 0; c < M.n; c++) if (M.col[c] || M.ch[c] > 0) { idx.push(c); val.push(M.col[c], M.m[c], M.ch[c]); if (M.col[c]) colonies[M.col[c]].cells--; }
  R.moldSave = { idx: Int32Array.from(idx), val: Float32Array.from(val) };
  M.tex.dispose();
  moldRooms[R.mi] = null;
  R.mold = null;
}
function restoreMold(R) {
  const M = R.mold, { idx, val } = R.moldSave;
  for (let i = 0; i < idx.length; i++) {
    const c = idx[i], k = val[i * 3];
    if (c >= M.n) continue;
    if (k) { M.col[c] = k; M.m[c] = val[i * 3 + 1]; colonies[k].cells++; M.inFront[c] = 1; M.front.push(c); if (M.m[c] < 1) { M.inThick[c] = 1; M.thick.push(c); } }
    M.ch[c] = val[i * 3 + 2];
    if (M.ch[c] > 0) { M.inChar[c] = 1; M.charred.push(c); }
  }
  R.moldSave = null;
}

// the cell on the far side of a doorway: the threshold cell of the doorway it leads to, mirrored (two rooms joined at a
// doorway face each other, so one's left is the other's right). Null if that room has no mold cells yet.
function across(R, c) {
  const M = R.mold, di = M.doorOf[c], L = R.links?.[di];
  if (!L || !L.room.built || !L.room.mold) return null;   // (a room being built, or let go, has no thresholds)
  let p = M.pair.get(c);
  if (p === undefined || p.room !== L.room) {
    let s = 0;
    for (const [cc, ss] of M.doorCells[di]) if (cc === c) s = ss;
    let best = -1, bd = CELL * 0.75;
    for (const [o, so] of L.room.mold.doorCells[L.door]) { const d = Math.abs(so + s); if (d < bd) { bd = d; best = o; } }
    p = { room: L.room, c: best };
    M.pair.set(c, p);
  }
  return p.c >= 0 ? p : null;
}

// ---------------------------------------------------------------- colonies
// { name, creep (m/s), rush (m/s), rushEvery [s, s], rushFor [s, s], when: 'unseen' | 'clock' | 'never', range (m along
//   the surfaces: it only rushes when you're this close), thicken [creep s, rush s] }
export function addColony(c) {
  const k = colonies.length;
  colonies.push(Object.assign({ id: k, creep: 0.08, rush: 0, rushEvery: [20, 40], rushFor: [1.2, 2.5], when: 'never', range: 16, thicken: [3, 0.5],
    mode: 'creep', t: 0, tip: null, tipCell: null, tipDist: INF, lastTipDist: INF, cells: 0 }, c));
  const C = colonies[k];
  C.t = rnd(C.rushEvery);
  return k;
}
const rnd = ([a, b]) => a + (b - a) * Math.random();

function take(R, c, k, amount = 0.04) {
  const M = R.mold;
  if (M.col[c]) return;
  M.col[c] = k; M.m[c] = Math.max(M.m[c], amount); M.dirty = true;
  colonies[k].cells++;
  if (!M.inThick[c]) { M.inThick[c] = 1; M.thick.push(c); }
  if (!M.inFront[c]) { M.inFront[c] = 1; M.front.push(c); }
}
// a colony that's been there a while: cells of room R within r of a point, fully grown (density 0-1), its outline
// ragged (how readily each cell takes decides where it reached)
export function seed(k, R, x, y, z, r, density = 1) {
  const M = R.mold;
  query(R, x, y, z, r, (c, d) => {
    const v = density * Math.min(1, (1 - d / r) * 3 * Math.min(M.res[c], 1.4) - 0.35 * (1 - M.res[c]));
    if (v <= 0.05) return;
    take(R, c, k, v);
    M.m[c] = Math.max(M.m[c], v);
  });
}
export function clearMold() {
  for (const R of moldRooms) {
    if (!R) continue;
    const M = R.mold;
    M.m.fill(0); M.ch.fill(0); M.col.fill(0); M.inFront.fill(0); M.inThick.fill(0); M.inChar.fill(0);
    M.front = []; M.thick = []; M.charred = []; M.dirty = true;
  }
  for (const C of colonies) if (C) C.cells = 0;
}

// ---------------------------------------------------------------- fire
// Burns room R's cells within r (m) of a point (room coordinates): amount ~1 takes a fully grown cell in one go. Leaves
// char where there was mold, and heat around it that stops the mold growing there for a moment. Returns how much mold
// it burnt.
export function burn(R, x, y, z, r, amount) {
  const M = R.mold;
  if (!M) return 0;
  let burnt = 0;
  query(R, x, y, z, r * 1.6, (c, d) => {
    M.hot[c] = time;
    if (d > r || !M.col[c]) return;
    const w = 1 - (d / r) * (d / r), tk = Math.min(M.m[c], amount * w / (0.6 + 0.4 * M.res[c]));
    if (tk <= 0) return;
    M.m[c] -= tk; burnt += tk;
    M.ch[c] = Math.min(1, M.ch[c] + tk * 1.6 + 0.02);
    if (!M.inChar[c]) { M.inChar[c] = 1; M.charred.push(c); }
    if (M.m[c] <= 0.02) {   // gone: its neighbours are an edge again
      colonies[M.col[c]].cells--; M.col[c] = 0; M.m[c] = 0;
      M.ch[c] = Math.max(M.ch[c], 0.75);
      for (let e = R.C.nb0[c]; e < R.C.nb0[c + 1]; e++) { const o = R.C.nb[e]; if (M.col[o] && !M.inFront[o]) { M.inFront[o] = 1; M.front.push(o); } }
    }
    M.dirty = true;
  });
  return burnt;
}

// ---------------------------------------------------------------- distance to you, along the surfaces and through doorways
// A breadth-first search from the cells at your feet, over every active room's cells, spread over several frames; the
// finished distances replace the old ones all at once. It stops cfg.reach cells out.
let qR = new Int32Array(1 << 16), qC = new Int32Array(1 << 16), qh = 0, qt = 0, bfsOn = false, bfsWait = 0, bfsRooms = [];
function qpush(ri, c) {
  if (qt >= qR.length) { const a = new Int32Array(qR.length * 2), b = new Int32Array(qR.length * 2); a.set(qR); b.set(qC); qR = a; qC = b; }
  qR[qt] = ri; qC[qt] = c; qt++;
}
function startBfs(you) {
  qh = qt = 0;
  bfsRooms = moldRooms.filter(R => R?.mold.active);
  for (const R of bfsRooms) R.mold.nextDist.fill(INF);
  const R0 = you.room;
  if (!R0?.mold?.active) { bfsOn = false; return; }
  const N = R0.mold.nextDist;
  query(R0, you.x, 0.6, you.z, 0.9, c => {
    const horiz = Math.hypot(R0.C.px[c] - you.x, R0.C.pz[c] - you.z);
    if (R0.C.py[c] > 1.9 || horiz > 0.75) return;
    if (N[c] === INF) { N[c] = 0; qpush(R0.mi, c); }
  });
  bfsOn = qt > 0;
}
function stepBfs(budget) {
  const t0 = performance.now();
  while (qh < qt && budget-- > 0) {
    const R = moldRooms[qR[qh]], c = qC[qh++];
    if (!R) continue;
    const C = R.C, N = R.mold.nextDist, d = N[c] + 1;
    if (d > cfg.reach) continue;
    for (let e = C.nb0[c]; e < C.nb0[c + 1]; e++) { const o = C.nb[e]; if (N[o] > d) { N[o] = d; qpush(R.mi, o); } }
    if (R.mold.doorOf[c] >= 0) {
      const p = across(R, c);
      if (p && p.room.mold.active) { const N2 = p.room.mold.nextDist; if (N2[p.c] > d) { N2[p.c] = d; qpush(p.room.mi, p.c); } }
    }
  }
  stats.bfsMs += performance.now() - t0;
  if (qh >= qt) {
    for (const R of bfsRooms) { const M = R.mold; if (!M) continue; const t = M.dist; M.dist = M.nextDist; M.nextDist = t; }
    bfsOn = false;
  }
}

// ---------------------------------------------------------------- per frame
// you: { room (the room you're in), x, z (your feet, in its coordinates), cam: Vector3, dir: Vector3 (where the camera
// looks), toWorld(R, c, out): a cell's position in the world (false if its room isn't placed) }
const _v = new THREE.Vector3();
export function updateMold(dt, you) {
  time += dt;
  stats.bfsMs = 0;
  if (!bfsOn && (bfsWait -= dt) <= 0) { startBfs(you); bfsWait = 0.3; }
  if (bfsOn) stepBfs(6000);   // (about 3 ms of a frame at most; a full pass takes a third of a second)

  // each colony's mind: creeping, or rushing at you for a moment
  for (let k = 1; k < colonies.length; k++) {
    const C = colonies[k];
    C.tipDist = INF; C.tipCell = C.tip; C.tip = null;
    if (C.mode === 'rush') {
      if ((C.t -= dt) <= 0) { C.mode = 'creep'; C.t = rnd(C.rushEvery); }
    } else if (C.rush > 0 && C.when !== 'never' && C.cells > 0 && (C.t -= dt) <= 0) {
      let go = C.lastTipDist * CELL < C.range;
      if (go && C.when === 'unseen' && C.tipCell) {   // only while you're not looking at it
        if (you.toWorld(C.tipCell.R, C.tipCell.c, _v)) { _v.sub(you.cam).normalize(); if (_v.dot(you.dir) > Math.cos(0.95)) go = false; }
      }
      if (go) { C.mode = 'rush'; C.t = rnd(C.rushFor); }
      else C.t = 0.5 + Math.random();   // try again shortly
    }
  }

  // the edges spread (cells taken this frame join the edge at the end, and start spreading next frame)
  let rushing = 0, front = 0, active = 0;
  for (const R of moldRooms) {
    const M = R?.mold;
    if (!M?.active) continue;
    active++;
    const Cs = R.C, keep = [], L0 = M.front.length;
    for (let f = 0; f < L0; f++) {
      const c = M.front[f], k = M.col[c];
      if (!k) { M.inFront[c] = 0; continue; }
      const C = colonies[k], dc = M.dist[c];
      if (dc < C.tipDist) { C.tipDist = dc; C.tip = { R, c }; }
      let open = 0;
      const rush = C.mode === 'rush' && dc <= C.lastTipDist + cfg.tipWidth;
      if (rush) rushing++;
      // creep: v m/s needs about v / (CELL * 1.4) takes a second from the cells ahead; rush races only from the tips
      const base = (rush ? C.rush : C.creep) / (CELL * 1.4) / (rush ? cfg.rushToward : cfg.toward) * (rush ? cfg.rushK : cfg.creepK);
      const grown = M.m[c] > (rush ? 0.12 : 0.2);
      const tryCell = (R2, o, slow = 1) => {
        const M2 = R2.mold;
        if (M2.col[o]) return;
        open++;
        if (!grown || M2.ch[o] > cfg.charBlock || time - M2.hot[o] < 0.6 || R2.power?.on) return;   // (nor into a lit safe room)
        const dd = M2.dist[o], bias = dd < dc ? (rush ? cfg.rushToward : cfg.toward) : dd > dc ? (rush ? cfg.rushAway : cfg.away) : (rush ? cfg.rushSide : cfg.side);
        if (Math.random() < base * bias * M2.res[o] * dt * slow * (R2.plan.damp ? cfg.damp : 1)) take(R2, o, k, rush ? 0.13 : 0.04);   // (a rushing cell races on at once)
      };
      for (let e = Cs.nb0[c]; e < Cs.nb0[c + 1]; e++) tryCell(R, Cs.nb[e]);
      if (M.doorOf[c] >= 0) {   // through the doorway: under a shut door only slowly (it seeps)
        const p = across(R, c);
        if (p && p.room.mold.active) { const di = M.doorOf[c], L = R.links[di], D = R.ownDoors?.[di] ?? L.room.ownDoors?.[L.door]; tryCell(p.room, p.c, D && D.open < 0.55 ? cfg.seep : 1); }
      }
      if (open) keep.push(c); else M.inFront[c] = 0;
    }
    for (let f = L0; f < M.front.length; f++) keep.push(M.front[f]);
    M.front = keep;
  }
  for (const R of moldRooms) if (R?.mold.active) front += R.mold.front.length;
  for (let k = 1; k < colonies.length; k++) colonies[k].lastTipDist = colonies[k].tipDist;
  stats.rush = rushing; stats.front = front; stats.rooms = active;

  for (const R of moldRooms) {
    const M = R?.mold;
    if (!M?.active) continue;
    // new cells thicken
    for (let t = M.thick.length - 1; t >= 0; t--) {
      const c = M.thick[t], k = M.col[c];
      if (!k) { M.inThick[c] = 0; M.thick[t] = M.thick[M.thick.length - 1]; M.thick.pop(); continue; }
      const C = colonies[k];
      M.m[c] = Math.min(1, M.m[c] + dt / (C.mode === 'rush' ? C.thicken[1] : C.thicken[0]) * (0.6 + 0.4 * M.res[c]) * (R.plan.damp ? cfg.damp : 1));
      M.dirty = true;
      if (M.m[c] >= 1) { M.inThick[c] = 0; M.thick[t] = M.thick[M.thick.length - 1]; M.thick.pop(); }
    }
    // char fades (slowly: a burnt patch stays clear for half a minute)
    for (let t = M.charred.length - 1; t >= 0; t--) {
      const c = M.charred[t];
      M.ch[c] = Math.max(0, M.ch[c] - cfg.charFade * dt);
      M.dirty = true;
      if (M.ch[c] <= 0) { M.inChar[c] = 0; M.charred[t] = M.charred[M.charred.length - 1]; M.charred.pop(); }
    }
    if (M.dirty) upload(R);
  }
  let cells = 0; for (let k = 1; k < colonies.length; k++) cells += colonies[k].cells;
  stats.cells = cells;
  let near = INF; for (let k = 1; k < colonies.length; k++) near = Math.min(near, colonies[k].lastTipDist);
  stats.nearest = near;
}
// a room starts or stops growing (it's placed around you, or no longer)
export function setMoldActive(R, on) {
  if (!R.mold || R.mold.active === on) return;
  R.mold.active = on;
  if (on) R.mold.dirty = true;
  else R.mold.dist.fill(INF);
}

function upload(R) {
  const M = R.mold, C = R.C, data = M.data;
  M.dirty = false;
  for (let c = 0; c < M.n; c++) { const t = C.tex[c] * 2; data[t] = M.m[c] * 255; data[t + 1] = M.ch[c] * 255; }
  const b = C.border;
  for (let i = 0; i < b.length; i += 2) { const t = b[i] * 2, s = C.tex[b[i + 1]] * 2; data[t] = data[s]; data[t + 1] = data[s + 1]; }
  M.tex.needsUpdate = true;
}

// ---------------------------------------------------------------- what the rest of the game asks (room coordinates)
// the cells of a ceiling light (for coverage): those within its rectangle on the ceiling
export function cellsIn(R, x0, z0, x1, z1, y, ny) {
  const out = [], C = R.C;
  query(R, (x0 + x1) / 2, y, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + CELL, c => {
    if (C.ny[c] !== ny || C.px[c] < x0 || C.px[c] > x1 || C.pz[c] < z0 || C.pz[c] > z1 || Math.abs(C.py[c] - y) > 0.05) return;
    out.push(c);
  });
  return out;
}
// the thickest living mold of room R within r of a point (room coordinates): { c, m } or null (for fire spreading over it)
export function moldPeak(R, x, y, z, r) {
  if (!R?.mold) return null;
  const M = R.mold;
  let best = -1, bm = 0;
  query(R, x, y, z, r, c => { if (M.col[c] && M.m[c] > bm) { bm = M.m[c]; best = c; } });
  return best < 0 ? null : { c: best, m: bm };
}
export function coverage(R, list) { let s = 0; for (const c of list) s += R.mold.m[c]; return list.length ? s / list.length : 0; }
// how much mold is at your feet (the floor right under you, and the wall you're pressed against below head height)
export function contact(R, x, z) {
  if (!R?.mold) return 0;
  let v = 0;
  const C = R.C, m = R.mold.m;
  query(R, x, 0.4, z, 0.6, c => {
    const horiz = Math.hypot(C.px[c] - x, C.pz[c] - z);
    if ((C.ny[c] === 1 && horiz < 0.34) || (C.ny[c] === 0 && horiz < 0.36 && C.py[c] < 1.5)) v = Math.max(v, m[c]);
  });
  return v;
}
// how much mold there is within r of a point (0-1+): for sounds and spores
export function nearby(R, x, y, z, r) {
  if (!R?.mold) return 0;
  let s = 0, w = 0;
  const m = R.mold.m;
  query(R, x, y, z, r, (c, d) => { const k = 1 - d / r; s += m[c] * k; w += k; });
  return w ? s / w : 0;
}
export const moldState = () => ({ rooms: moldRooms.filter(Boolean) });
