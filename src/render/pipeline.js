// Render pipeline: a 90s camcorder on tape. Per frame:
//   scene (75% res, HDR) -> fire and smoke (half res, composited into the scene) -> floor reflections (half res)
//   -> 1x1 auto exposure
//   -> camera pass (lens, CCD sensor, the camera's processing; a history buffer smooths the render's edges)
//   -> tape pass (the burned-in REC sign and date stamp, then the tape: band-limited luma and colour, noise, jitter,
//      head switching, dropouts, interlace) -> screen
// With FX off, a plain tone-mapped render goes straight to the screen.
import * as THREE from 'three';
import { renderer, scene, camera, rtType, expoType } from '../core/context.js';
import { clamp, smooth } from '../core/util.js';
import { state, flags, fx } from '../state.js';
import { overlayTex, drawOverlay, resizeOverlay } from '../ui/overlay.js';
import { shared } from '../world/materials.js';
import { makeCoverGlass } from './lens.js';
const coverGlass = makeCoverGlass();

// Fire and smoke (weapon/fire.js) are drawn into their own half-resolution layer, then composited over the scene
// before anything else sees it, so the camera treats flames like any other light: they set the exposure, bloom,
// flare, clip and get compressed with the rest of the picture. Particles there read the scene's depth (soft edges,
// hidden behind walls) through these uniforms. count = 0: the layer and its passes are skipped.
export const fxLayer = {
  scene: new THREE.Scene(), count: 0,
  uniforms: { tDepth: { value: null }, uInvRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.05 }, uFar: { value: 70 } },
};

// the recording is always 4:3 at a 90s video resolution (480 lines), whatever the screen size
export const RES = [[480, 360], [640, 480], [960, 720]];
export const ASPECT = 4 / 3;

const VS = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const GLSL_COMMON = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSRGB(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const fsScene = new THREE.Scene();
const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
fsQuad.frustumCulled = false;
fsScene.add(fsQuad);
const pass = (uniforms, fragmentShader) => new THREE.ShaderMaterial({ uniforms, vertexShader: VS, fragmentShader, depthTest: false, depthWrite: false });

// 1. screen-space reflections in standing water (half resolution; glossy blur from the mip chain). Only where the floor
// shader marked water in the scene's alpha (a flooded room, world/materials.js); flags.ssr is on only while one is near.
const reflMat = pass({
  tDepth: { value: null }, tScene: { value: null },
  uProj: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uInvView: { value: new THREE.Matrix4() },
  uFloorN: { value: new THREE.Vector3() }, uFocal: { value: 300 }, uTexelY: { value: 0.002 },
  uTimeW: shared.uTimeW, uRipple: shared.uRipple,
}, GLSL_COMMON + `
  uniform sampler2D tDepth, tScene;
  uniform mat4 uProj, uInvProj, uInvView;
  uniform vec3 uFloorN; uniform float uFocal, uTexelY, uTimeW; uniform vec4 uRipple;
  varying vec2 vUv;
  float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }
  float viewZ(vec2 uv){ float d = textureLod(tDepth, uv, 0.0).r; vec4 p = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.z / p.w; }
  void main(){
    float wet = 1.0 - texture2D(tScene, vUv).a;   // (the floor shader's mark: how much of this pixel is water)
    float d = texture2D(tDepth, vUv).r;
    if (wet < 0.03 || d > 0.99999) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec4 pv = uInvProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec3 P = pv.xyz / pv.w;
    vec3 W = (uInvView * vec4(P, 1.0)).xyz;
    if (abs(W.y) > 0.015) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float rough = 0.07, gloss = wet * wet;   // (a little soft, and fading toward a puddle's edge: crisp reflections cut off by
                                             // the puddle's outline read as scraps of paper on the floor)
    vec3 V = normalize(P);
    vec3 Rd = reflect(V, uFloorN);
    float F = 0.04 + 0.96 * pow(1.0 - clamp(dot(-V, uFloorN), 0.0, 1.0), 5.0);
    float t = 0.06, tPrev = 0.0;
    bool hit = false;
    vec2 huv = vec2(0.0);
    for (int i = 0; i < 22; i++) {
      vec3 Q = P + Rd * t;
      if (Q.z > -0.06) break;
      vec4 c = uProj * vec4(Q, 1.0);
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
      float sz = viewZ(uv);
      if (Q.z < sz) { if (sz - Q.z < 0.3 + t * 0.08) { hit = true; huv = uv; } break; }
      tPrev = t; t *= 1.3;
    }
    if (!hit) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
    float a = tPrev, b = t;
    for (int j = 0; j < 5; j++) {
      float m = 0.5 * (a + b);
      vec3 Q = P + Rd * m;
      vec4 c = uProj * vec4(Q, 1.0);
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (Q.z < viewZ(uv)) { b = m; huv = uv; } else { a = m; }
    }
    vec3 Q = P + Rd * b;
    // the water isn't still: a slow shiver, and the rings round your feet as you wade
    float rr = length(W.xz - uRipple.xy);
    huv += (vec2(vnoise(W.xz * 5.0 + uTimeW * 0.4), vnoise(W.xz * 5.0 - uTimeW * 0.37 + 7.0)) - 0.5) * 0.006
         + vec2(0.0, sin(rr * 26.0 - uTimeW * 9.0) * exp(-rr * 1.6) * smoothstep(0.05, 0.4, rr) * uRipple.z * 0.01);
    float lod = clamp(log2(1.0 + b * (0.012 + rough * rough * 3.0) * uFocal / max(-Q.z, 0.3)), 0.0, 6.0);
    float sy = exp2(lod) * uTexelY * 1.6;                          // glossy reflections stretch vertically
    vec3 col = textureLod(tScene, huv, lod).rgb * 0.5 + textureLod(tScene, huv + vec2(0.0, sy), lod).rgb * 0.25 + textureLod(tScene, huv - vec2(0.0, sy), lod).rgb * 0.25;
    vec2 e = smoothstep(vec2(0.0), vec2(0.07), huv) * smoothstep(vec2(0.0), vec2(0.07), 1.0 - huv);
    float fade = e.x * e.y * (1.0 - smoothstep(16.0, 26.0, b));
    gl_FragColor = vec4(col * F * gloss * fade * (1.0 + wet * 0.6), 1.0);
  }`);

// 2. auto exposure and white balance (1x1 ping-pong), adapted values:
//    r: centre-weighted log-average luminance. Small bright things (lamps, exit signs) are clipped before averaging
//       so glancing at them doesn't swing the exposure; changes under ~0.3 stops are followed only slowly (no pumping).
//    g: the brightest large area near the centre (highlight protection, e.g. a wall right in the flashlight beam).
//       Read from a coarse mip, so small light sources are averaged away and don't trigger it.
//    b, a: the scene's average colour (log2 of red / green and blue / green), followed slowly (a few seconds): the
//       camera's auto white balance drifts against whatever colour fills the picture, as a real one does when fire
//       turns a room orange.
const expoMat = pass({ tScene: { value: null }, tPrev: { value: null }, uLod: { value: 0 }, uDt: { value: 0.03 }, uInit: { value: 1 } }, `
  uniform sampler2D tScene, tPrev; uniform float uLod, uDt, uInit; varying vec2 vUv;
  void main(){
    float s = 0.0, ws = 0.0, hi = -14.0;
    vec3 sc = vec3(0.0);
    for (int y = 0; y < 7; y++) for (int x = 0; x < 7; x++) {
      vec2 p = (vec2(float(x), float(y)) + 0.5) / 7.0;
      vec3 c = textureLod(tScene, p, uLod).rgb;
      float ll = log2(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-4));
      float w = 1.0 - 0.75 * length(p - 0.5) * 1.414;
      s += w * min(ll, log2(0.15) + 4.0); ws += w;
      sc += w * min(c, vec3(2.0));
      if (w > 0.6) hi = max(hi, ll);
    }
    float cur = s / ws;
    sc = max(sc / ws, vec3(1e-4));
    vec2 chroma = vec2(log2(sc.r / sc.g), log2(sc.b / sc.g));
    vec4 prev = texture2D(tPrev, vec2(0.5));
    float speed = (cur > prev.x ? 3.0 : 1.2) * mix(0.25, 1.0, smoothstep(0.15, 0.4, abs(cur - prev.x)));
    float speedHi = hi > prev.y ? 4.0 : 1.2;
    vec4 v = uInit > 0.5 ? vec4(cur, hi, chroma) : vec4(mix(prev.x, cur, 1.0 - exp(-uDt * speed)), mix(prev.y, hi, 1.0 - exp(-uDt * speedHi)),
      mix(prev.zw, chroma, 1.0 - exp(-uDt * 0.45)));
    gl_FragColor = v;
  }`);
const expoRT = expoType ? [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: expoType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false })) : null;
let expoIdx = 0, expoInit = true;

