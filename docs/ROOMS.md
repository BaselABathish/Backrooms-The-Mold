# Rooms: draft catalogue

Status (2026-11-20): built, see docs/GRAPH.md:
- archetypes 1–7, 10, 11, 13 and 14;
- corridor T and zigzag shapes;
- dark stretches (archetype 12 in part: dark rooms come in runs).

- safe rooms with their generators, and doors (world/interact.js, docs/GRAPH.md).

- flooded rooms (round 8): water from noise in the room's own coordinates, reflections only in the water, a tide line, wading.

Not built: the looping stairwell (9), and in safe rooms the tap and batteries.

## How rooms are made

Every room is an **archetype** (what kind of space it is) built with **parameters** (shape, size, light, wear). One archetype gives many rooms, so the place never tiles visibly.

| Parameter | Range |
|---|---|
| Footprint | rectangle, L, T, U, cross, ring (around a solid core), irregular (merged rectangles) |
| Size | S (3–5 m), M (6–12 m), L (12–25 m), XL (25–60 m) |
| Ceiling | low 2.1 m, normal 2.6 m, tall 4–5 m, void (lights hang into darkness) |
| Lights | all on, one dead, flickering, patchy, dark |
| Wear | clean, stained, damp, torn wallpaper, water-damaged ceiling tiles |
| Doors | 1–6 doorways: open archways, framed door holes, real doors (rare) |
| Surface set | yellow wallpaper (most), off-white paint, faded green, concrete |

**Rendering:** the room you're in plus **N rooms deep** through doorways (N = 2–3, tuned to the iGPU). Rooms past that are never in view, because doorways and corridor bends block the line of sight. Rooms can overlap in world space as long as they're never visible at once.

**Drift:** the farther you get from the start, the more rooms drift away from the classic look. They get more damp, more mold, fewer working lights, odder archetypes. That gives a sense of going deeper, even in free roam.

## Archetypes

### Common (most of the map)

**1. Wallpaper hall.** The classic space: an open room broken up by partial walls and stub walls. Sizes M–XL. Long sightlines, so the space inside must make sense; the impossible connections happen at its doorways. Mold encounter: a **rush** across the carpet, seen from far off.

**2. Corridor.** Narrow (1.2–2 m), straight, L, zigzag or T. This is where most of the impossible connections are hidden: a bend hides the switch. Mold encounter: a **rush** down its length, or a doorway ahead sealed over.

**3. Pillar field.** A huge, low room with a grid of square pillars. Lit in patches, so there are pools of light with dark gaps. You lose your direction here. Mold encounter: it **creeps** from pillar to pillar, out of sight behind them.

**4. Partition maze.** Dense walls 1.5 m to full height, like an office with the desks taken out. Short sightlines, many turns. Mold encounter: **ambush** around a corner.

**5. Closet / alcove.** Small dead ends, 2–4 m. Sometimes a closet holds supplies, sometimes it's **bigger on the inside** (a closet door opens onto an XL hall).

### Variants (rarer, to break the rhythm)

**6. Crawlspace.** Ceiling at 1.5 m: you crouch to pass. Ducts, cables, fibreglass. Feels trapped. Mold on the ceiling right above the camera.

**7. Tall void.** A normal floor, but the ceiling rises out of sight. Light fixtures hang on long cables. The hum comes from above.

**8. Flooded room.** The carpet is soaked, with ankle-deep water in the low spots. Splashing footsteps. The pipeline's floor reflections return here, on the water. Mold grows fastest in the damp.

**9. Looping stairwell.** Concrete stairs. Go down four flights and come back out at the landing you started on. A sign of what the place is like, not a puzzle.

**10. Service corridor.** Concrete, exposed pipes, a buzzing breaker panel, a caged light. Darker and colder. This is where fuel and batteries are usually found, which fits the setting.

**11. Office remnant.** Rare. A desk, a chair, a dead phone, a filing cabinet. Like something left behind. It feels important and holds supplies. Later it could hold story.

**12. Dark sector.** A cluster of rooms with every light dead. Flashlight only. Mold you can't see until the beam finds it.

**13. Self-loop room.** A room where one doorway leads back into the same room through its opposite wall. You notice it from a stain or a prop you just passed. Cheap and very unsettling.

**14. Wrong room.** A room that's almost the one you were just in: same shape, one thing different (a light that was on is off, a stain moved). It's a copy, not the room itself.

## Safe rooms

They have to look and sound different, so the player recognises one before stepping inside:
- **Look and sound.** Cool white light instead of yellow, painted concrete walls, and a steady generator hum in place of the buzz.
- **Entrance.** One heavy metal door that you close behind you.

**Why they're safe:** the mold doesn't grow where it's lit and dry. A safe room stays safe **while its lights are on**, and its lights run on a small generator.

**What keeps them from being a hiding place forever:** the generator burns fuel, the same fuel as the flamethrower.
- Staying means spending what you'd use to fight.
- When the generator runs dry, the lights go out and the mold that has been waiting at the door starts to come in.
- On the outside of the door, the mold piles up while you're inside: a warning, and a reason to burn your way out.

**Inside:** sometimes supplies (fuel, batteries), a working tap (water, to recover from spores), and a chance to breathe. They're rare, and the player shouldn't be able to find their way back to one easily (the graph sees to that).

## Mold encounters (by room)

The mold's speed changes per encounter, as you asked:
- **Creep.** Slow, steady spread along walls, floors and ceilings. Pillar fields, mazes, dark sectors.
- **Rush.** A fast surge: a black tide across a floor, up the walls. Long corridors and open halls, where you see it coming.
- **Bloom.** The room you're in starts going dark from inside the walls. Any room, once the mold level is high.
- **Seal.** A doorway is grown over; burn through or find another way.
- **Behind you.** The room you just left fills up. You see it on your own footage first.

## Decided (2026-11-20)

- **Crouching: yes.** Crawlspaces stay in.
- **Doors: yes.** Rare, heavy doors outside safe rooms that you can close to slow the mold.
- **Flamethrower in frame:** the nozzle and wand at the lower edge of the picture, with no hands showing (hands are hard to make convincing; see bodycam-game's no-characters rule).
