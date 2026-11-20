// Shared runtime state. Kept deliberately small: modules read and write these fields directly.
export const state = {
  fx: true,          // bodycam processing on (V toggles a plain game camera)
  flashOn: false,    // the light mounted on the flamethrower
  qi: 1,             // index into RES in render/pipeline.js (main.js picks 0 on touch devices)
  started: false,    // the start screen has been dismissed
  yawRate: 0,        // camera angular speed in rad/s: drives rolling shutter, codec smear and clothing rustle
  pitchRate: 0,
  ui: null,          // an open panel; look and move input is ignored while set
  trigger: false,    // the flamethrower's trigger is held (mouse button, the FIRE button on touch)
  crouch: false,     // C / Ctrl: crouching (crawlspaces, ducking under things)
  use: false,        // E (USE on a phone) is held: doors, a generator, fuel cans (world/interact.js)
  usePressed: false, // ... and was pressed since the last frame
};

// debug toggles for the costlier passes (window.__br.flags)
export const flags = { ssr: false, tnr: true, fire: true, haze: true };

// Camera effects requested by the game layer and applied by render/pipeline.js.
export const fx = {
  interf: 0,      // 0-1: electrical interference in the sensor readout (torn rows, bad lines, noise)
  corrupt: 0,     // 0-1: damage to the recording itself (broken macroblocks, lost slices)
  enhance: 0,     // 0-1: footage review "enhance" (shadows lifted, sharpened)
  heat: 0,        // 0-1: heat shimmer strength (the flamethrower and anything burning), set by weapon/fire.js
  lens: 0,        // 0-1: mold grown over the lens (the end)
  flash: 1,       // weapon light output multiplier (flicker, failure)
  drop: 0,        // 0-1: extra chance per frame that the camera drops a frame
};
