# Backrooms: working notes and quality bar

A found-footage survival game in the backrooms (three.js 0.170 + Vite 8, for GitHub Pages). It started from Signal Loss's body-camera renderer and rig (`../bodycam-game`, whose CLAUDE.md holds the lessons this one inherits). Since round 7 the camera is a 90s camcorder recording to tape. [README.md](README.md) covers running it. [docs/ROOMS.md](docs/ROOMS.md) is the room catalogue, [docs/GRAPH.md](docs/GRAPH.md) explains how rooms are made and joined, [docs/FLAMETHROWER.md](docs/FLAMETHROWER.md) the fire, and [docs/MOLD.md](docs/MOLD.md) the mold.

The game the user wants:
- **Survival.** Black mold creeps or rushes at you, and a flamethrower slows it and burns it away.
- **Space.** Non-Euclidean, built as a graph of rooms: most doorways lead both ways, some don't, and the room behind you can change. Many room types, of many shapes and sizes.
- **Safe rooms.** Lit and dry, held only while their generator runs.
- **Play.** Free roam for now, no story yet. One death ends the run.
- **Platforms.** It must look like real footage and run on the user's Radeon 610M laptop and on phones.

When a playtest teaches something new, add it here.

## The bar (inherited from Signal Loss: keep these)
- **Real footage first.** Realism comes from imitating the camera, not from scene detail: a 4:3 frame at 480 lines, 30 fps like NTSC video, the chest-mount rig that lags and jolts, and the camera and tape passes in `render/pipeline.js` (a 90s CCD camcorder recording to tape; see "The 90s camcorder").
  - Burn in only what a camcorder burns in: a red ● REC at the top left and the date stamp at the bottom left. No HUD inside the picture.
  - Sound is only what a body mic would record, all synthesized.
