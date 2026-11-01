# Plan v2: PolyBlast — 3D low-poly multiplayer battle royale

*Revised after the user chose a first-person 3D view and eventual public hosting.*

**Status: shipped and hosted.** Built and playable three ways: `http://localhost:3000` (real
multiplayer), `npm run desktop` (Electron window running the server in-process), and on GitHub Pages
as a static build where the match runs inside the page. Keyboard/mouse, controller and touchscreen are
all supported, and the game switches between them by itself. Package installers are not set up yet;
see [README.md](README.md) for run/play/tune instructions. Each player now has a customisable
avatar (body colour, trim, hat) that bots randomise, and the lobby has a live 3D preview of it.
Steps 1–7 of the build order are done, with
the 23-check headless suite (`npm test`) passing.

One thing the plan did not anticipate, found during playtest: an idle player was dying to bots in
6–17 s. Two causes — bots had 360° awareness (`botFov` was defined but never used) and bot fire had
no accuracy handicap (`botSpreadPenalty` was unused, so their aim error still let them land ~40% of
shots at 30 m). Both are fixed; measured over 20 seeds, an idle player now survives a median of 66 s.

A first-person battle royale you can play with friends: drop into a low-poly arena, loot, and fight
until the circle leaves one player standing.

## Shape

- **3D first-person**, Three.js, low-poly flat-shaded art. No external model/texture assets — geometry
  is built from primitives at runtime, so the whole game is code in this repo.
- **Real multiplayer**: an authoritative Node server owns the match; browsers connect over WebSockets.
- **2–16 humans** plus **AI bots** filling the lobby, so a solo test still plays like a battle royale.
- Runs offline at `http://localhost:3000`; friends on your LAN join via your IP.

## Architecture

```
Browser (Three.js client)              Node server (authority, 30 Hz)
--------------------------             -------------------------------
input.js   pointer lock, WASD, mouse   sim.js    movement, collision, weapons,
render.js  scene, players, zone, fx            damage, loot, zone, win condition
net.js     ws + snapshot buffer        world.js  seeded map gen, AABB collision, raycasts
hud.js     health/ammo/minimap         bots.js   AI (loot, rotate, engage, cover)
main.js    screens + game loop         index.js  static files + ws upgrade
```

**Authority:**
- Clients send *intents only*: `{yaw, pitch, moveX, moveZ, jump, fire, reload, interact, slot}`.
- Rotation is client-owned so aiming feels instant. Position, health, hits, damage, pickups, deaths
  and the winner are all resolved server-side. Hitting a player requires a real raycast through the
  server's world geometry, so you cannot shoot through walls.
- Hitscan raycasts with server-applied spread; the client only draws tracers from broadcast events.
- **Netcode:** 30 Hz fixed-step sim, 20 Hz snapshots. Own position is eased toward the authoritative
  position (no full rewind/prediction — on localhost/LAN the correction is invisible), own rotation is
  instant, remote players are interpolated ~100 ms in the past.
- **Deployability:** `server/sim.js`, `world.js` and `bots.js` are plain ES modules with no Node APIs
  and no timers — the transport lives in `index.js`. That keeps a later port to a Durable Object
  (Workers + Sites realtime) to swapping the transport, not rewriting the game.

## Match rules

1. **Lobby** — join, pick a name. When at least one human is in, a 5 s countdown starts and bots fill
   to a target lobby size. Late joiners spectate until the next match.
2. **Drop** — everyone spawns unarmed at a spread-out position with 3 s of spawn protection.
3. **Loot** — weapons, ammo, medkits and armor plates lie around the map. `E` takes or swaps.
4. **The circle** — five phases: hold, then close. Outside the ring you take escalating damage.
   A minimap and an off-screen arrow show where to run.
5. **Combat** — hitscan guns with spread, headshot multipliers, armor absorption, no respawns.
6. **Win** — last player standing. Results for 5 s, then a fresh match on a newly generated map.

## Content in v1

- **Weapons:** pistol, SMG, shotgun (8 pellets), rifle. Each has damage, rpm, spread, mag, reload,
  range and headshot multiplier, all in one tunables table.
- **Items:** ammo crate, medkit (+40 HP), armor plate (+25 armor, absorbs 60% of damage).
- **Two weapon slots**, per-kind reserve ammo, tactical reload.
- **Map:** 160×160 arena, seeded procedural buildings, crates and cover, boundary walls, flat shading,
  fog, gradient sky, grid ground.
