# Backrooms (working title)

A found-footage survival game in the backrooms, shot on a 90s camcorder. It's built with three.js and Vite, everything is procedural (no asset files), and it runs in the browser, including on phones and weak laptop GPUs. The camera simulation started from Signal Loss's body camera (`../bodycam-game`) and is now a 90s CCD camcorder recording to tape: 4:3, soft and late colour, grain, dropouts, a red REC and the date stamp burned in. The chest-mounted rig and the synthesized audio come from Signal Loss too.

```bash
npm install
npm run dev        # http://127.0.0.1:8796
npm run build      # static site in dist/, deployable to GitHub Pages
```

**Now:** the backrooms as a graph of rooms, made as you go: wallpaper halls, corridors (straight, bent, T, zigzag), pillar fields, partition mazes, closets, crawlspaces you crawl through, tall voids with lights hanging into the dark, concrete service corridors, an office left behind, rooms that loop into themselves, and rooms that are almost the one you just left. They're lit, dying or dark, and deeper rooms are darker and moldier. Doorways join them seamlessly, but one in five doesn't lead back the way you came (the room behind you changes while you aren't looking), and sometimes a doorway loops into a room you've already passed through. You start in the old test hall; past its far doorway, a dark corridor is grown over with black mold, its doorway sealed. Mold spreads toward you along walls, floors and ceilings and through doorways. It creeps, and some colonies rush when you aren't looking. Burn it back with the flamethrower. If it reaches your feet, it takes the camera and the run ends. Your fuel is finite (the gauge on the flamethrower shows it). Some doorways have heavy doors you can shut against the mold, and behind a shut door the room can change. Deeper in, some rooms are flooded: ankle-deep water you wade through, and the mold grows fastest there. Safe rooms are lit and dry, behind a steel door: the mold can't grow in them while their generator runs, and the generator burns the same fuel as you.

**Controls:**
- **Keyboard and mouse:** WASD to move, Shift to run, mouse to look. Hold the left mouse button (once the pointer is locked) or Space to fire. E uses things (doors, a generator: hold E to pour fuel in, fuel cans). F turns on the weapon light, C crouches (or hold Ctrl), V turns the camcorder effects on and off, and Q changes the resolution.
- **Touch:** the left thumb moves and the right thumb looks. Hold FIRE to fire, and drag it to aim while firing. USE appears when something usable is in reach.

**Docs:**
- [docs/ROOMS.md](docs/ROOMS.md): the room catalogue, safe rooms and mold encounters.
- [docs/GRAPH.md](docs/GRAPH.md): how rooms are made, joined and placed around you (the space isn't Euclidean).
- [docs/FLAMETHROWER.md](docs/FLAMETHROWER.md): how the fire works and what to tune.
- [docs/MOLD.md](docs/MOLD.md): how the mold grows, burns and is drawn, and what to tune.
- [CLAUDE.md](CLAUDE.md): the quality bar and the checks every change goes through.
