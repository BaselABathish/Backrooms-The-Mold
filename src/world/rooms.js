// Room plans (docs/ROOMS.md): an archetype plus random parameters gives a room's plan, in its own coordinates. A plan
// is only numbers and names (it can be copied: a "wrong room" is a copy with one thing changed); world/roombuild.js
// turns it into geometry, light and mold cells.
// Everything is on the ceiling's 0.6 m grid (walls, doorways, light fixtures), so fixtures land in whole tiles.
// The room's air is the union of its rects; its walls stand outside them, WALL thick (each room owns its half of a
// wall: two rooms joined at a doorway make a 0.2 m wall). A doorway is DOOR_W wide and h high (DOOR_H, or low into a
// crawlspace), a hole through the wall with a header above; its centre on the wall's outer face is where two rooms are
// joined (world/level.js).
//
// plan: { kind, H (ceiling height), rects: [{ x0, z0, x1, z1 }],
//   boxes: [{ x0, z0, x1, z1, y0, h, nosurf? }] (walls, headers, pillars, partitions; nosurf: a collider only, drawn by
//     its own geometry: a desk, a pipe, a duct),
//   doors: [{ x, z, nx, nz, h, strip: { x0, z0, x1, z1 } }],
//   fixtures: [{ x, z, alongX, state, y? (hanging: its height), bulb?, cage? }], vents, gone: [[x0, z0]],
//   pipes: [{ along: 'x' | 'z', c, y, r, a0, a1 }], ducts: [{ x0, z0, x1, z1, y0, y1 }], props: [{ type, x, z, ry }],
//   mats: { floor, wall, ceil, upper?, top } (names: roombuild.js MATS), base (a rubber base on the walls), tiles (a drop
//   ceiling: vents, sprinklers), tint (the tubes' colour), colonies: [{ name, temper, seeds: [[x, y, z, r, density]] }],
//   light: 'on' | 'patchy' | 'dying' | 'dark', loop?: [d, e] (a self-loop room: doorway d leads into this room's e),
//   cans: [{ x, z, ry, taken }] (fuel cans, world/interact.js), safe?: a safe room (its generator: a prop),
//   water?: a flooded room: how much of its floor is under water (0-1), damp?: mold grows faster in it (game/mold.js) }
import { mulberry32 } from '../core/util.js';

export const G = 0.6, WALL = 0.1, DOOR_W = 1.8, DOOR_H = 2.1, CEIL_H = 2.6;
const LOW_DOOR = 1.2;   // into a crawlspace

// the outline of a union of grid rects: segments { axis: 'z' (a wall plane z = c, running along x) | 'x', c, a0, a1,
// n (outward: +1 / -1 along the plane's axis) }
function outline(rects) {
  const gx0 = Math.round(Math.min(...rects.map(r => r.x0)) / G), gx1 = Math.round(Math.max(...rects.map(r => r.x1)) / G);
  const gz0 = Math.round(Math.min(...rects.map(r => r.z0)) / G), gz1 = Math.round(Math.max(...rects.map(r => r.z1)) / G);
  const W = gx1 - gx0, D = gz1 - gz0, inside = new Uint8Array(W * D);
  for (const r of rects) for (let j = Math.round(r.z0 / G) - gz0; j < Math.round(r.z1 / G) - gz0; j++) for (let i = Math.round(r.x0 / G) - gx0; i < Math.round(r.x1 / G) - gx0; i++) inside[j * W + i] = 1;
  const at = (i, j) => i >= 0 && j >= 0 && i < W && j < D ? inside[j * W + i] : 0;
  const segs = [];
  const run = (axis, n, c, cells) => {   // merge consecutive grid edges on one line into segments
    let s = null;
    for (let k = 0; k <= cells.length; k++) {
      if (k < cells.length && cells[k]) { if (s === null) s = k; }
      else if (s !== null) { segs.push({ axis, n, c, a0: ((axis === 'z' ? gx0 : gz0) + s) * G, a1: ((axis === 'z' ? gx0 : gz0) + k) * G }); s = null; }
    }
  };
  for (let j = 0; j <= D; j++) {
    run('z', -1, (gz0 + j) * G, Array.from({ length: W }, (_, i) => at(i, j) && !at(i, j - 1)));
    run('z', 1, (gz0 + j) * G, Array.from({ length: W }, (_, i) => at(i, j - 1) && !at(i, j)));
  }
  for (let i = 0; i <= W; i++) {
    run('x', -1, (gx0 + i) * G, Array.from({ length: D }, (_, j) => at(i, j) && !at(i - 1, j)));
    run('x', 1, (gx0 + i) * G, Array.from({ length: D }, (_, j) => at(i - 1, j) && !at(i, j)));
  }
  return segs;
}

// where a doorway can go on a segment: centres every 0.3 m with at least 0.3 m of wall either side (or the whole
// segment, if it is exactly a doorway wide)
function doorSpots(sg) {
  const len = sg.a1 - sg.a0;
  if (Math.abs(len - DOOR_W) < 0.01) return [sg.a0 + DOOR_W / 2];
  const out = [];
  for (let u = sg.a0 + 0.3 + DOOR_W / 2; u + DOOR_W / 2 <= sg.a1 - 0.3 + 1e-6; u += 0.3) out.push(+u.toFixed(3));
  return out;
}
function makeDoor(sg, u, h) {
  const o = sg.c + sg.n * WALL, lo = Math.min(sg.c, o), hi = Math.max(sg.c, o);
  return sg.axis === 'z'
    ? { seg: sg, u, h, x: u, z: o, nx: 0, nz: sg.n, strip: { x0: u - DOOR_W / 2, x1: u + DOOR_W / 2, z0: lo, z1: hi } }
    : { seg: sg, u, h, x: o, z: u, nx: sg.n, nz: 0, strip: { x0: lo, x1: hi, z0: u - DOOR_W / 2, z1: u + DOOR_W / 2 } };
}
// the walls round the outline, with a hole and a header for each doorway. In a room taller than the wallpaper (a tall
// void), every wall is split at 2.6 m, so the part above can be built in another material.
function walls(segs, doors, H) {
  const boxes = [];
  for (const sg of segs) {
    const o = sg.c + sg.n * WALL, lo = Math.min(sg.c, o), hi = Math.max(sg.c, o);
    const piece = (a0, a1, y0) => {
      if (a1 - a0 < 1e-6) return;
      const ys = H > 3 ? (y0 < CEIL_H ? [[y0, CEIL_H], [CEIL_H, H]] : [[y0, H]]) : [[y0, H]];
      for (const [b0, b1] of ys) boxes.push(sg.axis === 'z' ? { x0: a0, x1: a1, z0: lo, z1: hi, y0: b0, h: b1 } : { x0: lo, x1: hi, z0: a0, z1: a1, y0: b0, h: b1 });
    };
    let a = sg.a0;
    for (const d of doors.filter(d => d.seg === sg).sort((p, q) => p.u - q.u)) {
      piece(a, d.u - DOOR_W / 2, 0); piece(d.u - DOOR_W / 2, d.u + DOOR_W / 2, d.h); a = d.u + DOOR_W / 2;
    }
    piece(a, sg.a1, 0);
  }
  return boxes;
}