// 3. the camera: cover glass, lens, sensor and image processor (ISP). Writes into a history buffer for temporal noise
// reduction. In order: where each pixel's light comes from (lens distortion, rolling shutter, interference, heat
// shimmer); the optics (a soft lens with a little colour fringing, motion blur over the shutter time); exposure and
// white balance; light scattered by the lens and the dirty cover glass (glow, smears, streaks, ghosts); sensor noise
// in linear light; the image processor (local tone mapping, noise reduction smearing the dark, the tone curve,
// sharpening, saturation, vignette); temporal noise reduction.
const camMat = pass({
  tScene: { value: null }, tDepth: { value: null }, tExpo: { value: null }, tRefl: { value: null }, tHist: { value: null }, tFx: { value: null },
  tGlass: { value: coverGlass },
  uAspect: { value: 4 / 3 }, uMaxLod: { value: 8 },
  uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
  uTime: { value: 0 }, uShutter: { value: 0.5 }, uRollX: { value: 0 }, uRollY: { value: 0 }, uDistort: { value: 0.12 },
  uAdaptOK: { value: expoType ? 1 : 0 }, uHistOK: { value: 0 }, uReflOK: { value: 1 }, uBand: { value: 0.03 }, uBandPhase: { value: 0 }, uWB: { value: 0 },
  // Low-light limits: how strongly auto exposure chases darkness, the most gain it can apply, and how much the
  // WDR processing may lift shadows. These keep a dark hallway dark (and noisy) instead of brightening it back up.
  uExpoK: { value: 0.62 }, uExpoMax: { value: 1.5 }, uWdrMax: { value: 1.25 }, uWdrK: { value: 0 },   // (uWdrK 0: a 90s camera has no local tone mapping)
  // highlight protection: how bright (linear, before the tone curve) the brightest big area near the centre may stay
  // (a wall right in front of the flashlight) before exposure comes down for it
  uHiCap: { value: 1.1 },
  // auto white balance: the average colour (log2 r/g, b/g) the camera is tuned for (the lit hall), and how much of a
  // departure from it it corrects
  uWBRef: { value: new THREE.Vector2(0.37, -0.79) }, uAWB: { value: 0.25 },   // (measured in the hall: __br.exposure().wb)
  // how much the cover glass scatters (0: clean)
  uGlass: { value: 0.5 },
  // the CCD's vertical smear from anything very bright, and the autofocus hunting (blur, in mip levels)
  uSmear: { value: 1 }, uDefocus: { value: 0 },
  // the game layer (state.js fx): interference, heat shimmer over anything burning, mold over the lens
  uInterf: { value: 0 }, uHeat: { value: 0 }, uMoldLens: { value: 0 },
  // depth-buffer value 0.95 m from the camera: nearer than that is the flamethrower, which moves with the body
  uWeaponD: { value: 0.5 },
}, GLSL_COMMON + `
  uniform sampler2D tScene, tDepth, tExpo, tRefl, tHist, tFx, tGlass;
  uniform float uAspect, uMaxLod;
  uniform mat4 uInvViewProj, uPrevViewProj;
  uniform float uTime, uShutter, uRollX, uRollY, uDistort, uAdaptOK, uHistOK, uReflOK, uBand, uBandPhase, uWB, uExpoK, uExpoMax, uWdrMax, uHiCap;
  uniform vec2 uWBRef; uniform float uAWB, uGlass, uWdrK, uSmear, uDefocus;
  uniform float uInterf, uHeat, uWeaponD, uMoldLens;
  varying vec2 vUv;
  vec3 cam(vec3 x){ return toSRGB(aces(x * 0.9)); }
  float vnz(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }
  float win(vec2 p){ return 1.0 - smoothstep(0.3, 0.5, length(p - 0.5)); }
  vec2 lens(vec2 uv){   // barrel distortion, scaled so the corners stay in frame
    vec2 c = (uv - 0.5) * vec2(uAspect, 1.0);
    float r2 = dot(c, c), rc2 = 0.25 * uAspect * uAspect + 0.25;
    c *= (1.0 + uDistort * r2) / (1.0 + uDistort * rc2);
    return c / vec2(uAspect, 1.0) + 0.5;
  }
  // the scene through a cheap lens: never pin sharp (its blur and the sensor's anti-aliasing filter smooth every edge
  // over a pixel or so; a perfectly sharp, stair-stepped edge is what gives a render away)
  vec3 optic(vec2 p){ return textureLod(tScene, p, 0.75 + uDefocus).rgb; }
  void main(){
    vec2 uv = vUv;
    vec2 cc = (uv - 0.5) * vec2(uAspect, 1.0);
    float rc2 = 0.25 * uAspect * uAspect + 0.25;
    float r2n = dot(cc, cc) / rc2;
    vec2 suv = lens(uv) + vec2(uRollX, uRollY) * (0.5 - uv.y);   // rolling shutter: rows are read top to bottom
    // interference: a few thin sensor rows read out of place. Rare when it's faint, many only when it's on top of you,
    // and never whole bands of the picture (that reads as the camera shaking, not as the signal breaking up)
    if (uInterf > 0.001) {
      float tq = floor(uTime * 24.0), row = floor(uv.y * 180.0);
      suv.x += (hash12(vec2(row, tq + 7.0)) - 0.5) * 0.03 * uInterf * step(1.0 - uInterf * uInterf * 0.3, hash12(vec2(row * 0.173, tq)));
    }
    // Heat shimmer: hot air rising off the flames bends the light passing through it. The mask is the fire layer, blurred
    // and read from a little below each pixel (the hot air rises), so the shimmer sits over and around anything burning.
    if (uHeat > 0.001) {
      vec3 hm3 = textureLod(tFx, suv - vec2(0.0, 0.035), 3.0).rgb + textureLod(tFx, suv - vec2(0.0, 0.09), 4.0).rgb * 0.7;
      float hm = (1.0 - exp(-luma(hm3) * 0.6)) * uHeat;
      if (hm > 0.003) {
        vec2 q = suv * vec2(uAspect, 1.0) * 38.0 + vec2(0.0, -uTime * 4.5);
        vec2 hn = vec2(vnz(q), vnz(q * 1.37 + vec2(17.3, 5.1))) - 0.5;
        suv += hn * hm * 0.006;
      }
    }
    // exWant: the exposure the camera would like; ex: what it can actually do. Brighter than normal it compensates
    // almost fully (a faster shutter is always available); in the dark it only partly compensates and then runs out
    // of gain, so the picture stays dark while the noise goes up (see gain below)
    vec4 ev = uAdaptOK > 0.5 ? texture2D(tExpo, vec2(0.5)) : vec4(log2(0.15), -14.0, uWBRef);
    float dEv = ev.x - log2(0.15);
    float exWant = exp2(-(dEv > 0.0 ? 0.92 : uExpoK) * dEv);
    exWant = min(exWant, uHiCap / exp2(ev.y));   // highlight protection: a big bright area stays just short of clipping
    float ex = clamp(exWant, 0.03, uExpoMax);
    // the shutter stays open longer in the dark (more motion blur) and closes down for bright light (crisper fire)
    float shut = clamp(0.5 + 0.35 * log2(max(exWant, 0.05)), 0.15, 0.95);

    // camera motion blur from depth reprojection
    float d = texture2D(tDepth, suv).r;
    vec4 wp = uInvViewProj * vec4(suv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); wp /= wp.w;
    vec4 pp = uPrevViewProj * wp;
    vec2 puv = pp.xy / pp.w * 0.5 + 0.5;
    // the flamethrower right in front of the camera turns with the body: it doesn't smear when the view pans
    if (d < uWeaponD) puv = suv;
    vec2 vel = (suv - puv) * uShutter * shut * 2.0;
    float vl = length(vel);
    if (vl > 0.05) { vel *= 0.05 / vl; vl = 0.05; }
    vec3 c0 = optic(suv);
    vec3 cw = textureLod(tScene, suv, 1.5).rgb;
    c0 = mix(c0, cw, smoothstep(0.8, 3.0, luma(cw) * ex));
    vec3 col = c0;
    if (vl > 0.0012) {   // only blur when something actually moves on screen (saves 6 taps per pixel when still)
      float jit = hash12(gl_FragCoord.xy + fract(uTime) * 91.7);
      col = vec3(0.0);
      for (int i = 0; i < 6; i++) { float t = (float(i) + jit) / 6.0 - 0.5; col += optic(suv - vel * t); }
      col /= 6.0;
    }
    // lateral chromatic aberration: red and blue land a little apart toward the edges. (Read as out of focus as the
    // green: with red and blue sharp while the autofocus hunted, every light got a green halo.)
    vec2 cd = suv - 0.5;
    col = max(col + vec3(textureLod(tScene, 0.5 + cd * 1.009, 0.75 + uDefocus).r - c0.r, 0.0, textureLod(tScene, 0.5 + cd * 0.991, 0.75 + uDefocus).b - c0.b), 0.0);
    if (uReflOK > 0.5) col += texture2D(tRefl, suv).rgb;

    col *= ex;
    // auto white balance: corrects part of how far the picture's colour has drifted from what it's tuned for
    vec2 wbd = clamp((ev.zw - uWBRef) * uAWB, vec2(-0.35), vec2(0.35));
    col *= vec3(exp2(-wbd.x), 1.0, exp2(-wbd.y));
    // fluorescent tubes flicker at twice mains frequency; a rolling shutter turns that into slow horizontal bands
    // (a CCD reads the whole frame at once: uBand 0)
    col *= 1.0 - uBand * (0.5 + 0.5 * sin(6.28318 * (uv.y * 3.7 + uBandPhase)));
    // CCD vertical smear: an interline CCD leaks charge from anything very bright into its whole column as it's read
    // out, a faint vertical streak through the picture above and below it. Only for light far beyond clipping (a flame
    // with the gain up, a lit room seen from the dark): at 1.6 the hall's own ceiling panels drew hard-edged bands
    // down the whole frame.
    if (uSmear > 0.001) {
      float sm = 0.0;
      for (int i = 0; i < 8; i++) sm += max(luma(textureLod(tScene, vec2(suv.x, (float(i) + 0.5) / 8.0), 3.0).rgb) * ex - 6.0, 0.0);
      col += vec3(1.0, 0.93, 0.96) * min(sm * 0.125, 1.5) * 0.03 * uSmear;
    }

    // Light scattered in the lens and the cover glass. Close round a bright light: glow that softens its edges (light
    // bleeding past them, not a dark outline); wider: bloom and veiling glare; where the glass is smudged: a haze over
    // anything bright behind it, and along the wipe, streaks smeared along its stroke.
    vec3 bS = cw * ex;
    vec3 b1 = textureLod(tScene, suv, 2.0).rgb * ex;
    vec3 b2 = textureLod(tScene, suv, 3.5).rgb * ex;
    vec3 b3 = textureLod(tScene, suv, 5.0).rgb * ex;
    vec3 bl = b1 * 0.5 + b2 * 0.3 + b3 * 0.2;
    if (uReflOK > 0.5) bl += textureLod(tRefl, suv, 2.0).rgb * ex * 0.6;
    col += min(max(bS - 1.0, 0.0), vec3(4.0)) * 0.3;                    // the glow right round a light
    col += min(max(bl - 0.8, 0.0), vec3(3.0)) * 0.45 + textureLod(tScene, vec2(0.5), uMaxLod - 1.0).rgb * ex * 0.045;
    vec2 gl2 = texture2D(tGlass, uv).rg * uGlass;
    vec3 b4 = textureLod(tScene, suv, 6.0).rgb * ex;   // (very wide: light scattered by a film on the glass has no shape)
    col += (min(max(b3 * 0.6 + b4 * 0.4 - 0.2, 0.0), vec3(3.0)) * 0.32 + b4 * 0.02) * gl2.r;
    if (gl2.g > 0.02) {   // the wipe: light dragged a little way along it, fading
      vec2 sd = normalize(vec2(0.62, 0.78)) * vec2(1.0 / uAspect, 1.0) * 0.012;
      vec3 st = vec3(0.0);
      for (int i = 1; i <= 4; i++) {
        float fi = float(i);
        st += (max(textureLod(tScene, suv + sd * fi, 3.0).rgb * ex - 1.0, 0.0) + max(textureLod(tScene, suv - sd * fi, 3.0).rgb * ex - 1.0, 0.0)) * (1.0 - fi * 0.2);
      }
      col += min(st, vec3(3.0)) * gl2.g * 0.06;
    }
    // lens ghosts: faint coloured reflections of bright lights, mirrored through the centre (capped, so a big bright area
    // can't flood the frame with them)
    vec2 gv = 0.5 - suv, g1 = 0.5 + gv * 0.55, g2 = 0.5 + gv * 1.3;
    col += (min(max(textureLod(tScene, g1, 4.0).rgb * ex - 1.4, 0.0), vec3(1.5)) * vec3(0.16, 0.32, 0.22) * win(g1)
          + min(max(textureLod(tScene, g2, 4.5).rgb * ex - 1.4, 0.0), vec3(1.5)) * vec3(0.30, 0.14, 0.32) * win(g2)) * 0.05;

    // WDR: local tone mapping lifts dark areas and holds back bright ones (with the typical halos)
    float wdr = mix(1.0, clamp(pow(max(luma(b2), 1e-4) / 0.18, -0.28), 0.6, uWdrMax), uWdrK);
    col *= wdr;
    // purple fringing next to blown highlights
    col += vec3(0.30, 0.02, 0.55) * smoothstep(1.0, 3.0, luma(b1)) * (1.0 - smoothstep(0.8, 1.6, luma(col))) * 0.12;
    float gain = clamp(log2(exWant / 0.6) / 3.5, 0.0, 1.0);
    float dk = 1.0 - smoothstep(0.015, 0.22, luma(col));

    // Sensor noise, in linear light before the tone curve: shot noise grows with the square root of the light, read
    // noise doesn't; the gain amplifies both, so a dark picture boils and a bright one only shimmers. Demosaicing
    // spreads each speck over about two pixels; the colour noise is blotchier still. A few hot pixels never go dark.
    vec2 fc = gl_FragCoord.xy;
    float Yl = luma(col);
    float sig = sqrt(max(Yl, 0.0)) * (0.016 + 0.05 * gain * gain) + 0.0015 + 0.014 * gain * gain + 0.03 * uInterf;
    float tn = fract(uTime * 7.13) * 517.0;
    float nY = (hash12(fc + tn) - 0.5) * 0.9 + (hash12(floor(fc * 0.5) + tn * 1.31) - 0.5) * 0.6;
    vec2 cq = floor(fc * 0.34);
    float n1 = hash12(cq + fract(uTime * 3.7) * 331.0) - 0.5, n2 = hash12(cq + fract(uTime * 5.3) * 173.0) - 0.5;
    col += (vec3(nY) + vec3(n1, -0.5 * (n1 + n2), n2) * (0.35 + 0.45 * gain)) * sig * 0.6;   // (most of the grain is the tape's)
    col *= 1.0 + (hash12(vec2(fc.x, 7.0)) - 0.5) * 0.04 * (0.3 + gain);   // fixed pattern: each column a little off
    float hp = hash12(floor(fc) * 1.37 + 0.5);
    if (hp > 0.99984) col += vec3(hash12(fc + 3.1), hash12(fc + 7.7), hash12(fc + 1.9)) * (0.015 + 0.3 * gain) * (hp > 0.99996 ? 3.0 : 1.0);
    col = max(col, 0.0);
    // Noise reduction: in the dark, and the more gain there is, the processor smooths the picture to hide its noise and
    // takes fine detail with it: a smeary, watercolour look. A cheap wide lens is also softer toward the corners.
    // (a 90s camcorder did little of this: its dark is grainy rather than smeared)
    col = mix(col, bS * wdr, clamp(smoothstep(0.35, 1.0, r2n) * 0.5 + dk * (0.2 + 0.32 * gain), 0.0, 0.85));

    // tone curve, then ISP sharpening at two radii: halos on edges, kept small (an outline round every light is a tell)
    vec3 g = cam(col);
    float Y = luma(g);
    float Y1 = luma(cam(bS * wdr));
    float Y2 = luma(cam(b1 * wdr));
    Y += clamp((Y - Y1) * 0.35 + (Y - Y2) * 0.25, -0.05, 0.08) * (1.0 - smoothstep(0.002, 0.015, vl));   // (the camera's aperture correction; the deck adds its own)
    g += Y - luma(g);
    float yg = luma(g);
    g = mix(vec3(yg), g, 0.74) * vec3(0.955 + uWB, 1.02, 0.965 - uWB) + vec3(-0.012, 0.0, 0.006);
    g = (g - 0.022) / 0.978;
    g *= 1.0 - 0.42 * pow(r2n, 1.3);   // vignette
    float shadow = 1.0 - smoothstep(0.05, 0.6, luma(g));
    if (uInterf > 0.001) {   // whole rows of bad pixels (some tinted green or magenta), and the gain pumping
      float tl = floor(uTime * 30.0), rowId = floor(fc.y * 0.5), rn = hash12(vec2(rowId, tl)), tint = hash12(vec2(rowId, tl + 3.0));
      float run = hash12(vec2(floor(fc.x / (24.0 + 260.0 * tint)), rowId + tl));   // broken into runs, not full-width stripes
      vec3 lc = tint < 0.4 ? vec3(0.05, 0.22, 0.06) : tint < 0.7 ? vec3(0.22, 0.04, 0.24) : vec3(0.2);
      g = mix(g, g * 0.35 + lc, step(1.0 - 0.03 * uInterf, rn) * step(0.4, run));
      g *= 1.0 + (hash12(vec2(floor(uTime * 15.0), 1.7)) - 0.5) * 0.45 * uInterf;
    }

    // Mold on the lens: how the camera's end looks. It creeps in from the edges of the picture, out of focus on the glass
    // (soft, shapeless, almost black), until only a blurred hole is left in the middle, then nothing.
    if (uMoldLens > 0.001) {
      vec2 lq = uv * vec2(uAspect, 1.0);
      float edge = min(min(uv.x, 1.0 - uv.x) * uAspect, min(uv.y, 1.0 - uv.y));
      float nn = vnz(lq * 4.0 + uTime * 0.06) * 0.6 + vnz(lq * 11.0 - uTime * 0.04) * 0.4;
      float reach = uMoldLens * 0.62;
      float cov = smoothstep(reach + 0.03, reach - 0.08, edge + (nn - 0.5) * 0.22);
      g = mix(g, vec3(0.012, 0.014, 0.011) + g * 0.04, cov);
    }

    // temporal noise reduction: blend with the reprojected previous frame when they agree;
    // in the dark it tolerates bigger differences, so moving shadows smear like a real camera
    if (uHistOK > 0.5) {
      float sfac = (1.0 + 2.0 * uDistort * dot(cc, cc)) / (1.0 + uDistort * rc2);
      vec2 huv = uv - (suv - puv) / sfac;
      if (huv.x > 0.002 && huv.y > 0.002 && huv.x < 0.998 && huv.y < 0.998) {
        vec3 h = texture2D(tHist, huv).rgb;
        float tol = 0.04 + 0.08 * shadow;
        float w = mix(0.3, 0.5, shadow) * (1.0 - smoothstep(tol, tol * 2.4, length(g - h)));   // (light: no 90s camera smoothed over time)
        g = mix(g, h, w);
      }
    }
    gl_FragColor = vec4(max(g, 0.0), 1.0);
  }`);

