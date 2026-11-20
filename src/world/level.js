// The level: the backrooms as a graph of rooms (docs/ROOMS.md, docs/GRAPH.md), made as you go. Each room is planned
// (world/rooms.js) and built over a few frames (world/roombuild.js). The rooms around you, up to DEPTH doorways deep,
// are placed in the world, joined at their doorways, so you see from one into the next. When you step through a
// doorway, the placing starts again from the room you're in, which stays where it is.
// The space isn't Euclidean:
//  - A doorway leads somewhere. The doorway on the other side usually leads back, but 1 in 5 leads somewhere else, and
//    then the room behind you changes, but only while you aren't looking at that doorway: a placed room that's no
//    longer wanted stays until its doorway is out of view.
//  - Now and then a doorway leads into a room you've been through before (a loop). A room can be placed more than once.
//  - Two rooms that would overlap aren't both placed (the doorway stays dark until they can be).
// No doorway you can see may lead into nothing (playtest: doorways "start as black walls and change when you get
// close"): the ring of rooms beyond the placed ones is built in the background before it's needed, a room you need near
// you replaces one that's only still standing because it's in view, and when a room still has to appear or go in a
// doorway you're looking at, the tape glitches over that doorway (world.onSpaceShift).
// Light: a pool of POOL point lights stands in for the nearest clusters of working fixtures in the placed rooms; each
// lights its own room, and the room beyond the doorway between it and you, through that doorway (materials.js).
// Rooms are turned only in quarter turns, so walls stay on the axes and colliders stay boxes.
import * as THREE from 'three';
import { scene, renderer, pmrem, rtType, camera } from '../core/context.js';
import { shared, roomMaterials, PROP_MATS, WALL_MATS, litFor, plenumMat } from './materials.js';
import { colliders } from './builder.js';
import { makePlan, wrongPlan, WALL, DOOR_W, DOOR_H } from './rooms.js';
import { buildRoom, updateRoomLights } from './roombuild.js';
import { world } from './world.js';
import { setMoldActive, coverage, burn as moldBurn, contact as moldContact, nearby as moldNearby, seed as moldSeed, releaseMold, moldPeak, addColony } from '../game/mold.js';
import { makeDoor, attachDoor, attachCans, doorShut, doorCollider } from './interact.js';
import { sootMat, scorchMesh, dropScorchMesh } from '../weapon/scorch.js';

export const DEPTH = 3;          // rooms are placed this many doorways deep
const MAX_INST = 16;             // at most this many placed at once
const PLACE_MAX = 2;             // ... and this many newly placed in one update (beyond the rooms next door)
const POOL = 12;                 // point lights for the rooms
const MAX_BUILT = 32;            // rooms kept built; the ones you left longest ago are let go (memory, and the long garbage-collection pauses a big heap brings)
export const graphCfg = { back: 0.8, loop: 0.08, wrong: 0.05, doors: 0.08 };   // (doors: a doorway has a door)   // a doorway leads back the way you came; into a room you've been through; into a copy of the room you're leaving
const ENV_LEVEL = 0.32;          // strength of the captured bounce light
export const SPAWN = { x: 0, z: -1.4, yaw: 0 };

export const rooms = [], insts = [];
let cur = null, nextId = 1, seedState = 7919;
const nextSeed = () => (seedState = (Math.imul(seedState, 1103515245) + 12345) >>> 0);