const inRects = (rects, x0, z0, x1, z1) => rects.some(r => x0 >= r.x0 - 1e-6 && x1 <= r.x1 + 1e-6 && z0 >= r.z0 - 1e-6 && z1 <= r.z1 + 1e-6);
const hitsBox = (boxes, x0, z0, x1, z1, m = 0.05) => boxes.some(b => b.y0 < 0.5 && x1 > b.x0 - m && x0 < b.x1 + m && z1 > b.z0 - m && z0 < b.z1 + m);
// keep the floor in front of every doorway clear (so a doorway never opens onto a pillar)
const nearDoor = (doors, x0, z0, x1, z1, m = 1.8) => doors.some(d => x1 > Math.min(d.x, d.x - d.nx * m) - 1.0 && x0 < Math.max(d.x, d.x - d.nx * m) + 1.0 && z1 > Math.min(d.z, d.z - d.nz * m) - 1.0 && z0 < Math.max(d.z, d.z - d.nz * m) + 1.0);

// troffers on a grid over the room (each one 1.2 x 0.6 m), where they fit
function troffers(plan, rnd, { alongX = true, step = 2.4, offX = 0, offZ = 0, y } = {}) {
  const xs = plan.rects.flatMap(r => [r.x0, r.x1]), zs = plan.rects.flatMap(r => [r.z0, r.z1]);
  const X0 = Math.min(...xs), X1 = Math.max(...xs), Z0 = Math.min(...zs), Z1 = Math.max(...zs);
  const [hx, hz] = alongX ? [0.6, 0.3] : [0.3, 0.6];
  const nx = Math.max(1, Math.floor((X1 - X0) / step)), nz = Math.max(1, Math.floor((Z1 - Z0) / step));
  const sx = X0 + Math.round(((X1 - X0) - (nx - 1) * step) / 2 / G) * G + offX + (alongX ? 0 : 0.3), sz = Z0 + Math.round(((Z1 - Z0) - (nz - 1) * step) / 2 / G) * G + offZ + (alongX ? 0.3 : 0);
  for (let r = 0; r < nz; r++) for (let c = 0; c < nx; c++) {
    const x = +(sx + c * step).toFixed(3), z = +(sz + r * step).toFixed(3);
    if (!inRects(plan.rects, x - hx - 0.05, z - hz - 0.05, x + hx + 0.05, z + hz + 0.05) || hitsBox(plan.boxes, x - hx, z - hz, x + hx, z + hz)) continue;
    plan.fixtures.push({ x, z, alongX, state: 'on', y });
  }
}
// which light a room gets: from the archetype's table; in a dark stretch of rooms (the room you came from was dark),
// more likely dark too
function chooseLight(rnd, table, o) { return o.dark && rnd() < 0.6 ? 'dark' : pick(rnd, table); }
// how the room is lit: most fixtures in a lit room work; a few are dead, one stutters
function lightUp(plan, rnd, light) {
  plan.light = light;
  for (const f of plan.fixtures) {
    const u = rnd();
    f.state = light === 'dark' ? 'off'
      : light === 'dying' ? (u < 0.55 ? 'off' : u < 0.85 ? 'dying' : 'flicker')
      : light === 'patchy' ? (u < 0.45 ? 'off' : u < 0.55 ? 'flicker' : u < 0.6 ? 'dying' : 'on')
      : (u < 0.1 ? 'off' : u < 0.14 ? 'flicker' : u < 0.16 ? 'dying' : 'on');
  }
}
// ceiling details: return-air grilles, a missing tile or two (all whole tiles)
function ceilingDetails(plan, rnd) {
  const area = plan.rects.reduce((s, r) => s + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
  const tile = () => { const r = plan.rects[(rnd() * plan.rects.length) | 0]; return [r.x0 + G * Math.floor(rnd() * (r.x1 - r.x0) / G), r.z0 + G * Math.floor(rnd() * (r.z1 - r.z0) / G)]; };
  const free = ([x0, z0]) => !plan.fixtures.some(f => x0 + G > f.x - 0.6 && x0 < f.x + 0.6 && z0 + G > f.z - 0.6 && z0 < f.z + 0.6) && !hitsBox(plan.boxes, x0, z0, x0 + G, z0 + G, 0.01);
  for (let k = 0, n = Math.round(area / 22); k < n; k++) { const t = tile(); if (free(t)) plan.vents.push(t); }
  if (rnd() < 0.3) { const t = tile(); if (free(t)) plan.gone.push(t); }
}

// doorways: on different walls where possible, never two on one spot (prefer: an order of [segment, u] to try)
function finish(plan, rnd, nDoors, prefer = null, h = DOOR_H) {
  const segs = outline(plan.rects);
  const spots = [];
  for (const sg of segs) for (const u of doorSpots(sg)) spots.push([sg, u]);
  const picked = [];
  const order = prefer ? prefer(spots) : spots.sort(() => rnd() - 0.5);
  for (const [sg, u] of order) {
    if (picked.length >= nDoors) break;
    if (picked.some(([s2, u2]) => s2 === sg && Math.abs(u2 - u) < DOOR_W + 1.2)) continue;
    if (!prefer && picked.some(([s2]) => s2 === sg) && picked.length < segs.length) continue;
    picked.push([sg, u]);
  }
  plan.doors = picked.map(([sg, u]) => makeDoor(sg, u, h));
  plan.boxes.unshift(...walls(segs, plan.doors, plan.H));
  return plan;
}
// ends of a corridor first (its short segments), then its sides
const endsFirst = rnd => spots => [...spots.filter(([sg]) => sg.a1 - sg.a0 <= 2.4 + 1e-6).sort(() => rnd() - 0.5), ...spots.filter(([sg]) => sg.a1 - sg.a0 > 2.4 + 1e-6).sort(() => rnd() - 0.5)];
const WALLPAPER = { floor: 'carpet', wall: 'wallpaper', ceil: 'tiles', top: 'wallpaper' };
const newPlan = (kind, rects, H = CEIL_H, mats = WALLPAPER) => ({ kind, H, rects, boxes: [], doors: [], fixtures: [], vents: [], gone: [], pipes: [], ducts: [], props: [], cans: [], colonies: [],
  light: 'on', mats, base: mats.wall === 'wallpaper', tiles: mats.ceil === 'tiles', tint: null });
const snap = v => Math.round(v / G) * G;
const RR = (rnd, a, b) => a + (b - a) * rnd();
const pick = (rnd, arr) => arr[(rnd() * arr.length) | 0];

// ---------------------------------------------------------------- archetypes (docs/ROOMS.md numbers them)
// 1. Wallpaper hall: open, broken up by stub walls and pillars. A rectangle or an L.
function hall(rnd, depth, o) {
  const w = snap(RR(rnd, 8.4, 16.8)), d = snap(RR(rnd, 8.4, 16.8));
  const rects = [{ x0: 0, z0: 0, x1: w, z1: d }];
  if (rnd() < 0.3) {   // an L: a wing off one side
    const ww = snap(RR(rnd, 4.8, w * 0.7)), wd = snap(RR(rnd, 3.6, 8.4));
    rects.push(rnd() < 0.5 ? { x0: 0, z0: d, x1: ww, z1: d + wd } : { x0: w - ww, z0: -wd, x1: w, z1: 0 });
  }
  const plan = newPlan('hall', rects);
  finish(plan, rnd, 2 + (rnd() < 0.6 ? 1 : 0) + (rnd() < 0.3 ? 1 : 0));
  obstacles(plan, rnd, rects[0]);
  troffers(plan, rnd);
  lightUp(plan, rnd, chooseLight(rnd, depth < 2 ? ['on'] : ['on', 'on', 'on', 'patchy', 'patchy', 'dying', 'dark'], o));
  ceilingDetails(plan, rnd);
  if (depth >= 1 && rnd() < 0.25 + 0.04 * depth) colonyInCorner(plan, rnd, depth);
  return plan;
}
// 8. Flooded room: a hall the water has come into. The carpet is soaked through and ankle-deep water stands in the low
// spots (plan.water: how much of the floor; where, from noise in world/materials.js, so it stays with the room). You
// splash through it and wade a little slower; the lights are failing (the damp has got into them); mold grows fastest
// here (plan.damp).
function flooded(rnd, depth, o) {
  const w = snap(RR(rnd, 7.2, 14.4)), d = snap(RR(rnd, 7.2, 13.2));
  const rects = [{ x0: 0, z0: 0, x1: w, z1: d }];
  const plan = newPlan('flooded', rects);
  finish(plan, rnd, 2 + (rnd() < 0.5 ? 1 : 0));
  obstacles(plan, rnd, rects[0]);
  troffers(plan, rnd);
  lightUp(plan, rnd, chooseLight(rnd, ['on', 'patchy', 'patchy', 'dying', 'dying', 'dark'], o));
  ceilingDetails(plan, rnd);
  plan.water = +(0.5 + 0.4 * rnd()).toFixed(2);
  plan.damp = true;
  if (rnd() < 0.5) colonyInCorner(plan, rnd, depth);
  return plan;
}
// stub walls and pillars, clear of the doorways
function obstacles(plan, rnd, r) {
  for (let k = 0, n = 1 + ((rnd() * 3) | 0); k < n; k++) {
    for (let tries = 0; tries < 12; tries++) {
      const alongX = rnd() < 0.5, len = snap(RR(rnd, 2.4, 4.8));
      const x = snap(RR(rnd, r.x0 + 1.8, r.x1 - 1.8 - (alongX ? len : 0))), z = snap(RR(rnd, r.z0 + 1.8, r.z1 - 1.8 - (alongX ? 0 : len)));
      const b = alongX ? { x0: x, x1: x + len, z0: z - 0.1, z1: z + 0.1 } : { x0: x - 0.1, x1: x + 0.1, z0: z, z1: z + len };
      if (b.x1 > r.x1 - 1.2 || b.z1 > r.z1 - 1.2 || nearDoor(plan.doors, b.x0, b.z0, b.x1, b.z1) || hitsBox(plan.boxes, b.x0, b.z0, b.x1, b.z1, 1.2)) continue;
      plan.boxes.push({ ...b, y0: 0, h: plan.H }); break;
    }
  }
  for (let k = 0, n = (rnd() * 3) | 0; k < n; k++) {
    const x = snap(RR(rnd, r.x0 + 2.4, r.x1 - 2.4)), z = snap(RR(rnd, r.z0 + 2.4, r.z1 - 2.4));
    if (nearDoor(plan.doors, x, z, x + 0.6, z + 0.6) || hitsBox(plan.boxes, x, z, x + 0.6, z + 0.6, 1.2)) continue;
    plan.boxes.push({ x0: x, z0: z, x1: x + 0.6, z1: z + 0.6, y0: 0, h: plan.H });
  }
}
// corridor shapes: straight, L, T (a branch off the middle) or Z (two bends)
function corridorRects(rnd, wd) {
  const len = snap(RR(rnd, 6, 16.8)), shape = pick(rnd, ['straight', 'straight', 'L', 'L', 'T', 'Z']);
  const rects = [{ x0: 0, z0: 0, x1: wd, z1: len }];
  const l2 = snap(RR(rnd, 4.8, 10.8)), side = rnd() < 0.5 ? 1 : -1;
  if (shape === 'L') rects.push(side > 0 ? { x0: wd, z0: len - wd, x1: wd + l2, z1: len } : { x0: -l2, z0: len - wd, x1: 0, z1: len });
  if (shape === 'T') { const m = snap(len / 2 - wd / 2); rects.push(side > 0 ? { x0: wd, z0: m, x1: wd + l2, z1: m + wd } : { x0: -l2, z0: m, x1: 0, z1: m + wd }); }
  if (shape === 'Z') {
    const l3 = snap(RR(rnd, 3.6, 8.4));
    if (side > 0) rects.push({ x0: wd, z0: len - wd, x1: wd + l2, z1: len }, { x0: l2, z0: len, x1: wd + l2, z1: len + l3 });
    else rects.push({ x0: -l2, z0: len - wd, x1: 0, z1: len }, { x0: -l2, z0: len, x1: wd - l2, z1: len + l3 });
  }
  return { rects, shape };
}
// a line of fixtures down the middle of each leg
function legLights(plan, rnd, every = 3.6, make = (x, z, alongX) => ({ x, z, alongX, state: 'on' })) {
  for (const r of plan.rects) {
    const alongX = r.x1 - r.x0 > r.z1 - r.z0, n = Math.floor(((alongX ? r.x1 - r.x0 : r.z1 - r.z0) - 1.2) / every) + 1;
    for (let k = 0; k < n; k++) {
      // (across the leg, centred on the nearest odd multiple of 0.3 m: a fixture's short side covers one whole tile)
      const mid = v => Math.round((v - 0.3) / G) * G + 0.3;
      const x = alongX ? r.x0 + 1.2 + k * every : mid((r.x0 + r.x1) / 2), z = alongX ? mid((r.z0 + r.z1) / 2) : r.z0 + 1.2 + k * every;
      const [hx, hz] = alongX ? [0.6, 0.3] : [0.3, 0.6];
      if (!inRects(plan.rects, x - hx - 0.05, z - hz - 0.05, x + hx + 0.05, z + hz + 0.05) || plan.fixtures.some(f => Math.abs(f.x - x) < 1.3 && Math.abs(f.z - z) < 1.3)) continue;
      plan.fixtures.push(make(+x.toFixed(3), +z.toFixed(3), alongX));
    }
  }
}
// 2. Corridor: narrow, straight or bent. Doorways at its ends, sometimes one in a side.
function corridor(rnd, depth, o) {
  const wd = rnd() < 0.5 ? 1.8 : 2.4, { rects, shape } = corridorRects(rnd, wd);
  const plan = newPlan('corridor', rects);
  finish(plan, rnd, (shape === 'T' ? 3 : 2) + (rnd() < 0.35 ? 1 : 0), endsFirst(rnd));
  legLights(plan, rnd);
  lightUp(plan, rnd, chooseLight(rnd, depth < 1 ? ['on', 'patchy'] : ['on', 'patchy', 'dying', 'dark', 'dark'], o));
  ceilingDetails(plan, rnd);
  if (depth >= 1 && rnd() < 0.3 + 0.04 * depth) colonyAtEnd(plan, rnd, depth);
  return plan;
}
// 3. Pillar field: big and low-feeling, a grid of square pillars, lit in patches.
function pillars(rnd, depth, o) {
  const w = snap(RR(rnd, 14.4, 21.6)), d = snap(RR(rnd, 14.4, 21.6)), pitch = pick(rnd, [3.6, 4.8]), size = pick(rnd, [0.6, 1.2]);
  const plan = newPlan('pillars', [{ x0: 0, z0: 0, x1: w, z1: d }]);
  finish(plan, rnd, 2 + ((rnd() * 3) | 0));
  for (let x = pitch; x < w - 1.8; x += pitch) for (let z = pitch; z < d - 1.8; z += pitch) {
    const x0 = snap(x - size / 2), z0 = snap(z - size / 2);
    if (nearDoor(plan.doors, x0, z0, x0 + size, z0 + size, 1.2)) continue;
    plan.boxes.push({ x0, z0, x1: x0 + size, z1: z0 + size, y0: 0, h: plan.H });
  }
  troffers(plan, rnd, { step: pitch, offX: pitch / 2 - (pitch / 2) % G, offZ: 0 });
  lightUp(plan, rnd, chooseLight(rnd, ['patchy', 'patchy', 'on', 'dying'], o));
  ceilingDetails(plan, rnd);
  if (depth >= 1 && rnd() < 0.35 + 0.04 * depth) colonyInCorner(plan, rnd, depth, true);
  return plan;
}
// 4. Partition maze: an office with the desks taken out. Partitions on a 2.4 m grid, most 1.5 m high (you see over
// them), some to the ceiling; every part reachable (a random spanning tree), with a few loops. Short sightlines.
function maze(rnd, depth, o) {
  const cw = 2.4, nx = 4 + ((rnd() * 3) | 0), nz = 4 + ((rnd() * 3) | 0);
  const plan = newPlan('maze', [{ x0: 0, z0: 0, x1: nx * cw, z1: nz * cw }]);
  // doorways in the middle of a cell's outer edge, one per wall at most
  finish(plan, rnd, 2 + (rnd() < 0.5 ? 1 : 0), spots => {
    const ok = spots.filter(([sg, u]) => Math.abs((((u - sg.a0) % cw) + cw) % cw - cw / 2) < 0.01).sort(() => rnd() - 0.5), out = [];
    for (const s of ok) if (!out.some(t => t[0] === s[0])) out.push(s);
    return out;
  });
  const open = new Set(), seen = new Set(), key = (i, j, di, dj) => di ? `x${Math.min(i, i + di)},${j}` : `z${i},${Math.min(j, j + dj)}`;
  const stack = [[(rnd() * nx) | 0, (rnd() * nz) | 0]];
  seen.add(stack[0].join());
  while (stack.length) {   // depth-first: a maze with long dead ends
    const [i, j] = stack[stack.length - 1];
    const next = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => i + di >= 0 && j + dj >= 0 && i + di < nx && j + dj < nz && !seen.has(`${i + di},${j + dj}`));
    if (!next.length) { stack.pop(); continue; }
    const [di, dj] = pick(rnd, next);
    open.add(key(i, j, di, dj)); seen.add(`${i + di},${j + dj}`); stack.push([i + di, j + dj]);
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    for (const [di, dj] of [[1, 0], [0, 1]]) {
      if (i + di >= nx || j + dj >= nz || open.has(key(i, j, di, dj)) || rnd() < 0.18) continue;   // (some knocked out: loops)
      const h = rnd() < 0.68 ? 1.5 : plan.H;
      plan.boxes.push(di ? { x0: (i + 1) * cw - 0.05, x1: (i + 1) * cw + 0.05, z0: j * cw, z1: (j + 1) * cw, y0: 0, h }
        : { x0: i * cw, x1: (i + 1) * cw, z0: (j + 1) * cw - 0.05, z1: (j + 1) * cw + 0.05, y0: 0, h });
    }
  }
  troffers(plan, rnd, { offX: 0, offZ: 0 });
  lightUp(plan, rnd, chooseLight(rnd, ['on', 'on', 'patchy', 'dying'], o));
  ceilingDetails(plan, rnd);
  // an ambush: mold waiting in a dead end, that rushes when you're close and not looking
  if (depth >= 1 && rnd() < 0.35 + 0.04 * depth) {
    const deadEnds = [];
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) if ([[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([di, dj]) => i + di >= 0 && j + dj >= 0 && i + di < nx && j + dj < nz && open.has(key(i, j, di, dj))).length === 1) deadEnds.push([i, j]);
    const [i, j] = deadEnds.length ? pick(rnd, deadEnds) : [0, 0], cx = (i + 0.5) * cw, cz = (j + 0.5) * cw;
    plan.colonies.push({ name: 'ambush', temper: { creep: 0.05, rush: 2.0, rushEvery: [6, 12], rushFor: [0.8, 1.4], when: 'unseen', range: 6, thicken: [4, 0.6] },
      seeds: [[cx, 0, cz, 1.0, 1], [cx, plan.H, cz, 1.1, 1], [cx - cw / 2, 1.0, cz, 0.8, 0.9], [cx, 1.0, cz - cw / 2, 0.8, 0.9]] });
  }
  return plan;
}
// 5. Closet / alcove: a small dead end. Often where the mold is thickest.
function closet(rnd, depth, o) {
  const w = pick(rnd, [2.4, 3.0, 3.6]), d = pick(rnd, [2.4, 3.6, 4.8]);
  const plan = newPlan('closet', [{ x0: 0, z0: 0, x1: w, z1: d }]);
  finish(plan, rnd, 1);
  const r = plan.rects[0];
  plan.fixtures.push({ x: snap((r.x0 + r.x1) / 2), z: snap((r.z0 + r.z1) / 2) + 0.3, alongX: true, state: 'on' });
  if (!inRects(plan.rects, plan.fixtures[0].x - 0.65, plan.fixtures[0].z - 0.35, plan.fixtures[0].x + 0.65, plan.fixtures[0].z + 0.35)) plan.fixtures.length = 0;
  lightUp(plan, rnd, chooseLight(rnd, ['on', 'dying', 'dark'], o));
  if (rnd() < 0.2) { const d0 = plan.doors[0]; plan.cans.push({ x: clampTo(r.x0 + r.x1 - d0.x, r.x0 + 0.3, r.x1 - 0.3), z: clampTo(r.z0 + r.z1 - d0.z, r.z0 + 0.3, r.z1 - 0.3), ry: rnd() * 6.28 }); }
  if (depth >= 1 && rnd() < 0.5) {
    const d0 = plan.doors[0], fx = r.x0 + r.x1 - d0.x, fz = r.z0 + r.z1 - d0.z;   // the back of the closet
    plan.colonies.push({ name: 'closet', temper: { creep: 0.06, rush: 0, when: 'never', thicken: [4, 1] },
      seeds: [[fx, 1.2, fz, 1.6, 1], [fx, 0, fz, 1.4, 1], [fx, CEIL_H, fz, 1.3, 0.9]] });
  }
  return plan;
}
// 6. Crawlspace: a ceiling at 1.5 m (you go through on your knees), the doorways into it low. Rough block walls, a
// concrete floor, fibreglass insulation sagging between the joists overhead, ducts and cables under it. Bare bulbs, if
// any work. Mold on the ceiling right above the camera.
function crawl(rnd, depth, o) {
  const H = 1.5, wd = pick(rnd, [3.0, 3.6, 4.8]), len = snap(RR(rnd, 7.2, 14.4));
  const rects = [{ x0: 0, z0: 0, x1: wd, z1: len }];
  if (rnd() < 0.4) { const l2 = snap(RR(rnd, 4.8, 9.6)); rects.push(rnd() < 0.5 ? { x0: wd, z0: len - wd, x1: wd + l2, z1: len } : { x0: -l2, z0: len - wd, x1: 0, z1: len }); }
  const plan = newPlan('crawl', rects, H, { floor: 'concreteFloor', wall: 'concrete', ceil: 'insulation', top: 'concrete' });
  finish(plan, rnd, 2 + (rnd() < 0.3 ? 1 : 0), endsFirst(rnd), LOW_DOOR);
  for (const r of rects) {   // a duct down each leg, under the joists, off to one side; a cable or two beside it
    const alongX = r.x1 - r.x0 > r.z1 - r.z0, side = rnd() < 0.5 ? 0.35 : -0.35, wD = 0.46;
    const c = alongX ? (r.z0 + r.z1) / 2 + side * (r.z1 - r.z0) / 2 : (r.x0 + r.x1) / 2 + side * (r.x1 - r.x0) / 2;
    const d = alongX ? { x0: r.x0, x1: r.x1, z0: c - wD / 2, z1: c + wD / 2, y0: H - 0.33, y1: H - 0.02 } : { x0: c - wD / 2, x1: c + wD / 2, z0: r.z0, z1: r.z1, y0: H - 0.33, y1: H - 0.02 };
    plan.ducts.push(d);
    plan.boxes.push({ x0: d.x0, z0: d.z0, x1: d.x1, z1: d.z1, y0: d.y0, h: H, nosurf: true });
    for (let k = 0; k < 2; k++) plan.pipes.push({ along: alongX ? 'x' : 'z', c: c - side * (0.5 + k * 0.08) * 1.6, y: H - 0.06 - k * 0.03, r: 0.012, a0: alongX ? r.x0 : r.z0, a1: alongX ? r.x1 : r.z1, cable: true });
  }
  legLights(plan, rnd, 4.8, (x, z) => ({ x, z, alongX: true, state: 'on', bulb: true }));
  plan.tint = 0xffd8a8;   // old incandescent bulbs: warm
  lightUp(plan, rnd, chooseLight(rnd, ['dying', 'dying', 'patchy', 'dark'], o));
  if (depth >= 1 && rnd() < 0.5 + 0.04 * depth) {   // in the insulation overhead, at the far end
    const r = rects[rects.length - 1], fx = (r.x0 + r.x1) / 2, fz = (r.z0 + r.z1) / 2;
    plan.colonies.push({ name: 'crawl', temper: { creep: 0.07, rush: 1.4, rushEvery: [16, 30], rushFor: [0.8, 1.6], when: 'unseen', range: 8, thicken: [3.5, 0.7] },
      seeds: [[fx, H, fz, 1.8, 1], [fx, 0.8, fz, 1.0, 0.9]] });
  }
  return plan;
}
// 7. Tall void: a normal floor, but the walls go up into the dark; the lights hang on long cables. The ceiling is out of
// sight (the flashlight barely reaches it).
function tallVoid(rnd, depth, o) {
  const H = pick(rnd, [7.2, 9.0, 11.4]), w = snap(RR(rnd, 9.6, 15.6)), d = snap(RR(rnd, 9.6, 15.6));
  const plan = newPlan('void', [{ x0: 0, z0: 0, x1: w, z1: d }], H, { floor: 'carpet', wall: 'wallpaper', upper: 'voidWall', ceil: 'voidCeil', top: 'wallpaper' });
  plan.tiles = false;
  finish(plan, rnd, 2 + (rnd() < 0.5 ? 1 : 0));
  if (rnd() < 0.6) {   // a column into the dark (in two parts, like the walls: wallpaper, then bare above)
    const x = snap(RR(rnd, 3, w - 3.6)), z = snap(RR(rnd, 3, d - 3.6));
    if (!nearDoor(plan.doors, x, z, x + 0.6, z + 0.6)) plan.boxes.push({ x0: x, z0: z, x1: x + 0.6, z1: z + 0.6, y0: 0, h: CEIL_H }, { x0: x, z0: z, x1: x + 0.6, z1: z + 0.6, y0: CEIL_H, h: H });
  }
  troffers(plan, rnd, { step: 3.6, y: +RR(rnd, 3.0, 3.6).toFixed(2) });
  lightUp(plan, rnd, chooseLight(rnd, ['on', 'patchy', 'patchy', 'dying'], o));
  if (depth >= 1 && rnd() < 0.3 + 0.04 * depth) colonyInCorner(plan, rnd, depth);
  return plan;
}
// 10. Service corridor: painted block, a concrete floor and ceiling, pipes along one wall, a breaker box, caged bulbs.
// Darker and colder than the rest.
function service(rnd, depth, o) {
  const wd = rnd() < 0.5 ? 1.8 : 2.4, { rects, shape } = corridorRects(rnd, wd);
  const plan = newPlan('service', rects, 2.8, { floor: 'concreteFloor', wall: 'concrete', ceil: 'concreteCeil', top: 'concrete' });
  finish(plan, rnd, (shape === 'T' ? 3 : 2) + (rnd() < 0.3 ? 1 : 0), endsFirst(rnd));
  for (const r of rects) {   // three pipes along one side of each leg, up near the ceiling
    const alongX = r.x1 - r.x0 > r.z1 - r.z0, side = rnd() < 0.5;
    for (let k = 0; k < 3; k++) {
      const rad = [0.075, 0.05, 0.035][k], off = 0.14 + k * 0.17, y = plan.H - 0.22 - (k % 2) * 0.12;
      const c = alongX ? (side ? r.z0 + off : r.z1 - off) : (side ? r.x0 + off : r.x1 - off);
      plan.pipes.push({ along: alongX ? 'x' : 'z', c, y, r: rad, a0: alongX ? r.x0 : r.z0, a1: alongX ? r.x1 : r.z1 });
    }
  }
  // the breaker box: on a long wall, off the floor, facing into the corridor (nx, nz), clear of the doorways
  const r0 = rects[0], alongZ = r0.z1 - r0.z0 > r0.x1 - r0.x0, z = snap(RR(rnd, r0.z0 + 1.2, r0.z1 - 1.2)) + 0.3, x = snap(RR(rnd, r0.x0 + 1.2, r0.x1 - 1.2)) + 0.3, lo = rnd() < 0.5;
  const bp = alongZ ? { type: 'breaker', x: lo ? r0.x0 : r0.x1, z, nx: lo ? 1 : -1, nz: 0 } : { type: 'breaker', x, z: lo ? r0.z0 : r0.z1, nx: 0, nz: lo ? 1 : -1 };
  if (!nearDoor(plan.doors, bp.x - 0.4, bp.z - 0.4, bp.x + 0.4, bp.z + 0.4, 0.6) && !plan.boxes.some(b => b.y0 < 0.5 && bp.x + bp.nx * 0.2 > b.x0 && bp.x + bp.nx * 0.2 < b.x1 && bp.z + bp.nz * 0.2 > b.z0 && bp.z + bp.nz * 0.2 < b.z1)) plan.props.push(bp);
  legLights(plan, rnd, 3.6, (x, z) => ({ x, z, alongX: true, state: 'on', bulb: true, cage: true }));
  plan.tint = 0xe6eeff;   // cold
  if (rnd() < 0.3) {   // a fuel can left against a wall
    const r = rects[(rnd() * rects.length) | 0], alongX = r.x1 - r.x0 > r.z1 - r.z0, a = RR(rnd, 0.25, 0.75);
    const c = alongX ? { x: r.x0 + (r.x1 - r.x0) * a, z: rnd() < 0.5 ? r.z0 + 0.2 : r.z1 - 0.2 } : { x: rnd() < 0.5 ? r.x0 + 0.2 : r.x1 - 0.2, z: r.z0 + (r.z1 - r.z0) * a };
    if (!nearDoor(plan.doors, c.x - 0.2, c.z - 0.2, c.x + 0.2, c.z + 0.2, 1.2)) plan.cans.push({ ...c, ry: rnd() * 6.28 });
  }
  lightUp(plan, rnd, chooseLight(rnd, ['on', 'on', 'patchy', 'dying', 'dark'], o));
  if (depth >= 1 && rnd() < 0.3 + 0.04 * depth) colonyAtEnd(plan, rnd, depth);
  return plan;
}
// 11. Office remnant: a small room with what was left behind: a desk with a dead phone on it, a chair pushed back, a
// filing cabinet, papers on the floor. Rare.
function office(rnd, depth, o) {
  const w = pick(rnd, [4.8, 6.0, 7.2]), d = pick(rnd, [4.8, 6.0]);
  const plan = newPlan('office', [{ x0: 0, z0: 0, x1: w, z1: d }]);
  finish(plan, rnd, 1 + (rnd() < 0.4 ? 1 : 0));
  // the desk faces into the room from the wall opposite the first doorway
  const d0 = plan.doors[0], back = d0.nz ? { z: d0.nz > 0 ? 0.45 : d - 0.45, x: snap(RR(rnd, 1.5, w - 1.5)), ry: d0.nz > 0 ? 0 : Math.PI }
    : { x: d0.nx > 0 ? 0.45 : w - 0.45, z: snap(RR(rnd, 1.5, d - 1.5)), ry: d0.nx > 0 ? Math.PI / 2 : -Math.PI / 2 };
  plan.props.push({ type: 'desk', x: back.x, z: back.z, ry: back.ry });
  const fx = Math.sin(back.ry), fz = Math.cos(back.ry);   // the desk's front, into the room
  plan.props.push({ type: 'chair', x: back.x + fx * 1.05 + RR(rnd, -0.3, 0.3), z: back.z + fz * 1.05 + RR(rnd, -0.3, 0.3), ry: back.ry + RR(rnd, -0.7, 0.7) });
  const cornerX = rnd() < 0.5 ? 0.35 : w - 0.35, cornerZ = rnd() < 0.5 ? 0.4 : d - 0.4;
  if (!nearDoor(plan.doors, cornerX - 0.3, cornerZ - 0.3, cornerX + 0.3, cornerZ + 0.3, 1.0)) plan.props.push({ type: 'cabinet', x: cornerX, z: cornerZ, ry: cornerX < 1 ? Math.PI / 2 : -Math.PI / 2 });
  for (let k = 0, n = 4 + ((rnd() * 8) | 0); k < n; k++) plan.props.push({ type: 'paper', x: RR(rnd, 0.4, w - 0.4), z: RR(rnd, 0.4, d - 0.4), ry: RR(rnd, 0, 6.28) });
  if (rnd() < 0.5) { const cx = cornerX < 1 ? w - 0.35 : 0.35; if (!nearDoor(plan.doors, cx - 0.2, cornerZ - 0.2, cx + 0.2, cornerZ + 0.2, 1.0)) plan.cans.push({ x: cx, z: cornerZ, ry: rnd() * 6.28 }); }
  for (const p of plan.props) if (p.type !== 'paper') {   // furniture is in the way (drawn by itself, not as wall)
    const [hw, hd, h] = { desk: [0.75, 0.4, 0.76], chair: [0.3, 0.3, 0.9], cabinet: [0.3, 0.25, 1.32] }[p.type];
    const c = Math.abs(Math.cos(p.ry)), s = Math.abs(Math.sin(p.ry)), ex = hw * c + hd * s, ez = hw * s + hd * c;
    plan.boxes.push({ x0: p.x - ex, z0: p.z - ez, x1: p.x + ex, z1: p.z + ez, y0: 0, h, nosurf: true });
  }
  troffers(plan, rnd);
  lightUp(plan, rnd, chooseLight(rnd, ['on', 'on', 'patchy'], o));
  ceilingDetails(plan, rnd);
  return plan;
}
// 13. Self-loop room: one doorway leads back into the same room through the opposite wall. Through it you see the room
// again, and again. You notice it from a stain or a mark you just passed (soot and mold are the same in every copy).
function selfloop(rnd, depth, o) {
  const w = snap(RR(rnd, 7.2, 12)), d = snap(RR(rnd, 7.2, 12));
  const plan = newPlan('selfloop', [{ x0: 0, z0: 0, x1: w, z1: d }]);
  finish(plan, rnd, 3, spots => {
    const west = spots.filter(([sg]) => sg.axis === 'x' && sg.n < 0), east = spots.filter(([sg]) => sg.axis === 'x' && sg.n > 0);
    const us = west.map(s => s[1]).filter(u => east.some(e => Math.abs(e[1] - u) < 0.01));
    const u = us[(rnd() * us.length) | 0];
    const entry = spots.filter(([sg]) => sg.axis === 'z').sort(() => rnd() - 0.5)[0];
    return [entry, west.find(s => Math.abs(s[1] - u) < 0.01), east.find(s => Math.abs(s[1] - u) < 0.01)].filter(Boolean);
  });
  if (plan.doors.length === 3) plan.loop = [2, 1];   // east leads into west
  obstacles(plan, rnd, plan.rects[0]);
  troffers(plan, rnd);
  lightUp(plan, rnd, chooseLight(rnd, ['on', 'on', 'patchy'], o));
  ceilingDetails(plan, rnd);
  plan.gone.push([snap(RR(rnd, 1.2, w - 1.8)), snap(RR(rnd, 1.2, d - 1.8))]);   // something to recognise it by
  return plan;
}