// 4. the tape: a 90s camcorder recording (VHS / Video8 class), played back. The burned-in REC sign and date stamp go
// onto the tape with the picture. Then, as the signal goes through the tape:
//  - timebase error: every line a little early or late (a fine wobble), the top lines bent sideways ("flagging"), and
//    at the bottom the few lines where the playback heads switch over, torn sideways and noisy;
//  - luma band-limited along the line (about 300 of these 640 pixels resolved), with the deck's sharpness peaking
//    putting a halo either side of edges;
//  - colour far softer still (about a sixth of the luma's resolution), smeared along the line and a few pixels late,
//    and averaged with the line above;
//  - tape noise: grain in the luma, a little streaky along the line, more when the picture is dark (the camera's gain
//    is up); slow blotches of colour noise; now and then a dropout (a white streak with a fading tail);
//  - interlace: the odd lines are the other field, a sixtieth of a second older, so a fast pan combs;
//  - levels: blacks sit a little up and are never clean, whites don't quite reach white; colour a little faded.
// Damage (uCorrupt: the end) is tracking trouble: bands that slip and fill with noise, more dropouts, and finally the
// colour killer drops the picture to black and white.
const presentMat = pass({
  tHist: { value: null }, tPrev: { value: null }, tOverlay: { value: overlayTex }, uRes: { value: new THREE.Vector2(640, 480) },
  uTime: { value: 0 }, uMotion: { value: 0 }, uCorrupt: { value: 0 }, uEnhance: { value: 0 }, uInterf: { value: 0 },
  uGrain: { value: 0.07 }, uChroma: { value: 1 }, uSharp: { value: 0.7 }, uComb: { value: 0.5 },
  uGlitchRect: { value: new THREE.Vector4(0, 0, 0, 0) }, uGlitch: { value: 0 },   // (a doorway the space just changed in)
}, GLSL_COMMON + `
  uniform sampler2D tHist, tPrev, tOverlay;
  uniform vec2 uRes; uniform float uTime, uMotion, uCorrupt, uEnhance, uInterf, uGrain, uChroma, uSharp, uComb, uGlitch;
  uniform vec4 uGlitchRect;
  varying vec2 vUv;
  float vnz(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y); }
  vec3 yiq(vec3 c){ return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
  vec3 rgb(vec3 q){ return vec3(q.x + 0.956 * q.y + 0.621 * q.z, q.x - 0.272 * q.y - 0.647 * q.z, q.x - 1.106 * q.y + 1.703 * q.z); }
  vec3 enh(vec3 c){ c = pow(max(c, 0.0), vec3(1.0 / (1.0 + 1.5 * uEnhance))); return (c - 0.05 * uEnhance) * (1.0 + 0.3 * uEnhance); }
  // what went onto the tape: the picture and the stamp burned into it
  vec3 rec(vec2 uv){ vec4 o = texture2D(tOverlay, uv); return mix(texture2D(tHist, uv).rgb, o.rgb, o.a); }
  vec3 recSoft(vec2 uv){ vec4 o = texture2D(tOverlay, uv); return mix(textureLod(tHist, uv, 1.0).rgb, o.rgb, o.a); }
  void main(){
    vec2 fc = gl_FragCoord.xy, px = 1.0 / uRes;
    float k = uRes.y / 480.0, line = floor(fc.y), fromTop = uRes.y - fc.y, tf = floor(uTime * 30.0);
    // timebase
    float jit = ((hash12(vec2(line, tf)) - 0.5) * 0.45 + (vnz(vec2(line * 0.045, uTime * 1.7)) - 0.5) * 1.1) * k;
    jit += exp(-fromTop / (11.0 * k)) * (3.5 + 2.5 * sin(uTime * 0.83)) * k;                  // flagging
    float hsH = (7.0 + 3.0 * hash12(vec2(tf, 1.3))) * k, hs = step(fc.y, hsH);
    jit += hs * (10.0 + 22.0 * (1.0 - fc.y / hsH) + 8.0 * hash12(vec2(line, tf))) * k;       // head switching
    float band = 0.0;
    if (uCorrupt > 0.001) {   // tracking: a band of noise rolling up the picture, the lines in it slipping
      float bp = fract(uTime * 0.37) * 1.5 - 0.25;
      band = smoothstep(0.06 + 0.16 * uCorrupt, 0.0, abs(vUv.y - bp)) * uCorrupt;
      jit += band * (hash12(vec2(line, tf + 5.0)) - 0.3) * 50.0 * k;
    }
    if (uInterf > 0.001) jit += step(1.0 - 0.02 * uInterf, hash12(vec2(line * 0.37, tf))) * (hash12(vec2(line, tf + 9.0)) - 0.5) * 30.0 * uInterf * k;
    // Over a doorway where a room has just appeared in view, the tape breaks up for a moment, the way tracking does:
    // bands of a few lines torn sideways, their ends ragged and reaching past the doorway (tape damage runs along the
    // lines), some bands untouched, a few lines of snow, the colour dropping out. (A crisp box of colour noise read as
    // a digital censor block.)
    float gIn = 0.0, gBlk = floor(fc.y / (3.0 * k));
    if (uGlitch > 0.001) {
      float gw = uGlitchRect.z - uGlitchRect.x, ext = gw * (0.1 + 0.7 * hash12(vec2(gBlk, tf + 5.0)));
      float gx = smoothstep(uGlitchRect.x - ext - 0.03, uGlitchRect.x - ext + 0.01, vUv.x) * (1.0 - smoothstep(uGlitchRect.z + ext - 0.01, uGlitchRect.z + ext + 0.03, vUv.x));
      float gy = smoothstep(uGlitchRect.y - 0.05, uGlitchRect.y + 0.02, vUv.y) * (1.0 - smoothstep(uGlitchRect.w - 0.02, uGlitchRect.w + 0.05, vUv.y));
      gIn = gx * gy * uGlitch * step(0.3, hash12(vec2(gBlk, tf + 9.0)));
      jit += gIn * (hash12(vec2(gBlk, tf + 13.0)) - 0.5) * 70.0 * k;
    }
    vec2 uv = vUv + vec2(jit * px.x, 0.0);
    // luma along the line, band-limited (~1 px), then peaking against a wider blur
    float Y = yiq(rec(uv)).x * 0.4 + (yiq(rec(uv + vec2(px.x, 0.0))).x + yiq(rec(uv - vec2(px.x, 0.0))).x) * 0.24
            + (yiq(rec(uv + vec2(2.0 * px.x, 0.0))).x + yiq(rec(uv - vec2(2.0 * px.x, 0.0))).x) * 0.06;
    float Yw = yiq(textureLod(tHist, uv, 1.6).rgb).x;
    Y += clamp((Y - Yw) * uSharp, -0.12, 0.12);
    // interlace: the odd lines are the previous field; a pan combs
    if (mod(line, 2.0) > 0.5) Y = mix(Y, yiq(texture2D(tPrev, uv).rgb).x, uComb * smoothstep(0.1, 0.9, uMotion));
    // colour: very soft along the line, late (lagging right), and averaged with the line above
    vec2 IQ = vec2(0.0);
    float wsum = 0.0;
    for (int i = -3; i <= 3; i++) {
      float fi = float(i), w = exp(-fi * fi / 4.5);
      vec2 q = uv + vec2((fi * 2.8 - 3.5) * k * px.x, 0.0);
      // (the camera drains the colour from anything near clipping, so a blown-out panel is white, and its tint doesn't
      // bleed into a green fringe below it)
      vec3 qa = yiq(recSoft(q)), qb = yiq(recSoft(q + vec2(0.0, px.y)));
      IQ += w * (qa.yz * (1.0 - 0.85 * smoothstep(0.8, 1.05, qa.x)) + qb.yz * (1.0 - 0.85 * smoothstep(0.8, 1.05, qb.x))) * 0.5; wsum += w;
    }
    IQ /= wsum;
    // tape noise. Grain in the luma, smeared a little along the line, stronger in the dark (and the darker the whole
    // picture, the higher the camera's gain); colour noise in slow blotches along the line
    float avgY = yiq(textureLod(tHist, vec2(0.5), 8.0).rgb).x, gainUp = 1.0 - smoothstep(0.04, 0.3, avgY);
    // (two hashes summed: grain that clusters round the middle, like real noise, instead of an even spread)
    float nx = fc.x / (1.6 * k), ts = fract(uTime * 7.31) * 517.0;
    vec2 gq = vec2(floor(nx), line) + ts;
    float g0 = hash12(gq) + hash12(gq + 41.3), g1 = hash12(gq + vec2(1.0, 0.0)) + hash12(gq + vec2(1.0, 0.0) + 41.3);
    float grain = (mix(g0, g1, smoothstep(0.0, 1.0, fract(nx))) - 1.0) * uGrain * (1.0 + 0.35 * (1.0 - smoothstep(0.05, 0.45, Y)) + 0.25 * gainUp);
    float cl = floor(line * 0.5), cx = fc.x / ((18.0 + 22.0 * hash12(vec2(cl, tf + 0.7))) * k) + hash12(vec2(cl, tf + 1.9)) * 7.0;   // (blotch lengths vary line to line)
    vec2 cn = vec2(mix(hash12(vec2(floor(cx), cl) + tf * 0.37), hash12(vec2(floor(cx) + 1.0, cl) + tf * 0.37), fract(cx)),
                   mix(hash12(vec2(floor(cx), cl) + tf * 0.71 + 3.7), hash12(vec2(floor(cx) + 1.0, cl) + tf * 0.71 + 3.7), fract(cx))) - 0.5;
    IQ += cn * (0.03 + 0.04 * gainUp) * uChroma;
    // dropouts: a white streak where the tape lost its signal, fading along the line
    float dr = hash12(vec2(line, tf + 0.5));
    if (dr < 0.0035 * (1.0 + 8.0 * uCorrupt)) {
      float x0 = hash12(vec2(line, tf + 1.5)) * uRes.x, len = (12.0 + 110.0 * hash12(vec2(line, tf + 2.5))) * k, u = (fc.x - x0) / len;
      if (u > 0.0 && u < 1.0) { Y = mix(Y, 0.92, (1.0 - u) * 0.85); IQ *= 0.3; }
    }
    // the head switching band: noisy and drained of colour; tracking bands full of snow
    if (hs > 0.5) { Y = mix(Y, hash12(fc * 0.7 + tf), 0.25); IQ *= 0.4; }
    if (band > 0.001) { Y = mix(Y, hash12(vec2(floor(fc.x * 0.5), line) + tf), band * 0.75); IQ *= 1.0 - band; }
    if (gIn > 0.001) {
      float snowLine = step(0.72, hash12(vec2(floor(line / 2.0), tf + 21.0)));
      Y = mix(Y, hash12(vec2(floor(fc.x * 0.5), line) + tf * 1.7), gIn * snowLine * 0.5);
      Y += (hash12(vec2(gBlk, tf + 31.0)) - 0.5) * 0.12 * gIn;   // each torn band a little brighter or darker
      IQ *= 1.0 - 0.7 * gIn;
    }
    // RF interference from a failing tube: a faint herringbone
    Y += sin(fc.y * 1.1 + fc.x * 0.42 + uTime * 47.0) * 0.012 * uInterf;
    // the colour killer: badly damaged tape plays back in black and white
    IQ *= (1.0 - smoothstep(0.55, 0.9, uCorrupt)) * 0.9 * uChroma;
    vec3 c = rgb(vec3(Y, IQ));
    if (uEnhance > 0.001) c = enh(c);
    // levels: lifted blacks, whites short of white. The grain rides on top, so black is never clean: it fizzes both
    // ways round the lifted level instead of being clipped to a flat floor.
    c = 0.036 + max(c, 0.0) * 0.93 + grain * (1.0 - 0.6 * hs);
    gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`);

