// Builds a room from its plan (world/rooms.js), over several frames: buildRoom is a generator that yields between its
// steps (world/level.js runs it a few milliseconds a frame). What it makes, all in the room's own coordinates:
//  - geometry: one merged geometry per base material (each placed copy of the room draws it with its own materials)
//  - colliders, surfaces and mold cells (world/surfaces.js, game/mold.js)
//  - an AO map (top-down: the floor darkens near walls, damp stains; the ceiling's AO in alpha)
//  - light fixtures (troffers on the ceiling or hanging on cables, bare or caged bulbs; they flicker and die under
//    mold), all of the room's lamps in one mesh, and clusters of fixtures that one point light stands in for
//  - pipes, ducts, furniture
import * as THREE from 'three';
import { clamp, mulberry32 } from '../core/util.js';
import { wallpaperMat, carpetMat, ceilMat, baseMat, fixtureFrameMat, fixtureOffMat, ventMat, plenumMat, panelBase, MAX_PANELS,
  concreteWallMat, concreteFloorMat, concreteCeilMat, voidWallMat, voidCeilMat, insulationMat, pipeMat, ductMat, cableMat, paintedMetalMat,
  deskMat, fabricMat, plasticMat, paperMat, engineMat, safeWallMat, safeCeilMat } from './materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxB, pcyl, pbox, pboxR, part, E, setTarget, push } from './builder.js';
import { buildSurfaces, surfaceQuad, projectMoldUv, atlasUv } from './surfaces.js';
import { DOOR_H, CEIL_H } from './rooms.js';
import { initRoomMold, cellsIn } from '../game/mold.js';

const FIXCOL = [0xffeccc, 0xfff1da, 0xffe8c2, 0xfaefd8, 0xffebc8];
export const LIGHT_I = 1.35;          // one working troffer, candela (only relative levels matter: auto exposure)
const BULB_I = 0.7;                   // a bare bulb gives about half a troffer's light
const DENSITY_REF = 0.2;              // working light per square metre of the start hall: its bounce light is the reference
// the materials a plan names
const MATS = { carpet: carpetMat, wallpaper: wallpaperMat, tiles: ceilMat, concrete: concreteWallMat, concreteFloor: concreteFloorMat,
  concreteCeil: concreteCeilMat, voidWall: voidWallMat, voidCeil: voidCeilMat, insulation: insulationMat, safe: safeWallMat, safeCeil: safeCeilMat };

// a lamp (a troffer's panel or a bulb) in the room's one lamp mesh: its index into the room's brightness, and its colour
function lamp(g, index, hex) {
  const n = g.attributes.position.count, c = new THREE.Color(hex), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('aPanel', new THREE.BufferAttribute(new Float32Array(n).fill(index), 1));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  push(g, panelBase);
}

