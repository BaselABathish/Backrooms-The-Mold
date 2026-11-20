// The flamethrower: the wand in the lower right of the picture (held at the hip; no hands in shot), its pilot flame,
// the light mounted on it, and the valve. The wand points where the hands aim (player.js hand springs), converging on
// the point the camera looks at, so the stream lands where you look. Near a wall it is pulled back and lowered.
// Its pressure gauge, facing the camera, is the only readout (no HUD in found footage): the tank's pressure falls as
// the fuel goes (FUEL_MAX is about a hundred seconds of fire). On an empty tank the trigger only clicks.
import * as THREE from 'three';
import { scene, camera } from '../core/context.js';
import { state, fx } from '../state.js';
import { world } from '../world/world.js';
import { P } from '../player/player.js';
import { shk, clamp } from '../core/util.js';
import { cookieTex } from '../world/textures.js';
import { blackMetalMat, steelMat, shieldMat, sootyMat, rubberMat, gaugeMat, needleMat, lensMat } from '../world/materials.js';
import { nozzle, setPilotLight } from './fire.js';
import { noiseUniform } from './noise3d.js';
import { flameStart, flameStop, setFlame, fuelDry } from '../audio/audio.js';

// ---------------------------------------------------------------- the model (barrel along -z, origin at the grip)
const wand = new THREE.Group();
const part = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); wand.add(m); return m;
};
const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };
const along = (r0, r1, len, seg = 16, open = false) => { const g = new THREE.CylinderGeometry(r1, r0, len, seg, 1, open); g.rotateX(-Math.PI / 2); return g; };   // r0 at the back, r1 at the front
const NOZZLE_Z = -0.805, PILOT = new THREE.Vector3(0, -0.026, -0.8), LIGHT_AT = new THREE.Vector3(0.064, 0.004, -0.53);
part(along(0.024, 0.024, 0.46), blackMetalMat, 0, 0, -0.17);                                     // body (fuel line)
part(new THREE.BoxGeometry(0.07, 0.075, 0.11), blackMetalMat, 0, 0.008, -0.02);                  // valve block
part(new THREE.BoxGeometry(0.03, 0.05, 0.02), blackMetalMat, 0, -0.045, -0.02);                  // trigger housing
const gauge = new THREE.Group(); gauge.position.set(0, 0.062, -0.03); gauge.rotation.x = 0.85; wand.add(gauge);
{
  const g = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.016, 24), [blackMetalMat, gaugeMat, blackMetalMat]);
  gauge.add(g);
  gauge.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.02, 8), blackMetalMat), 0, -0.012, 0));
}
const needle = new THREE.Group(); needle.position.y = 0.0085; gauge.add(needle);
needle.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.0018, 0.0006, 0.021), needleMat), 0, 0, -0.007));
part(along(0.037, 0.037, 0.30, 24, true), shieldMat, 0, 0, -0.55);                               // perforated heat shield
part(along(0.0395, 0.0395, 0.012, 24), steelMat, 0, 0, -0.40);                                  // its end rings
part(along(0.0395, 0.0395, 0.012, 24), steelMat, 0, 0, -0.70);
part(along(0.0105, 0.0105, 0.16, 12), steelMat, 0, 0, -0.70);                                    // barrel inside it
part(along(0.011, 0.0075, 0.026, 12), sootyMat, 0, 0, -0.792);                                   // nozzle, black with soot
part(along(0.0045, 0.0045, 0.2, 8), steelMat, 0, -0.026, -0.69);                                 // igniter tube under the barrel
part(along(0.0065, 0.005, 0.014, 8), sootyMat, 0, -0.026, -0.793);
part(new THREE.BoxGeometry(0.022, 0.012, 0.045), blackMetalMat, 0.045, 0.004, -0.5);             // light mount
part(along(0.016, 0.016, 0.11, 16), blackMetalMat, LIGHT_AT.x, LIGHT_AT.y, -0.47);               // the light
part(along(0.0185, 0.0185, 0.02, 16), blackMetalMat, LIGHT_AT.x, LIGHT_AT.y, -0.517);
part(new THREE.CircleGeometry(0.015, 16), lensMat, LIGHT_AT.x, LIGHT_AT.y, -0.5275, 0, Math.PI, 0);
{
  const hose = new THREE.CatmullRomCurve3([[0, -0.01, 0.06], [0, -0.045, 0.14], [0.01, -0.14, 0.2], [0.03, -0.36, 0.18], [0.05, -0.62, 0.1]].map(p => new THREE.Vector3(...p)));
  part(new THREE.TubeGeometry(hose, 24, 0.011, 8), rubberMat);
}
wand.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
scene.add(wand);

