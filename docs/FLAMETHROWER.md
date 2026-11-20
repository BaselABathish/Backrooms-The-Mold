# The flamethrower

Status: prototype, in the test room (`world/testroom.js`). Infinite fuel, no damage yet, no mold yet.
- 2026-11-20: first version.
- Playtest 1, same day: "looks nice, but there are still balls of fire; it should be more continuous". The jet is now drawn as one continuous body (see "How the jet is drawn"), and fires left burning on surfaces have a body of flame of their own.

## What you see and hear

- **The wand, always in frame.** It sits at the lower right, held at the hip: the barrel, a perforated heat shield, the nozzle, an igniter tube with a pilot flame, a light on the right side, a pressure gauge facing the camera, and a fuel hose running out of shot. There are no hands (characters looked unconvincing in Signal Loss).
  - It points where the hands aim (player.js hand springs, ahead of the slower chest camera). It converges on what the camera looks at, never closer than 2.8 m, and is held a little high for the distance, so the falling stream lands on the aim point.
  - Near a wall it slides back just enough to keep the nozzle off the wall, the hands come up, and it dips slightly. It stays in the picture.
- **The pilot flame.** A small blue flame with a yellow tip, always burning. It throws a faint light on the nozzle and on a wall up close.
- **The valve.** Opening it clicks, the stream lights with a soft heavy thump, and the wand kicks up a little. While it runs, it roars, the fuel hisses, the wand shivers, and the gauge needle drops from about 210 to 150 psi and jitters. Shutting it clacks, and the flame chokes off with a sputter. A few burning drops run out of the nozzle and fall.
- **The stream.** One continuous jet: a thin bright rope out of the nozzle that swells into a rolling, turbulent flame as the fuel burns. It falls a little, slows, and rises. It bends into a whip when you swing, because the fuel keeps the motion it left the nozzle with.
- **Splashes.** Where it hits a wall, floor or ceiling, the fuel fans out along the surface, sticks and keeps burning: a surface fire. Each draws one body of flame (white at the heart, through yellow and orange to a dull red rim, breaking into tongues at the top), plus licks of flame that break away from it, sparks and smoke. Fire climbs walls and rolls along the ceiling.
- **Smoke.** A thin haze of soot that rises fast, pools under the ceiling and drifts. Flames light it orange from below. It darkens a lit wall but never hides it, so you can always see where you're going, and it thins out further right in front of the lens.
- **Scorch.** Soot builds up where fuel lands and along where a splash slides. Marks belong to the room they're on (up to 160 a room) and stay there wherever the room is placed. Streaks climb the wall above anything that keeps burning. Fresh marks glow with dull red ember specks for a second or two. Marks only ever get darker.
- **Burning mold.** Fire shrivels the mold it touches: every fire on a surface burns the mold round it, a splash burns a patch, and the stream burns along where it slides. Burnt mold turns to ash and black char that nothing grows on for about half a minute, with embers in the freshest, and it sizzles and pops while it burns. Details in docs/MOLD.md.
- **Mold catches fire** (playtest 2: "fire should spread more"). Mold is fuel:
  - A fire on mold feeds on it and lasts as long as there's mold under it.
  - Fire creeps over thick mold: from a burning fire, the thickest living mold about half a metre away catches. It climbs a little more readily, and goes round corners from floor to wall to ceiling, since each mold cell knows which way it faces.
  - A creeping fire goes at most 4 steps from where the stream hit, so a one-second burst at a colony becomes a burning front about 2 m across that eats into it for 5–7 s, then dies out.
  - The splash also fans out 40% further and burns a wider patch.
- **Fuel.** The tank holds `FUEL_MAX` = 500 s of fire at full flow (100 until round 8), and only the gauge shows it: its pressure falls with the fuel, from 210 psi full toward 25 psi empty, and drops further while the fuel runs. On an empty tank the trigger only clicks and breathes out a last puff of gas, and the pilot stays lit. Fuel cans refill 225 (45% of the tank, as before). A safe room's generator burns the same fuel. `__br.weapon.infinite = true` turns the limit off.
- **Light.** Two point lights follow the fire, one for the stream and one for the fires it starts. They flicker, they're kept clear of surfaces (0.6 and 0.7 m), and every point light softens close up (`world/materials.js`), so a wall next to a fire doesn't flare into a white patch.
- **The camera.** The fire goes through the same camera as everything else (see below): auto exposure pulls down when flames fill the view, the core clips and blooms, hot air shimmers over the flames, and the tape smears it. In the dark corridor the camera's exposure drops from its gain limit (2.4) to about 1.06 when you fire.

## How it works

| File | What it does |
|---|---|
| `weapon/flamethrower.js` | The model, its pose every frame, the pilot flame, the weapon light, the valve, the gauge. It fills `fire.nozzle` (flow, drip, last and current nozzle position and direction, velocity). |
| `weapon/fire.js` | The particles (stream, licks, smoke, embers), surface fires, the two fire lights, heat shimmer strength, and the burning sound level. It draws into the fire layer. |
| `weapon/scorch.js` | Soot decals (one instanced mesh, 420 marks, oldest reused). |
| `weapon/noise3d.js` | A 64³ tileable noise texture (two channels), made at load in about 0.2 s. |
| `render/pipeline.js` | The fire layer (`fxLayer`): drawn at half resolution after the scene, then composited over it before exposure, bloom and the camera pass. Heat shimmer is in the camera pass, masked by the fire layer. |
| `audio/audio.js` | `flameStart`, `flameStop`, `setFlame(flow)`, `setBurning(level)`. |