// Safe room (docs/ROOMS.md): lit and dry. Pale painted block, a concrete floor, cool white light that never flickers,
// one heavy steel door (world/interact.js makes it), a generator against the back wall that keeps the lights on while
// it has fuel, a steel shelf, fuel cans. The mold doesn't grow in it while it's lit.
function safe(rnd, depth, o) {
  const w = pick(rnd, [4.8, 6.0, 7.2]), d = pick(rnd, [4.8, 6.0]);
  const plan = newPlan('safe', [{ x0: 0, z0: 0, x1: w, z1: d }], CEIL_H, { floor: 'concreteFloor', wall: 'safe', ceil: 'safeCeil', top: 'safe' });
  plan.safe = true;
  finish(plan, rnd, 1);
  const d0 = plan.doors[0];
  // the back wall, opposite the door: the generator against it, facing into the room (fx, fz), a can either side
  const onZ = d0.nz !== 0, fx = onZ ? 0 : (d0.nx > 0 ? 1 : -1), fz = onZ ? (d0.nz > 0 ? 1 : -1) : 0;
  const wallC = onZ ? (fz > 0 ? 0 : d) : (fx > 0 ? 0 : w), along = onZ ? snap(w / 2 + RR(rnd, -0.6, 0.6)) : snap(d / 2 + RR(rnd, -0.6, 0.6));
  const gx = onZ ? along : wallC + fx * 0.38, gz = onZ ? wallC + fz * 0.38 : along;
  plan.props.push({ type: 'generator', x: gx, z: gz, fx, fz });
  const [hw, hd] = onZ ? [0.48, 0.34] : [0.34, 0.48];
  plan.boxes.push({ x0: gx - hw, z0: gz - hd, x1: gx + hw, z1: gz + hd, y0: 0, h: 0.8, nosurf: true });
  for (const s of [-1, 1]) if (rnd() < (s < 0 ? 0.9 : 0.6)) {
    const a = along + s * 0.85;
    plan.cans.push(onZ ? { x: a, z: wallC + fz * 0.2, ry: rnd() * 0.4 } : { x: wallC + fx * 0.2, z: a, ry: Math.PI / 2 + rnd() * 0.4 });
  }
  // a steel shelf along a side wall
  const sideX = onZ ? (rnd() < 0.5 ? 0 : w) : null, sideZ = onZ ? null : (rnd() < 0.5 ? 0 : d);
  const sh = onZ ? { x: sideX + (sideX ? -0.25 : 0.25), z: d / 2, fx: sideX ? -1 : 1, fz: 0 } : { x: w / 2, z: sideZ + (sideZ ? -0.25 : 0.25), fx: 0, fz: sideZ ? -1 : 1 };
  if (!nearDoor(plan.doors, sh.x - 0.5, sh.z - 0.5, sh.x + 0.5, sh.z + 0.5, 1.4)) {
    plan.props.push({ type: 'shelf', ...sh });
    const [sw, sd] = sh.fx ? [0.22, 0.6] : [0.6, 0.22];
    plan.boxes.push({ x0: sh.x - sw, z0: sh.z - sd, x1: sh.x + sw, z1: sh.z + sd, y0: 0, h: 1.8, nosurf: true });
  }
  troffers(plan, rnd);
  for (const f of plan.fixtures) f.state = 'on';
  plan.light = 'on';
  plan.tint = 0xeef3ff;   // cool white
  return plan;
}
const clampTo = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- colonies
function colonyInCorner(plan, rnd, depth, big = false) {
  const r = plan.rects[0], cx = rnd() < 0.5 ? r.x0 : r.x1, cz = rnd() < 0.5 ? r.z0 : r.z1;
  const k = 1 + Math.min(depth, 8) * 0.08 + (big ? 0.4 : 0), top = Math.min(plan.H, CEIL_H + 1);
  plan.colonies.push({ name: 'corner', temper: { creep: 0.045 + 0.005 * Math.min(depth, 6), rush: depth >= 3 && rnd() < 0.4 ? 1.6 : 0, rushEvery: [20, 40], rushFor: [0.8, 1.6], when: 'clock', range: 10, thicken: [5, 1] },
    seeds: [[cx, 1.4, cz, 1.0 * k, 1], [cx, top, cz, 1.2 * k, 1], [cx, 0, cz, 0.8 * k, 0.9]] });
}
function colonyAtEnd(plan, rnd, depth) {
  // the end of the corridor farthest from its first doorway: the mold fills it and grows round the doorway there
  const d0 = plan.doors[0], far = plan.doors.slice(1).sort((a, b) => Math.hypot(b.x - d0.x, b.z - d0.z) - Math.hypot(a.x - d0.x, a.z - d0.z))[0];
  if (!far) return;
  const x = far.x - far.nx * 0.6, z = far.z - far.nz * 0.6, sx = -far.nz, sz = far.nx;   // just inside it, and across
  plan.colonies.push({ name: 'corridor', temper: { creep: 0.09, rush: 2.2, rushEvery: [14, 30], rushFor: [1.0, 2.2], when: 'unseen', range: 14, thicken: [3.5, 0.6] },
    seeds: [[x, 1.3, z, 1.5, 1], [x - far.nx * 0.8, 0, z - far.nz * 0.8, 1.4, 1], [x, plan.H, z, 1.4, 1], [x + sx * 0.9, 1.0, z + sz * 0.9, 1.1, 1], [x - sx * 0.9, 1.4, z - sz * 0.9, 1.0, 1]] });
}

