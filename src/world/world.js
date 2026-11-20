// What the player, audio, weapon and renderer need to know about the current level. Filled in by the level that is built.
export const world = {
  groundY: (x, z) => 0,      // floor height under a point
  ceiling: 2.6,              // aiming rays, fire and smoke stop here
  raycast: null,             // optional (origin, dir) => distance, replacing the flat-floor + box raycast
  fixtures: [],              // fluorescent fixtures the audio hums with
  ambience: 'backrooms',     // which soundscape audio.js plays
  flashCd: 48,               // weapon light centre intensity (candela), relative to the level's lighting (at 24, mold
                             // 3-5 m ahead in a dark room couldn't be told from the dark)
  ambient: 0.35,             // how much room light falls on smoke (it is lit by nothing else but the flames)
  // set by world/level.js: burn the mold round a world point; a world point on a surface in its room's coordinates;
  // and (main.js) what to do when a room is no longer placed
  burn: () => 0, toRoom: null, onRemoveRoom: null, moldAt: () => null,
  onSpaceShift: null,        // (x, z, nx, nz, h): a room just appeared in a doorway you can see (main.js glitches the tape there)
  forceCrouch: false,        // a ceiling or doorway too low to stand in (a crawlspace)
  inWater: false,            // you're in a flooded room (splashing steps, wading slower, rings round your feet)
  wetNear: false,            // a flooded room is placed near you (the reflection pass runs)
};
