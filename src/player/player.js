// The player and the chest-mounted camera rig: movement, collision, crouching, footsteps, and all the ways a
// body-worn camera moves differently from a game camera (lag, stride twist, bob, jolts, breathing, tilt).
// The hands (the hand springs below) hold the flamethrower; weapon/flamethrower.js poses it from P.hand* and P.aim.
import * as THREE from 'three';
import { camera } from '../core/context.js';
import { rng, clamp, smooth, shk } from '../core/util.js';
import { state } from '../state.js';
import { colliders, actorCircles, raycastWorld } from '../world/builder.js';
import { world } from '../world/world.js';
import { stepSound } from '../audio/audio.js';

const MOUNT_ROLL = -0.035, MOUNT_PITCH = -0.05;   // a chest mount is never perfectly level

// hOff, rollOff: footage only (a clip's camera height above the chest mount, and an extra roll): a camera that has
// fallen off the vest lies still on the ground, on its side
export const P = { crouchK: 0, aim: new THREE.Vector3(), hOff: 0, rollOff: 0, x: 0, z: 0.6, vx: 0, vz: 0, aimYaw: 0, aimPitch: 0, camYaw: 0, camYawV: 0, camPitch: 0, camPitchV: 0, phase: 0, joltY: 0, joltV: 0, kickP: 0, kickPV: 0, lean: 0, leanV: 0, prevFv: 0, exert: 0, t: 0, speed: 0, handYaw: 0, handYawV: 0, handPitch: 0, handPitchV: 0, beamD: 6 };
export const keys = {};
export const stick = { x: 0, y: 0, mag: 0 };
// A cutscene can take the body over (game.js: g.control, g.moveTo, g.lookAt). It walks or runs along `path` ([x, z]
// points), looking where it goes or at `look` ([x, y, z]); the player's input is ignored meanwhile. The camera rig
// works from the motion as usual, so a cutscene looks (and records) exactly like the player moving.
export const auto = { on: false, path: [], speed: 3.3, look: null, turn: 7, resolve: null, stuck: 0 };
let prevYawT = 0, prevPitchT = 0;
const _dir = new THREE.Vector3(), _eye = new THREE.Vector3();

function collide() {
  const r = 0.3;
  for (let it = 0; it < 2; it++) for (const b of colliders) {
    if (b.y0 > 0.5) continue;   // overhead (a doorway's header)
    const cx = clamp(P.x, b.x0, b.x1), cz = clamp(P.z, b.z0, b.z1), dx = P.x - cx, dz = P.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-9) { const d = Math.sqrt(d2); P.x = cx + dx / d * r; P.z = cz + dz / d * r; }
    else {
      const pl = P.x - b.x0, pr = b.x1 - P.x, pb = P.z - b.z0, pf = b.z1 - P.z, m = Math.min(pl, pr, pb, pf);
      if (m === pl) P.x = b.x0 - r; else if (m === pr) P.x = b.x1 + r; else if (m === pb) P.z = b.z0 - r; else P.z = b.z1 + r;
    }
  }
  for (const a of actorCircles) {   // characters
    const dx = P.x - a.x, dz = P.z - a.z, rr = r + a.r, d2 = dx * dx + dz * dz;
    if (d2 < rr * rr && d2 > 1e-9) { const d = Math.sqrt(d2); P.x = a.x + dx / d * rr; P.z = a.z + dz / d * rr; }
  }
}

// put the player somewhere (a save, the dev panel): no footstep or camera swing from the jump
export function teleport(x, z, yaw = P.aimYaw, pitch = 0) {
  Object.assign(P, { x, z, lx: x, lz: z, vx: 0, vz: 0, aimYaw: yaw, aimPitch: pitch });
  resetRig();
}
// settle the camera rig on the current aim (after a teleport or a footage seek)
export function resetRig() {
  Object.assign(P, { camYaw: P.aimYaw, camYawV: 0, camPitch: P.aimPitch * 0.9, camPitchV: 0, handYaw: P.aimYaw, handYawV: 0, handPitch: P.aimPitch, handPitchV: 0,
    joltY: 0, joltV: 0, kickP: 0, kickPV: 0, lean: 0, leanV: 0, prevFv: 0 });
  P.gy = undefined;
}