// ---------------------------------------------------------------- the start: the hall and dark corridor of the test room
// The hall (14.4 x 16.8 m, two stub walls, two pillars) with a doorway in the far wall to the dark corridor, and one in
// each side wall. The corridor (2.4 x 10.8 m, its lights dead) has an old colony filling its far end, round a doorway.
function startHall() {
  const plan = newPlan('hall', [{ x0: -7.2, z0: -16.8, x1: 7.2, z1: 0 }]);
  finish(plan, null, 3, spots => {
    const want = [[s => s.axis === 'z' && s.n < 0, 0], [s => s.axis === 'x' && s.n < 0, -9.0], [s => s.axis === 'x' && s.n > 0, -4.2]];
    return want.map(([f, u]) => spots.find(([sg, v]) => f(sg) && Math.abs(v - u) < 0.01)).filter(Boolean);
  });
  plan.boxes.push({ x0: -7.2, z0: -6.1, x1: -3.0, z1: -5.9, y0: 0, h: CEIL_H }, { x0: 2.9, z0: -13.8, x1: 3.1, z1: -9.6, y0: 0, h: CEIL_H },
    { x0: -2.7, z0: -11.7, x1: -2.1, z1: -11.1, y0: 0, h: CEIL_H }, { x0: 3.9, z0: -3.9, x1: 4.5, z1: -3.3, y0: 0, h: CEIL_H });
  const special = { '1,5': 'off', '3,0': 'off', '5,4': 'off', '4,2': 'flicker', '6,5': 'dying', '2,3': 'off' };
  for (let r = 0; r < 7; r++) for (let c = 0; c < 6; c++) {
    const x = -6.0 + 2.4 * c, z = -1.5 - 2.4 * r;
    if (hitsBox(plan.boxes.filter(b => b.h > 0), x - 0.6, z - 0.3, x + 0.6, z + 0.3)) continue;
    plan.fixtures.push({ x, z, alongX: true, state: special[`${r},${c}`] || 'on' });
  }
  plan.vents.push([-4.8, -4.2], [1.8, -9.0], [-1.2, -14.4], [4.8, -13.8]);
  plan.gone.push([2.4, -6.6]);
  plan.start = true;
  return plan;
}
function startCorridor() {
  const plan = newPlan('corridor', [{ x0: -1.2, z0: -10.8, x1: 1.2, z1: 0 }]);
  finish(plan, null, 2, spots => [spots.find(([sg]) => sg.axis === 'z' && sg.n > 0), spots.find(([sg]) => sg.axis === 'z' && sg.n < 0)]);
  plan.fixtures.push({ x: 0.3, z: -1.8, alongX: false, state: 'off' }, { x: 0.3, z: -5.4, alongX: false, state: 'off' }, { x: 0.3, z: -9.0, alongX: false, state: 'dying' });
  plan.vents.push([0.0, -7.2]);
  plan.light = 'dark';
  const Z = -10.8;
  plan.colonies.push({ name: 'corridor', temper: { creep: 0.09, rush: 2.2, rushEvery: [14, 30], rushFor: [1.0, 2.2], when: 'unseen', range: 14, thicken: [3.5, 0.6] },
    seeds: [[0, 1.3, Z, 1.7, 1], [0, 0, Z + 1.0, 1.5, 1], [0.3, CEIL_H, Z + 1.4, 1.6, 1], [-1.2, 1.0, Z + 1.6, 1.2, 1], [1.2, 1.4, Z + 2.0, 1.0, 1]] });
  return plan;
}