- **Particles are simulated on the CPU,** structure of arrays, up to 1100. Each frame they're sorted back to front and drawn as one instanced draw. Premultiplied blending: flames add light and smoke hides what's behind it, in one pass.
- **The stream emits along the nozzle's path** through the frame, on an even beat that carries over from frame to frame, each particle advanced by the part of the frame since it left. An uneven gap shows in the jet as a pulse.
- **Turbulence.** Tongues of flame, a fire's body and smoke read one shared noise field that rises through the room. Where they overlap, their billows line up into one body of flame or smoke instead of averaging into a smooth ball. This was the difference between "glass balls" and smoke that reads as real. The jet reads its own field, which flows out with the fuel (below).
- **Particles are soft where they meet the room** (they read the scene's depth) and hidden behind walls. They're never smaller than about 1.5 pixels of the fire layer (the jet 2.5): smaller ones twinkle, so they are enlarged and dimmed.
- **Collisions** use the level's colliders plus the floor and ceiling. A particle stays a little off a surface in proportion to its size.

### How the jet is drawn (the "balls of fire" fix)
Before playtest 1, each stream particle was a soft ball with its own pattern, and the jet read as a string of balls. Now the particles are samples of one continuous body:
- **A window, not a ball.** Each particle stands for a short stretch of a tube along the jet: a soft window as long as the gap to the next particle (σ = 1.1 gaps), weighted so that the windows of a run of particles add up to one. The tube's radius follows the fuel's age exactly (no randomness), so neighbours agree.
- **Along the jet's bend, not its flight.** Each particle tracks the gap to the fuel that left just after it (`sg`, with its growth `sgv` from how fast the nozzle was turning). Out of a still nozzle that is just the jet's speed; when you swing, the jet bends away from the direction the fuel flies, and the windows follow the bend. Laid along the flight, a swung jet fell apart into blobs.
- **In perspective, per pixel.** Each window's quad covers where its stretch of tube projects (both ends in perspective: right after the nozzle the jet heads almost straight away from the camera, and perspective, not its slant, spreads it over the screen). Each pixel intersects its own ray with the tube and gets as much flame as the ray passes through: the jet's thickness side on, its length end on.
- **The flame is read nearest the axis.** The turbulence and the jet's cross-section are read at the point of that path, within the window's core, nearest the jet's axis, in the fuel's own coordinates: across the jet, and along it by when that fuel left the nozzle (`tauE`). So the pattern flows out with the fuel and churns as it ages. Read at the window's middle instead, a ray down the jet met each window's core only near its own crossing, and the windows lit up one at a time: beads.
- **Thin means soft.** Where the jet is only a few pixels wide (right out of the nozzle), its flame front is softened. A sharp edge sampled pixel by pixel along a thin diagonal line breaks it up into beads.
- **Debugging:** `__br.fire.density(true)` draws only how much jet each pixel's ray passes through, in grey. It should be smooth; if it is and the flame isn't, the problem is in the shading, not the geometry.

## Tuning (live, from the console)

`__br.fire.cfg`:
- `rate`: stream particles per second (190). The jet stays continuous at any rate; fewer means wider windows.
- `speed`: 14.5 m/s.
- `spread`: 0.018 rad.
- `smokeP`: chance a stream puff leaves smoke (0.12). `smokeFire`: smoke puffs a second from a surface fire at full strength (2.0).
- `flame`: flame brightness relative to the room (5). At 24 it was a blown-out white blob with a huge halo.
- `lightK`: room light per unit of flame (0.55).
- Burning mold:
  - `moldFuel` (0.014 s of burning per unit of mold burnt) and `moldFuelMax` (at most 1.5 s gained per second);
  - `spreadMin`: how thick mold must be to catch (0.45);
  - `spreadDist` (0.5 m), `spreadRate` (1.3 a second at full strength), `spreadGen` (4 steps from the stream's hit).
- `splash`: how far a splash reaches along the surface, and the patch it burns (1.4).

Also: `__br.flags.fire` and `__br.flags.haze` turn the fire layer and the shimmer off, `__br.fire.stats()` counts what's alive, and `__br.fire.clear()` clears it.

## Measured (2026-11-20, hidden Browser pane, 540p; a visible pane reads about 2x faster)

- **GPU:** idle about 16.4 ms a frame. Firing at a wall about 20.2 ms: the fire layer 1.75 ms (1.1 before the continuous jet), the composite 0.4 ms, the rest is the scene lit by the fire lights.
- **CPU:** about 2.5 ms per simulated frame with about 300 particles alive (sorting and uploading included).
- **Brightness:** hall mean 0.32, dark corridor 0.08, the corridor while firing 0.25.

## Not done yet

- Fuel: a tank that runs dry (the gauge is ready to show it), refills found in the level.
- Damage: firing at a wall half a metre away engulfs you, and should hurt.
- Mold: fire is meant to slow it and burn it away. Burning will probably write into the mold's own growth maps rather than add decals.
- Point lights cast no shadows, so they leak through walls. Only the hall/corridor doorway is handled (the portal in `world/materials.js`). The room graph will need this per room.
