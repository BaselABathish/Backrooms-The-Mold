// Materials. Every lit material is a MeshStandardMaterial patched with:
//  - rooms: point lights (which cast no shadows) light only their own room, and the room beyond one doorway of it, through
//    that doorway (world/level.js decides which, per light: uLR, uLD). Each placed room has its own set of materials
//    (roomMaterials) carrying its id, its bounce-light level, its AO map, its mold texture and a noise offset; materials
//    outside the rooms (the flamethrower, soot) belong to the room you're in (shared.uRoomCur, uEnvKCur).
//  - bounce light per room: the captured environment, scaled by how lit the room is (a dark room gets almost none)
//  - range skip: out-of-range point lights skip the BRDF (most of the per-pixel lighting cost)
//  - point lights soften close up: a fire's light a few tens of centimetres from a wall would otherwise blow it out to
//    a white patch (and a troffer doesn't light the ceiling it is set into)
//  - AO: a baked top-down map per room for floor/ceiling (also carrying damp stains), a height gradient for walls
//  - spot lights (the weapon light) soften close up: a lens and reflector a few centimetres wide aren't a point, and the
//    plain inverse-square law would blow a wall right in front of the light out to white
//  - mold (materials made with { mold: true }): the colony read from the mold texture (game/mold.js) at the surface's
//    atlas coordinates (attribute aMoldUv, world/surfaces.js), with its fine detail made here from 3D noise
import * as THREE from 'three';
import * as T from './textures.js';
import { noiseUniform } from '../weapon/noise3d.js';

// uniforms shared by every lit material (filled in by world/level.js)
//   uAOH: wall AO, (ceiling height, fade distance)
//   uLR[i], uLD[i]: point light i (in three.js's order): (its room, the room beyond its doorway) and that doorway, a
//     rectangle in a wall plane: (plane coordinate, from, to along it, height; height > 0: a plane z = c, < 0: x = c).
//     Room -1: a light that lights everything.
//   uRoomCur, uEnvKCur: the room you're in and its bounce-light level, for materials that aren't part of a room
//   tNoise: 3D noise (weapon/noise3d.js), for the mold's detail
//   (uPortal, uEnvZ: the old single portal and bounce zone, kept only for the smoke shader: set to 'none')
export const MAX_POINT = 16;
export const shared = { uAOH: { value: new THREE.Vector2(2.6, 0.55) },
  uLR: { value: Array.from({ length: MAX_POINT }, () => new THREE.Vector4(-1, -1, 0, 0)) },
  uLD: { value: Array.from({ length: MAX_POINT }, () => new THREE.Vector4(0, 0, 0, 1)) },
  uRoomCur: { value: -1 }, uEnvKCur: { value: 1 },
  // water: the time, and where you're wading (x, z, how hard: the rings round your feet)
  uTimeW: { value: 0 }, uRipple: { value: new THREE.Vector4(0, 0, 0, 0) },
  uPortal: { value: new THREE.Vector4(-1e4, 0, 0, 0) }, uEnvZ: { value: new THREE.Vector4(-1e4, 1, 1, 1) },
  tNoise: noiseUniform };
// what a material outside the rooms uses for the room uniforms
const noRoom = { uRoomId: shared.uRoomCur, uEnvK: shared.uEnvKCur, tAO: { value: T.blackTex }, uAOB: { value: new THREE.Vector4(-1e4, -1e4, 2e4, 2e4) },
  tMold: { value: T.blackTex }, uNoiseOff: { value: new THREE.Vector3() }, uWater: { value: new THREE.Vector4(0, 0, 0, 0) } };
// (for shaders that aren't lit materials: smoke)
export const PORTAL_GLSL = `
uniform vec4 uPortal, uEnvZ;
float portalVis(vec3 L, vec3 P){
  float sL = L.z - uPortal.x, sP = P.z - uPortal.x;
  if (sL * sP >= 0.0) return 1.0;
  float t = sL / (sL - sP);
  vec2 h = mix(L.xy, P.xy, t);
  return smoothstep(uPortal.y - 0.08, uPortal.y + 0.08, h.x) * (1.0 - smoothstep(uPortal.z - 0.08, uPortal.z + 0.08, h.x)) * (1.0 - smoothstep(uPortal.w - 0.08, uPortal.w + 0.08, h.y));
}
float envZone(vec3 P){ return P.z > uEnvZ.x ? 1.0 : mix(uEnvZ.w, uEnvZ.z, exp(-(uEnvZ.x - P.z) / uEnvZ.y)); }
`;