export function* buildRoom(room) {
  const plan = room.plan, H = plan.H, rnd = mulberry32((room.seed ^ 0x5bd1e995) >>> 0);
  const tgt = { buckets: new Map(), colliders: [] };
  let prev = setTarget(tgt);
  const step = function* (label) { setTarget(prev); yield label; prev = setTarget(tgt); };   // (give the frame back between steps)
  try {
    for (const b of plan.boxes) tgt.colliders.push({ x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, y0: b.y0, h: b.h, nosurf: b.nosurf });
    const strips = plan.doors.map(d => ({ ...d.strip, h: d.h ?? DOOR_H }));
    // the room's air: inside its rects (or a doorway's hole, below its header), outside every wall and pillar
    const open = (x, y, z) => {
      if (y <= 0.001 || y >= H - 0.001) return false;
      if (!plan.rects.some(r => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) && !strips.some(r => y < r.h && x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1)) return false;
      for (const c of tgt.colliders) if (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1 && y > c.y0 && y < c.h) return false;
      return true;
    };
    room.open = open;

    // ---- light fixtures: 2x4 troffers (0.6 x 1.2 m) on the ceiling grid or hanging on cables; bulbs
    const fixtures = [];
    let np = 0;
    for (const f of plan.fixtures) {
      const fy = f.y ?? H, hang = fy < H - 0.05;   // where its frame is
      const [hx, hz] = f.bulb ? [0.08, 0.08] : f.alongX ? [0.6, 0.3] : [0.3, 0.6];
      const F = { lx: f.x, lz: f.z, x: f.x, z: f.z, y: fy, hx, hz, state: f.state, i: (f.bulb ? BULB_I : LIGHT_I) * (0.9 + 0.2 * rnd()), hex: plan.tint ?? FIXCOL[(rnd() * FIXCOL.length) | 0],
        val: f.state === 'off' ? 0 : f.state === 'dying' ? 0.08 : 1, timer: 1 + 3 * rnd(), burst: 0, swap: 0, mold: 0, cells: [], panel: -1, ceiling: !hang };
      const works = f.state !== 'off' && np < MAX_PANELS;
      if (!works) { F.state = 'off'; F.val = 0; }
      if (f.bulb) {   // a bulb in a socket on the ceiling, in a wire cage or bare
        const by = fy - 0.12;
        pcyl(cableMat, { x: f.x, z: f.z }, 0.022, 0.07, 0, fy - 0.035, 0, null, 10);
        if (f.cage) {
          for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + 0.4; pcyl(pipeMat, { x: f.x + Math.cos(a) * 0.062, z: f.z + Math.sin(a) * 0.062 }, 0.0035, 0.15, 0, by + 0.005, 0, null, 4); }
          part(new THREE.TorusGeometry(0.063, 0.0035, 4, 14), pipeMat, { x: f.x, z: f.z }, 0, by - 0.07, 0, E(Math.PI / 2, 0, 0));
          part(new THREE.TorusGeometry(0.063, 0.0035, 4, 14), pipeMat, { x: f.x, z: f.z }, 0, by + 0.03, 0, E(Math.PI / 2, 0, 0));
        }
        const g = new THREE.SphereGeometry(0.048, 12, 8).toNonIndexed();
        g.translate(f.x, by, f.z);
        g.attributes.uv.array.fill(0.5);   // (the middle of the lens texture: an even glow)
        if (works) { F.panel = np++; lamp(g, F.panel, F.hex); } else push(g, fixtureOffMat);
      } else {
        if (hang) {   // a housing on two cables up into the dark
          boxB(fixtureFrameMat, f.x - hx - 0.02, fy, f.z - hz - 0.02, f.x + hx + 0.02, fy + 0.09, f.z + hz + 0.02);
          for (const s of [-1, 1]) {
            const cx = f.alongX ? f.x + s * (hx - 0.15) : f.x, cz = f.alongX ? f.z : f.z + s * (hz - 0.15);
            pcyl(pipeMat, { x: cx, z: cz }, 0.009, H - fy - 0.09, 0, (fy + 0.09 + H) / 2, 0, null, 5);   // (a steel cable, thick enough to catch the light)
          }
        } else boxB(fixtureFrameMat, f.x - hx - 0.02, H - 0.014, f.z - hz - 0.02, f.x + hx + 0.02, H - 0.001, f.z + hz + 0.02);
        const y0 = fy - 0.03, y1 = fy - 0.015;
        if (!works) boxB(fixtureOffMat, f.x - hx, y0, f.z - hz, f.x + hx, y1, f.z + hz);
        else {
          F.panel = np++;
          const g = new THREE.BoxGeometry(2 * hx, y1 - y0, 2 * hz).toNonIndexed();
          g.translate(f.x, (y0 + y1) / 2, f.z);
          lamp(g, F.panel, F.hex);
        }
      }
      fixtures.push(F);
    }
    room.fixtures = fixtures;
    // a point light stands in for each cluster of up to four nearby working fixtures
    const clusters = [], used = new Set();
    for (const f of fixtures) {
      if (f.state === 'off' || used.has(f)) continue;
      const mem = fixtures.filter(o => o.state !== 'off' && !used.has(o) && Math.abs(o.lx - f.lx) < 2.5 && Math.abs(o.lz - f.lz) < 2.5).slice(0, 4);
      mem.forEach(o => used.add(o));
      const col = new THREE.Color(0, 0, 0);
      for (const o of mem) col.add(new THREE.Color(o.hex));
      col.multiplyScalar(1 / mem.length);
      const avg = k => mem.reduce((s, o) => s + o[k], 0) / mem.length;
      clusters.push({ mem, x: avg('lx'), z: avg('lz'), y: avg('y') - (mem[0].hx < 0.1 ? 0.2 : 0.25), color: col, i: 0 });
    }
    room.clusters = clusters;
    yield* step('fixtures');

    // ---- ceiling details on a drop ceiling: return-air grilles, missing tiles, sprinkler heads
    if (plan.tiles) {
      for (const [x0, z0] of plan.vents) boxB(ventMat, x0 + 0.01, H - 0.008, z0 + 0.01, x0 + 0.59, H - 0.001, z0 + 0.59);
      for (const [x0, z0] of plan.gone) boxB(plenumMat, x0 + 0.01, H - 0.003, z0 + 0.01, x0 + 0.59, H - 0.001, z0 + 0.59);
      for (const r of plan.rects) for (let z = r.z0 + 1.5; z < r.z1 - 0.3; z += 3.6) for (let x = r.x0 + 1.5; x < r.x1 - 0.3; x += 3.6) {
        if (fixtures.some(f => Math.abs(f.lx - x) < f.hx + 0.1 && Math.abs(f.lz - z) < f.hz + 0.1) || plan.vents.some(([vx, vz]) => x > vx && x < vx + 0.6 && z > vz && z < vz + 0.6)) continue;
        if (!open(x, H - 0.05, z)) continue;
        pcyl(fixtureFrameMat, { x, z }, 0.011, 0.03, 0, H - 0.015, 0, null, 8);
        pcyl(fixtureFrameMat, { x, z }, 0.024, 0.003, 0, H - 0.032, 0, null, 10);
      }
    }
    // pipes and cables (along a wall or under the ceiling), with the thick ones in the fire's way; ducts with their seams
    for (const p of plan.pipes) {
      const len = p.a1 - p.a0, mid = (p.a0 + p.a1) / 2, mat = p.cable ? cableMat : pipeMat;
      const geo = new THREE.CylinderGeometry(p.r, p.r, len, p.cable ? 5 : 10);
      if (p.along === 'x') part(geo, mat, { x: mid, z: p.c }, 0, p.y, 0, E(0, 0, Math.PI / 2));
      else part(geo, mat, { x: p.c, z: mid }, 0, p.y, 0, E(Math.PI / 2, 0, 0));
      if (!p.cable) {
        for (let a = p.a0 + 0.6; a < p.a1 - 0.3; a += 1.8) {   // brackets up to the ceiling
          const bx = p.along === 'x' ? a : p.c, bz = p.along === 'x' ? p.c : a;
          boxB(paintedMetalMat, bx - 0.02, p.y + p.r, bz - 0.02, bx + 0.02, H, bz + 0.02);
        }
        if (p.r >= 0.03) tgt.colliders.push(p.along === 'x' ? { x0: p.a0, x1: p.a1, z0: p.c - p.r, z1: p.c + p.r, y0: p.y - p.r, h: p.y + p.r, nosurf: true }
          : { x0: p.c - p.r, x1: p.c + p.r, z0: p.a0, z1: p.a1, y0: p.y - p.r, h: p.y + p.r, nosurf: true });
      }
    }
    for (const d of plan.ducts) {
      boxB(ductMat, d.x0, d.y0, d.z0, d.x1, d.y1, d.z1);
      const alongX = d.x1 - d.x0 > d.z1 - d.z0;
      for (let a = (alongX ? d.x0 : d.z0) + 1.2; a < (alongX ? d.x1 : d.z1) - 0.2; a += 1.2) {
        if (alongX) boxB(ductMat, a - 0.015, d.y0 - 0.012, d.z0 - 0.012, a + 0.015, d.y1, d.z1 + 0.012);
        else boxB(ductMat, d.x0 - 0.012, d.y0 - 0.012, a - 0.015, d.x1 + 0.012, d.y1, a + 0.015);
      }
    }
    // furniture, and what's left lying about
    for (const p of plan.props) {
      const B = { x: p.x, z: p.z, ry: p.ry || 0 };
      if (p.type === 'desk') {
        pbox(deskMat, B, 1.5, 0.035, 0.76, 0, 0.742, 0);
        for (const s of [-1, 1]) pbox(deskMat, B, 0.03, 0.72, 0.72, s * 0.72, 0.36, 0);
        pbox(deskMat, B, 1.42, 0.42, 0.02, 0, 0.5, -0.34);
        pbox(deskMat, B, 0.42, 0.69, 0.68, 0.48, 0.36, 0.01);
        for (let k = 0; k < 3; k++) pbox(paintedMetalMat, B, 0.12, 0.018, 0.02, 0.48, 0.15 + k * 0.22, 0.36);
        pboxR(plasticMat, B, 0.22, 0.07, 0.2, -0.45, 0.795, 0.06, 0.02);       // the phone
        pboxR(plasticMat, B, 0.21, 0.045, 0.06, -0.45, 0.84, 0.0, 0.02);       // its handset
        pbox(paperMat, B, 0.3, 0.03, 0.22, 0.15, 0.775, 0.1, E(0, 0.2, 0));
      } else if (p.type === 'chair') {
        pcyl(paintedMetalMat, B, 0.024, 0.36, 0, 0.24, 0, null, 8);
        for (let k = 0; k < 5; k++) { const a = k * Math.PI * 2 / 5; pbox(paintedMetalMat, B, 0.3, 0.028, 0.04, Math.cos(a) * 0.14, 0.05, -Math.sin(a) * 0.14, E(0, a, 0)); }
        pboxR(fabricMat, B, 0.5, 0.08, 0.48, 0, 0.47, 0, 0.03);
        pboxR(fabricMat, B, 0.46, 0.5, 0.06, 0, 0.8, -0.23, 0.03, E(-0.12, 0, 0));
      } else if (p.type === 'cabinet') {
        pbox(paintedMetalMat, B, 0.46, 1.32, 0.62, 0, 0.66, 0);
        for (let k = 0; k < 4; k++) {
          pbox(paintedMetalMat, B, 0.41, 0.29, 0.012, 0, 0.18 + k * 0.32, 0.315);
          pbox(pipeMat, B, 0.12, 0.02, 0.025, 0, 0.27 + k * 0.32, 0.33);
        }
      } else if (p.type === 'paper') {
        pbox(paperMat, B, 0.21, 0.002, 0.297, 0, 0.002, 0);
      } else if (p.type === 'generator') {   // a small yellow generator in a tube frame, its exhaust up through the ceiling
        const B2 = { x: p.x, z: p.z, ry: Math.atan2(p.fx, p.fz) };   // (its front, local +z, faces into the room)
        pbox(engineMat, B2, 0.78, 0.42, 0.52, 0, 0.33, 0);                       // the engine block and alternator
        pboxR(engineMat, B2, 0.62, 0.16, 0.42, -0.04, 0.63, 0, 0.05);           // the fuel tank on top
        pcyl(cableMat, B2, 0.04, 0.03, -0.2, 0.725, 0.05, null, 12);            // its cap
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) pcyl(paintedMetalMat, B2, 0.016, 0.72, sx * 0.44, 0.36, sz * 0.3, null, 6);   // the frame
        for (const sz of [-1, 1]) pbox(paintedMetalMat, B2, 0.92, 0.03, 0.03, 0, 0.7, sz * 0.3);
        pbox(paintedMetalMat, B2, 0.22, 0.16, 0.02, 0.22, 0.42, 0.27);          // the control panel
        pcyl(pipeMat, B2, 0.028, H - 0.3, 0.3, (H + 0.3) / 2 + 0.15, -0.18, null, 8);   // the exhaust
        room.genAt = { x: p.x, z: p.z };   // (where the generator stands; room.gen is the build in progress)
        if (np < MAX_PANELS) {   // its lamp: green while it runs
          const g = new THREE.BoxGeometry(0.028, 0.028, 0.012).toNonIndexed();
          const c = Math.cos(B2.ry), s = Math.sin(B2.ry), lx = 0.17, lz = 0.283;
          g.translate(p.x + lx * c + lz * s, 0.45, p.z - lx * s + lz * c);
          room.genLamp = np++;
          lamp(g, room.genLamp, 0x6dff7a);
        }
      } else if (p.type === 'shelf') {   // steel shelving: four posts, four shelves, a few boxes
        const B2 = { x: p.x, z: p.z, ry: Math.atan2(p.fx, p.fz) };
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) pbox(paintedMetalMat, B2, 0.03, 1.8, 0.03, sx * 0.58, 0.9, sz * 0.2);
        for (let k = 0; k < 4; k++) pbox(paintedMetalMat, B2, 1.2, 0.02, 0.42, 0, 0.12 + k * 0.52, 0);
        for (let k = 0; k < 3; k++) if (rnd() < 0.7) pbox(deskMat, B2, 0.3 + rnd() * 0.2, 0.22, 0.3, (rnd() - 0.5) * 0.6, 0.24 + k * 0.52, 0);
      } else if (p.type === 'breaker') {   // a grey box with a conduit up into the ceiling
        const x0 = p.x, x1 = p.x + p.nx * 0.12, z0 = p.z, z1 = p.z + p.nz * 0.12;
        if (p.nx) { boxB(paintedMetalMat, x0, 1.05, p.z - 0.26, x1, 1.85, p.z + 0.26); boxB(cableMat, x1, 1.08, p.z - 0.004, x1 + p.nx * 0.004, 1.82, p.z + 0.004); }
        else { boxB(paintedMetalMat, p.x - 0.26, 1.05, z0, p.x + 0.26, 1.85, z1); boxB(cableMat, p.x - 0.004, 1.08, z1, p.x + 0.004, 1.82, z1 + p.nz * 0.004); }
        pcyl(pipeMat, { x: p.x + p.nx * 0.05, z: p.z + p.nz * 0.05 }, 0.016, H - 1.85, 0, (1.85 + H) / 2, 0, null, 8);
      }
    }
    yield* step('details');

    // ---- surfaces, and from them what's drawn: floor, ceiling, walls (and above 2.6 m in a tall room), partition tops,
    // and on wallpapered walls the rubber base along the foot
    setTarget(prev);
    const C = yield* buildSurfaces({ open, floors: [...plan.rects, ...strips].map(r => ({ x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1, y: 0 })), ceilings: plan.rects.map(r => ({ ...r, y: H })), boxes: tgt.colliders });
    prev = setTarget(tgt);
    room.C = C;
    const M = plan.mats, wallMat = MATS[M.wall], upperMat = M.upper ? MATS[M.upper] : wallMat;
    let nq = 0;
    for (const sf of C.surfaces) {
      if (++nq % 40 === 0) yield* step('quads');
      if (sf.n === 1) {
        surfaceQuad(C, sf, sf.s > 0 ? (sf.p < 0.01 ? MATS[M.floor] : MATS[M.top]) : sf.p >= H - 0.01 ? MATS[M.ceil] : wallMat);
        continue;
      }
      surfaceQuad(C, sf, sf.b0 >= CEIL_H - 0.05 ? upperMat : wallMat);
      if (sf.b0 > 0.01 || !plan.base) continue;
      // the base: a box 1.2 cm proud of the wall, 10 cm high, mapped onto the wall behind it
      const lo = [0, 0, 0], hi = [0, 0, 0];
      lo[sf.n] = Math.min(sf.p, sf.p + sf.s * 0.012); hi[sf.n] = Math.max(sf.p, sf.p + sf.s * 0.012);
      lo[sf.a] = sf.a0; hi[sf.a] = sf.a1; lo[1] = 0; hi[1] = 0.1;
      const g = new THREE.BoxGeometry(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]).toNonIndexed();
      g.translate((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
      const P = g.attributes.position, Mv = new Float32Array(P.count * 2);
      for (let i = 0; i < P.count; i++) { const q = [P.getX(i), P.getY(i), P.getZ(i)], uv = atlasUv(C, sf, q[sf.a], q[sf.b]); Mv[i * 2] = uv[0]; Mv[i * 2 + 1] = uv[1]; }
      g.setAttribute('aMoldUv', new THREE.BufferAttribute(Mv, 2));
      push(g, baseMat);
    }
    yield* step('quadsEnd');
    room.geos = [];
    for (const mat of [...tgt.buckets.keys()]) {   // (one material at a time)
      const geos = tgt.buckets.get(mat); tgt.buckets.delete(mat);
      const geo = mergeGeometries(geos);
      if (!geo.attributes.aMoldUv) projectMoldUv(C, geo);   // fixtures, pipes, furniture: the ceiling's mold where they touch it, or none
      geo.computeBoundingSphere();
      room.geos.push([mat, geo]);
      yield* step('merge');
    }

    // ---- AO and damp stains (top-down, 16 px per metre)
    setTarget(prev);
    yield* bakeAO(room, rnd);

    // ---- mold: the room's cells, its colonies, and the cells each ceiling light covers
    yield* initRoomMold(room);
    prev = setTarget(tgt);
    for (const f of fixtures) if (f.ceiling) f.cells = cellsIn(room, f.lx - f.hx - 0.05, f.lz - f.hz - 0.05, f.lx + f.hx + 0.05, f.lz + f.hz + 0.05, H, -1);
    room.colliders = tgt.colliders;
    room.area = plan.rects.reduce((s, r) => s + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
    // the materials' uniforms for this room (each placed copy adds its own id)
    room.u = { uEnvK: { value: 1 }, tAO: { value: room.aoTex }, uAOB: { value: room.aoB }, tMold: { value: room.moldTex }, uAOH: { value: new THREE.Vector2(Math.min(H, CEIL_H + 0.4), 0.55) },
      uNoiseOff: { value: new THREE.Vector3(rnd() * 40, 0, rnd() * 40) }, uPanelV: { value: Array.from({ length: MAX_PANELS / 4 }, () => new THREE.Vector4()) },
      uWater: { value: new THREE.Vector4(plan.water ?? 0, 0, 0, 0) } };
    updateRoomLights(room, 0);
    room.built = true;
  } finally { setTarget(prev); }
}