// the fire layer over the scene: premultiplied (its alpha is how much the smoke hides what's behind it)
const compMat = new THREE.ShaderMaterial({
  uniforms: { tFx: { value: null } }, vertexShader: VS, depthTest: false, depthWrite: false, transparent: true,
  blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  fragmentShader: `uniform sampler2D tFx; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tFx, vUv); }`,
});

// FX off: plain game camera with a fixed exposure (no auto exposure, so it is set for the dimmed night lighting)
const rawMat = pass({ tScene: { value: null }, tRefl: { value: null }, uReflOK: { value: 1 }, uExposure: { value: 2.5 } }, GLSL_COMMON + `
  uniform sampler2D tScene, tRefl; uniform float uReflOK, uExposure; varying vec2 vUv;
  void main(){ vec3 c = texture2D(tScene, vUv).rgb; if (uReflOK > 0.5) c += texture2D(tRefl, vUv).rgb; gl_FragColor = vec4(toSRGB(aces(c * uExposure)), 1.0); }`);

// ---------------------------------------------------------------- render targets and projection
let sceneRT = null, reflRT = null, fxRT = null, histRT = [null, null], histIdx = 0, histValid = false;
let maxLod = 8, hfovRad = 2, vfovRad = 1.5;
const baseProj = new THREE.Matrix4();

