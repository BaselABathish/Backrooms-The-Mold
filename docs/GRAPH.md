# The room graph

The backrooms are a graph of rooms joined by doorways, made as you go. The rooms near you are placed in the world, so you see from one room into the next. The space is not Euclidean: the way back isn't always the way you came.

Code: `world/rooms.js` (plans), `world/roombuild.js` (building a room), `world/level.js` (the graph, placing, light), `world/surfaces.js` and `game/mold.js` (per-room mold).

## What you see

- **Room after room.** Each doorway opens onto another room, of eleven kinds (docs/ROOMS.md has the numbers):
  - **Hall** (1): open wallpaper, rectangular or L-shaped, with stub walls and pillars.
  - **Corridor** (2): straight, L-shaped, T-shaped (a branch off the middle) or zigzag.
  - **Pillar field** (3).
  - **Partition maze** (4): partitions on a 2.4 m grid, most 1.5 m high, some to the ceiling. There is always a way through, plus a few loops. Mold may wait in a dead end and rush you when you're close and not looking.
  - **Closet** (5).
  - **Crawlspace** (6): a 1.5 m ceiling of fibreglass between old joists, block walls, a concrete floor, ducts and cables overhead, bare bulbs, and low doorways. You go through on your knees: the camera ducks by itself near a low doorway and inside.
  - **Tall void** (7): wallpaper up to 2.6 m, then bare walls going up 7–11 m into the dark. The lights hang on steel cables at 3–3.6 m.
  - **Service corridor** (10): painted block walls, a concrete floor and ceiling, three pipes along one wall, a breaker box, caged bulbs, cold light.
  - **Office remnant** (11, rare): a desk with a dead phone, a chair pushed back, a filing cabinet, papers on the floor.
  - **Self-loop room** (13): one doorway leads back into the same room through the opposite wall. Through it you see the room again and again. Its soot and mold are the same in every copy.
  - **Wrong room** (14): you step through a doorway into a copy of the room you're leaving, with one thing different: a light out, a light working, a grille gone, a missing tile moved.

  Each room is lit (or not) in its own way: all on, patchy, dying or dark. Dark rooms come in stretches, so a dark room's neighbours are more often dark. Rooms get darker and moldier the deeper you go.
- **The way back changes.** One doorway in five doesn't lead back the way you came. You walk through, and while you're looking back, the room you left is still there. Look away, and the doorway behind you now leads somewhere else. It never changes while you're looking at it.
- **Loops.** Now and then a doorway leads into a room you've already been through, from a side you didn't expect.
- **The start** is the old test room: the hall, with a doorway in each side wall, and the dark corridor whose far end is filled with mold. Now there is a doorway there, grown over, with another room beyond it. You have to burn your way through.

## How it works

- **Plans** (`world/rooms.js`). An archetype and a seed give a plan in the room's own coordinates, on the ceiling's 0.6 m grid.
  - The room's air is a union of rectangles.
  - Its walls stand outside them, 0.1 m thick. Each room owns half of a wall, so two rooms joined at a doorway make a 0.2 m wall.
  - Doorways are 1.8 m wide holes with a header above, at least 0.3 m from a corner, 2.1 m high (1.2 m into a crawlspace). Joined doorways of different heights show a lower opening inside the higher one, and light through them passes under the lower header.
  - Each room has its own ceiling height (1.5 m to 11.4 m) and names its materials (carpet or concrete floor; wallpaper or painted block walls; tiles, insulation or bare concrete overhead; a different material above 2.6 m in a tall room). A partition lower than the ceiling has a top face. Furniture, pipes and ducts are drawn by themselves; their boxes in the plan are colliders only (`nosurf`).
  - A plan also holds interior walls and pillars, light fixtures with their states, ceiling details and mold colonies.
  - Which archetype comes up depends on how deep you are: halls, corridors, closets, mazes and service corridors from the start; pillar fields, crawlspaces, tall voids, offices, self-loop rooms and flooded rooms deeper in.