function* bakeAO(room, rnd) {
  const plan = room.plan, ppm = 16;
  const xs = plan.rects.flatMap(r => [r.x0, r.x1]), zs = plan.rects.flatMap(r => [r.z0, r.z1]);
  const B = { x0: Math.min(...xs) - 0.6, z0: Math.min(...zs) - 0.6, x1: Math.max(...xs) + 0.6, z1: Math.max(...zs) + 0.6 };
  const W = Math.round((B.x1 - B.x0) * ppm), D = Math.round((B.z1 - B.z0) * ppm);
  const open = new Float32Array(W * D);
  const fill = (x0, z0, x1, z1, v) => {
    for (let j = Math.max(0, Math.floor((z0 - B.z0) * ppm)); j < Math.min(D, Math.ceil((z1 - B.z0) * ppm)); j++)
      for (let i = Math.max(0, Math.floor((x0 - B.x0) * ppm)); i < Math.min(W, Math.ceil((x1 - B.x0) * ppm)); i++) open[j * W + i] = v;
  };
  for (const r of plan.rects) fill(r.x0, r.z0, r.x1, r.z1, 1);
  for (const d of plan.doors) fill(d.strip.x0, d.strip.z0, d.strip.x1, d.strip.z1, 1);
  for (const c of plan.boxes) if (c.y0 === 0) fill(c.x0, c.z0, c.x1, c.z1, 0);
  yield 'aoFill';
  const blur = (src, rad) => {
    const a = Float32Array.from(src), b = new Float32Array(W * D);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < D; y++) { let s = 0; for (let x = -rad; x <= rad; x++) s += a[y * W + clamp(x, 0, W - 1)]; for (let x = 0; x < W; x++) { b[y * W + x] = s / (2 * rad + 1); s += a[y * W + Math.min(x + rad + 1, W - 1)] - a[y * W + Math.max(x - rad, 0)]; } }
      for (let x = 0; x < W; x++) { let s = 0; for (let y = -rad; y <= rad; y++) s += b[clamp(y, 0, D - 1) * W + x]; for (let y = 0; y < D; y++) { a[y * W + x] = s / (2 * rad + 1); s += b[Math.min(y + rad + 1, D - 1) * W + x] - b[Math.max(y - rad, 0) * W + x]; } }
    }
    return a;
  };
  const ao = blur(open, 4);
  yield 'blur4';
  const wide = blur(open, 9);
  yield 'blur9';
  // damp: irregular dark patches, more of them in darker, deeper rooms
  const damp = new Float32Array(W * D), area = room.plan.rects.reduce((s, r) => s + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
  const nDamp = Math.round(area / 12 * (plan.light === 'on' ? 0.8 : 1.4));
  for (let k = 0; k < nDamp; k++) {
    const r = plan.rects[(rnd() * plan.rects.length) | 0];
    const cx = r.x0 + rnd() * (r.x1 - r.x0), cz = r.z0 + rnd() * (r.z1 - r.z0), rx = 0.4 + rnd() * 1.2, rz = rx * (0.5 + rnd() * 0.9), str = 0.3 + rnd() * 0.5;
    for (let j = Math.max(0, Math.floor((cz - rz - B.z0) * ppm)); j < Math.min(D, (cz + rz - B.z0) * ppm); j++)
      for (let i = Math.max(0, Math.floor((cx - rx - B.x0) * ppm)); i < Math.min(W, (cx + rx - B.x0) * ppm); i++) {
        const dx = (B.x0 + (i + 0.5) / ppm - cx) / rx, dz = (B.z0 + (j + 0.5) / ppm - cz) / rz;
        const e = 1 - (dx * dx + dz * dz) * (0.85 + 0.3 * Math.sin(Math.atan2(dz, dx) * 5 + k));
        if (e > 0) damp[j * W + i] = Math.max(damp[j * W + i], str * Math.min(1, e * 3));
      }
    if (k % 12 === 11) yield 'damp';
  }
  yield 'dampEnd';
  const data = new Uint8Array(W * D * 4);
  for (let i = 0; i < W * D; i++) {
    const v = (0.5 + 0.5 * Math.pow(clamp(ao[i], 0, 1), 0.8)) * (0.9 + 0.1 * clamp(wide[i], 0, 1)), d = damp[i];
    data[i * 4] = Math.round(255 * v * (1 - 0.32 * d));
    data[i * 4 + 1] = Math.round(255 * v * (1 - 0.36 * d));
    data[i * 4 + 2] = Math.round(255 * v * (1 - 0.42 * d));
    data[i * 4 + 3] = Math.round(255 * (0.35 + 0.65 * clamp(wide[i], 0, 1)));
  }
  const tex = new THREE.DataTexture(data, W, D);
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
  room.aoTex = tex;
  room.aoB = new THREE.Vector4(B.x0, B.z0, W / ppm, D / ppm);
}