- **Bots:** prioritise loot while unarmed, rotate to the safe circle, engage the nearest visible enemy,
  strafe, reload, and retreat when hurt.
- **HUD:** crosshair + hit markers, health/armor, ammo, weapon slots, alive counter, circle timer,
  kill feed, minimap, damage numbers, spectator camera.
- **Feel:** muzzle flash, tracers, screen shake, footstep/gunshot synth SFX via WebAudio (no files),
  per-player colours and floating name tags.

## Controls

`WASD` move · mouse look · left click fire · `R` reload · `E` pick up · `1`/`2` gun slots ·
`3` knife · `Shift` sprint · `Ctrl`/`C` slide · `Space` jump · `Esc` release mouse.

## Files

```
package.json            deps: ws, three
PLAN.md                 this document
README.md               how to run, play, tune, and deploy later
shared/protocol.js      message shapes, constants shared by both sides
server/config.js        every tunable: weapons, zone, movement, match rules
server/world.js         seeded map generation, AABB collision, raycasts, loot placement
server/sim.js           authoritative match: players, damage, zone, win condition
server/bots.js          bot decision making
server/index.js         HTTP static server + WebSocket room + tick loop
public/index.html       shell, lobby, HUD markup, import map for three
public/style.css        UI styling
public/js/net.js        socket + snapshot buffer + interpolation
public/js/input.js      pointer lock, key state, mouse buttons
public/js/render.js     Three.js scene, world meshes, players, tracers, zone, loot
public/js/hud.js        DOM HUD + 2D minimap
public/js/sfx.js        procedural WebAudio sound effects
public/js/main.js       bootstrap, screens, per-frame loop
test/smoke.test.js      headless end-to-end: clients join, shoot, die, one winner, reset
```

## Build order (each milestone playable)

1. **Skeleton** — server serves the client, ws join works, lobby lists players, pointer-lock 3D scene
   renders an empty arena.
2. **Movement** — WASD + look + jump, collision against walls, server-authoritative with smoothed own
   position; verify with two browser tabs.
3. **Combat** — firing, spread, raycast hit detection, damage/death, tracers, hit markers, kill feed,
   spectating.
4. **Loot** — pickups, two slots, reload, ammo, medkits, armor.
5. **Battle royale loop** — shrinking circle with damage, last standing, results, fresh seed.
6. **Bots** — looting, rotating, engaging, and dying convincingly.
7. **Polish + proof** — HUD/minimap/sfx, headless smoke test, two-tab playtest, README.

## Out of scope for v1

Squads/teams, vehicles, destructible terrain, accounts/persistence/leaderboards, cross-server
matchmaking, mobile touch controls, voice chat, cosmetics, ranked anti-cheat beyond server authority.

## Public hosting

**Live now:** <https://venulousthyduckulous.github.io/PolyBlast/> (GitHub Pages, repo `PolyBlast`).

The transport-agnostic sim paid off here. Pages only serves files, so instead of a WebSocket server
the match runs in the page: `public/js/local-server.js` mirrors the server's join/input/tick/snapshot
loop and feeds the client through a socket-shaped object, so `Net` and everything above it are
unchanged. `npm run build` produces `dist/` (three.js vendored, all paths relative, plus an
`offline.json` marker) and `npm run deploy` force-pushes it to `gh-pages`.

Consequence to remember: **Pages is single-player against bots.** Real multiplayer still needs the
Node server. Hosting that means the Durable Object step below — Workers static assets for the client,
a WebSocket ticket endpoint with a realtime binding, and the sim ticked by the object's alarm loop.

## Multi-device input

Input is arbitrated in one place (`public/js/devices.js`): platform detection seeds the default
(touch on phones/tablets, keyboard on desktop) and then last input wins. A controller appearing or
being used takes over; touching the screen takes it back; a key or click takes it back again. This is
why the touch layer renders on top of the canvas as DOM rather than inside it — it can be hidden
entirely while a pad is driving, and the window-level touch listener still notices the tap that
reclaims control.

## How we'll know it works

- Headless smoke test: N synthetic clients join, the match starts, a shot deals damage, the circle
  closes, exactly one survivor wins, and the match resets.
- Manual: two browser tabs, confirm each sees the other move, shoot, and die; confirm walls stop bullets.