// which rooms a point light reaches: its own, and the one beyond its doorway, through the doorway
const ROOM_GLSL = `
uniform float uRoomId, uEnvK;
uniform vec4 uLR[ ${MAX_POINT} ], uLD[ ${MAX_POINT} ];
float roomVis(vec4 R, vec4 D, vec3 L, vec3 P){
  if (R.x < -0.5 || uRoomId < -0.5 || abs(R.x - uRoomId) < 0.5) return 1.0;
  if (abs(R.y - uRoomId) > 0.5) return 0.0;
  bool zp = D.w > 0.0;
  float sL = (zp ? L.z : L.x) - D.x, sP = (zp ? P.z : P.x) - D.x;
  if (sL * sP >= 0.0) return 0.0;
  vec3 X = mix(L, P, sL / (sL - sP));
  float a = zp ? X.x : X.z, h = abs(D.w);
  return smoothstep(D.y - 0.08, D.y + 0.08, a) * (1.0 - smoothstep(D.z - 0.08, D.z + 0.08, a)) * (1.0 - smoothstep(h - 0.08, h + 0.08, X.y));
}
`;
const LIGHTS_CHUNK = THREE.ShaderChunk.lights_fragment_begin.replace(
  /(getPointLightInfo\(\s*pointLight,\s*\w+,\s*directLight\s*\);)([\s\S]*?)(RE_Direct\()/,
  (m, info, mid, call) => info + '\n\t\tdirectLight.color *= roomVis( uLR[ i ], uLD[ i ], ( pointLight.position - viewMatrix[ 3 ].xyz ) * mat3( viewMatrix ), vWPos );'
    + '\n\t\t{ vec3 pl = pointLight.position - geometryPosition; float pd2 = dot( pl, pl ); directLight.color *= pd2 / ( pd2 + 0.3 ); }' + mid + 'if ( directLight.color.r + directLight.color.g + directLight.color.b > 1e-4 ) ' + call);
if (LIGHTS_CHUNK === THREE.ShaderChunk.lights_fragment_begin) console.warn('point light range-skip patch not applied (three.js shader chunks changed?)');
const SPOT_INFO = 'getSpotLightInfo( spotLight, geometryPosition, directLight );';
const LIGHTS_CHUNK2 = LIGHTS_CHUNK.replace(SPOT_INFO, SPOT_INFO +
  '\n\t\t{ vec3 sl = spotLight.position - geometryPosition; float sd2 = dot( sl, sl ); directLight.color *= sd2 / ( sd2 + 0.35 ); }');
if (LIGHTS_CHUNK2 === LIGHTS_CHUNK) console.warn('spot light near-field patch not applied (three.js shader chunks changed?)');

const FRAG_HEAD = `
varying vec3 vWPos, vLPos;
uniform sampler2D tAO; uniform vec4 uAOB; uniform vec2 uAOH;
uniform vec4 uWater, uRipple; uniform float uTimeW;
` + ROOM_GLSL;
export const FLOOR = 1, WALL = 2, CEIL = 3;
// (in the room's own coordinates, vLPos: a room's AO map moves with it)
const AO_CODE = [
  '',
  'diffuseColor.rgb *= texture2D(tAO, (vLPos.xz - uAOB.xy) / uAOB.zw).rgb;',
  'diffuseColor.rgb *= (0.5 + 0.5 * smoothstep(0.0, 0.5, vLPos.y)) * (0.72 + 0.28 * smoothstep(uAOH.x, uAOH.x - uAOH.y, vLPos.y));',
  'diffuseColor.rgb *= 0.45 + 0.55 * texture2D(tAO, (vLPos.xz - uAOB.xy) / uAOB.zw).a;',
];
// Mold on a surface. The texture says how much there is (r) and how burnt (g), smoothly over cells of ~12 cm; the fine
// structure comes from noise in the world. Not flat black (that read as a hole or paint): a dark grey-green, mottled and
// granular, blacker in old thick growth, with a paler grey fuzz at the growing rim and small round colonies just ahead
// of it; a damp brown stain round it; raised in lumps (bump); velvety, so it catches light at a glancing angle (a soft
// sheen), with a few wet patches on old growth. Where fire has been: ash and black char, embers in the freshest.
const MOLD_HEAD = `
#define MOLD
precision highp sampler3D;
uniform sampler2D tMold; uniform highp sampler3D tNoise; uniform vec3 uNoiseOff;
varying vec2 vMoldUv;
`;
const MOLD_SURFACE = `
  float moldCov = 0.0, moldH = 0.0, moldWet = 0.0, moldEmber = 0.0;
  if (vMoldUv.x >= 0.0) {
    vec2 md = texture2D(tMold, vMoldUv).rg;
    if (md.r > 0.004 || md.g > 0.01) {
      // (the noise tiles every unit: read it in rotated coordinates at unrelated scales, or fine detail repeats in a grid)
      // (in the room's own coordinates, offset per room: the detail stays put on a room that moves, and differs between rooms)
      vec3 P = vLPos + uNoiseOff, Q = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60) * P;
      float n1 = texture(tNoise, P * 2.1).r, n2 = texture(tNoise, Q * 6.37 + 0.37).g, n3 = texture(tNoise, P * 0.6 + 0.61).r;
      float n4 = texture(tNoise, Q.zxy * 13.3 + 0.13).r * 0.6 + texture(tNoise, Q * 21.7 + 0.71).g * 0.4;   // granules
      // (fine granules in the edge too: it dissolves into specks rather than ending on a crisp line)
      float f = md.r * 1.3 + (n1 - 0.5) * 0.9 + (n2 - 0.5) * 0.4 + (n4 - 0.5) * 0.3 - 0.62;
      moldCov = smoothstep(-0.06, 0.2, f);
      // small round colonies ahead of the edge, thinning out with distance from it
      float spots = smoothstep(0.7, 0.8, n2 * 0.55 + n4 * 0.25 + n1 * 0.2 + md.r * 0.35) * smoothstep(0.015, 0.15, md.r);
      moldCov = max(moldCov, spots);
      // height rises gently from the edge (a step there drew a dark rim: torn paper, not growth)
      moldH = max(smoothstep(-0.02, 0.6, f), spots * 0.5) * (0.35 + 0.35 * n2 + 0.3 * n4);
      moldWet = smoothstep(0.85, 1.0, md.r) * smoothstep(0.72, 0.85, n3) * smoothstep(0.45, 0.7, n4);
      float halo = smoothstep(0.0, 0.6, md.r + 0.2 * n1 - 0.05) * (1.0 - moldCov);
      diffuseColor.rgb *= mix(vec3(1.0), vec3(0.8, 0.78, 0.6), halo);   // a damp, yellow-brown water stain
      float old = smoothstep(0.75, 1.0, md.r) * (0.4 + 0.6 * n1);
      // Dark: black mold reflects a few percent. Close to a fire it's lit several times brighter than the wall behind
      // you, and at 0.1 it read there as pale grey plaster. Its texture comes from light (lumps, velvet sheen) more than
      // from colour.
      vec3 mc = mix(vec3(0.034, 0.039, 0.029), vec3(0.011, 0.013, 0.01), old);   // dark grey-green; old, thick growth blacker
      mc *= 0.6 + 0.8 * n4 * (0.6 + 0.4 * n2);                                    // mottled, granular
      float rim = clamp(moldCov * (1.0 - moldCov) * 4.0, 0.0, 1.0) + spots * 0.5;
      mc = mix(mc, vec3(0.085, 0.085, 0.075), clamp(rim * 0.5 * (0.3 + n2) + (1.0 - smoothstep(0.2, 0.6, md.r)) * 0.15 * n4, 0.0, 1.0));   // young: paler fuzz
      diffuseColor.rgb = mix(diffuseColor.rgb, mc, moldCov);
      vec3 ash = mix(vec3(0.02, 0.018, 0.016), vec3(0.15, 0.14, 0.13), smoothstep(0.55, 0.8, n2));
      diffuseColor.rgb = mix(diffuseColor.rgb, ash, smoothstep(0.05, 0.45, md.g) * 0.85);
      moldEmber = smoothstep(0.85, 1.0, md.g) * smoothstep(0.55, 0.85, n2) * smoothstep(0.4, 0.7, n1);
    }
  }
`;
const MOLD_ROUGH = `
  roughnessFactor = mix(roughnessFactor, mix(0.92, 0.42, moldWet), moldCov);
`;
const MOLD_BUMP = `
  if (moldCov > 0.002) {   // raised lumps, a few millimetres: bump from the screen-space slope of its height
    vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
    float hx = dFdx(moldH) * 0.02, hy = dFdy(moldH) * 0.02;
    vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
    float det = dot(sx, r1) * faceDirection;
    normal = normalize(abs(det) * normal - sign(det) * (hx * r1 + hy * r2));
    // velvet: the fuzz catches light at a glancing angle
    float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
    diffuseColor.rgb += vec3(0.035, 0.038, 0.032) * pow(1.0 - ndv, 3.0) * moldCov;
  }
`;
// Mold is matte like velvet or soot: its fuzz traps light, so it hardly reflects, even at a glancing angle. With the
// usual reflectance, a wall of mold seen along a corridor toward a fire showed nothing but that glancing reflection
// (pale grey, as bright as the wallpaper beside it), because its own colour is so dark.
const MOLD_SPEC = `
  material.specularColor *= 1.0 - 0.85 * moldCov;
  material.specularF90 = mix(material.specularF90, 0.12, moldCov);
`;
// Water, in a flooded room (uWater.x: how much of the floor). The carpet is soaked dark everywhere; ankle-deep water
// stands in the low spots, which come from noise in the room's own coordinates (they stay with the room); deeper is
// darker and murkier. The water is glossy (the room's lights glint in it), shivers, and rings out round your feet as
// you wade. The floor marks how much of it is water in the scene's alpha, and the reflection pass
// (render/pipeline.js) reflects the room in it there and nowhere else.
const WATER_FLOOR = `
  float water = 0.0;
  if (uWater.x > 0.001) {
    vec3 wq = vec3((vLPos.xz + uNoiseOff.xz) * 0.12, 0.43);
    float wn = texture(tNoise, wq).r * 0.62 + texture(tNoise, wq * 2.9 + 0.31).g * 0.28 + texture(tNoise, wq * 8.3 + 0.67).r * 0.1;
    float lvl = mix(0.38, 0.62, uWater.x);
    water = 1.0 - smoothstep(lvl - 0.035, lvl + 0.01, wn);
    float deep = smoothstep(0.0, 0.18, lvl - wn);
    diffuseColor.rgb *= 0.5;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.62, 0.62, 0.55) * (1.0 - 0.45 * deep) + vec3(0.006, 0.006, 0.004), water);
  }
`;
const WATER_ROUGH = `
  if (uWater.x > 0.001) roughnessFactor = mix(min(roughnessFactor, 0.82), 0.04, water);
`;
const WATER_BUMP = `
  if (water > 0.01) {   // ripples (bump from the screen-space slope of a height in metres)
    float rr = length(vWPos.xz - uRipple.xy);
    float rh = sin(rr * 26.0 - uTimeW * 9.0) * exp(-rr * 1.6) * smoothstep(0.05, 0.4, rr) * uRipple.z
             + (texture(tNoise, vec3(vLPos.xz * 0.9, uTimeW * 0.03)).r - 0.5) * 0.35;
    rh *= water * 0.004;
    vec3 wsx = dFdx(-vViewPosition), wsy = dFdy(-vViewPosition);
    vec3 w1 = cross(wsy, normal), w2 = cross(normal, wsx);
    float wdet = dot(wsx, w1) * faceDirection;
    normal = normalize(abs(wdet) * normal - sign(wdet) * (dFdx(rh) * w1 + dFdy(rh) * w2));
  }
`;
// the water has stood against the walls: their bottom soaked dark, a tide line above it
const WATER_WALL = `
  if (uWater.x > 0.001) {
    float tide = 0.1 + 0.07 * texture(tNoise, vec3((vLPos.x + vLPos.z) * 0.35 + uNoiseOff.x, vLPos.y * 0.2, 0.2)).r;
    diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(tide - 0.01, tide + 0.05, vLPos.y));
    diffuseColor.rgb *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.025, abs(vLPos.y - tide - 0.035)));
  }
`;
// room: the room uniforms of one placed room (world/level.js), or none: a material outside the rooms
export function lit(params, mode = 0, extra, { mold = false, room = noRoom } = {}) {
  const m = new THREE.MeshStandardMaterial(params);
  m.onBeforeCompile = (sh) => {
    for (const k in shared) sh.uniforms[k] = shared[k];
    for (const k in room) sh.uniforms[k] = room[k];
    sh.vertexShader = 'varying vec3 vWPos, vLPos;\n' + (mold ? 'attribute vec2 aMoldUv; varying vec2 vMoldUv;\n' : '') + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
\tvec4 wPos4 = vec4(transformed, 1.0);
\t#ifdef USE_INSTANCING
\twPos4 = instanceMatrix * wPos4;
\t#endif
\tvLPos = wPos4.xyz;
\tvWPos = (modelMatrix * wPos4).xyz;` + (mold ? '\n\tvMoldUv = aMoldUv;' : ''));
    let fs = sh.fragmentShader
      .replace('#include <lights_fragment_begin>', LIGHTS_CHUNK2)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + (AO_CODE[mode] ?? '') + (mold ? MOLD_SURFACE : '')
        + (mold && mode === FLOOR ? WATER_FLOOR : mold && mode === WALL ? WATER_WALL : ''));
    const fl = mold && mode === FLOOR;
    if (mold) fs = fs
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + MOLD_ROUGH + (fl ? WATER_ROUGH : ''))
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + MOLD_BUMP + (fl ? WATER_BUMP : ''))
      .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' + (fl ? '\tgl_FragColor.a = 1.0 - 0.98 * water;' : ''))
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n' + MOLD_SPEC)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vec3(1.0, 0.22, 0.03) * moldEmber * 2.0;');
    // reflections of the captured environment come from a single capture point, so they are not position-correct: keep them faint
    fs = fs.replace('#include <lights_fragment_maps>', '#include <lights_fragment_maps>\n\tiblIrradiance *= uEnvK;\n\tradiance *= 0.5 * uEnvK;');
    sh.fragmentShader = FRAG_HEAD + (mold ? MOLD_HEAD : '') + fs;
    extra?.(sh);
  };
  m.customProgramCacheKey = () => 'lit' + mode + (extra ? extra.key : '') + (mold ? 'M' : '');
  m.userData.params = params; m.userData.mode = mode; m.userData.extra = extra; m.userData.mold = mold;
  return m;
}
// the same material for one placed room (the same shader: no compile)
export const litFor = (base, room) => { const d = base.userData, m = lit(d.params, d.mode, d.extra, { mold: d.mold, room }); m.userData.base = base; return m; };

// Light panels, all of a room's in one mesh: each panel's vertices carry its index (aPanel) into the room's panel
// brightness (uPanelV, 4 per vec4: flicker, death under mold) and its tube's tint (vertex colour). A panel goes dark
// where mold grows over it.
export const MAX_PANELS = 192;
export function panelMaterial(room) {
  const m = new THREE.MeshBasicMaterial({ map: T.diffTex, color: new THREE.Color(PANEL, PANEL, PANEL), vertexColors: true });
  m.onBeforeCompile = sh => {
    sh.uniforms.tMold = room.tMold; sh.uniforms.uPanelV = room.uPanelV;
    sh.vertexShader = `attribute vec2 aMoldUv; attribute float aPanel; uniform vec4 uPanelV[ ${MAX_PANELS / 4} ]; varying vec2 vMoldUv; varying float vPanelV;\n` + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n\tvMoldUv = aMoldUv;\n\tint pi = int(aPanel + 0.5);\n\tvPanelV = uPanelV[ pi / 4 ][ pi % 4 ];');
    sh.fragmentShader = 'uniform sampler2D tMold; varying vec2 vMoldUv; varying float vPanelV;\n' + sh.fragmentShader.replace('#include <map_fragment>',
      '#include <map_fragment>\n\tdiffuseColor.rgb *= vPanelV;\n\tif (vMoldUv.x >= 0.0) diffuseColor.rgb *= 1.0 - 0.99 * smoothstep(0.2, 0.7, texture2D(tMold, vMoldUv).r);');
  };
  m.customProgramCacheKey = () => 'panelRoom';
  return m;
}

// ---------------------------------------------------------------- the rooms
const MOLD = { mold: true };
export const wallpaperMat = lit({ map: T.wallpaperTex, roughness: 0.82 }, WALL, undefined, MOLD);
export const carpetMat = lit({ map: T.carpetTex, roughness: 1, envMapIntensity: 0.3 }, FLOOR, undefined, MOLD);
export const ceilMat = lit({ map: T.ceilTex, roughness: 0.95 }, CEIL, undefined, MOLD);
export const baseMat = lit({ color: 0x3e3427, roughness: 0.7 }, WALL, undefined, MOLD);          // rubber cove base
export const fixtureFrameMat = lit({ color: 0xd6d1c2, roughness: 0.5 }, 0, undefined, MOLD);
export const fixtureOffMat = lit({ map: T.diffTex, color: 0x9a968a, roughness: 0.5 }, 0, undefined, MOLD);
export const ventMat = lit({ color: 0xcfcab8, roughness: 0.6 }, 0, undefined, MOLD);
export const plenumMat = new THREE.MeshBasicMaterial({ color: 0x030303 });
// other rooms' surfaces (the same shaders as the wallpaper, carpet and ceiling: a different texture or tint compiles nothing)
export const concreteWallMat = lit({ map: T.concreteTex, roughness: 0.9 }, WALL, undefined, MOLD);         // painted block
export const concreteFloorMat = lit({ map: T.concreteFloorTex, roughness: 0.72, envMapIntensity: 0.4 }, FLOOR, undefined, MOLD);
export const concreteCeilMat = lit({ map: T.concreteTex, color: 0x8c8a80, roughness: 0.95 }, CEIL, undefined, MOLD);
export const voidWallMat = lit({ map: T.concreteTex, color: 0x5a5446, roughness: 0.95 }, WALL, undefined, MOLD);   // a tall void above the wallpaper
export const voidCeilMat = lit({ map: T.concreteTex, color: 0x24221d, roughness: 1 }, CEIL, undefined, MOLD);
export const insulationMat = lit({ map: T.insulationTex, roughness: 1 }, CEIL, undefined, MOLD);            // a crawlspace's ceiling
// props, pipes, ducts, cables (the same shader as the light fixtures' frames; their mold coordinates come from the
// ceiling, or none)
export const pipeMat = lit({ color: 0x5f625c, metalness: 0.65, roughness: 0.48 }, 0, undefined, MOLD);
export const ductMat = lit({ color: 0x8b8e88, metalness: 0.8, roughness: 0.38 }, 0, undefined, MOLD);
export const cableMat = lit({ color: 0x141414, roughness: 0.8 }, 0, undefined, MOLD);
export const paintedMetalMat = lit({ color: 0x77796f, metalness: 0.45, roughness: 0.55 }, 0, undefined, MOLD);   // breaker box, filing cabinet
export const deskMat = lit({ color: 0x5e4a33, roughness: 0.55 }, 0, undefined, MOLD);                          // wood-grain laminate
export const fabricMat = lit({ color: 0x2b2c31, roughness: 0.95 }, 0, undefined, MOLD);
export const plasticMat = lit({ color: 0xbcb299, roughness: 0.45 }, 0, undefined, MOLD);                       // an old beige phone
export const paperMat = lit({ color: 0xd8d4c6, roughness: 0.9 }, 0, undefined, MOLD);
// doors, a safe room's generator and its pale walls, fuel cans (the same shaders again)
export const doorSteelMat = lit({ color: 0x4d5850, metalness: 0.55, roughness: 0.5 }, 0, undefined, MOLD);    // heavy painted steel
export const doorWoodMat = lit({ color: 0x8f7556, roughness: 0.62 }, 0, undefined, MOLD);                    // an old painted wooden door
export const engineMat = lit({ color: 0x9c8a36, metalness: 0.35, roughness: 0.5 }, 0, undefined, MOLD);      // the generator's yellow
export const canMat = lit({ color: 0x8c1d14, metalness: 0.3, roughness: 0.45 }, 0, undefined, MOLD);         // a red jerrycan
export const safeWallMat = lit({ map: T.concreteTex, color: 0xdde8de, roughness: 0.85 }, WALL, undefined, MOLD);   // pale painted block
export const safeCeilMat = lit({ map: T.concreteTex, color: 0xf0f2ea, roughness: 0.9 }, CEIL, undefined, MOLD);    // and a painted slab overhead
// (the panels' place holder while a room is built: replaced by the room's panelMaterial)
export const panelBase = new THREE.MeshBasicMaterial();

// fluorescent panels: HDR, brightness relative to the rooms' lighting (world/rooms.js)
export const PANEL = 6.0;
// one placed room's materials, for the base materials its geometry was built with
export function roomMaterials(room, bases) {
  const map = new Map();
  for (const b of bases) map.set(b, b === plenumMat ? plenumMat : b === panelBase ? panelMaterial(room) : litFor(b, room));
  return map;
}

// ---------------------------------------------------------------- the flamethrower (weapon/flamethrower.js)
export const blackMetalMat = lit({ color: 0x18191a, metalness: 0.6, roughness: 0.42 });
export const steelMat = lit({ color: 0xaeb2b5, metalness: 0.9, roughness: 0.34 });
export const shieldMat = lit({ map: T.shieldTex, metalness: 0.65, roughness: 0.5 });
export const brassMat = lit({ color: 0xa88550, metalness: 1, roughness: 0.38 });
export const sootyMat = lit({ color: 0x1b1714, metalness: 0.3, roughness: 0.8 });   // the nozzle: black with soot
export const rubberMat = lit({ color: 0x111111, roughness: 0.85 });
export const gaugeMat = lit({ map: T.gaugeTex, roughness: 0.25 });
export const needleMat = new THREE.MeshBasicMaterial({ color: 0x1a0805 });
export const lensMat = new THREE.MeshBasicMaterial({ color: 0x0b0b0b });   // the weapon light's lens; glows when on

// world-mapped UVs: [scale u, x offset, z offset, scale v (walls; default = scale u)]
export const uvScale = new Map([
  [wallpaperMat, [1 / T.WALL_W, 0, 0, 1 / T.WALL_H]],
  [carpetMat, [1 / T.CARPET_M, 0, 0]],
  [ceilMat, [1 / T.CEIL_M, 0, 0]],
  [baseMat, [1, 0, 0]],
  [concreteWallMat, [1 / T.BLOCK_M, 0, 0]], [voidWallMat, [1 / T.BLOCK_M, 0, 0]],
  [concreteFloorMat, [1 / T.SLAB_M, 0, 0]], [concreteCeilMat, [1 / T.BLOCK_M, 0, 0]], [voidCeilMat, [1 / T.BLOCK_M, 0, 0]],
  [insulationMat, [1 / T.INSUL_M, 0, 0]], [safeWallMat, [1 / T.BLOCK_M, 0, 0]], [safeCeilMat, [1 / T.BLOCK_M, 0, 0]],
]);
// walls (they stop the weapon light: they cast its shadow)
export const WALL_MATS = new Set([wallpaperMat, concreteWallMat, voidWallMat, safeWallMat]);
// meshes using these cast the weapon light's shadows
export const PROP_MATS = new Set([fixtureFrameMat, pipeMat, ductMat, paintedMetalMat, deskMat, fabricMat, plasticMat, doorSteelMat, doorWoodMat, engineMat, canMat]);
