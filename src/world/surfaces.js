// The surfaces mold can grow on, per room: every floor, ceiling and wall face that faces the room's air, cut into
// square cells of about CELL metres, in the room's own coordinates. Each surface gets a rectangle in the room's mold
// texture (one texel per cell, with a one-texel border copied from its edge so filtering never reads a neighbour), and
// the room's walls, floors and ceilings are built from these surfaces, one quad per visible face, carrying their texture
// coordinates (attribute aMoldUv). The cells also know their neighbours, across the corners where surfaces meet (floor to
// wall, wall round a corner, wall to ceiling), so mold spreads over the room as one skin. (Across doorways, to the next
// room, game/mold.js links them.)
import * as THREE from 'three';
import { push } from './builder.js';
import { uvScale } from './materials.js';

export const CELL = 0.12;
// a surface: n (the normal's axis 0/1/2), s (its sign), p (the plane's coordinate), a/b (the two in-plane axes) with
// ranges a0..a1, b0..b1; nu x nv cells of cu x cv metres; its texture rectangle starts at (tx, ty) (the border's corner)
const toWorld = (s, A, B, off = 0) => { const v = [0, 0, 0]; v[s.n] = s.p + s.s * off; v[s.a] = A; v[s.b] = B; return v; };

// A generator (it yields between its phases, so a room can be built over several frames); its return value is the
// room's surface context C: { surfaces, n, px, py, pz, nx, ny, nz, surf, tex, nb0, nb, W, H, border } (the cells: centre,
// normal, which surface, which texel, and the neighbour lists, CSR: nb[nb0[i]..nb0[i+1]]).
// open(x, y, z): is this point in the room's air? floors/ceilings: [{ x0, z0, x1, z1, y }]; boxes: the room's colliders.
// The room is laid out on a 0.05 m grid, so walls are scanned in 5 cm steps.
export function* buildSurfaces({ open, floors, ceilings, boxes, step = 0.05 }) {
  const surfaces = [];
  const add = (n, s, p, a, a0, a1, b, b0, b1) => {
    const la = a1 - a0, lb = b1 - b0;
    if (la < 0.05 || lb < 0.05) return;
    const nu = Math.max(1, Math.round(la / CELL)), nv = Math.max(1, Math.round(lb / CELL));
    surfaces.push({ n, s, p, a, b, a0, a1, b0, b1, nu, nv, cu: la / nu, cv: lb / nv, tx: 0, ty: 0, idx: null });
  };
  for (const f of floors) add(1, 1, f.y, 0, f.x0, f.x1, 2, f.z0, f.z1);
  for (const f of ceilings) add(1, -1, f.y, 0, f.x0, f.x1, 2, f.z0, f.z1);
  // walls: each face of each box, cut down to the stretches that face open air (boxes marked nosurf are only colliders:
  // a desk, a pipe, a duct draw themselves)
  for (const c of boxes) {
    if (c.nosurf) continue;
    const faces = [[0, -1, c.x0, 2, c.z0, c.z1], [0, 1, c.x1, 2, c.z0, c.z1], [2, -1, c.z0, 0, c.x0, c.x1], [2, 1, c.z1, 0, c.x0, c.x1]];
    for (const [n, s, p, a, a0, a1] of faces) {
      let start = null;
      const steps = Math.round((a1 - a0) / step);
      for (let k = 0; k <= steps; k++) {
        const A = a0 + (k + 0.5) * step;
        const inside = k < steps && [0.25, 0.5, 0.75].some(f => { const q = toWorld({ n, s, p, a, b: 1 }, A, c.y0 + (c.h - c.y0) * f, 0.03); return open(q[0], q[1], q[2]); });
        if (inside && start === null) start = a0 + k * step;
        if (!inside && start !== null) { add(n, s, p, a, start, Math.min(a0 + k * step, a1), 1, c.y0, c.h); start = null; }
      }
    }
    if (c.y0 > 0.01) add(1, -1, c.y0, 0, c.x0, c.x1, 2, c.z0, c.z1);   // a header's underside
    if (open((c.x0 + c.x1) / 2, c.h + 0.03, (c.z0 + c.z1) / 2)) add(1, 1, c.h, 0, c.x0, c.x1, 2, c.z0, c.z1);   // the top of a low partition
    yield 'scan';
  }
  // cells: only where the surface faces open air (a floor under a pillar has none)
  const cells = [];
  let work = 0;
  for (const s of surfaces) {
    s.idx = new Int32Array(s.nu * s.nv).fill(-1);
    for (let j = 0; j < s.nv; j++) {
      for (let i = 0; i < s.nu; i++) {
        const q = toWorld(s, s.a0 + (i + 0.5) * s.cu, s.b0 + (j + 0.5) * s.cv, 0.03);
        if (!open(q[0], q[1], q[2])) continue;
        s.idx[j * s.nu + i] = cells.length / 3;
        cells.push(s, i, j);
      }
      if ((work += s.nu) > 3000) { work = 0; yield 'cells'; }
    }
  }
  // the texture: shelf-packed, tallest first
  let W = 256;
  for (const s of surfaces) while (s.nu + 2 > W) W *= 2;
  const order = [...surfaces].sort((p, q) => (q.nv - p.nv) || (q.nu - p.nu));
  let x = 0, y = 0, rowH = 0;
  for (const s of order) {
    const w = s.nu + 2, h = s.nv + 2;
    if (x + w > W) { x = 0; y += rowH; rowH = 0; }
    s.tx = x; s.ty = y; x += w; rowH = Math.max(rowH, h);
  }
  const H = Math.ceil((y + rowH) / 4) * 4;
  // cell arrays
  const n = cells.length / 3;
  const C = { surfaces, n, W, H, px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n), nx: new Int8Array(n), ny: new Int8Array(n), nz: new Int8Array(n),
    surf: new Uint16Array(n), tex: new Int32Array(n), nb0: null, nb: null, border: null };
  const sIndex = new Map(surfaces.map((s, i) => [s, i]));
  for (let k = 0; k < n; k++) {
    const s = cells[k * 3], i = cells[k * 3 + 1], j = cells[k * 3 + 2];
    const q = toWorld(s, s.a0 + (i + 0.5) * s.cu, s.b0 + (j + 0.5) * s.cv);
    C.px[k] = q[0]; C.py[k] = q[1]; C.pz[k] = q[2];
    if (s.n === 0) C.nx[k] = s.s; else if (s.n === 1) C.ny[k] = s.s; else C.nz[k] = s.s;
    C.surf[k] = sIndex.get(s);
    C.tex[k] = (s.ty + 1 + j) * W + (s.tx + 1 + i);
  }
  yield 'cellArrays';
  // borders: each border texel copies the nearest cell of its surface
  const border = [];
  for (const s of surfaces) {
    for (let j = -1; j <= s.nv; j++) for (let i = -1; i <= s.nu; i++) {
      const ci = Math.min(Math.max(i, 0), s.nu - 1), cj = Math.min(Math.max(j, 0), s.nv - 1), inner = i >= 0 && j >= 0 && i < s.nu && j < s.nv;
      const k = s.idx[cj * s.nu + ci];
      if (k < 0 || (inner && s.idx[j * s.nu + i] >= 0)) continue;
      border.push((s.ty + 1 + j) * W + (s.tx + 1 + i), k);
    }
  }
  C.border = Int32Array.from(border);
  yield 'atlas';
  // neighbours. Within a surface: the 8 around a cell, by index. Across surfaces: only cells at a surface's edge (or next
  // to a hole in it) can have any, found by distance (within 1.5 cells) with a spatial hash of those edge cells alone.
  const cnt = new Int32Array(n), edge = new Uint8Array(n);
  for (const s of surfaces) {
    for (let j = 0; j < s.nv; j++) for (let i = 0; i < s.nu; i++) {
      const k = s.idx[j * s.nu + i];
      if (k < 0) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= s.nu || jj >= s.nv || s.idx[jj * s.nu + ii] < 0) edge[k] = 1; else cnt[k]++;
      }
    }
    if ((work += s.nu * s.nv) > 20000) { work = 0; yield 'nbCount'; }
  }
  const R = CELL * 1.5, inv = 1 / R, hash = new Map();
  const key = (i, j, k) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  for (let k = 0; k < n; k++) if (edge[k]) {
    const h = key(Math.floor(C.px[k] * inv), Math.floor(C.py[k] * inv), Math.floor(C.pz[k] * inv));
    if (!hash.has(h)) hash.set(h, []);
    hash.get(h).push(k);
  }
  const cross = [];
  yield 'nbEdges';
  for (let k = 0; k < n; k++) {
    if (!edge[k]) continue;
    if ((++work & 2047) === 0) yield 'nbCross';
    const bi = Math.floor(C.px[k] * inv), bj = Math.floor(C.py[k] * inv), bk = Math.floor(C.pz[k] * inv);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const list = hash.get(key(bi + di, bj + dj, bk + dk));
      if (!list) continue;
      for (const o of list) {
        if (o === k || C.surf[o] === C.surf[k]) continue;
        const dx = C.px[o] - C.px[k], dy = C.py[o] - C.py[k], dz = C.pz[o] - C.pz[k];
        if (dx * dx + dy * dy + dz * dz > R * R) continue;
        // a cell never connects to one facing the opposite way (the two sides of something thin)
        if (C.nx[o] * C.nx[k] + C.ny[o] * C.ny[k] + C.nz[o] * C.nz[k] < -0.5) continue;
        cross.push(k, o); cnt[k]++;
      }
    }
  }
  const nb0 = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) nb0[k + 1] = nb0[k] + cnt[k];
  const nb = new Int32Array(nb0[n]), fill = nb0.slice(0, n);
  yield 'nbAlloc';
  for (const s of surfaces) {
    for (let j = 0; j < s.nv; j++) for (let i = 0; i < s.nu; i++) {
      const k = s.idx[j * s.nu + i];
      if (k < 0) continue;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= s.nu || jj >= s.nv) continue;
        const o = s.idx[jj * s.nu + ii];
        if (o >= 0) nb[fill[k]++] = o;
      }
    }
    if ((work += s.nu * s.nv) > 20000) { work = 0; yield 'nbFill'; }
  }
  for (let t = 0; t < cross.length; t += 2) nb[fill[cross[t]]++] = cross[t + 1];
  C.nb0 = nb0; C.nb = nb;
  return C;
}