// ---------------------------------------------------------------- the graph
// from: the room it's made from (dark rooms come in stretches); plan: a ready plan (a wrong room's)
function newRoom(depth, kind = null, from = null, plan = null, seed = nextSeed()) {
  plan ??= makePlan(seed, depth, kind, { dark: from?.plan.light === 'dark' });
  const R = { id: rooms.length, seed, depth, plan, links: plan.doors.map(() => undefined), built: false, gen: null, inst: [], pool: [], moldT: 0 };
  if (plan.loop) { const [d, e] = plan.loop; R.links[d] = { room: R, door: e }; R.links[e] = { room: R, door: d }; }   // a self-loop room
  rooms.push(R);
  if (plan.safe) {   // its generator (fuel in seconds) and its steel door, open to start with
    R.power = { fuel: 45 + Math.random() * 45, max: 150, on: true };
    makeDoor(R, 0, 'steel', 1);
  }
  return R;
}
// where room R's doorway d leads: { room, door } (decided the first time anyone needs to know). t: where R is placed
// (or is about to be), taken: the floor plans already wanted round it, so a new room is made to fit beside them.
function ensureLink(R, d, t = null, taken = null) {
  if (R.links[d] !== undefined) return R.links[d];
  let L = null;
  if (rooms.length > 10 && Math.random() < graphCfg.loop) {   // into a room you've already been through, by a doorway nobody uses
    const c = [];
    for (const o of rooms) if (o !== R && !o.inst.length && Math.abs(o.depth - R.depth) <= 3) o.links.forEach((l, e) => { if (l === undefined) c.push({ room: o, door: e }); });
    if (c.length) L = c[(Math.random() * c.length) | 0];
  }
  // a wrong room: almost the one you're leaving, one thing different, entered by the same doorway (so it seems to face
  // you the other way round)
  if (!L && R.built && !R.plan.loop && !R.plan.start && !R.plan.wrong && R.plan.kind !== 'closet' && Math.random() < graphCfg.wrong) {
    const N = newRoom(R.depth + 1, null, R, wrongPlan(R.plan, nextSeed()));
    L = { room: N, door: d };
  }
  if (!L) {
    // A new room. Where it goes is known, so try a few rooms and entrances for one that fits beside the rooms already
    // wanted or standing there: one that overlapped a neighbour couldn't be placed, and its doorway stayed dark, near
    // you. (Loops and wrong rooms above still don't fit, on purpose: that's the place being impossible.)
    // (the kind is drawn once, as before, and only its layout and entrance vary: retrying the draw itself favoured small
    // rooms with many doorways, and safe rooms, with one, all but stopped coming)
    // (if that kind can't fit after four tries, the last two may be any kind: a corridor or a closet fits where a hall
    // can't)
    let pick = null, kind = null;
    for (let tries = 0; tries < 6 && !pick; tries++) {
      const seed = nextSeed(), plan = makePlan(seed, R.depth + 1, tries < 4 ? kind : null, { dark: R.plan.light === 'dark' });
      kind ??= plan.kind;
      const free = plan.doors.map((_, e) => e).filter(e => !plan.loop || (e !== plan.loop[0] && e !== plan.loop[1]));
      for (let k = free.length - 1; k > 0; k--) { const j = (Math.random() * (k + 1)) | 0; [free[k], free[j]] = [free[j], free[k]]; }
      for (const e of free) {
        const ta = t && alignAt(t, R, d, { plan }, e);
        if (t && !ta) continue;
        if (ta) {
          const rects = worldRects({ plan }, ta);
          if ((taken && taken.some(r => overlaps(r, rects))) || insts.some(I => overlaps(I.rects, rects))) continue;
        }
        pick = { plan, seed, door: e }; break;
      }
      if (!pick && tries === 5) pick = { plan, seed, door: free.length ? free[0] : 0 };   // (nothing fits: the doorway may stay dark)
    }
    L = { room: newRoom(R.depth + 1, null, R, pick.plan, pick.seed), door: pick.door, fresh: true };
  }
  R.links[d] = L;
  if (L.room.links[L.door] === undefined && Math.random() < graphCfg.back) L.room.links[L.door] = { room: R, door: d };
  if (L.room.plan.safe && R.mold && !R.plan.safe) {
    // the mold that waits at a safe room's door: a colony in the room outside, near the doorway, that creeps after you
    const D = R.plan.doors[d], k = addColony({ name: 'waiting', creep: 0.06, rush: 0, when: 'never', thicken: [4, 1] });
    const x = D.x - D.nx * 2.2, z = D.z - D.nz * 2.2, sx = -D.nz, sz = D.nx;
    for (const [ox, oz, y, r] of [[0, 0, 0, 0.9], [1.2, 0.3, 0.9, 0.7], [-1.2, 0.3, 0.9, 0.7]]) moldSeed(k, R, x + sx * ox - D.nx * oz, y, z + sz * ox - D.nz * oz, r, 1);
  } else if (!R.ownDoors?.[d] && !L.room.plan.safe && !R.plan.safe && !R.plan.loop && !L.room.plan.loop && Math.random() < graphCfg.doors
    && (R.plan.doors[d].h ?? DOOR_H) > 1.9 && (L.room.plan.doors[L.door].h ?? DOOR_H) > 1.9) {
    // now and then a door in the way (shut more often than not)
    makeDoor(R, d, R.plan.kind === 'service' ? 'steel' : 'wood', Math.random() < 0.6 ? 0 : 1);
  }
  return L;
}

// ---------------------------------------------------------------- building, a few milliseconds a frame
// queue: rooms to place now; later: the ring beyond what's placed, built in the background so it's ready when you
// get there (before, 1 in 5 doorways in view waited on a build)
const queue = [], later = [];
let built = false, ahead = new Set();
function want(R) {
  if (R.built || queue.includes(R)) return;
  const i = later.indexOf(R); if (i >= 0) later.splice(i, 1);
  queue.push(R);
}
function wantLater(R) { if (!R.built && !queue.includes(R) && !later.includes(R)) later.push(R); }
function buildStep(ms) {
  const t0 = performance.now();
  while ((queue.length || later.length) && performance.now() - t0 < ms) {
    const Q = queue.length ? queue : later, R = Q[0];
    R.gen ??= buildRoom(R);
    if (R.gen.next().done) { Q.shift(); R.gen = null; built = true; R.lastPlaced = performance.now(); }
  }
}
function buildNow(R) {
  if (R.built) return;
  R.gen ??= buildRoom(R);
  while (!R.gen.next().done);
  R.gen = null;
  for (const Q of [queue, later]) { const i = Q.indexOf(R); if (i >= 0) Q.splice(i, 1); }
}