// 14. Wrong room: a copy of a room's plan with one thing different (a light that was on is off, one that was off works,
// a grille gone, a stain moved). world/level.js decides when you walk into one.
export function wrongPlan(plan, seed) {
  const rnd = mulberry32(seed), P = structuredClone(plan);
  P.kind = plan.kind; P.wrong = true; P.start = false; P.colonies = [];
  const lit = P.fixtures.filter(f => f.state === 'on'), dead = P.fixtures.filter(f => f.state === 'off');
  const changes = [];   // only changes that change something
  if (lit.length) changes.push(() => { pick(rnd, lit).state = 'off'; });
  if (dead.length && P.light !== 'dark') changes.push(() => { pick(rnd, dead).state = 'on'; });
  if (P.vents.length) changes.push(() => { P.vents.splice((rnd() * P.vents.length) | 0, 1); });
  if (P.tiles) changes.push(() => {   // a ceiling tile missing that wasn't (or the missing one moved)
    const r = P.rects[0], t = [r.x0 + G * (1 + Math.floor(rnd() * ((r.x1 - r.x0) / G - 2))), r.z0 + G * (1 + Math.floor(rnd() * ((r.z1 - r.z0) / G - 2)))];
    if (P.gone.length) P.gone[0] = t; else P.gone.push(t);
  });
  if (changes.length) pick(rnd, changes)();
  return P;
}

// a new room's plan: which archetype is drawn from how deep in you are (odder and darker deeper in). o.dark: the room
// you came from is dark (dark rooms come in stretches)
export function makePlan(seed, depth, kind = null, o = {}) {
  if (kind === 'startHall') return startHall();
  if (kind === 'startCorridor') return startCorridor();
  const rnd = mulberry32(seed);
  const table = depth < 2
    ? [['hall', 4], ['corridor', 5], ['closet', 1], ['maze', 1], ['service', 1], ['safe', 0.6]]
    : [['hall', 4], ['corridor', 5], ['pillars', 2], ['closet', 2], ['maze', 2], ['service', 2], ['crawl', 1.2], ['void', 1], ['office', 0.6], ['selfloop', 0.6], ['safe', 1.6], ['flooded', 1.2]];
  let u = rnd() * table.reduce((s, t) => s + t[1], 0), k = table[0][0];
  for (const [name, w] of table) { if ((u -= w) < 0) { k = name; break; } }
  if (kind) k = kind;
  return { hall, corridor, pillars, maze, closet, crawl, void: tallVoid, service, office, selfloop, safe, flooded }[k](rnd, depth, o);
}