- **No characters on screen** (they looked unconvincing). That's why the flamethrower is shown without hands.
- **The camera never moves without a reason.** Springs integrate in substeps of at most 0.02 s. No image effect shifts whole bands of the picture.
- **Measure brightness and cost, don't eyeball them.** `__br.brightness()`, `__br.exposure()`, `await __br.profile(40)`.
- **Play starts at once.** Every shader is compiled during loading. `__br.programs()` must not grow while you walk the level, fire everywhere, crouch, switch the light on, let the mold grow and die, wade into a flooded room (it is 24 now: the water's reflection pass is compiled at load).
- **Never copy a copyrighted game.** The backrooms is a shared internet idea, so the generic look is fine; stay away from anything specific to Kane Pixels' series.

## The camera (round 2: "it should be indistinguishable from a video")
What each part of `render/pipeline.js` does is in its comments. These are the rules it taught:
- **No dark outline round a light.** A blown-out light must glow and soften at its edges, not sit there like a sticker. Three things drew outlines:
  - the troffer texture's dark border;
  - ISP sharpening halos (now clamped, -0.05 to +0.08);
  - lens ghosts that read as pale spots on the floor (the mid one is gone, the others are faint and tinted).
- **No stair-stepped edges.** A real lens and sensor never alias. The scene is read slightly soft (`optic()`, mip 0.75), and the brighter something is, the wider the lens spreads it (bright edges take the mip-1.5 sample), so a blown-out panel's outline follows a smooth contour. Sharpening then restores apparent detail, with halos, as cheap cameras do.
- **The dirty cover glass** (`render/lens.js`): smudges, a fingerprint, a sleeve wipe, dust, drawn once into a screen-space mask. It only shows by scattering light: a shapeless haze from very wide mips (5 to 6), and a short smear along the wipe.
  - Narrower mips or wider taps made recognisable blurred copies of each light: doubled lamps, which read as fake at once.
- **Noise before noise reduction, in linear light.**
  - Shot noise follows the square root of the light, read noise is constant, and the gain (exposure beyond normal) amplifies both, squared.
  - The processor's noise reduction (a blend toward the mip-1.5 sample, in the dark and at high gain) comes after the noise and smooths it into the watercolour smear of low-light video.
  - Colour noise stays low (cameras suppress it hard). Added after noise reduction, the dark corridor was a carpet of green and magenta specks.
  - A lit room should only shimmer; the dark corridor boils, but stays legible.
- **Fixed pattern:** a column pattern and a few hot pixels (about 0.016%), brighter with gain. Too many hot pixels look like stars.
- **Auto white balance** follows the scene's average colour slowly and corrects a quarter of the drift from the hall's own colour (`uWBRef`, measured with `__br.exposure().wb`). Fire turns the picture orange, then the camera cools it a little. Measure the reference again if the rooms' colours change.
- **The shutter** opens longer in the dark (more motion blur) and closes for bright light (crisper fire).
- **The codec is gone.** Its skipped blocks (night grain freezing and jumping block by block) are a 2010s digital tell; the tape pass replaced it in round 7.
- **Static:** a flickering tube throws electrical noise, and within a few metres the camera picks it up as faint interference (main.js `tubeInterference`). It stays faint: a few torn rows and the gain pumping, never whole bands.
- **A/B timings back to back.** The iGPU's clock moves by a third between runs: camera pass 4.5 ms old against 3.7–4.0 ms new, minutes apart, the same within that noise. Swap the files and profile both in one sitting.

## The 90s camcorder (round 7: "why is there an id number ... take a look at what 90s footage actually looks like, add some grain")
The bodycam became a consumer camcorder of about 1996 (VHS / Video8 class), from what real footage and the cameras' manuals show:
[CCD smear](https://www.manualslib.com/manual/1999288/Sony-Dxc-Ls1p.html?page=46),
[the date display](https://www.manualslib.com/manual/263333/Sony-Gv-D800.html?page=30),
[what's burned in](https://creativecow.net/?p=589533),
[NTSC chroma and luma bandwidth](https://forums.libretro.com/t/ntsc-shader-discussion/27190/27),
[tape damage](https://borisfx.com/documentation/optics-2026/Optics%202026/Filters-S_VHSDamage.html).
- **What changed from the bodycam:**
  - 4:3 at 480 lines (640×480; phones 480×360) and a narrower lens.
  - A CCD: no rolling shutter, no fluorescent banding, the vertical smear.
  - Much less noise reduction, no WDR, no codec. The autofocus hunts now and then.
  - The tape pass (`presentMat`, in YIQ) does the rest. It's listed in its comment: timebase wobble, flagging at the top, the head-switching band at the bottom, soft luma with peaking, colour far softer and late, grain, colour blotches, dropouts, combing on fast pans, lifted blacks.
- **Grain rides on top of the levels.** Added before the black lift, its negative half was clipped and black stayed a flat floor. Added after, black fizzes both ways, as on tape.
  - **The user's level:** about 8.5/255 of temporal noise in the hall's midtones (line jitter included), and about 10 in the dark corridor. At 11 and 15 it was "a bit much" and "dark rooms are a bit too grainy". Measure it as the difference between two frames of a still view, `sd / sqrt(2)`, binned by brightness.
  - The camera's own noise reduction is a little weaker than the bodycam's: a 90s camera's dark is grainy, not smeared.
- **The CCD smear is only for light far beyond clipping.** The threshold is luma × exposure above 6, averaged down the column. At 1.6 the hall's own ceiling panels drew hard-edged bright bands down the whole frame.
- **Every read of the scene in the camera pass uses the same focus.** The colour fringing's red and blue reads stayed sharp while the autofocus blurred green, so every light got a green halo whenever it hunted. It was seen as "green rims for the first second" (the start hunt).
- **Highlights lose their colour near clipping.** The tape's chroma taps fade above luma 0.8, so a blown panel is white, as on a real camera.
- **The burn-in is bold Courier with a dark edge** (`ui/overlay.js`). Keep it: the user preferred it to a 5×7 dot font. The dot font read sharper through the tape (in a 3× crop over a bright panel, Courier's REC smears into blobs), but at full size Courier reads fine.
- **Phones:** in landscape the 4:3 frame has black bars either side. FIRE sits in the right bar and the small buttons go top right, over the ceiling; at the bottom right they covered the fuel gauge.
- **Measured** (640×480, hidden pane): hall mean 0.31, dark corridor 0.08, corridor while firing 0.24. GPU at spawn: scene 5.9, camera 4.5, tape 3.6, total 14.0 ms.

## Fire (what the prototype taught)
- **Fire goes through the camera like any other light.** It is drawn in its own half-resolution layer and composited into the scene *before* exposure, bloom and the camera pass, so it sets the exposure, clips, blooms, shimmers and gets compressed with everything else. Don't draw it after the camera pass.
- **Brightness.** `fire.cfg.flame` = 5 against the room's light. At 24 the flame was a white blob with a halo the size of the screen. The core should clip, and orange should stay visible around it.
- **Turbulence that survives overlap.** Smoke and flames on surfaces read one shared, rising world-space noise field. With per-puff noise, overlapping puffs averaged into smooth glassy balls.
- **No balls of fire (playtest 1: "there are still balls of fire, it should be more continuous").** The jet must read as one continuous body, from any angle and while swinging. What it took (details in docs/FLAMETHROWER.md, "How the jet is drawn"):
  - Particles are samples of one tube, not balls. Each draws a window along the jet as long as the gap to the next, and the windows add up to one. The tube's width follows the fuel's age exactly, with no per-particle randomness.
  - The windows lie along the jet's bend (the tracked gap to the next particle), not along each particle's flight, or a swung jet falls apart.
  - Each window is drawn in perspective and each pixel intersects its own ray with the tube. A flat, camera-facing approximation fails right after the nozzle, where the jet heads straight away from the camera.
  - The flame and turbulence are read at the point of the ray, within the window's core, nearest the jet's axis, in the fuel's own coordinates (across the jet; along it by emission time). Read anywhere else, the windows light up one at a time: beads.
  - Particles leave the nozzle on an even beat, and a jet only a few pixels wide gets a soft flame edge (a sharp edge on a thin diagonal line aliases into beads).
  - Check it with 3x crops of the first metre out of the nozzle, both straight and swinging, and with `__br.fire.density(true)`: if the density is smooth and the flame isn't, the problem is in the shading.
- **Colour.** Flame colours are more saturated than they "should" be, because the camera's processing desaturates by about 26%. Without that, splashes read as murky tan.
- **Smoke** is soot: dark against lit walls, grey against darkness, lit orange from below by the flames. Smoke from a splash starts above the flames, not among them, or it muddies them.
- **Smoke must never hide where you're going** (playtest 3: "the black smoke makes it impossible to see where you're going").
  - A puff's peak opacity is 0.34 (it was 0.78), and it fades within about a metre of the lens.
  - Puffs are 0.45–0.7 m (they were 0.75–1.2 m, which hung below eye level from a 2.6 m ceiling), and they rise fast (buoyancy 2.2).
  - About a third as many come from the stream (`smokeP` 0.12), and fewer from surface fires (`smokeFire` 2.0).
  - Measure it with `__br.fire.coverage()`, the fire layer's alpha. After 3 s of fire at a wall 2.4 m away in the hall, alpha above 0.5 covered 47% of the frame, and 41% 1.5 s later. Now it's 23% and 12%.
- **The stream lands where you aim.** It converges on the aim point (never closer than 2.8 m) and is held a little high for the distance, or it falls short onto the floor.
- **Scorch has to read as one char,** not as splats: a soft, ragged soot texture, a small merge radius, upright streaks above lasting fires. Embers on fresh char are dull red specks; a glow over the whole mark read as a bright cut-out.
- **A fire on a surface needs its colour gradient.** White at the heart, through yellow and orange to a dull red rim: the hot core starts well inside the flame's edge. Without that room, a wall fire clipped to one flat pale blob with a cut-out outline.
- **Point lights soften close up** (`pd2 / (pd2 + 0.3)` in world/materials.js), and the fire lights are kept 0.6–0.7 m off surfaces.
- **Mold is fuel (playtest 2: "fire should spread more").**
  - Fire on mold feeds on it and creeps over thick mold, at most 4 steps from where the stream hit: a one-second burst becomes a burning front about 2 m across that eats into the colony for 5–7 s.
  - It's limited on purpose, so one spark can't clear a colony.
  - Check it from `teleport(0, -21.2, 0)`, `aim(0, -0.3)`: the corridor's far end is a doorway now, so aiming level sends the stream through it and nothing burns.
  - Find a room's colony by `rooms[i].colonyIds`: colony numbers follow the order rooms were built.
- **The wand is always in frame.** Near a wall it slides back only as far as needed and the hands come up. Tipping it down hid it completely.

## Mold (what the first round taught)
How it works is in docs/MOLD.md. The rules:
- **Black mold is dark and matte.** Albedo 0.01–0.04, its specular cut by 85% and its grazing reflectance to 0.12 (`MOLD_SPEC`).
  - Lit up close by a fire, it is several times brighter than the wallpaper behind you: at 0.1 it read as pale plaster.
  - With the usual reflectance, a wall of it seen along a corridor toward a fire showed nothing but its glancing reflection, as bright as the wallpaper beside it.
- **Its texture comes from light, not colour:** raised lumps (bump) and a velvet sheen at glancing angles. Flat black with no texture read as a hole or as paint.
- **No crisp edge.** The edge dissolves into specks, and its height rises gently: a height step drew a dark rim like torn paper.
- **Judge it in three lights,** with crops:
  - the lit hall: the corner colony, `teleport(-4.6, -2.2, Math.PI / 2)`, `aim(Math.PI / 2, 0.15)`;
  - the corridor while firing at it: `teleport(0, -20.6, 0)`, `aim(0, -0.12)`;
  - the weapon light alone, 2 m from it: `teleport(0, -22.2, 0)`, `setFlash(true)`.
- **Speeds are measured, not set.** The edge's speed comes out of the spreading odds, the thickening and the cell graph; `cfg.creepK` and `cfg.rushK` calibrate it. Measure `colonies[k].lastTipDist * 0.12` over 20 s of creep, and over a forced rush (`__br.mold.rush(1, 2)`) from more than 5 m away (a 2 s rush covers about 4.4 m).
- **Testing traps:**
  - After a teleport, run `sim(30)` before reading distances: the distance field is rebuilt every 0.3 s over several frames.
  - Don't teleport straight after firing: the valve's closing dribble fires at the new spot (it burned the corner colony in a test).
  - Standing still near mold for a minute kills you. Test the end on a fresh page: only a reload undoes `die()`.

## Rooms and the graph (what the first graph round taught)
How it works is in docs/GRAPH.md. The rules:
- **A room never moves while you can see it, and no doorway near you leads into nothing** (playtest: doorways "start as black walls and change when you get close, or even change rooms when you approach"). How it's kept (docs/GRAPH.md, "Placing"):
  - Placing restarts from the room you're in, which stays where it is. A placed room no longer wanted is removed only when none of its doorways is in view: that's what makes "the way back changed" feel uncanny, not glitchy.
  - The one exception: a room standing only because it's in view, blocking a room you need near you, goes (unless it fills that very doorway).
  - Space is claimed nearest doorway first, new rooms are made to fit, unseen links that stop fitting are decided again, and the ring beyond is built ahead.
  - A doorway that still leads nowhere is capped dark (with a collider): through the open hole you saw another room from the wrong side.
  - When a room appears or goes in a doorway you can see, the tape tears over that doorway. That's the only visible change, and it reads as the recording breaking up.
  - **Measure it with line of sight,** not the frustum: rays from the camera to points in the doorway against the placed rooms. The frustum test counted doorways hidden behind walls (and the glitch fired over bare walls).
  - **Budget anything per update that makes rooms:** deciding a whole ring at once took 20–70 ms.
- **Everything that belongs to a room lives in its own coordinates:** its AO map, mold texture, mold detail (`vLPos` plus a per-room noise offset in the shaders) and soot marks. In world coordinates they would slide off when the room is placed somewhere else.
- **Per-room materials share shaders.** Make them with `litFor` / `roomMaterials` (same `customProgramCacheKey`), pool them per room, and never dispose them: disposing the last material that uses a shader deletes it, and the next room would compile it again. `__br.programs()` must stay at 24 while you walk through new rooms.
- **Water (flooded rooms)** is in the shared floor shader (a per-room `uWater`), so it compiles nothing. The floor marks how much of each pixel is water in the scene's alpha, and the old screen-space reflection pass reflects only there (`flags.ssr` only while a flooded room is near, 0.3 ms). Puddles come from noise in the room's own coordinates. Crisp reflections cut off by a puddle's edge read as scraps of paper: they're soft and fade toward the edge.
- **A fixed pool of point lights.** 12 for the rooms plus the fire's 2, assigned each frame. Lights are never added or removed. The per-light room data (`uLR`, `uLD`) follows three.js's light order, which is the scene's traversal order: never hide a light or reorder the scene's lights.
- **Build in slices.** A room takes 60–180 ms to build. It is a generator that yields every few milliseconds; the yields are labelled, so a slow slice can be found by timing `next()` (docs/GRAPH.md). Before slicing, crossing a doorway cost frames of up to 130 ms.
- **The walk was smooth only once the background building was sliced finely.** Check frame times while crossing doorways, not only standing still.
- **A new material must reuse a shader.** Same lit mode, mold flag and map presence as an existing one: a different texture or colour compiles nothing, a missing or added map does. Props, pipes and ducts are mold-enabled (mode 0, like the fixture frames) for that reason; plain lit props would have needed a new shader (room meshes receive shadows, the wand doesn't).
- **Colliders that draw themselves are `nosurf`** (furniture, pipes, ducts), or the surface builder covers them in wallpaper. A partition lower than the ceiling needs its top face (added where there's air above it).
- **Light rows are centred on odd multiples of 0.3 m** across a corridor. Centred on the grid, every fixture in a 1.8 m corridor failed the fit test and those corridors were all dark.
- **Rooms are let go** (24 kept built), their mold kept sparsely. A let-go room has no `C`, `mold`, `u` or `geos`: guard anything that holds a room across frames (a colony's tip, the mold's distance search).
- **Crawlspaces:** the camera ducks by itself (`world.forceCrouch`) inside and near a low doorway. Every ceiling-dependent thing reads the room's height (`plan.H`, `world.ceiling`, the wall AO's `uAOH`).
- **What you can see decides what can change.** `visibleSet` walks from your room through open doorways in the camera's view. A room behind a shut door counts as unseen, so a door is a place where the room behind you changes. (An earlier test, "any of its doorways in view", kept rooms behind shut doors forever.)
- **Doors, generators and cans** live in `world/interact.js`. The rule for adding something usable: decide what it blocks (colliders: `refreshNear` on `world.doorsChanged`; light: `shutAt` in the light pool; mold: `tryCell`'s slow factor) and what it shows (the prompt). Pick targets by how squarely you look at them first, then distance; floor items need a longer reach, since it's measured from the chest.
- **Don't reuse names on a room.** `R.gen` is the room's build in progress; the generator's position is `R.genAt`. Using `R.gen` for both broke building.
- **Testing traps:**
  - Frame times in the hidden pane are unreliable: the tab gets no animation frames, and long synchronous `sim` loops stall at random inside `renderer.render` (up to 5 s with nothing changing). Use `profile` for the GPU, time the game logic and the build slices separately, and ask the user about hitches in real play.
  - `__br.level.visit(kind)` makes a room of a kind and puts you in it.
  - Teleport only within placed rooms; a room's old place is empty once it's removed. Use `__br.level.goto(id)`.
  - Use your own tab: the user may be playing in the Browser pane's.
  - A scripted walk that teleports through doorways goes round in circles unless it prefers rooms it hasn't visited; it also explores far faster than a player, so its build and placing costs are a worst case.
  - Long synchronous test scripts time out at 45 s: split walks into calls of about 15 rooms.
  - **`sim(n)` renders once,** so the auto exposure moves one step per call. Before comparing brightness, settle it with `sim(1)` 150 times: after `sim(120)` a wall 1.2 m away was still exposed for the dark.
  - **A/B shots come from one spot, without turning away.** Facing a wall lets the graph swap the room behind a doorway, and the next shot sees a different room.
  - **Seed test mold well away from where you stand.** A patch 0.8 m from a test position reached the player's feet and ended the run mid-test. Freeze the mold for A/B tests with `mold.cfg.creepK = mold.cfg.rushK = 0`.
  - `await import('/src/...')` in the console can return a second copy of a module (Vite's `?t=` URLs), with empty state. Use the `__br` hooks.
  - The start corridor's far doorway is grown over with mold: walking through it kills you. Clear the mold (`__br.mold.clear()`) to test the graph.

## Light
- **Point lights cast no shadows,** so they shine through walls. Each lights its own room only, plus the room beyond the one doorway between it and you, through that doorway (`roomVis`). The bounce light is scaled per room by how much of its light works. Walls cast the weapon light's shadow.
- **Measured (540p, bodycam):** hall mean 0.34 (normal indoor footage is 0.3–0.45), dark corridor 0.06, corridor while firing 0.25. As a camcorder (480 lines): 0.31, 0.08 and 0.24. Auto exposure in the corridor goes from its 2.4 limit to about 1.06 when you fire.
- **The weapon light has to show mold in the dark** (playtest: "the flashlight should reveal more ... enough that you can identify if mold is in front of you").
  - It's 48 cd with a wide, soft spill (cone 0.72 rad, penumbra 0.5). Mold shows by contrast: black, ragged shapes on lit wallpaper and floor.
  - At 24 cd with a 0.6 cone, mold on the floor 3 m ahead and the colony 4.5 m down the dark corridor couldn't be told from the dark.
  - Up close the auto exposure's highlight protection holds the hot spot back: a wall 1.2 m away looks the same as at 24. In the lit hall it makes no visible difference.
  - Check it with A/B shots from one spot: the corridor's colony from `teleport(0, -20.6, 0)`, and a floor patch (`mold.seed(1, 0.3, 0, -20.4, 0.75)`) from `teleport(0, -17.4, 0)`, `aim(0, -0.2)`.
- **Lens ghosts are toned down** (`* 0.08`) because the panels here are far brighter than the hospital's night lighting. The panels are `PANEL` = 6.

## Loading
- **The bounce-light capture is 256,** the same size as the placeholder environment. At 128, every shader compiled twice and loading took 8.6 s.
- **With the mold,** loading took 6.7 s on a cold shader cache (3.7 s of it compiling) and 2.1 s warm.
- **With the graph** (11 rooms made, 9–10 placed before play): 2.1–3.8 s warm, 8.7 s cold.
- **The fire layer's passes run once during loading** (`fxLayer.count = 1` in `warmUp`), or the composite shader would compile on the first shot.

## Performance (hidden pane, 540p; a visible pane reads about 2x faster)
- **GPU:** idle about 16.4 ms a frame, firing at a wall 20.2 ms (fire layer 1.75, composite 0.4). The continuous jet costs about 0.65 ms of that more than the old puffs did. With the mold: 14.0 ms idle, 10.4 ms in the corridor facing it (no change beyond the clock's noise).
- **CPU:** about 2.5 ms per frame of simulation with about 300 particles. All game logic without fire, mold included, 1.6 ms.
- **The graph:** start hall 11.5 ms GPU, the biggest pillar field 20.6 ms (22.7 ms firing with the light on). Crossing 14 doorways in a row: frames 4.8 ms median, 17 ms at worst.
- **Room lighting:** 12 cluster lights plus the fire lights is the biggest scene cost. Fewer or baked lights are the first place to save.

## Working with the user
- **The user playtests in their own browser** (http://127.0.0.1:8796) and sends short feedback. Answer it point by point.
- **Under creative control, make the call** and flag it plainly so they can veto it.
- **Before calling a visual problem fixed,** reproduce it in a crop first and look at the same crop after.

## Code guardrails
- **three.js is pinned to exactly 0.170.0.** `world/materials.js` patches shader chunks by string; a failed patch only warns in the console.
- **Lights are never added, removed or hidden during play** (only their intensity changes), or shaders recompile. The fire's two lights, the weapon light and every room light exist from load.
- **The weapon light's shadow map is rendered once during loading** (`renderer.shadowMap.needsUpdate` in `warmUp`). Before that, its depth shader compiled on the first F press: a hitch.
- **`Object3D.position` can't be assigned** (`Object.assign(mesh, { position })` throws). Use `.position.set`.
- **For multi-line edits, write a Python patch script** with the Write tool and run it. Bash heredocs with quotes in them break.

## Before reporting a change as done
1. **Open the game:** `preview_start` with `name: 'backrooms'` (port 8796), and run `python tools/shot-server.py` in the background (port 8798).
2. **Drive it.** First `await __br.ready`, then `__br.paused = true; __br.start()`. Then:
   - `__br.teleport(x, z, yaw)`, `__br.aim(yaw, pitch)`, `__br.sim(frames, { KeyW: true, fire: true })`.
   - `sim` draws only the last frame. After a teleport or a long `sim`, step it with `sim(1)` a few times before a screenshot, or the temporal filter blends in the old view.
   - `shot` and crops must read the canvas in the same task as the frame was drawn (there's no preserved drawing buffer): grab every crop first, then encode and post.
3. **Look at it** with `await __br.shot('name', 960, false)`, which writes `.shots/name.jpg`. Look at fire in the lit hall (spawn), against a wall at about 2.4 m (`teleport(-5, -3.4, 0)`), and in the dark corridor (`teleport(0, -18.2, 0)`). Look at mold in the three lights listed under Mold. Look through the start hall's side doorways (`teleport(-3, -9, Math.PI / 2)`, `teleport(3, -4.2, -Math.PI / 2)`), and walk through a few doorways checking frame times.
4. **Measure** brightness, exposure and GPU time before and after any visual change.
5. **Check:**
   - a clean console in a fresh tab;
   - `__br.programs()` unchanged after walking and firing;
   - `npx vite build` passes;
   - `node --check` on every file you touched;
   - phone layout under the `mobile` viewport (touch class, the FIRE button holds and drags).
6. **Report:**
   - what changed and how it was checked;
   - what couldn't be checked (audio by ear, real-time feel, phones);
   - any creative calls the user may veto.

## Handy tools
- **`window.__br`:**
  - `brightness`, `exposure`, `profile`, `bench`, `programs`
  - `post.camera`, `post.tape`: the passes' uniforms (`uSmear`, `uDefocus`; `uGrain`, `uChroma`, `uSharp`, `uComb`)
  - `sim`, `run`, `teleport`, `aim`, `shot`
  - `fire` (`cfg`, `stats`, `clear`, `fires`, `nozzle`, `density`, `coverage`), `weapon`, `wand`, `scorch`
  - `mold` (`colonies`, `cfg`, `stats`, `seed`, `burn`, `clear`, `rush`, `contact`, `touch`, `die`, `state`)
  - `level` (`rooms`, `insts`, `current()`, `cfg`, `reconcile()`, `goto(id)`, `visit(kind)`), `doors`; `weapon.fuel`, `weapon.infinite`
  - `boot` (load timings)
  - `flags`, `state`, `setFlash`, `setCrouch`, `setFx`, `setQuality`