// ---------------------------------------------------------------- placing: quarter turns and a shift
const rot2 = (r, x, z) => r === 0 ? [x, z] : r === 1 ? [z, -x] : r === 2 ? [-x, -z] : [-z, x];
const toW = (I, x, z) => { const [a, b] = rot2(I.rot, x, z); return [a + I.tx, b + I.tz]; };
const toL = (I, x, z) => rot2((4 - I.rot) & 3, x - I.tx, z - I.tz);
// doorway d of room R placed at t ({ rot, tx, tz }), in the world: its centre on the wall's outer face, and its outward
// normal
function doorAt(t, R, d) { const D = R.plan.doors[d], [x, z] = toW(t, D.x, D.z), [nx, nz] = rot2(t.rot, D.nx, D.nz); return { x, z, nx, nz }; }
const doorW = (I, d) => doorAt(I, I.room, d);
// where room R goes so that its doorway e meets doorway d of room Rf placed at t
function alignAt(t, Rf, d, R, e) {
  const A = doorAt(t, Rf, d), D = R.plan.doors[e];
  for (let r = 0; r < 4; r++) {
    const [nx, nz] = rot2(r, D.nx, D.nz);
    if (Math.abs(nx + A.nx) < 1e-3 && Math.abs(nz + A.nz) < 1e-3) { const [bx, bz] = rot2(r, D.x, D.z); return { rot: r, tx: +(A.x - bx).toFixed(4), tz: +(A.z - bz).toFixed(4) }; }
  }
  return null;
}
const same = (a, b) => a.rot === b.rot && Math.abs(a.tx - b.tx) < 1e-3 && Math.abs(a.tz - b.tz) < 1e-3;
// a room's floor plan in the world (walls included), for overlap tests
function worldRects(R, t) {
  return R.plan.rects.map(r => {
    const [ax, az] = toW(t, r.x0 - WALL, r.z0 - WALL), [bx, bz] = toW(t, r.x1 + WALL, r.z1 + WALL);
    return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz) };
  });
}
const overlaps = (A, B) => A.some(a => B.some(b => a.x0 < b.x1 - 0.02 && b.x0 < a.x1 - 0.02 && a.z0 < b.z1 - 0.02 && b.z0 < a.z1 - 0.02));
// is a world point inside a placed room (its air, or a doorway's hole)?
function inside(I, x, z) {
  const [lx, lz] = toL(I, x, z), p = I.room.plan;
  return p.rects.some(r => lx > r.x0 && lx < r.x1 && lz > r.z0 && lz < r.z1) || p.doors.some(D => lx >= D.strip.x0 - 1e-3 && lx <= D.strip.x1 + 1e-3 && lz >= D.strip.z0 - 1e-3 && lz <= D.strip.z1 + 1e-3);
}
export function roomAt(x, z) { return cur && inside(cur, x, z) ? cur : insts.find(I => inside(I, x, z)) || null; }

function placeInst(R, t) {
  const I = { id: nextId++, room: R, rot: t.rot, tx: t.tx, tz: t.tz, group: new THREE.Group(), meshes: [], depth: 9, adj: [], rects: worldRects(R, t) };
  const pooled = R.pool.pop();
  if (pooled) { I.u = pooled.u; I.mats = pooled.mats; I.u.uRoomId.value = I.id; }
  else { I.u = { ...R.u, uRoomId: { value: I.id } }; I.mats = roomMaterials(I.u, R.geos.map(g => g[0])); I.mats.set(sootMat, litFor(sootMat, I.u)); }
  I.group.position.set(I.tx, 0, I.tz); I.group.rotation.y = I.rot * Math.PI / 2;
  I.group.updateMatrix(); I.group.matrixAutoUpdate = false;
  for (const [base, geo] of R.geos) {
    const mesh = new THREE.Mesh(geo, I.mats.get(base));
    mesh.matrixAutoUpdate = false;
    mesh.receiveShadow = mesh.material.isMeshStandardMaterial === true;
    mesh.castShadow = PROP_MATS.has(base) || WALL_MATS.has(base);   // (walls stop the weapon light)
    I.group.add(mesh); I.meshes.push(mesh);
  }
  I.scorch = scorchMesh(R, I.mats.get(sootMat));
  I.group.add(I.scorch);
  I.group.updateMatrixWorld(true);
  for (const D of R.ownDoors ?? []) if (D) attachDoor(I, D);
  attachCans(I);
  I.gen = R.genAt;
  I.group.updateMatrixWorld(true);
  I.wcol = R.colliders.map(c => {
    const [ax, az] = toW(I, c.x0, c.z0), [bx, bz] = toW(I, c.x1, c.z1);
    return { x0: Math.min(ax, bx), z0: Math.min(az, bz), x1: Math.max(ax, bx), z1: Math.max(az, bz), y0: c.y0, h: c.h };
  });
  // the fixtures where they are in the world (for the hum, and the camera picking up a flickering tube)
  I.fix = R.fixtures.map(f => { const p = Object.create(f); [p.x, p.z] = toW(I, f.lx, f.lz); return p; });
  R.lastPlaced = performance.now();
  scene.add(I.group);
  insts.push(I); R.inst.push(I);
  setMoldActive(R, true);
  return I;
}
function removeInst(I) {
  scene.remove(I.group);
  insts.splice(insts.indexOf(I), 1); I.room.inst.splice(I.room.inst.indexOf(I), 1);
  dropScorchMesh(I.room, I.scorch);
  I.room.pool.push({ u: I.u, mats: I.mats });
  I.room.lastPlaced = performance.now();
  if (!I.room.inst.length) setMoldActive(I.room, false);
  for (const p of pool) if (p.inst === I) { p.inst = null; p.cl = null; p.light.intensity = 0; }
  world.onRemoveRoom?.((x, z) => I.rects.some(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) && !insts.some(J => inside(J, x, z)));
}

