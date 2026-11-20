# The mold

The enemy: black mold that grows over the rooms' walls, floors and ceilings toward you. It creeps, and some colonies rush. Fire burns it back. If it reaches your feet, it takes the camera and the run ends.

Code: `world/surfaces.js` (the cells it lives on), `game/mold.js` (the simulation), `world/materials.js` (how it's drawn), `main.js` (`moldAround`, `die`, `updateEnd`: contact and the end), `audio/audio.js` (its sounds).

## What you see and hear

- **The growth.** Dark grey-green, almost black, and matte like velvet. Old, thick growth is blackest. The colony is raised in lumps that catch the light, with a soft sheen at a glancing angle and a few wet patches. Its edge is ragged and fractal and dissolves into specks, with small round colonies just ahead of it. A damp, yellow-brown stain spreads round it.
- **Creep.** A broad front that edges toward you a few centimetres a second, coming round through doorways and over the ceiling rather than through walls (it measures distance along the surfaces).
- **Rush.** For a second or two, thin tendrils race out from the colony's tips nearest you along the floor and walls, at about 2 m/s. A fresh tendril shows as a stain and specks first, then fills in black behind. The corridor colony only rushes while you're not looking at it.
- **Lights.** A ceiling panel the mold grows over starts to flicker, then sputters and dims, then goes out.
- **Fire.** Where fire touches it, it shrivels to ash and black char, with embers in the freshest char. It sizzles and pops while it burns. Nothing grows on char for about half a minute, and heat holds the edge back for a moment around a fire.
- **Doors and safe rooms.** A shut door holds the mold back: it only seeps under, at 4% of its rate (`cfg.seep`). It can't grow at all in a safe room while the generator runs. When it runs dry, the mold comes in. Outside a safe room's door, a colony waits and piles up while you're inside.
- **It burns.** Thick mold catches fire and feeds it. Flames creep over a colony from where the stream hit, about 2 m at most, leaving char and embers (docs/FLAMETHROWER.md).
- **Close to it.** A faint wet crackle near the mic, and now and then something wet giving way. A rushing colony brings a hiss that swells as it nears. Breathing its spores makes you cough.
- **The end.** If the mold covers the floor at your feet (or the wall you're pressed against, below 1.5 m) for 0.7 s, it takes you. A choked gasp. Dark growth closes over the lens from the frame's edges, soft and out of focus as anything on the cover glass would be. The picture breaks up, the signal goes (NO SIGNAL, the sound cuts out), then the end card. One death ends the run; "Start again" reloads.

## How it works

- **Per room.** Each room has its own cells, mold state and texture, in the room's own coordinates (docs/GRAPH.md). Only rooms placed around you grow. Across a doorway, the floor cells in its hole link to those of the doorway it leads to, so mold spreads, and measures its distance to you, through doorways along the graph's links: a doorway that doesn't lead back takes the mold somewhere else too.
- **Cells.** Every floor, ceiling and wall face that faces open air is cut into square cells of about 12 cm (`CELL`): 4,000 in a closet, 25,000–70,000 in a hall or pillar field. Each cell is one texel of an atlas texture (512 wide, RG8: r is mold 0–1, g is char 0–1), with a one-texel border copied from each surface's edge so filtering never reads a neighbour. The room's geometry is built from the same surfaces and carries their atlas coordinates (`aMoldUv`). Ceiling fixtures project onto the ceiling's cells.
- **One skin.** Cells know their neighbours, including across the corners where surfaces meet (floor to wall, round a wall's corner, wall to ceiling), so mold spreads over a room as one layer.
- **Distance to you.** A breadth-first search from the cells at your feet, over the cell graph, spread over several frames (6,000 cells a frame) and restarted every 0.3 s. The finished distances replace the old ones at once. So "toward you" means along the surfaces: round through the doorway, not through the wall.
- **Spreading.** Each frame, every cell on a colony's edge may take each free neighbour, with odds of the colony's speed × a bias × how readily that cell takes × dt. The bias prefers cells nearer you (creep: 4 toward, 1 sideways, 0.2 away). How readily cells take is patchy (smooth noise) with grain, which makes the front ragged and fractal.
- **A colony's temper.** Each colony has a creep speed, a rush speed, how often it rushes (`rushEvery`), for how long (`rushFor`), when (`'unseen'`: only while you aren't looking at its tip; `'clock'`; `'never'`), a range (it only rushes within this distance along the surfaces) and how fast new growth thickens (`thicken`: creeping, rushing).
- **Rush.** Only edge cells within 4 cells (`tipWidth`) of the colony's nearest point race, with a strong forward bias (7 toward, 0.25 sideways). A rushing cell starts thick enough to race on at once. The result: thin tendrils from the tips, not a wall.
- **Thickening.** New cells start thin and thicken over the colony's `thicken` time. A creeping cell spreads only once it is a fifth grown.
- **Fire** calls `burn(x, y, z, r, amount)`: from every fire on a surface each frame (r 0.2–0.65 m), at every splash (r 0.42–0.63 m), and along a sliding stream (some frames). What a fire burns feeds it. `moldPeak` (`world.moldAt` in the world) finds the thickest living mold near a point, for fire to creep onto. Burning removes mold, adds char (nothing grows on char above 0.25; it fades at 0.025 a second, so a burnt patch stays clear for about 30 s) and marks cells within 1.6 r as hot, which can't be taken for 0.6 s. A burnt-out cell turns its neighbours back into edge.
- **Lights.** Every 0.25 s each panel reads the mold over its cells: above 0.12 it flickers, above 0.35 it's dying (dim with bursts), above 0.55 it goes out.
- **Contact and spores.** `contact()` is the most mold on the floor within 0.34 m of your feet, or on a wall within 0.36 m below 1.5 m. Above 0.5 it counts up, and it falls back twice as fast when you step off; at 0.7 s you die. Thick mold within 2.2 m makes you cough every few seconds (sooner the more there is).
- **Upload.** While anything in a room grows, burns or fades, its whole texture is rewritten and uploaded that frame.

## How it's drawn (`world/materials.js`)

The rules this round taught, all in `MOLD_SURFACE`, `MOLD_ROUGH`, `MOLD_BUMP` and `MOLD_SPEC`:
- **Dark.** Albedo 0.011–0.039, grey-green. The paler fuzz at the growing rim and on the spots reaches only 0.085. At 0.1 or more, mold lit up close by a fire read as pale grey plaster next to the dimmer wallpaper behind you.
- **Matte.** Its specular reflectance is cut by 85% and its grazing reflectance (F90) to 0.12. With the usual reflectance, a wall of mold seen along the corridor toward a fire showed nothing but its glancing reflection: pale grey, as bright as the wallpaper beside it.
- **Texture from light, not colour.** Raised lumps (a bump from its height, 2 cm at most) and a velvet sheen at glancing angles. Flat black with no texture read as a hole or as paint.
- **No crisp edge.** Fine granules in the edge make it dissolve into specks, and the height rises gently from the edge. A height step there drew a dark rim like torn paper.
- **The noise tiles every unit,** so read it in rotated coordinates at unrelated scales. Read straight, the fine detail repeated in a visible grid.
- **The stain** round it is multiplied in (yellow-brown). **Char** is ash and black char, with emissive embers only in the freshest.
- **Panels under mold** darken with it (`moldPanel`), and each lit panel has its own material for that.

## Tuning (live, from the console)

- `__br.mold.cfg`: `toward`, `side`, `away` (creep bias), `rushToward`, `rushSide`, `rushAway`, `tipWidth`, `charBlock`, `charFade`, and `creepK` / `rushK`, which calibrate the measured edge speed to the colony's `creep` / `rush`.
- `__br.mold.colonies[k]`: `creep`, `rush` (m/s), `rushEvery`, `rushFor` (s, [min, max]), `when`, `range` (m), `thicken` ([creep s, rush s]), and live `mode`, `t`, `cells`, `lastTipDist` (cells; × 0.12 for metres).
- Hooks: `seed(k, x, y, z, r, density)`, `burn(x, y, z, r, amount)`, `clear()`, `rush(k, seconds)` to set one off now, `contact()`, `touch()`, `die()` to test the end, `stats` (`cells`, `front`, `rush`, `nearest`, `bfsMs`), `state()` (the raw arrays).

**Colonies** come with a room's plan (world/rooms.js):
- **The start corridor**: fills its far end, round the doorway there. Creeps at 0.09 m/s, rushes at 2.2 m/s for 1–2.2 s every 14–30 s, only when unseen and within 14 m. Thickens in 3.5 s creeping, 0.6 s rushing. Generated corridors get the same temper, a little more often the deeper they are.
- **Corners** of halls and pillar fields: creep at about 0.05 m/s; deeper in, some rush on their own clock.
- **Closets**: often a thick colony at the back.
- (The test room's corner colony over the panel at (-6, -1.5) is gone with the test room.)

## Measured (2026-11-20, hidden Browser pane, 540p)

- **Speeds.** With the first calibration (0.55), creep measured 0.10 m/s and a forced rush 2.4 m/s against targets of 0.09 and 2.2; both factors are 0.5 now. A speed is measured as the change in `lastTipDist` over 20 s of creep, and over a forced 2 s rush from more than 5 m away.
- **Burning.** About 1.5 s of fire at the corridor colony and a 2 s sweep took it from 2,284 cells to 1,844. The char held, and the colony kept creeping round the burnt patch.
- **Lights.** Standing under the panel at (-6, -3.9), 2.2 m from the corner colony: it flickered after 50 s and died after 55 s (and the colony reached the camera soon after).
- **The end.** 3.3 s from contact to NO SIGNAL, 4.6 s to the card.
- **Cost.** GPU 14.0 ms a frame idle in the hall and 10.4 ms in the corridor facing the mold: no change beyond the iGPU's clock noise (16.4 ms idle before). CPU: all game logic 1.6 ms a frame, mold included (its distance search at most about 0.4 ms).
- **Shaders.** `__br.programs()` is 23 (21 before) and stays there through walking, the light, crouching, firing, mold growth and the end.
- **Loading.** 6.7 s to ready on a cold shader cache (3.7 s of it compiling), 2.1 s warm.
- **Brightness.** The corridor deep in mold, under the weapon light alone: mean 0.015, with the exposure at its 2.4 limit. The black mold swallows the light; the light's pool on the floor shows where its edge is. (Measured with the old 24 cd light. At 48 cd with a wider spill, round 7, the mold reads as black, ragged shapes on the lit walls and floor from 3–5 m away.)

## Not done yet

- **Encounters.** The ones in docs/ROOMS.md beyond creep, rush and a grown-over doorway (ambush, bloom, behind you).
- **Safe rooms.** Mold doesn't avoid light or dry rooms yet (the safe-room rule), and there are no doors to slow it.
- **Spores.** Nothing drawn in the air yet, only the coughing.
- **Upload.** Upload only the rows that changed, if the atlas grows with more rooms.
- **Objects.** Mold grows on the room's shell and the ceiling fixtures only.