- **Building** (`world/roombuild.js`) runs as a generator, a few milliseconds a frame. It makes:
  - merged geometry per material;
  - colliders;
  - mold surfaces and cells (with fast neighbour finding: grid neighbours within a surface, distance search only at surface edges);
  - an AO and damp-stain map;
  - the fixtures, all of a room's panels in one mesh, and light clusters.

  Most slices take under 10 ms and the longest about 16 ms. A room takes 60–180 ms in all.
- **The graph** (`world/level.js`). Each doorway's link `{ room, door }` is decided the first time anything needs it.
  - Usually it leads to a new room, and that room's doorway leads back (`graphCfg.back` = 0.8).
  - **A new room is made to fit** beside the rooms already there. Its kind is drawn as usual, then up to four layouts of that kind and all its entrances are tried for one that overlaps nothing wanted or placed; failing that, two of any kind (a corridor or closet fits where a hall can't). Redrawing the kind every try had favoured small rooms with many doorways, and safe rooms all but stopped coming.
  - **A link is soft until someone sees through it** (`fresh`, `seen`). Links are kept, but the layout round you changes as you go, so a room decided earlier can later collide with one claimed nearer you. If nobody has seen where that doorway leads, it is decided again (at most 3 times per doorway, 1 per update: uncapped, a spot where nothing fits made a new room every 0.1 s).
  - With `graphCfg.loop` = 0.08 it leads to an unused doorway of a room made earlier.
  - With `graphCfg.wrong` = 0.05 it leads into a wrong room: a copy of the room you're leaving (`wrongPlan`), entered by the same doorway, so it seems to face you the other way round.
  - A self-loop room's pair of doorways is linked to itself when it's made.
- **Placing** (playtest: doorways "start as black walls and change when you get close, or even change rooms when you approach").
  - From the room you're in, the rooms up to `DEPTH` = 3 doorways out are wanted, at most 16. **Space is claimed nearest doorway first**, by straight-line distance from you, not by graph depth: where two rooms want the same space, the one behind the doorway you're nearer to (the one you're walking toward) gets it. A room that would overlap one already claimed is skipped.
  - **The ring beyond is built ahead.** The edge rooms' doorways are decided, and their rooms built in the background (`later`, at 4 ms a frame; rooms needed now get 6 ms and go first), so a room is ready before you can see it. They're kept from being let go (`ahead`).
  - **Budgets, so crossing into new rooms doesn't hitch:** one new link decided per update (each tries several layouts), at most 2 new rooms placed per update beyond the rooms next door, placing every 0.1 s.
  - Each room is placed in quarter turns and a shift, so its doorway meets the one it joins, face to face.
  - Placed copies of rooms (instances) that match are kept, missing ones are created, and unwanted ones are removed **only when none of their doorways is in view**, except one thing: a room still standing only because it's in view, that blocks a room you need near you, goes (unless it fills that very doorway: then the way back changes behind your back, as before).
  - **Dark caps.** A doorway that leads to no placed room gets a black card just outside it (`plenumMat`, no new shader) and a collider. Without it you saw through the hole into whatever room stood behind that wall, from the wrong side, and it changed as you came closer.
  - **The glitch.** When a room appears or goes in a doorway you can actually see (rays against the placed rooms, ignoring caps), the tape tears over that doorway for 0.45 s (`world.onSpaceShift`, `glitchDoorway` in `render/pipeline.js`): bands of lines torn sideways with ragged ends, a few lines of snow, the colour dropping out.
  - A room can be placed more than once.
  - Placing deeper along the view (5 doorways ahead) was tried and dropped: the extra rooms stood in the way of near ones when you turned, and left more dark doorways close by.
- **Where you are.** When you cross a doorway's plane you are in the other room. Placing then restarts from there. That room doesn't move, so nothing you can see moves.
- **Each placed room has its own materials** (`roomMaterials`, `litFor`).
  - They carry the room's id, its bounce-light level, its AO map, its mold texture and a noise offset.
  - They share the compiled shaders, so nothing compiles during play (24 programs since the water's reflection pass).
  - They are pooled per room, never disposed: disposing the last user of a shader deletes it, and the next room would compile it again.
- **Room coordinates.** Everything that belongs to a room lives in the room's own coordinates (`vLPos` in the shaders), so it stays put however the room is placed:
  - its AO map, its mold texture and the mold's fine detail;
  - its soot marks (`weapon/scorch.js`, one instanced mesh per placed copy, sharing the room's data).
- **Light.**
  - A pool of 12 point lights is assigned each frame to the nearest working fixture clusters in the room you're in and the rooms next to it. A cluster that already has a light keeps it unless clearly worse, and a newly lit cluster fades in over 0.25 s.
  - Each point light lights its own room, plus the room beyond the one doorway between it and you, through that doorway (`roomVis` in `world/materials.js`, fed `uLR` / `uLD` in three.js's light order). The fire's two lights work the same way.
  - Walls cast the weapon light's shadow, so the weapon light stops at walls.
  - The bounce light is the start hall's capture, scaled per room by how much of its light still works.
- **Mold across doorways.**
  - The floor cells in a doorway's hole are linked to the matching cells of the doorway it leads to (mirrored, since the two face each other). Mold spreads, and its distance to you is measured, through doorways along the graph's links.
  - Only rooms that are placed grow. The rest wait.
  - A room still being built is never spread into.
- **Collisions** are rebuilt on every placing, from the room you're in and the rooms next to it. The fire, aiming and smoke use the ceiling of the room you're in (`world.ceiling`).
- **Letting rooms go.** At most 32 rooms stay built (`MAX_BUILT`, room for the ring built ahead). Every 2 s the ones placed longest ago are freed: their geometry, textures, cells and materials. Their plan, links and soot stay, and so does their mold, sparsely (cells are numbered the same when the room is built again, `releaseMold` / `restoreMold`). If you come back, the room is rebuilt as you left it. Without this the heap passed 260 MB after 100 rooms.
- **Leaving a room behind.** When a placed copy is removed, any fire burning in it goes out.

## Doors and safe rooms (`world/interact.js`)

- **Doors** are heavy double doors that you open and close with E, or USE on a phone.
  - A door belongs to one room's doorway (its owner). It swings into that room and is drawn by every placed copy of it.
  - Safe rooms have steel doors. Elsewhere, 8% of new doorway links get a door (`graphCfg.doors`): steel in service corridors, wood in the rest, shut more often than not. There are none on low crawlspace doorways or self-loop links.
  - A **shut door** stops you, the fire (a collider across the doorway), the light through the doorway (no spill), and the mold. Mold can only seep under: 4% of its rate through an open doorway (`moldCfg.seep`).
  - A shut door also **hides what's behind it**. Rooms count as seen only through a chain of open doorways in the camera's view (`visibleSet`), so behind a shut door the room can change while you're looking at the door. Open it, and it's another room.
- **Safe rooms**:
  - **Look:** pale painted block, a pale painted ceiling, a concrete floor, cool white light that never flickers, a steel shelf, and one steel door, open to start with.
  - **The generator:** against the back wall, in a tube frame, with an exhaust up through the ceiling and a lamp that's green while it runs and blinks when low. It burns a second of fuel per second while the room is placed, starting with 45–90 s.
  - **Running dry:** the generator coughs and stops, the lights die and the hum stops. Mold can come in again.
  - **Pouring fuel:** hold E at the generator to pour your own fuel in, 18 a second, up to 150. A dry generator restarts with a pull or two.
  - **Fuel cans:** each holds 225 (45% of the 500 s tank). Safe rooms have one or two; service corridors, offices and closets sometimes have one.
  - **Keeping mold out:** no cell of a powered safe room can be taken.
  - **The waiting mold:** when a room links into a safe room, a colony starts 2 m outside its doorway and creeps after you. While you're inside, it piles up at the door.
- **The flamethrower's fuel** is finite: 500 s of fire at full flow, shown only on the gauge (docs/FLAMETHROWER.md).
- **The prompt** ("E · open the door") sits at the bottom of the screen, outside the picture. It shows only when something usable is in reach and what you look at most squarely.

## Measured: dark doorways (2026-11-20)
A scripted walk teleports through doorways and turns through 8 directions in each room, counting doorways that lead nowhere and are in line of sight (rays against the placed rooms; the frustum alone counted doorways hidden behind walls).
- **Before:** 24 such doorways per 360 views, all within 10 m, nearly all in the room you're standing in.
- **After:** 0 in most walks; exploring as fast as possible (a new room every step), 0–2 within 10 m per 120 views, as dark caps. None see through into another room. About one glitch per 10 rooms.
- **Placing costs** (desktop, hidden pane): 0.3 ms typically, 5 ms at the 95th percentile and 17 ms at worst while exploring as fast as possible (`__br.level.stats`).

## Tuning and testing

- `__br.doors`: every door (`open` 0–1, `target`, `owner`, `d`, `kind`). `__br.weapon.fuel` (0–500) and `__br.weapon.infinite`. A safe room's `power` (`fuel`, `max`, `on`).
- `__br.level`: `rooms`, `insts`, `current()`, `cfg` (`back`, `loop`, `wrong`, `doors`), `reconcile()`, `depth`, `goto(id)`, which starts again from room `id` (0, the start hall, at the origin as at the start), and `visit(kind)`, which makes a new room of that kind and puts you in the middle of it.
- `__br.level.rooms[i].links[d]`: where room i's doorway d leads (`undefined` until someone needs it). Set one to `{ room, door }` to force a one-way doorway when testing the swap.
- **Teleport only within placed rooms.** Once a room is no longer placed, its old world coordinates are empty space. Use `goto`.
- **Test in your own tab.** The user may be playing in the Browser pane's tab.
- **Don't trust frame times from a hidden pane.** A background tab there gets no animation frames, and long synchronous `sim` loops in it stall at random for 0.1–5 s inside `renderer.render`, even with nothing changing. Measure GPU time with `__br.profile`, game logic separately, and building by timing the generator's slices.

## Measured (2026-11-20, hidden Browser pane, 540p)

- **Loading.** 11 rooms made at the start, 9–10 placed. Ready in 2.1–3.8 s warm, 8.7 s on a cold shader cache.
- **Walking.** 14 doorways crossed in a row, 36 rooms made: no errors, still 23 programs. Frames had a median of 4.8 ms and a worst of 17 ms (with room building in the background). The JS heap was 138 MB after 30 built rooms.
- **GPU.** Start hall 11.5 ms (the same as before the graph). The biggest pillar field (446 m²) 20.6 ms, and 22.7 ms with the weapon light on and firing.
- **The swap.** Looking back from inside the room you entered, the doorway still showed the corridor you came from. After two seconds of looking away, it led into another room.
- **The new types (GPU):**

  | Room | GPU | Placed copies |
  |---|---|---|
  | Service corridor | 6.2 ms | |
  | Tall void | 8.0 ms | |
  | Crawlspace | 9.2 ms | |
  | Self-loop | 13.4 ms | 12 |
  | Partition maze | 19.4 ms | |

  Still 23 programs: every new surface and prop reuses a shader.
- **Long walk.** 40 doorways with 24 rooms kept built: the heap levelled off at about 110–210 MB. 26 doorways crossed through every type: no errors.

## Not done yet

- **Rooms.** The looping stairwell (9) needs stairs, which the engine doesn't have yet.
- **Real-time frame times** with many rooms are unmeasured: the hidden pane can't show them (see above).
- **Recentring.** Coordinates grow as you walk; recentre the world on the room you're in once it's far from the origin.
- **Light through doorways** reaches only one room beyond each light's doorway, and a room more than one doorway away gets no direct light, only its bounce light.
- **Dark caps** still show where two rooms really can't both be placed (a doorway opening straight into another room's space) and nothing new fits. In walks they were rare and mostly far away.
- **Portal rendering** would let overlapping rooms both be seen (each drawn only through its own doorway); not worth the cost on the 610M yet.