// What should be placed: the rooms up to DEPTH doorways out from the one you're in, none overlapping. Space is claimed
// nearest doorway first (straight-line distance from you, not graph depth): where two rooms want the same space, the one
// behind the doorway you're nearer to, the one you're walking toward, gets it. (In graph order, a room reached through a
// side door could take the space behind the doorway right in front of you, which then stayed dark until you'd passed.)
// The ring beyond is decided and built in the background, so a room is ready before you can see it. (Placing deeper
// along the view was tried: the extra rooms stood in the way of near ones when you turned.)
function desire(budget = 1) {
  const root = { room: cur.room, t: cur, depth: 0, inst: cur, pr: 0, entry: -1 };
  const out = [root], taken = [cur.rects], next = new Set(), cand = [];
  let reroll = 1;   // unseen links that no longer fit, decided again this time (each doorway at most 3 times in all: where
                    // nothing fits, re-deciding every update made a new room every 0.1 s, and the doorway stayed dark anyway)
  let decide = budget;   // new links decided this time, nearest first (each tries a few rooms for one that fits: deciding all
                    // that a step into new rooms needed at once took up to 70 ms; the rest are decided over the next updates)
  const cx = camera.position.x, cz = camera.position.z;
  const expand = n => {
    const doors = n.room.plan.doors.map((_, d) => d);
    if (n.depth >= DEPTH) {   // the edge: where its doorways lead is decided, and those rooms built, in the background
      for (const d of doors) {
        if (n.room.links[d] === undefined && decide-- <= 0) continue;
        const L = ensureLink(n.room, d, n.t, taken); wantLater(L.room); next.add(L.room);
      }
      return;
    }
    for (const d of doors) {
      if (d === n.entry) continue;   // (the way it was reached: that space is its parent's)
      const [x, z] = toW(n.t, n.room.plan.doors[d].x, n.room.plan.doors[d].z);
      cand.push({ n, d, pr: Math.max(n.pr, Math.hypot(x - cx, z - cz)) + 0.5 * n.depth });
    }
  };
  expand(root);
  while (cand.length && out.length < MAX_INST) {
    let bi = 0;
    for (let i = 1; i < cand.length; i++) if (cand[i].pr < cand[bi].pr) bi = i;
    const { n, d, pr } = cand[bi]; cand[bi] = cand[cand.length - 1]; cand.pop();
    if (n.room.links[d] === undefined && decide-- <= 0) continue;
    let L = ensureLink(n.room, d, n.t, taken), t = alignAt(n.t, n.room, d, L.room, L.door);
    if (!t) continue;
    let rects = worldRects(L.room, t);
    if (taken.some(r => overlaps(r, rects))) {
      // It doesn't fit beside the rooms claimed nearer you (links are kept, but the layout round you changes as you go).
      // If nobody has seen where this doorway leads, it can still lead to a new room that fits.
      const tried = (n.room.rerolls ??= [])[d] ?? 0;
      if (!L.fresh || L.seen || L.room.inst.length || tried >= 3 || reroll-- <= 0 || decide-- <= 0) continue;
      n.room.rerolls[d] = tried + 1;
      n.room.links[d] = undefined;
      L = ensureLink(n.room, d, n.t, taken); t = alignAt(n.t, n.room, d, L.room, L.door);
      if (!t) continue;
      rects = worldRects(L.room, t);
      if (taken.some(r => overlaps(r, rects))) continue;
    }
    const w = { room: L.room, t, depth: n.depth + 1, inst: insts.find(I => I.room === L.room && same(I, t)) || null, from: n, door: d, pr, entry: L.door };
    out.push(w); taken.push(rects); want(L.room);
    expand(w);
  }
  ahead = next;
  return out;
}