function updateProjection() {
  camera.aspect = ASPECT;
  camera.fov = state.fx ? 66 : 60;   // a camcorder's lens at its wide end (about 82° across), a little narrower without FX
  camera.updateProjectionMatrix();
  baseProj.copy(camera.projectionMatrix);
  // depth-buffer value at 0.95 m (the camera pass leaves the flamethrower out of the motion blur)
  const n = camera.near, f = camera.far, D = 0.95;
  camMat.uniforms.uWeaponD.value = ((f + n) / (f - n) - 2 * f * n / ((f - n) * D)) * 0.5 + 0.5;
  vfovRad = camera.fov * Math.PI / 180; hfovRad = 2 * Math.atan(Math.tan(vfovRad / 2) * ASPECT);
}
const makeRT = (w, h, opts) => new THREE.WebGLRenderTarget(w, h, Object.assign({ type: rtType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false }, opts));

// (re)create everything that depends on the recording resolution (state.qi) or FX mode
export function resizePipeline() {
  const [cw, ch] = RES[state.qi];
  renderer.setSize(cw, ch, false);
  const ss = state.fx ? 0.75 : 1.0, sw = Math.round(cw * ss), sh = Math.round(ch * ss);
  if (sceneRT) { sceneRT.depthTexture.dispose(); sceneRT.dispose(); reflRT.dispose(); fxRT.dispose(); histRT.forEach(r => r.dispose()); }
  sceneRT = makeRT(sw, sh, { depthBuffer: true, depthTexture: new THREE.DepthTexture(sw, sh) });
  reflRT = makeRT(Math.max(8, sw >> 1), Math.max(8, sh >> 1));
  fxRT = makeRT(Math.max(8, sw >> 1), Math.max(8, sh >> 1));
  fxLayer.uniforms.tDepth.value = sceneRT.depthTexture;
  fxLayer.uniforms.uInvRes.value.set(1 / fxRT.width, 1 / fxRT.height);
  fxLayer.uniforms.uNear.value = camera.near; fxLayer.uniforms.uFar.value = camera.far;
  histRT = [makeRT(cw, ch), makeRT(cw, ch)];
  histValid = false;
  maxLod = Math.floor(Math.log2(Math.max(sw, sh)));
  updateProjection();
  resizeOverlay(cw, ch);
  camMat.uniforms.uMaxLod.value = maxLod;
  camMat.uniforms.uAspect.value = cw / ch;
  presentMat.uniforms.uRes.value.set(cw, ch);
  reflMat.uniforms.uFocal.value = sh / (2 * Math.tan(vfovRad / 2));
  reflMat.uniforms.uTexelY.value = 1 / sh;
  expoInit = true;
}