export function updatePlayer(dt) {
  P.t += dt;
  let fwd = 0, str = 0, sprint = false, ax = 0, az = 0;
  const driven = auto.on && !P.puppet;
  if (driven) {
    // the next point on the path (corners are cut a little, as a person would)
    const far = q => Math.hypot(q[0] - P.x, q[1] - P.z);
    while (auto.path.length > 1 && far(auto.path[0]) < 0.7) auto.path.shift();
    if (auto.path.length === 1 && far(auto.path[0]) < 0.3) auto.path.shift();
    if (auto.path.length) { const dx = auto.path[0][0] - P.x, dz = auto.path[0][1] - P.z, d = Math.hypot(dx, dz); ax = dx / d; az = dz / d; sprint = auto.speed > 2; }
    else if (auto.resolve) { const r = auto.resolve; auto.resolve = null; r(); }
    // where it looks: at a point, or where it's going (running: eyes on the floor ahead)
    let wy = null, wp = null;
    if (auto.look) { const [lx, ly, lz] = auto.look; wy = Math.atan2(-(lx - P.x), -(lz - P.z)); wp = Math.atan2(ly - ((P.gy ?? 0) + 1.33), Math.hypot(lx - P.x, lz - P.z)); }
    else if (ax || az) { wy = Math.atan2(-ax, -az); wp = -0.12; }
    if (wy !== null) {
      const k = 1 - Math.exp(-dt * auto.turn), dy = Math.atan2(Math.sin(wy - P.aimYaw), Math.cos(wy - P.aimYaw));
      P.aimYaw += clamp(dy * k, -10 * dt, 10 * dt);
      P.aimPitch += (wp - P.aimPitch) * k;
    }
  } else if (state.started && !P.puppet) {
    fwd = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) - stick.y;
    str = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + stick.x;
    sprint = !!(keys.ShiftLeft || keys.ShiftRight) || stick.mag > 0.92;
  }
  const il = Math.hypot(fwd, str); if (il > 1) { fwd /= il; str /= il; }
  const ox = P.lx ?? P.x, oz = P.lz ?? P.z;
  if (P.puppet) {   // footage playback has already placed the player; the camera rig still works from the motion
    P.vx = (P.x - ox) / Math.max(dt, 1e-4); P.vz = (P.z - oz) / Math.max(dt, 1e-4);
    sprint = Math.hypot(P.vx, P.vz) > 2.2;
  } else {
    let tx, tz;
    if (driven) { tx = ax * auto.speed; tz = az * auto.speed; }   // it runs where it's going, wherever it looks
    else {
      if (state.crouch || world.forceCrouch) sprint = false;
      const spd = (sprint ? 3.0 : 1.45) * (1 - 0.45 * P.crouchK) * (P.fast ? 3 : 1) * (world.inWater ? 0.85 : 1), sy = Math.sin(P.aimYaw), cy = Math.cos(P.aimYaw);
      tx = (-sy * fwd + cy * str) * spd; tz = (-cy * fwd - sy * str) * spd;
    }
    const a = 1 - Math.exp(-dt * ((driven ? ax || az : il > 0.01) ? 5 : 8));
    P.vx += (tx - P.vx) * a; P.vz += (tz - P.vz) * a;
    P.x += P.vx * dt; P.z += P.vz * dt;
    if (!P.noclip) collide();   // noclip: dev panel
  }
  P.lx = P.x; P.lz = P.z;
  P.speed = Math.hypot(P.x - ox, P.z - oz) / Math.max(dt, 1e-4);
  if (driven && auto.path.length) {   // caught on something: give up on that point and head for the next
    auto.stuck = P.speed < 0.4 ? auto.stuck + dt : 0;
    if (auto.stuck > 0.6) { auto.path.shift(); auto.stuck = 0; }
  }
  const sf = Math.min(P.speed / 3, 1);
  // crouching: about half a metre lower, eased (a person takes a moment to get down and up)
  P.crouchK += ((state.crouch || world.forceCrouch ? 1 : 0) - P.crouchK) * (1 - Math.exp(-dt * 7));
  const camH = 1.33 - 0.5 * P.crouchK;
  P.exert = clamp(P.exert + (sprint && P.speed > 2 ? dt * (driven ? 0.9 : 0.22) : -dt * 0.1), 0, 1);   // running for your life: out of breath fast

  // inertia: the torso pitches back when you set off and forward when you stop
  const fv = -Math.sin(P.camYaw) * P.vx - Math.cos(P.camYaw) * P.vz;
  const acc = (fv - P.prevFv) / Math.max(dt, 1e-4); P.prevFv = fv;
  const leanT = clamp(acc * 0.009, -0.035, 0.035);

  // footsteps
  const prevPhase = P.phase;
  P.phase += P.speed * dt / (sprint ? 0.95 : 0.72) * Math.PI;
  if (Math.floor(P.phase / Math.PI) > Math.floor(prevPhase / Math.PI) && P.speed > 0.3) {
    P.joltV -= 0.25 + 0.45 * sf; P.kickPV += (rng() - 0.5) * 0.12 - 0.05 * sf;
    stepSound(sf, world.inWater);
  }
  // The rig is a set of damped springs, integrated in small substeps: in one big step (a slow phone, a stall) the stiff
  // ones (the hand holding the flashlight, the jolt of each step) overshoot further every frame and shake the picture.
  const n = Math.min(Math.ceil(dt / 0.02), 8), h = dt / n;
  for (let i = 0; i < n; i++) {
    P.leanV += (90 * (leanT - P.lean) - 12 * P.leanV) * h; P.lean += P.leanV * h;
    P.joltV += (-170 * P.joltY - 15 * P.joltV) * h; P.joltY += P.joltV * h;
    P.kickPV += (-120 * P.kickP - 14 * P.kickPV) * h; P.kickP += P.kickPV * h;
    if (state.fx) {   // the chest turns slower than the player aims: spring with a little overshoot
      P.camYawV += (55 * (P.aimYaw - P.camYaw) - 10.5 * P.camYawV) * h; P.camYaw += P.camYawV * h;
      P.camPitchV += (70 * (P.aimPitch * 0.9 - P.camPitch) - 14 * P.camPitchV) * h; P.camPitch += P.camPitchV * h;
    }
    // the hand follows your aim quickly but smoothly, ahead of the slower chest camera
    P.handYawV += (160 * (P.aimYaw - P.handYaw) - 24 * P.handYawV) * h; P.handYaw += P.handYawV * h;
    P.handPitchV += (160 * (P.aimPitch - P.handPitch) - 24 * P.handPitchV) * h; P.handPitch += P.handPitchV * h;
  }

  const cyw = Math.cos(P.camYaw), syw = Math.sin(P.camYaw), rx = cyw, rz = -syw, fwX = -syw, fwZ = -cyw;
  const gy = world.groundY(P.x, P.z);   // ground under the feet, smoothed so uneven terrain doesn't jitter the camera
  P.gy = P.gy === undefined ? gy : P.gy + (gy - P.gy) * (1 - Math.exp(-dt * 12));
  if (state.fx) {
    const worn = 1 - smooth(0.3, 0.9, -P.hOff);   // 0: the camera has fallen off the vest and lies still
    const walkAmt = smooth(0.05, 0.8, P.speed) * worn;
    const bob = Math.abs(Math.sin(P.phase)) * (0.016 + 0.032 * sf) * walkAmt;
    const sway = Math.sin(P.phase) * 0.02 * (0.4 + sf) * walkAmt;
    const twist = Math.sin(P.phase) * (0.016 + 0.018 * sf) * walkAmt;   // shoulders counter-rotate with every stride
    const amp = (0.0028 + 0.0065 * sf + P.exert * 0.004) * worn;
    const breath = Math.sin(P.t * (1.5 + P.exert * 1.8)) * 0.0035 * (1 + P.exert * 2) * worn;
    camera.position.set(P.x + rx * (0.07 + sway) + fwX * 0.12, P.gy + camH + P.hOff + bob + P.joltY * worn, P.z + rz * (0.07 + sway) + fwZ * 0.12);
    const yawT = P.camYaw + twist + (shk(P.t * 0.21 + 5) * 0.012 + shk(P.t * 1.1) * amp) * worn;
    const pitchT = P.camPitch + MOUNT_PITCH * worn + P.lean * worn + shk(P.t * 1.3 + 10) * amp + P.kickP * worn + breath;
    const rollT = MOUNT_ROLL * worn + P.rollOff + shk(P.t * 0.17 + 9) * 0.01 * worn + Math.sin(P.phase) * 0.012 * (0.5 + sf) * walkAmt + shk(P.t * 0.9 + 20) * amp * 1.5 - P.camYawV * 0.008 * worn;
    camera.rotation.set(pitchT, yawT, rollT);
    state.yawRate = (yawT - prevYawT) / Math.max(dt, 1e-4); state.pitchRate = (pitchT - prevPitchT) / Math.max(dt, 1e-4);
    prevYawT = yawT; prevPitchT = pitchT;
  } else {
    P.camYaw = P.aimYaw; P.camPitch = P.aimPitch; P.camYawV = P.camPitchV = 0;
    camera.position.set(P.x, P.gy + camH + 0.32, P.z);
    camera.rotation.set(P.aimPitch, P.aimYaw, 0);
    state.yawRate = state.pitchRate = 0; prevYawT = P.aimYaw; prevPitchT = P.aimPitch;
  }
  camera.updateMatrixWorld();

  // Where the hands aim (springs above): the point the camera ray along the hand's direction hits. The flamethrower and
  // its light converge on it, so the stream and the beam land where you look at any distance.
  const hy = P.handYaw + shk(P.t * 1.7 + 30) * 0.004, hp = P.handPitch + shk(P.t * 1.9 + 40) * 0.004;
  _dir.set(-Math.sin(hy) * Math.cos(hp), Math.sin(hp), -Math.cos(hy) * Math.cos(hp));
  _eye.copy(camera.position);
  const hitD = world.raycast ? world.raycast(_eye, _dir) : raycastWorld(_eye, _dir, world.ceiling);
  P.beamD += (hitD - P.beamD) * (1 - Math.exp(-dt * 12));   // smoothed, so edges of walls don't make it jump
  P.aim.copy(_eye).addScaledVector(_dir, P.beamD);
  P.wallD = hitD;   // unsmoothed: how much room the flamethrower has in front of it
}