// is there a shut door in placed room I's doorway d (its own, or the room's beyond, which shares the doorway)?
// closed: shut all the way, so you can't see past it (a door just ajar shows the room behind it)
function shutAt(I, d, closed = false) {
  const own = I.room.ownDoors?.[d], A = I.adj[d], D = own || (A ? A.inst.room.ownDoors?.[A.door] : null);
  return !!D && (closed ? D.open < 0.03 : doorShut(D));
}
// a placed room is in view if one of its doorways into another placed room is (or you're in it). Not through a shut door:
// behind one, a room can change.
const _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _sph = new THREE.Sphere();
// Can you actually see into doorway D (h high)? Any of a few points in its opening in the picture with nothing in the
// way: rays against the placed rooms. (Only asked when a room appears or goes; the frustum alone said yes for doorways
// hidden behind walls, and the tape glitched over bare walls.)
const _ray = new THREE.Raycaster(), _rp = new THREE.Vector3(), _rq = new THREE.Vector3(), _rd = new THREE.Vector3();
function doorwayVisible(D, h) {
  const tx = -D.nz, tz = D.nx, groups = insts.map(I => I.group);
  for (const [o, y] of [[0, 0.8], [0, 1.6], [-0.35, 1.1], [0.35, 1.1], [0, 0.3]]) {
    _rp.set(D.x + tx * o + D.nx * 0.05, Math.min(y, h - 0.15), D.z + tz * o + D.nz * 0.05);
    _rq.copy(_rp).project(camera);
    if (_rq.z > 1 || Math.abs(_rq.x) > 1 || Math.abs(_rq.y) > 1) continue;
    _rd.copy(_rp).sub(camera.position); const len = _rd.length();
    _ray.set(camera.position, _rd.normalize()); _ray.near = 0.05; _ray.far = len - 0.03;
    if (!_ray.intersectObjects(groups, true).some(h => !h.object.userData.cap)) return true;   // (a dark cap is about to go)
  }
  return false;
}
// The placed rooms you might see: the one you're in, and from it on, through each doorway that's in the camera's view
// and not shut, the room beyond (a chain of open doorways). A room behind a shut door, or round a corner of doorways
// out of view, isn't seen.
function visibleSet() {
  _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _frustum.setFromProjectionMatrix(_pm);
  const seen = new Set([cur]), q = [cur];
  while (q.length) {
    const I = q.shift();
    for (let d = 0; d < I.adj.length; d++) {
      const A = I.adj[d];
      if (!A || seen.has(A.inst) || shutAt(I, d, true)) continue;
      const D = doorW(I, d);
      _sph.center.set(D.x, 1.05, D.z); _sph.radius = 1.7;
      if (camera.position.distanceTo(_sph.center) < 45 && _frustum.intersectsSphere(_sph)) {
        seen.add(A.inst); q.push(A.inst);
        const Lk = I.room.links[d]; if (Lk && Lk.room === A.inst.room) Lk.seen = true;   // (where it leads is known now)
      }
    }
  }
  return seen;
}
// which placed room is beyond each doorway (where two doorways meet face to face)
function linkAdjacency() {
  for (const I of insts) I.adj = I.room.plan.doors.map(() => null);
  for (const I of insts) for (let d = 0; d < I.adj.length; d++) {
    if (I.adj[d]) continue;
    const A = doorW(I, d);
    for (const J of insts) {
      if (J === I) continue;
      for (let e = 0; e < J.adj.length; e++) {
        const B = doorW(J, e);
        if (Math.abs(A.x - B.x) < 0.01 && Math.abs(A.z - B.z) < 0.01 && Math.abs(A.nx + B.nx) < 0.01 && Math.abs(A.nz + B.nz) < 0.01) { I.adj[d] = { inst: J, door: e }; J.adj[e] = { inst: I, door: d }; }
      }
    }
  }
}
export function reconcile(force = false) {
  const want = desire(force ? 40 : 1);   // (forced: loading, or a test that jumps somewhere: everything at once)
  const keep = new Set(want.filter(w => w.inst).map(w => w.inst));
  const seen = force ? null : visibleSet();
  for (const I of [...insts]) if (!keep.has(I) && I !== cur && (force || !seen.has(I))) removeInst(I);
  // at most PLACE_MAX new rooms a time, nearest first (want is in that order): with the next ring built ahead, crossing a
  // doorway made several ready at once, and placing them all in one frame took up to 13 ms
  let placed = 0;
  for (const w of want) {
    if (w.inst || !w.room.built) continue;
    if (!force && placed >= PLACE_MAX && w.depth > 1) { reT = Math.min(reT, 0.03); continue; }
    placed++;
    const rects = worldRects(w.room, w.t), block = insts.filter(I => overlaps(I.rects, rects));
    if (block.length) {
      // In the way: a room still standing only because it's in view. Where it fills this very doorway, it stays until
      // you look away (the way back changing behind your back). Anywhere else it would leave a dark doorway near you:
      // a room you need near you takes its place, and the tape glitches where it was.
      const D = w.from ? doorAt(w.from.t, w.from.room, w.door) : null;
      const fills = I => D && I.room.plan.doors.some((_, e) => { const B = doorW(I, e); return Math.abs(B.x - D.x) < 0.01 && Math.abs(B.z - D.z) < 0.01; });
      if (block.some(I => keep.has(I) || I === cur || fills(I))) continue;
      for (const I of block) { if (seen) glitchOut(I, seen); removeInst(I); }
    }
    w.inst = placeInst(w.room, w.t);
    // appearing in a doorway you can see: the tape glitches over that doorway, so it reads as the recording breaking up
    // rather than a room popping in
    if (seen && w.from?.inst && seen.has(w.from.inst) && !shutAt(w.from.inst, w.door, true)) {
      const D = doorAt(w.from.t, w.from.room, w.door);
      const h = w.from.room.plan.doors[w.door].h ?? DOOR_H;
      if (doorwayVisible(D, h)) world.onSpaceShift?.(D.x, D.z, D.nx, D.nz, h);
    }
  }
  for (const I of insts) I.depth = 9;
  for (const w of want) if (w.inst) w.inst.depth = Math.min(w.inst.depth, w.depth);
  linkAdjacency();
  updateCaps();
  for (const a of cur.adj) if (a && a.inst.depth > 1) a.inst.depth = 1;   // (a room still standing behind you counts as next door)
  for (const I of insts) for (const m of I.meshes) m.renderOrder = I.depth;   // near rooms first: walls hide what's behind them early
  refreshNear();
}
// a placed room that's about to go while in view: the tape glitches over its doorways you can see
function glitchOut(I, seen) {
  for (let d = 0; d < I.adj.length; d++) {
    const A = I.adj[d];
    if (!A || !seen.has(A.inst) || shutAt(I, d, true)) continue;
    const D = doorW(I, d);
    const h = I.room.plan.doors[d].h ?? DOOR_H;
    if (doorwayVisible(D, h)) world.onSpaceShift?.(D.x, D.z, D.nx, D.nz, h);
  }
}
// A doorway that leads to no placed room is capped with darkness: a black card just outside it, which also stops you.
// Without it you saw through the hole into whatever room stood behind that wall, from the wrong side, and it changed as
// you came closer (playtest: doorways "even change rooms when you approach"). It reads as an unlit room beyond. When its
// room is placed the card goes (and where you can see it, the tape glitches there).
const capGeos = new Map();
function capGeo(w, h) {
  const k = w + ':' + h;
  let g = capGeos.get(k);
  if (!g) { g = new THREE.PlaneGeometry(w, h); g.translate(0, h / 2, 0); capGeos.set(k, g); }
  return g;
}
function updateCaps() {
  for (const I of insts) {
    I.caps ??= [];
    for (let d = 0; d < I.adj.length; d++) {
      const need = !I.adj[d];
      let m = I.caps[d];
      if (need && !m) {
        const D = I.room.plan.doors[d], h = D.h ?? DOOR_H;
        m = new THREE.Mesh(capGeo(DOOR_W + 0.04, h + 0.02), plenumMat);
        m.position.set(D.x + D.nx * 0.015, 0, D.z + D.nz * 0.015);
        m.rotation.y = Math.atan2(-D.nx, -D.nz);   // (facing into the room)
        m.userData.cap = true;
        m.matrixAutoUpdate = false; m.updateMatrix();
        I.group.add(m); m.updateMatrixWorld(true);
        I.caps[d] = m;
      }
      if (m) m.visible = need;
    }
  }
}
function capCollider(I, d) {
  const D = doorW(I, d), h = I.room.plan.doors[d].h ?? DOOR_H, x = D.x + D.nx * 0.06, z = D.z + D.nz * 0.06;
  const zPlane = Math.abs(D.nz) > 0.5, hx = zPlane ? DOOR_W / 2 + 0.05 : 0.06, hz = zPlane ? 0.06 : DOOR_W / 2 + 0.05;
  return { x0: x - hx, z0: z - hz, x1: x + hx, z1: z + hz, y0: 0, h };
}
// what the player, the fire and aiming collide with: the room you're in and the ones next to it, shut doors, and dark caps
function refreshNear() {
  const near = insts.filter(I => I === cur || I.depth <= 1 || cur.adj.some(a => a?.inst === I));
  colliders.length = 0;
  for (const I of near) {
    for (const c of I.wcol) colliders.push(c);
    for (const m of I.doors ?? []) if (doorShut(m.D)) colliders.push(doorCollider(I, m.D));
    for (let d = 0; d < (I.caps?.length ?? 0); d++) if (I.caps[d]?.visible) colliders.push(capCollider(I, d));
  }
  world.fixtures = near.flatMap(I => I.fix);
}