// ---------------------------------------------------------------- optional GPU profiling (one timer query per pass)
let prof = null;
function timed(name, fn) {
  if (!prof) return fn();
  const gl = prof.gl, q = gl.createQuery();
  gl.beginQuery(prof.ext.TIME_ELAPSED_EXT, q); fn(); gl.endQuery(prof.ext.TIME_ELAPSED_EXT);
  prof.pending.push([name, q]);
}
// exposed for tuning from the console (window.__bc.post)
export const postUniforms = { camera: camMat.uniforms, tape: presentMat.uniforms, raw: rawMat.uniforms };
// after a cut (footage seek, teleport): don't blend with the old history, and let exposure snap to the new view
export function resetTemporal() { histValid = false; expoInit = true; }
// A tape glitch over a doorway (x, z on the wall's face, its outward normal nx, nz; w wide, h high) where the space has just
// changed in view (world/level.js). It lasts GLITCH_T seconds; the doorway's box on screen follows the camera.
const GLITCH_T = 0.45, glitch = { t: 0, c: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] };
const _gp = new THREE.Vector3(), _gf = new THREE.Vector3();
export function glitchDoorway(x, z, nx, nz, w, h) {
  const tx = -nz * w / 2, tz = nx * w / 2;
  glitch.c[0].set(x - tx, 0, z - tz); glitch.c[1].set(x + tx, 0, z + tz); glitch.c[2].set(x - tx, h, z - tz); glitch.c[3].set(x + tx, h, z + tz);
  glitch.t = GLITCH_T;
}
function updateGlitch(dt, U) {
  if (glitch.t <= 0) { U.uGlitch.value = 0; return; }
  glitch.t -= dt;
  camera.getWorldDirection(_gf);
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0, n = 0;
  for (const c of glitch.c) {
    if (_gp.copy(c).sub(camera.position).dot(_gf) < 0.05) continue;   // (a corner beside or behind you: the box is what's in front)
    _gp.copy(c).project(camera); n++;
    const u = _gp.x * 0.5 + 0.5, v = _gp.y * 0.5 + 0.5;
    x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
  }
  if (n < 2 || x1 < 0 || x0 > 1 || y1 < 0 || y0 > 1) { U.uGlitch.value = 0; return; }   // (out of the picture)
  U.uGlitchRect.value.set(Math.max(x0, -0.1), Math.max(y0, -0.1), Math.min(x1, 1.1), Math.min(y1, 1.1));
  U.uGlitch.value = Math.pow(Math.max(glitch.t, 0) / GLITCH_T, 0.6);
}

