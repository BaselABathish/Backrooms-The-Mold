// Geometry builders. Static geometry is collected per material and merged into one mesh each (few draw calls).
// Also tracks collision rectangles and prop footprints (used for collision and the baked floor AO).
// A room is built into its own target (setTarget): its geometry buckets and its colliders, in the room's own
// coordinates. `colliders` (exported) is the world's: what the player, the fire and aiming collide with, kept by
// world/level.js from the rooms placed around you.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { uvScale, PROP_MATS } from './materials.js';

// collision rectangles (x/z, with a height for aiming rays) and prop footprints (which also darken the baked floor AO)
export const colliders = [], footprints = [];
let target = { buckets: new Map(), colliders };
// build into { buckets: Map, colliders: [] } until the previous target (returned) is set back
export function setTarget(t) { const prev = target; target = t; return prev; }
export function push(geo, mat) { const g = geo.index ? geo.toNonIndexed() : geo; const b = target.buckets; if (!b.has(mat)) b.set(mat, []); b.get(mat).push(g); }

function worldUV(geo, [s, ox, oz, sv = s]) {
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

// axis-aligned box from two corners
export function boxB(mat, x0, y0, z0, x1, y1, z1) {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  if (uvScale.has(mat)) worldUV(g, uvScale.get(mat));
  push(g, mat);
}

// a part of a prop: local position (lx, ly, lz) and optional local rotation, relative to base B = { x, z, ry }
const _Y = new THREE.Vector3(0, 1, 0), ONE = new THREE.Vector3(1, 1, 1);
export function part(geo, mat, B, lx, ly, lz, e) {
  const ry = B.ry || 0;
  const q = new THREE.Quaternion().setFromAxisAngle(_Y, ry);
  if (e) q.multiply(new THREE.Quaternion().setFromEuler(e));
  const p = new THREE.Vector3(lx, ly, lz).applyAxisAngle(_Y, ry);
  p.x += B.x; p.z += B.z;
  geo.applyMatrix4(new THREE.Matrix4().compose(p, q, ONE));
  if (uvScale.has(mat)) worldUV(geo, uvScale.get(mat));
  push(geo, mat);
}
export const pbox = (mat, B, w, h, d, lx, ly, lz, e) => part(new THREE.BoxGeometry(w, h, d), mat, B, lx, ly, lz, e);
export const pboxR = (mat, B, w, h, d, lx, ly, lz, r = 0.02, e) => part(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3)), mat, B, lx, ly, lz, e);
export const pcyl = (mat, B, r, h, lx, ly, lz, e, seg = 10) => part(new THREE.CylinderGeometry(r, r, h, seg), mat, B, lx, ly, lz, e);
export const E = (x, y, z, o = 'XYZ') => new THREE.Euler(x, y, z, o);

// Walls are described by axis ('x' = the wall plane is x = c, running along z), the interior face coordinate c,
// and n = +1/-1, the direction from the wall into the room.
export const faceRy = (axis, n) => axis === 'x' ? n * Math.PI / 2 : (n > 0 ? 0 : Math.PI);
// a box mounted on a wall: centred at `along`/`y`, protruding `d` from the wall face (plus `off`)
export function wallBox(axis, c, n, along, y, w, h, d, mat, off = 0) {
  const ry = faceRy(axis, n), k = c + n * (off + d / 2);
  pbox(mat, axis === 'x' ? { x: k, z: along, ry } : { x: along, z: k, ry }, w, h, d, 0, y, 0);
}
export function wallPlane(axis, c, n, along, y, w, h, off, mat, uvFn) {
  const g = new THREE.PlaneGeometry(w, h);
  if (uvFn) uvFn(g.attributes.uv);
  const ry = faceRy(axis, n), k = c + n * off;
  part(g, mat, axis === 'x' ? { x: k, z: along, ry } : { x: along, z: k, ry }, 0, y, 0);
}
// moving obstacles (characters): { x, z, r }, updated every frame by whoever owns them
export const actorCircles = [];
// y0 > 0: something overhead (a header over a doorway): it stops rays, fire and smoke, but not the player
export function solidRect(x0, z0, x1, z1, height = 1.1, y0 = 0) { target.colliders.push({ x0: Math.min(x0, x1), z0: Math.min(z0, z1), x1: Math.max(x0, x1), z1: Math.max(z0, z1), h: height, y0 }); }

// distance along a ray to the first wall, prop box, floor or ceiling (for aiming); maxD if nothing is hit
export function raycastWorld(o, d, ceiling, maxD = 15) {
  let best = maxD;
  if (d.y < -1e-4) best = Math.min(best, -o.y / d.y);
  if (d.y > 1e-4) best = Math.min(best, (ceiling - o.y) / d.y);
  for (const b of colliders) {
    let t0 = 0, t1 = best;
    for (const [lo, hi, oo, dd] of [[b.x0, b.x1, o.x, d.x], [b.y0, b.h, o.y, d.y], [b.z0, b.z1, o.z, d.z]]) {
      if (Math.abs(dd) < 1e-6) { if (oo < lo || oo > hi) { t0 = Infinity; break; } continue; }
      let a = (lo - oo) / dd, c = (hi - oo) / dd;
      if (a > c) [a, c] = [c, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, c);
      if (t0 > t1) break;
    }
    if (t0 <= t1 && t0 > 0.05) best = Math.min(best, t0);
  }
  return best;
}
export function propFoot(B, hw, hd, dark = 0.6, collide = true) {
  footprints.push({ x: B.x, z: B.z, ry: B.ry || 0, hw, hd, dark });
  if (collide) {
    const c = Math.cos(B.ry || 0), s = Math.sin(B.ry || 0);
    const ex = Math.abs(hw * c) + Math.abs(hd * s), ez = Math.abs(hw * s) + Math.abs(hd * c);
    solidRect(B.x - ex, B.z - ez, B.x + ex, B.z + ez);
  }
}

// merge everything collected so far into one geometry per material: [[material, geometry], ...] (or, given a parent,
// meshes added to it)
export function mergeBuckets() {
  const out = [];
  for (const [mat, geos] of target.buckets) out.push([mat, mergeGeometries(geos)]);
  target.buckets.clear();
  return out;
}
export function mergeInto(parent) {
  for (const [mat, geo] of mergeBuckets()) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = mat.isMeshStandardMaterial === true;
    mesh.castShadow = PROP_MATS.has(mat);
    mesh.matrixAutoUpdate = false;
    parent.add(mesh);
  }
}