// ---------------------------------------------------------------- the pilot flame: a small blue flame with a yellow tip
const pilotMat = new THREE.ShaderMaterial({
  uniforms: { tNoise: noiseUniform, uTime: { value: 0 }, uK: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    precision highp sampler3D;
    uniform highp sampler3D tNoise; uniform float uTime, uK; varying vec2 vUv;
    void main(){
      vec2 p = vUv * 2.0 - 1.0;
      float n = texture(tNoise, vec3(p.x * 0.3 + 0.2, p.y * 0.3 - uTime * 1.7, uTime * 0.35)).r - 0.5;
      p.x += n * 0.35 * (p.y + 1.0);
      // a teardrop: round at the bottom, tapering to a flickering tip
      float y = p.y * 0.5 + 0.5, w = 0.42 * sqrt(max(1.0 - y, 0.0)) * smoothstep(-0.05, 0.25, y) * (1.0 + n * 0.5);
      float f = 1.0 - smoothstep(w * 0.55, w, abs(p.x));
      f *= smoothstep(0.0, 0.18, y) * (1.0 - smoothstep(0.62 + n * 0.3, 0.95, y));
      vec3 blue = vec3(0.18, 0.36, 1.0) * 1.6, yel = vec3(1.0, 0.62, 0.22) * 4.0;
      vec3 c = mix(blue, yel, smoothstep(0.25, 0.6, y)) * f * uK;
      gl_FragColor = vec4(c, 0.0);
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const pilot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), pilotMat);
pilot.frustumCulled = false;
scene.add(pilot);
const pilotLight = { p: new THREE.Vector3(), i: 0.06 };
setPilotLight(pilotLight);

// ---------------------------------------------------------------- the light on the wand
// (a 90s torch: a warm tungsten bulb.) A wide, soft spill round the hot centre lights the walls and floor around what
// you aim at, so mold shows as black, ragged shapes on lit wallpaper; up close the auto exposure holds it back.
export const light = new THREE.SpotLight(0xffe2bc, 0, 30, 0.72, 0.5, 2);
light.map = cookieTex;
light.castShadow = true;
light.shadow.mapSize.set(512, 512);
light.shadow.bias = -0.0006;
light.shadow.camera.near = 0.1;
light.shadow.camera.far = 25;
scene.add(light, light.target);

// ---------------------------------------------------------------- per frame
export const FUEL_MAX = 500;   // seconds of fire at full flow (was 100; the user asked for a longer tank)
const W = { flow: 0, open: false, drip: 0, kick: 0, kickV: 0, psi: 210, first: true, lower: 0, fuel: FUEL_MAX, infinite: false, dry: false };
const _piv = new THREE.Vector3(), _tgt = new THREE.Vector3(), _dir = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _tip = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _ax = new THREE.Vector3(), _hd = new THREE.Vector3();
const Zax = new THREE.Vector3(0, 0, 1), Xax = new THREE.Vector3(1, 0, 0);

export function updateWeapon(dt) {
  // the valve: opens in a few hundredths of a second; the stream sputters as it opens and shuts
  const pull = state.trigger && state.started && !state.ui, has = W.fuel > 0 || W.infinite;
  if (pull && !has && !W.dry) { W.dry = true; fuelDry(); }
  if (!pull) W.dry = false;
  const want = pull && has ? 1 : 0;
  if (want && !W.open) { W.open = true; flameStart(); W.kickV += 1.6; }
  if (!want && W.open) { W.open = false; flameStop(); W.drip = 1; }
  W.flow += (want - W.flow) * (1 - Math.exp(-dt * (want ? 16 : 26)));
  if (!want && W.flow < 0.03) W.flow = 0;
  W.drip = Math.max(0, W.drip - dt / 0.7);
  if (!W.infinite) W.fuel = Math.max(0, W.fuel - W.flow * dt);
  // a kick when the valve opens, settling on a spring (substeps, so a slow frame can't make it unstable)
  const n = Math.min(Math.ceil(dt / 0.02), 8), h = dt / n;
  for (let i = 0; i < n; i++) { W.kickV += (-140 * W.kick - 16 * W.kickV) * h; W.kick += W.kickV * h; }
  // pressure: follows what's left in the tank; drops while the fuel runs, creeps back after
  const full = 25 + 185 * (W.infinite ? 1 : W.fuel / FUEL_MAX);
  W.psi += ((W.flow > 0.1 ? full * 0.72 : full) - W.psi) * (1 - Math.exp(-dt * (W.flow > 0.1 ? 1.4 : 0.5)));

  // where the hands hold it: below and right of the chest camera, following the body (the slow chest yaw)
  const cy = Math.cos(P.camYaw), sy = Math.sin(P.camYaw), rx = cy, rz = -sy, fx2 = -sy, fz = -cy;
  const walk = Math.min(P.speed / 1.5, 1), firing = W.flow;
  const bobY = Math.sin(P.phase * 2 + 0.6) * 0.007 * walk, bobX = Math.sin(P.phase + 0.3) * 0.005 * walk;
  const jit = firing * 0.0012;
  // (forward of the camera enough that the camcorder's narrower view takes in the gauge: it's the only fuel readout)
  _piv.set(camera.position.x + rx * (0.2 + bobX) + fx2 * 0.34, camera.position.y - 0.3 + bobY, camera.position.z + rz * (0.2 + bobX) + fz * 0.34);
  _piv.x += (Math.random() - 0.5) * jit; _piv.y += (Math.random() - 0.5) * jit; _piv.z += (Math.random() - 0.5) * jit;
  // aimed at what the camera ray along the hands' direction hits, but never closer than 2.8 m (or it would cross-eye)
  _hd.copy(P.aim).sub(camera.position).normalize();
  _tgt.copy(camera.position).addScaledVector(_hd, Math.max(P.beamD, 2.8));
  // held a little high for the distance, so the falling stream lands on the aim point (a person learns the arc)
  const D = Math.min(_tgt.distanceTo(_piv), 8), tf = D / 14.5;
  _tgt.y += 0.5 * 5.4 * tf * tf * 0.75;
  _dir.subVectors(_tgt, _piv).normalize();
  // near a wall: slid back just enough to keep the nozzle off it, and dipped a little, the way anyone holds a long
  // thing in a tight spot. It stays in the picture.
  W.lower += (clamp(0.9 - ((P.wallD ?? 9) - 0.08), 0, 0.45) - W.lower) * (1 - Math.exp(-dt * 10));
  _piv.addScaledVector(_dir, -W.lower);
  _piv.y += W.lower * 0.35;   // (the hands come up as it slides back, so the nozzle stays in the bottom of the shot)
  _ax.crossVectors(_dir, _up).normalize();   // to the right of the barrel
  _dir.applyAxisAngle(_ax, -0.1 * W.lower + W.kick * 0.04 + shk(P.t * 2.3 + 7) * 0.006 + (Math.random() - 0.5) * firing * 0.004);
  _m.lookAt(_piv, _tgt.copy(_piv).add(_dir), _up);
  wand.quaternion.setFromRotationMatrix(_m).multiply(_q.setFromAxisAngle(Zax, -0.12 + shk(P.t * 1.1 + 3) * 0.02));
  wand.position.copy(_piv);
  wand.updateMatrixWorld(true);

  // the stream leaves the nozzle along the barrel
  _tip.set(0, 0, NOZZLE_Z).applyMatrix4(wand.matrixWorld);
  _dir.set(0, 0, -1).transformDirection(wand.matrixWorld);
  if (W.first) { nozzle.p1.copy(_tip); nozzle.d1.copy(_dir); W.first = false; }
  nozzle.p0.copy(nozzle.p1); nozzle.d0.copy(nozzle.d1);
  nozzle.p1.copy(_tip); nozzle.d1.copy(_dir);
  nozzle.v.subVectors(nozzle.p1, nozzle.p0).multiplyScalar(1 / Math.max(dt, 1e-3));
  if (nozzle.v.lengthSq() > 64) nozzle.v.setLength(8);   // (a teleport is not a swing)
  nozzle.flow = W.flow; nozzle.drip = W.drip;

  // the pilot flame, just ahead of the igniter, facing the camera
  pilot.position.copy(PILOT).applyMatrix4(wand.matrixWorld);
  pilot.position.y += 0.009;
  pilot.quaternion.copy(camera.quaternion);
  pilot.scale.set(0.022, 0.034, 1);
  pilotMat.uniforms.uTime.value = P.t;
  pilotMat.uniforms.uK.value = 1 - 0.6 * firing;
  pilotLight.p.copy(pilot.position); pilotLight.i = 0.05;

  // the light: from its mount, at the aim point
  light.position.copy(LIGHT_AT).applyMatrix4(wand.matrixWorld);
  light.target.position.copy(P.aim);
  light.target.updateMatrixWorld();
  light.intensity = state.flashOn ? world.flashCd * fx.flash : 0;
  lensMat.color.setScalar(state.flashOn ? 6 * fx.flash : 0.03);

  // the gauge: 0-300 psi over three quarters of a turn, with the needle shivering while the fuel runs
  const psi = W.psi + (Math.random() - 0.5) * 6 * firing;
  needle.rotation.y = -(psi / 300 - 0.5) * Math.PI * 1.5;

  setFlame(W.flow, P.t);
}
export const weapon = W;
export { wand };