// ---------------------------------------------------------------- light
const pool = [];   // { light, inst, cl, fade }
let lightOrder = null;
function initPool() {
  const g = new THREE.Group();
  for (let i = 0; i < POOL; i++) { const L = new THREE.PointLight(0xffffff, 0, 9, 2); g.add(L); pool.push({ light: L, inst: null, cl: null, fade: 0 }); }
  scene.add(g);
}
const _cand = [];
function updatePool(dt) {
  _cand.length = 0;
  const cx = camera.position.x, cz = camera.position.z;
  for (const I of insts) {
    if (I.depth > 2 && I !== cur) continue;
    for (const cl of I.room.clusters) {
      if (cl.i < 0.01) continue;
      const [x, z] = toW(I, cl.x, cl.z);
      let s = Math.hypot(x - cx, z - cz) + (I === cur ? 0 : 2 + 3 * Math.max(0, I.depth - 1));
      if (pool.some(p => p.inst === I && p.cl === cl)) s -= 1.5;   // (a lit cluster keeps its light unless clearly worse)
      _cand.push({ I, cl, s });
    }
  }
  _cand.sort((a, b) => a.s - b.s);
  const top = _cand.slice(0, POOL);
  for (const p of pool) if (p.inst && !top.some(c => c.I === p.inst && c.cl === p.cl)) { p.inst = null; p.cl = null; }
  for (const c of top) {
    if (pool.some(p => p.inst === c.I && p.cl === c.cl)) continue;
    const p = pool.find(q => !q.inst);
    if (!p) break;
    p.inst = c.I; p.cl = c.cl; p.fade = 0;
  }
  for (const p of pool) {
    if (!p.inst) { p.light.intensity = 0; continue; }
    p.fade = Math.min(1, p.fade + dt / 0.25);
    const [x, z] = toW(p.inst, p.cl.x, p.cl.z);
    p.light.position.set(x, p.cl.y, z); p.light.color.copy(p.cl.color); p.light.intensity = p.cl.i * p.fade;
  }
  // each point light (three.js's order): its room, and the doorway it shines through
  lightOrder ??= (() => { const a = []; scene.traverse(o => { if (o.isPointLight) a.push(o); }); return a; })();
  for (let i = 0; i < lightOrder.length; i++) {
    const L = lightOrder[i], p = pool.find(q => q.light === L), I = p ? p.inst : roomAt(L.position.x, L.position.z);
    if (!I || L.intensity <= 0) { shared.uLR.value[i].set(I ? I.id : -1, -2, 0, 0); continue; }
    let best = -1, bs = Infinity;
    for (let d = 0; d < I.adj.length; d++) {
      if (!I.adj[d] || shutAt(I, d)) continue;   // (no light through a shut door)
      const D = doorW(I, d), s = Math.hypot(L.position.x - D.x, L.position.z - D.z) + Math.hypot(D.x - cx, D.z - cz);
      if (s < bs) { bs = s; best = d; }
    }
    if (best < 0) { shared.uLR.value[i].set(I.id, -2, 0, 0); continue; }
    const D = doorW(I, best), zPlane = Math.abs(D.nz) > 0.5, along = zPlane ? D.x : D.z, A = I.adj[best];
    const h = Math.min(I.room.plan.doors[best].h ?? DOOR_H, A.inst.room.plan.doors[A.door].h ?? DOOR_H);   // (through the lower of the two openings)
    shared.uLR.value[i].set(I.id, A.inst.id, 0, 0);
    shared.uLD.value[i].set(zPlane ? D.z : D.x, along - DOOR_W / 2, along + DOOR_W / 2, zPlane ? h : -h);
  }
}