// (testing) how much of the frame the smoke hides: the fire layer's alpha, its mean and the share of it above 0.5
export function fxCoverage() {
  if (!fxRT || fxLayer.count === 0) return { mean: 0, over50: 0 };
  const w = fxRT.width, h = fxRT.height, half = rtType === THREE.HalfFloatType, buf = half ? new Uint16Array(w * h * 4) : new Float32Array(w * h * 4);
  renderer.readRenderTargetPixels(fxRT, 0, 0, w, h, buf);
  let s = 0, n50 = 0;
  for (let i = 3; i < buf.length; i += 4) { const a = half ? THREE.DataUtils.fromHalfFloat(buf[i]) : buf[i]; s += a; if (a > 0.5) n50++; }
  return { mean: +(s / (w * h)).toFixed(3), over50: +(n50 / (w * h)).toFixed(3) };
}

// current auto-exposure state (debugging): adapted log2 luminance, the exposure the camera wants, and what it uses
const _expoBuf = new Float32Array(4);
export function readExposure() {
  if (!expoRT || expoType !== THREE.FloatType) return null;
  renderer.readRenderTargetPixels(expoRT[expoIdx], 0, 0, 1, 1, _expoBuf);
  const u = camMat.uniforms, avgLog = _expoBuf[0], hiLog = _expoBuf[1], dEv = avgLog - Math.log2(0.15);   // mirrors the camera pass
  const exWant = Math.min(Math.pow(2, -(dEv > 0 ? 0.92 : u.uExpoK.value) * dEv), u.uHiCap.value / Math.pow(2, hiLog));
  return { avgLog: +avgLog.toFixed(2), hiLog: +hiLog.toFixed(2), exWant: +exWant.toFixed(3), ex: +Math.min(Math.max(exWant, 0.03), u.uExpoMax.value).toFixed(3),
    wb: [+_expoBuf[2].toFixed(3), +_expoBuf[3].toFixed(3)] };   // the adapted average colour: log2 r/g, b/g
}

