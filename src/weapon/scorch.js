// Soot left where burning fuel lands: decals on walls, floor and ceiling. A fresh mark glows for a second or two with
// embers: dull red-orange specks, not a glow over the whole mark (that read as a bright cut-out).
// Marks belong to the room they're in (kept in its own coordinates, so they stay on its walls wherever the room is
// placed): each room keeps up to MAXR, reusing the oldest, and each placed copy of the room draws them with one
// instanced mesh that shares the room's instance data (scorchMesh).
import * as THREE from 'three';
import { lit } from '../world/materials.js';
import { sootTex } from '../world/textures.js';
import { world } from '../world/world.js';

const MAXR = 160;
// the instance colour carries (soot opacity, ember glow, unused), not a tint
const sootShader = sh => {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <color_fragment>', '')
    .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_INSTANCING_COLOR
\tdiffuseColor.a *= vColor.r;
#endif`)
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
#ifdef USE_INSTANCING_COLOR
\tfloat speck = smoothstep(0.62, 0.92, texture2D(map, fract(vMapUv * 4.3 + 0.37)).a) * smoothstep(0.5, 0.95, texture2D(map, fract(vMapUv * 2.1 + 0.71)).a);
\ttotalEmissiveRadiance += vec3(1.0, 0.2, 0.02) * vColor.g * speck * sampledDiffuseColor.a * 2.5;
#endif`);
};
sootShader.key = 'soot';
// the base material (each placed room draws its marks with its own copy: materials.js litFor)
export const sootMat = lit({ color: 0x0b0806, map: sootTex, transparent: true, depthWrite: false, roughness: 1,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }, 0, sootShader);
const plane = new THREE.PlaneGeometry(1, 1);

const glowing = new Set();   // rooms with embers still cooling
function roomScorch(R) {
  return R.scorch ??= { marks: [], next: 0, meshes: new Set(),
    matrix: new THREE.InstancedBufferAttribute(new Float32Array(MAXR * 16), 16).setUsage(THREE.DynamicDrawUsage),
    color: new THREE.InstancedBufferAttribute(new Float32Array(MAXR * 3), 3).setUsage(THREE.DynamicDrawUsage) };
}
// the mesh that draws room R's marks in one placed copy of it (material: that copy's soot material)
export function scorchMesh(R, mat) {
  const S = roomScorch(R), m = new THREE.InstancedMesh(plane, mat, MAXR);
  m.instanceMatrix = S.matrix; m.instanceColor = S.color; m.count = S.marks.length;
  m.frustumCulled = false; m.receiveShadow = true; m.renderOrder = 1;
  S.meshes.add(m);
  return m;
}
export function dropScorchMesh(R, m) { R.scorch?.meshes.delete(m); }

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _n = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1), _up = new THREE.Vector3(), _qi = new THREE.Quaternion();
function place(S, i) {
  const m = S.marks[i];
  _n.set(m.nx, m.ny, m.nz);
  _q.setFromUnitVectors(Z, _n);
  if (m.stretch > 1 && Math.abs(m.ny) < 0.5) {   // turn the plane so its local y is the world's up
    _up.set(0, 1, 0).applyQuaternion(_qi.copy(_q).invert());
    _q.multiply(_q2.setFromAxisAngle(Z, Math.atan2(-_up.x, _up.y) + m.rot));
  } else _q.multiply(_q2.setFromAxisAngle(Z, m.rot));
  _p.set(m.x + m.nx * 0.002, m.y + m.ny * 0.002, m.z + m.nz * 0.002);
  _m.compose(_p, _q, _s.set(m.size, m.size * (m.stretch || 1), 1));
  _m.toArray(S.matrix.array, i * 16);
  S.matrix.needsUpdate = true;
}

// burning fuel landed here (world coordinates; amount ~0.02-0.2 per drop): darken the nearest mark on this surface, or
// start a new one. stretch > 1: a tall streak (soot climbing a wall above a fire), kept upright
export function deposit(wx, wy, wz, wnx, wny, wnz, amount, stretch = 1) {
  const L = world.toRoom?.(wx, wy, wz, wnx, wny, wnz);
  if (!L) return;
  const { R, x, y, z, nx, ny, nz } = L, S = roomScorch(R);
  let best = -1, bd = 0.1 * 0.1;
  for (let i = 0; i < S.marks.length; i++) {
    const m = S.marks[i];
    if (m.nx * nx + m.ny * ny + m.nz * nz < 0.9 || m.stretch !== stretch) continue;
    const d2 = (m.x - x) ** 2 + (m.y - y) ** 2 + (m.z - z) ** 2;
    if (d2 < bd) { bd = d2; best = i; }
  }
  glowing.add(R);
  if (best >= 0) {
    const m = S.marks[best];
    m.soot = Math.min(0.97, m.soot + amount * 0.6);
    m.ember = Math.min(1, m.ember + amount * 1.5);
    if (m.size < 0.9) { m.size += amount * 0.08; place(S, best); }
    return;
  }
  const i = S.marks.length < MAXR ? S.marks.length : S.next;
  S.next = (i + 1) % MAXR;
  const upright = stretch > 1 && Math.abs(ny) < 0.5;
  S.marks[i] = { x, y, z, nx, ny, nz, stretch, size: (0.26 + Math.random() * 0.22) * (upright ? 1.3 : 1), soot: Math.min(0.97, amount * 0.9), ember: upright ? 0 : amount * 2,
    rot: upright ? (Math.random() - 0.5) * 0.3 : Math.random() * 6.283 };
  for (const mesh of S.meshes) mesh.count = S.marks.length;
  place(S, i);
}

// per frame: embers cool down; marks only ever get darker
export function updateScorch(dt) {
  const k = Math.exp(-dt / 1.2);
  for (const R of glowing) {
    const S = R.scorch, c = S.color.array;
    let dirty = false, hot = false;
    for (let i = 0; i < S.marks.length; i++) {
      const m = S.marks[i];
      m.ember *= k;
      if (m.ember > 0.0005) hot = true;
      if (c[i * 3] !== m.soot || c[i * 3 + 1] > 0.0005) { c[i * 3] = m.soot; c[i * 3 + 1] = m.ember; dirty = true; }
    }
    if (dirty) S.color.needsUpdate = true;
    if (!hot) glowing.delete(R);
  }
}
export const scorchRooms = glowing;