// bounce light: capture the lit start hall once into an environment map (the yellow cast of the whole place comes from
// it; each room scales it by how lit it is)
async function captureBounceLight() {
  // 256: the same size as the placeholder environment (core/context.js), so swapping it in recompiles no shader
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: rtType === THREE.HalfFloatType ? THREE.HalfFloatType : THREE.UnsignedByteType });
  const cubeCam = new THREE.CubeCamera(0.05, 60, cubeRT);
  cubeCam.position.set(0, 1.4, -8.4);
  scene.add(cubeCam);
  try { await renderer.compileAsync(scene, cubeCam.children[0]); } catch (e) { /* compiled on first use instead */ }
  cubeCam.update(renderer, scene);
  scene.remove(cubeCam);
  scene.environment = pmrem.fromCubemap(cubeRT.texture).texture;
  scene.environmentIntensity = ENV_LEVEL;
  cubeRT.dispose();
}

// ---------------------------------------------------------------- the rest of the game's questions (world coordinates)
function hookWorld() {
  // burn the mold round a point, in every placed room it reaches
  world.burn = (x, y, z, r, amount) => {
    let b = 0;
    for (const I of insts) {
      if (!I.rects.some(q => x > q.x0 - r && x < q.x1 + r && z > q.z0 - r && z < q.z1 + r)) continue;
      const [lx, lz] = toL(I, x, z);
      b += moldBurn(I.room, lx, y, lz, r, amount);
    }
    return b;
  };
  // the thickest living mold within r of a world point, in the world: { m, x, y, z, nx, ny, nz } (a cell's centre and the
  // way its surface faces), or null. For fire spreading over mold.
  world.moldAt = (x, y, z, r) => {
    let out = null;
    for (const I of insts) {
      if (!I.rects.some(q => x > q.x0 - r && x < q.x1 + r && z > q.z0 - r && z < q.z1 + r)) continue;
      const [lx, lz] = toL(I, x, z), p = moldPeak(I.room, lx, y, lz, r);
      if (!p || (out && out.m >= p.m)) continue;
      const C = I.room.C, [wx, wz] = toW(I, C.px[p.c], C.pz[p.c]), [nx, nz] = rot2(I.rot, C.nx[p.c], C.nz[p.c]);
      out = { m: p.m, x: wx, y: C.py[p.c], z: wz, nx, ny: C.ny[p.c], nz };
    }
    return out;
  };
  // a point (and normal, out of the surface into the air) on a placed room's surface, in that room's coordinates (for
  // soot marks); the room is the one just off the surface
  world.toRoom = (x, y, z, nx, ny, nz) => {
    const I = roomAt(x + nx * 0.05, z + nz * 0.05) || roomAt(x, z);
    if (!I) return null;
    const [lx, lz] = toL(I, x, z), [lnx, lnz] = rot2((4 - I.rot) & 3, nx, nz);
    return { R: I.room, x: lx, y, z: lz, nx: lnx, ny, nz: lnz };
  };
}
const you = { room: null, x: 0, z: 0, cam: camera.position, dir: new THREE.Vector3(),
  toWorld(R, c, out) {
    if (!R.C) return false;
    let best = null, bd = Infinity;
    for (const I of R.inst) { const d = Math.hypot(I.tx - camera.position.x, I.tz - camera.position.z); if (d < bd) { bd = d; best = I; } }
    if (!best) return false;
    const [x, z] = toW(best, R.C.px[c], R.C.pz[c]);
    out.set(x, R.C.py[c], z);
    return true;
  } };