// runs `step(dt)` n times and returns the median GPU milliseconds per pass
export async function profilePasses(n, step) {
  const gl = renderer.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return 'timer queries not available';
  prof = { gl, ext, pending: [] };
  for (let i = 0; i < n; i++) { step(1 / 30); await new Promise(r => setTimeout(r, 5)); }
  const pending = prof.pending; prof = null;
  await new Promise(r => setTimeout(r, 300));
  const sums = {};
  for (const [name, q] of pending) { if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) (sums[name] ||= []).push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); }
  const out = {}; let total = 0;
  for (const k in sums) { const v = sums[k].sort((a, b) => a - b), med = v[v.length >> 1]; out[k] = +med.toFixed(2); total += med; }
  out.total = +total.toFixed(2); out.res = RES[state.qi].join('x');
  return out;
}

// ---------------------------------------------------------------- one frame
const HALTON = [[0.5, 0.333], [0.25, 0.667], [0.75, 0.111], [0.125, 0.444], [0.625, 0.778], [0.375, 0.222], [0.875, 0.556], [0.0625, 0.889]];
const vp = new THREE.Matrix4(), prevVP = new THREE.Matrix4();
let first = true, frameIdx = 0, bandPhase = 0;
// autofocus: when what's in front of the camera jumps nearer or further, the lens hunts for a moment (and in the dark,
// where it can't find contrast, now and then on its own)
const af = { dist: 3, hunt: 0, next: 6 };
function autofocus(dt, P) {
  const want = Math.max(P.beamD ?? 3, 0.4);
  if (Math.abs(Math.log(want / af.dist)) > 0.8 && af.hunt <= 0) af.hunt = 0.7;
  af.dist += (want - af.dist) * (1 - Math.exp(-dt * 6));
  if ((af.next -= dt) <= 0) { af.next = 6 + Math.random() * 14; if (Math.random() < 0.5) af.hunt = Math.max(af.hunt, 0.9); }
  af.hunt = Math.max(0, af.hunt - dt);
  return af.hunt > 0 ? 1.4 * Math.sin(af.hunt * 9.0) ** 2 * Math.min(1, af.hunt * 3) : 0;
}

export function renderFrame(dt, P) {
  drawOverlay(false);
  // sub-pixel jitter each frame; the temporal filter in the camera pass turns it into anti-aliasing
  camera.projectionMatrix.copy(baseProj);
  if (state.fx) { const [jx, jy] = HALTON[frameIdx % 8]; camera.projectionMatrix.elements[8] += (jx - 0.5) * 2 / sceneRT.width; camera.projectionMatrix.elements[9] += (jy - 0.5) * 2 / sceneRT.height; }
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  frameIdx++;
  camera.updateMatrixWorld();
  vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (first) { prevVP.copy(vp); first = false; }
  if (state.flashOn) renderer.shadowMap.needsUpdate = true;
  timed('scene', () => { renderer.setRenderTarget(sceneRT); renderer.render(scene, camera); });
  const fire = flags.fire && fxLayer.count > 0;
  if (fire) {
    timed('fire', () => {
      renderer.setRenderTarget(fxRT); renderer.setClearColor(0x000000, 0); renderer.clear(true, false, false);
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.render(fxLayer.scene, camera);
      renderer.autoClear = ac; renderer.setClearColor(0x000000, 1);
    });
    timed('composite', () => {
      compMat.uniforms.tFx.value = fxRT.texture; fsQuad.material = compMat;
      const ac = renderer.autoClear; renderer.autoClear = false;
      renderer.setRenderTarget(sceneRT); renderer.render(fsScene, fsCam);
      renderer.autoClear = ac;
    });
  }
  if (flags.ssr) {
    const u = reflMat.uniforms;
    u.tDepth.value = sceneRT.depthTexture; u.tScene.value = sceneRT.texture;
    u.uProj.value.copy(camera.projectionMatrix); u.uInvProj.value.copy(camera.projectionMatrixInverse); u.uInvView.value.copy(camera.matrixWorld);
    u.uFloorN.value.set(0, 1, 0).transformDirection(camera.matrixWorldInverse);
    timed('reflections', () => { fsQuad.material = reflMat; renderer.setRenderTarget(reflRT); renderer.render(fsScene, fsCam); });
  }
  if (state.fx) {
    const A = camMat.uniforms;
    if (expoRT) {
      const src = expoRT[expoIdx], dst = expoRT[1 - expoIdx], eu = expoMat.uniforms;
      eu.tScene.value = sceneRT.texture; eu.tPrev.value = src.texture; eu.uLod.value = Math.max(0, maxLod - 3); eu.uDt.value = dt; eu.uInit.value = expoInit ? 1 : 0;
      fsQuad.material = expoMat; renderer.setRenderTarget(dst); renderer.render(fsScene, fsCam);
      expoIdx = 1 - expoIdx; expoInit = false;
      A.tExpo.value = expoRT[expoIdx].texture;
    }
    bandPhase += dt * 0.23;
    A.tScene.value = sceneRT.texture; A.tDepth.value = sceneRT.depthTexture; A.tRefl.value = reflRT.texture; A.uReflOK.value = flags.ssr ? 1 : 0;
    A.tHist.value = histRT[histIdx].texture; A.uHistOK.value = histValid && flags.tnr ? 1 : 0;
    A.uInvViewProj.value.copy(vp).invert(); A.uPrevViewProj.value.copy(prevVP);
    A.uTime.value = P.t;
    A.uRollX.value = 0; A.uRollY.value = 0;   // (a CCD: no rolling shutter)
    A.uBand.value = 0;
    A.uDefocus.value = autofocus(dt, P);
    A.uBandPhase.value = bandPhase;
    A.uWB.value = 0.006 * Math.sin(P.t * 0.07) - (state.flashOn ? 0.01 : 0);
    A.uInterf.value = fx.interf; A.uMoldLens.value = fx.lens;
    A.tFx.value = fxRT.texture; A.uHeat.value = fire && flags.haze ? fx.heat : 0;
    const dst = histRT[1 - histIdx];
    timed('camera', () => { fsQuad.material = camMat; renderer.setRenderTarget(dst); renderer.render(fsScene, fsCam); });
    histIdx = 1 - histIdx; histValid = true;
    const B = presentMat.uniforms;
    updateGlitch(dt, B);
    B.tHist.value = dst.texture; B.tPrev.value = histRT[1 - histIdx].texture; B.uTime.value = P.t;
    B.uMotion.value = smooth(0.5, 3.0, Math.abs(state.yawRate) + Math.abs(state.pitchRate)) + 0.25 * smooth(2.0, 3.2, P.speed);
    B.uCorrupt.value = fx.corrupt; B.uEnhance.value = fx.enhance; B.uInterf.value = fx.interf;
    timed('tape', () => { fsQuad.material = presentMat; renderer.setRenderTarget(null); renderer.render(fsScene, fsCam); });
  } else {
    rawMat.uniforms.tScene.value = sceneRT.texture; rawMat.uniforms.tRefl.value = reflRT.texture; rawMat.uniforms.uReflOK.value = flags.ssr ? 1 : 0;
    timed('raw', () => { fsQuad.material = rawMat; renderer.setRenderTarget(null); renderer.render(fsScene, fsCam); });
  }
  prevVP.copy(vp);
}