// per frame, for each room that's placed: fluorescent flicker (the panels and the light they give). Mold growing over a
// light makes it stutter, then kills it. Also the room's bounce-light level, from how much of its light still works.
export function updateRoomLights(room, dt) {
  let work = 0;
  const powered = !room.power || room.power.on;
  for (const f of room.fixtures) {
    if (f.state === 'off') continue;
    if (!powered) f.val = Math.max(0, f.val - dt * (1.5 + 3 * Math.random()));   // the generator's dry: the lights die
    else if (f.mold > 0.55) f.val = Math.max(0, f.val - dt * 4);
    else {
      const sick = f.state === 'flicker' || f.state === 'dying' || f.mold > 0.12;
      if (!sick) f.val = 1;
      else {
        const dying = f.state === 'dying' || f.mold > 0.35, base = dying ? 0.08 : 1;
        if (f.burst > 0) {
          f.burst -= dt; f.swap -= dt;
          if (f.swap <= 0) {
            const on = Math.random() < (dying ? 0.4 : 0.6);
            f.val = on ? (dying ? 0.2 + Math.random() * 0.3 : 0.75 + Math.random() * 0.25) : 0.03 + Math.random() * 0.08;
            f.swap = 0.04 + Math.random() * 0.1;
          }
          if (f.burst <= 0) { f.val = base; f.timer = (dying ? 4 : 3) + Math.random() * 6; }
        } else if ((f.timer -= dt) <= 0) { f.burst = 0.15 + Math.random() * 0.6; f.swap = 0; }
        else f.val = f.burst > 0 ? f.val : base;
      }
    }
    room.u.uPanelV.value[f.panel >> 2].setComponent(f.panel & 3, Math.max(f.val, f.mold > 0.55 ? 0.004 : 0.012));
    work += f.i * f.val;
  }
  if (room.genLamp >= 0 && room.genLamp !== undefined) {   // the generator's lamp: steady while it runs, blinking when it's low
    const pw = room.power, v = !pw?.on ? 0 : pw.fuel < 20 ? (Math.sin(performance.now() / 160) > 0 ? 0.6 : 0.02) : 0.6;
    room.u.uPanelV.value[room.genLamp >> 2].setComponent(room.genLamp & 3, v);
  }
  for (const cl of room.clusters) cl.i = cl.mem.reduce((s, f) => s + (f.state === 'off' ? 0 : f.i * f.val), 0);
  // (slowly: a flicker doesn't pump the whole room's bounce light)
  const k = clamp(0.04 + 0.96 * work / Math.max(room.area, 1) / DENSITY_REF, 0.04, 1.1);
  room.u.uEnvK.value += (k - room.u.uEnvK.value) * (dt > 0 ? 1 - Math.exp(-dt * 2) : 1);
}