// the texture coordinates of a point on surface s (extrapolated outside its rectangle: such parts are hidden)
export function atlasUv(C, s, A, B) {
  return [(s.tx + 1 + (A - s.a0) / s.cu) / C.W, (s.ty + 1 + (B - s.b0) / s.cv) / C.H];
}

// A quad covering surface s (in material mat), with world UVs like the rest of the level and the mold coordinates.
export function surfaceQuad(C, s, mat, { off = 0, b0 = s.b0, b1 = s.b1 } = {}) {
  const corners = [[s.a0, b0], [s.a1, b0], [s.a1, b1], [s.a0, b1]];
  const pos = [], muv = [], nrm = [0, 0, 0];
  nrm[s.n] = s.s;
  for (const [A, B] of corners) { pos.push(...toWorld(s, A, B, off)); muv.push(...atlasUv(C, s, A, B)); }
  // two triangles, wound to face along the normal
  const P = i => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const e1 = P(1).sub(P(0)), e2 = P(2).sub(P(0)), fn = e1.cross(e2);
  const flip = fn.dot(new THREE.Vector3(...nrm)) < 0;
  const tri = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
  const g = new THREE.BufferGeometry();
  const P3 = [], M2 = [], N3 = [];
  for (const t of tri) { P3.push(pos[t * 3], pos[t * 3 + 1], pos[t * 3 + 2]); M2.push(muv[t * 2], muv[t * 2 + 1]); N3.push(...nrm); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(P3, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N3, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  g.setAttribute('aMoldUv', new THREE.Float32BufferAttribute(M2, 2));
  worldUv(g, mat);
  push(g, mat);
}
// the same room-space texture mapping as builder.js's boxes
function worldUv(geo, mat) {
  const cfg = uvScale.get(mat.userData.base || mat);
  if (!cfg) return;
  const [s, ox, oz, sv = s] = cfg;
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i) + ox; v = p.getZ(i) + oz; }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i) * sv / s; }
    else { u = p.getX(i); v = p.getY(i) * sv / s; }
    uv.setXY(i, u * s, v * s);
  }
}

// After merging: give a geometry built without mold coordinates (light fixtures, vents on the ceiling) those of the
// ceiling each vertex sits on or just below (tol: how far off it may be), or (-1, -1) where there is none.
export function projectMoldUv(C, geo, tol = 0.05) {
  const p = geo.attributes.position, out = new Float32Array(p.count * 2).fill(-1);
  const ceilings = C.surfaces.filter(s => s.n === 1 && s.s < 0);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    for (const s of ceilings) {
      if (y < s.p - tol || y > s.p + 0.01 || x < s.a0 || x > s.a1 || z < s.b0 || z > s.b1) continue;
      const [u, v] = atlasUv(C, s, x, z); out[i * 2] = u; out[i * 2 + 1] = v; break;
    }
  }
  geo.setAttribute('aMoldUv', new THREE.BufferAttribute(out, 2));
}