// what game/mold.js needs about you
export function moldYou(px, pz) { you.room = cur.room; [you.x, you.z] = toL(cur, px, pz); camera.getWorldDirection(you.dir); return you; }
export function moldContactAt(px, pz) { const [lx, lz] = toL(cur, px, pz); return moldContact(cur.room, lx, lz); }
export function moldNearbyAt(x, y, z, r) { const [lx, lz] = toL(cur, x, z); return moldNearby(cur.room, lx, y, lz, r); }
export function moldSeedAt(k, x, y, z, r, density) { const I = roomAt(x, z); if (!I) return; const [lx, lz] = toL(I, x, z); moldSeed(k, I.room, lx, y, lz, r, density); }
export const current = () => cur;
// (testing) make a new room of a given kind and start again from it
export function visitNew(kind, depth = 3) { const R = newRoom(depth, kind); buildNow(R); gotoRoom(R); return R; }
// (testing) start again from room R, placed at t (the start hall: at the origin, as at the start)
export function gotoRoom(R, t = { rot: 0, tx: 0, tz: 0 }) {
  for (const I of [...insts]) removeInst(I);
  buildNow(R);
  cur = placeInst(R, t);
  reconcile(true);
}

// ---------------------------------------------------------------- build the start, and run
export async function buildLevel(progress = async () => {}) {
  Object.assign(world, { ceiling: 2.6, ambient: 0.35 });
  hookWorld();
  initPool();
  const hall = newRoom(0, 'startHall'), cor = newRoom(1, 'startCorridor');
  hall.links[0] = { room: cor, door: 0 }; cor.links[0] = { room: hall, door: 0 };
  buildNow(hall);
  cur = placeInst(hall, { rot: 0, tx: 0, tz: 0 });
  // build everything DEPTH doorways out now (it's needed at once); deeper rooms are built in the background later
  for (let pass = 0; pass < 6; pass++) {
    desire(40);
    const todo = queue.slice();
    if (!todo.length) break;
    for (let i = 0; i < todo.length; i++) { buildNow(todo[i]); await progress(Math.min(0.95, (pass * 0.3 + i / todo.length) * 0.5)); }
  }
  reconcile(true);
  updatePool(1);
  await captureBounceLight();
}
// Let go of the rooms left longest ago once more than MAX_BUILT are built: their geometry, textures, cells and materials
// go; the plan, links, soot and (sparsely) mold stay, and the room is built again, as it was, if you come back.
let evictT = 0;
function evict() {
  const built = rooms.filter(R => R.built);
  if (built.length <= MAX_BUILT) return;
  const spare = built.filter(R => !R.inst.length && !queue.includes(R) && !R.gen && !ahead.has(R)).sort((a, b) => (a.lastPlaced || 0) - (b.lastPlaced || 0));
  for (const R of spare.slice(0, built.length - MAX_BUILT)) {
    releaseMold(R);
    for (const [, geo] of R.geos) geo.dispose();
    R.aoTex.dispose();
    R.geos = R.C = R.u = R.colliders = R.open = R.aoTex = R.moldTex = null;
    R.pool = [];
    for (const f of R.fixtures) f.cells = [];
    R.built = false;
  }
}
let reT = 0, matT = 0;
// (testing) what the level's upkeep costs: the slowest placing and building in a frame, ms
export const levelStats = { reconcileMax: 0, buildMax: 0 };
const timedReconcile = () => { const a = performance.now(); reconcile(); levelStats.reconcileMax = Math.max(levelStats.reconcileMax, performance.now() - a); };
export function updateLevel(dt, px, pz) {
  // the room you're in (a doorway's plane is the border between two)
  if (!inside(cur, px, pz)) {
    const J = insts.find(I => I !== cur && inside(I, px, pz));
    if (J) { cur = J; timedReconcile(); reT = 0.1; }
  }
  // (every 0.1 s: turning brings new doorways ahead, and their rooms must be placed before they come into the picture)
  if ((reT -= dt) <= 0 || built) { built = false; reT = 0.1; timedReconcile(); }
  else if (world.doorsChanged) refreshNear();
  world.doorsChanged = false;
  { const a = performance.now(); buildStep(queue.length ? 6 : 4); levelStats.buildMax = Math.max(levelStats.buildMax, performance.now() - a); }
  if ((evictT -= dt) <= 0) { evictT = 2; evict(); }
  // the placed rooms' lights: flicker, and mold over the fixtures
  matT -= dt;
  for (const R of rooms) {
    if (!R.inst.length) continue;
    if (matT <= 0) for (const f of R.fixtures) f.mold = coverage(R, f.cells);
    updateRoomLights(R, dt);
  }
  if (matT <= 0) matT = 0.25;
  updatePool(dt);
  shared.uRoomCur.value = cur.id; shared.uEnvKCur.value = cur.room.u.uEnvK.value;
  world.ambient = 0.35 * Math.min(1, cur.room.u.uEnvK.value);
  world.ceiling = cur.room.plan.H;
  // you duck in a crawlspace, and going through a low doorway into or out of one
  let low = cur.room.plan.H < 1.9;
  for (let d = 0; d < cur.adj.length && !low; d++) {
    const A = cur.adj[d];
    if ((cur.room.plan.doors[d].h ?? DOOR_H) >= 1.7 && !(A && (A.inst.room.plan.doors[A.door].h ?? DOOR_H) < 1.7)) continue;
    const D = doorW(cur, d);
    if (Math.hypot(px - D.x, pz - D.z) < 1.3) low = true;
  }
  world.forceCrouch = low;
  world.inWater = !!cur.room.plan.water;
  world.wetNear = insts.some(I => I.room.plan.water && I.depth <= 2);
}
