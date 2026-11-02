# PolyBlast

A first-person, low-poly battle royale that runs on your machine. Drop in unarmed, scavenge a gun,
stay inside the circle, and be the last player standing.

- **Real multiplayer** — an authoritative Node server owns the match; browsers connect over WebSockets.
- **Bots fill the lobby**, so a solo drop still plays like a battle royale.
- **No external services, no accounts, no assets.** All geometry and all sound are generated in code.

## Run it

```bash
npm install       # first time only

npm run desktop   # desktop app: a PolyBlast window, no browser needed
npm start         # browser mode: open http://localhost:3000 and hit DROP IN
npm run dev       # browser mode, restarting on server file changes
```

### Hosted on GitHub Pages

**<https://venulousthyduckulous.github.io/PolyBlast/>**

GitHub Pages only serves files — it cannot run the Node server, so there is no WebSocket match to
join. The simulation was written free of Node APIs, so the same match runs **inside the page**
instead: you drop in against the bots, and everything else is identical.

That is what the client does automatically. It looks for an `offline.json` marker (written by the
static build); if it finds one it starts a local match immediately, and otherwise it tries a real
server first and only falls back if none answers. So the same code plays offline on Pages, solo in
the desktop app, and genuinely multiplayer under `npm start`.

```bash
npm run build     # -> dist/ : the whole game, three.js vendored, all paths relative
npm run deploy    # build, then force-push dist/ to the gh-pages branch
```

The build is deliberately dumb: it copies files, writes `.nojekyll` and `offline.json`, and vendors
the three.js ESM build. There is no bundler step and no CI, so what you test locally is what ships.
Everything is referenced relatively, which is what makes the `/PolyBlast/` subpath work.

**Offline means no other humans.** On Pages you are playing against bots. Real multiplayer needs the
Node server, either locally or somewhere that can run it.

### Desktop app

`npm run desktop` launches the game in its own window via Electron. The window is just a shell: the
same HTTP + WebSocket server runs **in-process** inside the app, and the window loads the same client
the browser does, so the game itself is identical in both modes.

- The server tries port `3000`, and falls back to a free port automatically if something else is
  already using it — so you can run the desktop app and a browser session side by side.
- The renderer is sandboxed with no Node access; it only talks to the local server over HTTP and
  WebSocket. Mouse-look is granted through Electron's pointer-lock permission, and popups are denied.
- Closing the window stops the server and releases the port.

Building installable bundles (.exe/.dmg/AppImage) is not set up yet — that needs an installer packager
such as `electron-builder`.

Play with friends on the same network: the server prints its LAN address on boot, e.g.
`http://192.168.0.71:3000`. Anyone on that network can open it and join the same match. A friend in
browser mode joins the desktop app's match the same way, as long as they can reach its port.

> The page needs a mouse to aim. If a browser blocks pointer lock, you can still move and shoot —
> only the mouse look requires the lock.

## Your character

The lobby has a character editor: pick a body colour, a trim colour and a hat, and the model on the
turntable is exactly what other players see (the same mesh builder draws them in the match). Bots get
randomised avatars, so the lobby and the battlefield are full of different silhouettes.

Avatars are three indices ([`shared/avatar.js`](shared/avatar.js)), validated on join by
`sanitizeAvatar`, so a hand-crafted join packet can only choose from the published lists. The choice
is saved in `localStorage` and sent with the join packet.

## Controls

The game works out what you are playing on and switches to match. The rule is **last input wins**,
seeded by the platform:

| You are on | Default | Then |
| --- | --- | --- |
| Phone or tablet | Touchscreen | A connected controller takes over; touching the screen takes it back |
| Desktop | Keyboard + mouse | A controller takes over as soon as it is used; a key or click takes it back |

The lobby tells you which one is live, and a controller being plugged in or removed is picked up
immediately. Tapping the screen while a controller is driving hands control back to touch, and any
controller button hands it back to the controller — so the two never fight over the same stick.

**Keyboard + mouse**

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| Left click | Fire |
| Right click (hold) | Scope in (sniper) |
| `Shift` | Sprint (drains stamina) |
| `Ctrl` or `C` | Slide (needs sprint speed) |
| `Space` | Jump |
| `R` | Reload |
| `E` | Pick up / swap weapon |
| `1` `2` | Gun slots |
| `3` | Knife |
| `Esc` | Pause / release mouse |

**Controller** (standard mapping — Xbox layout names, any pad should do)

| Input | Action |
| --- | --- |
| Left stick | Move |
| Right stick | Look |
| `RT` | Fire |
| `LT` | Sprint |
| `B` or `L3` (hold) | Slide |
| `A` | Jump |
| `X` | Reload |
| `Y` | Pick up / swap weapon |
| `LB` | Scope in (sniper) |
| `RB` | Next weapon |
| `D-pad left/right` | Gun slots |
| `D-pad up` | Knife |
| `Start` | Pause |

**Touchscreen** (landscape recommended)

| Input | Action |
| --- | --- |
| Left thumb stick | Move |
| Drag anywhere else | Look |
| `FIRE` / `JUMP` / `RELOAD` / `PICK` | Actions |
| `SLIDE` (hold) | Slide |
| `SCOPE` (hold) | Scope in |
| `1` `2` | Gun slots |
| `KNIFE` | Knife |
| `II` | Pause |

The stick and the look drag track separate fingers, so you can run and aim at once. The HUD moves
itself out of the thumb zones and respects notched-screen safe areas.

## Movement and melee

**Sprint** is `9.2` m/s against a `6.4` walk, ramping in over about a tenth of a second and braking
smoothly when you let go. It burns stamina (21/s) and an empty bar latches until you release the key,
so a held `Shift` cannot stutter between two speeds.

**Slide** is a burst of momentum: it needs sprint speed, costs 20 stamina, lasts 0.72 s, and takes a
0.8 s recovery before you can slide again. While sliding the hitbox drops from 1.8 m to 0.95 m and the
camera drops with it, so shots aimed at a standing chest pass over your head. Firing ends the slide
but keeps the speed, which is what makes slide-into-shooting feel good. Holding the key does **not**
chain slides — release and press again.

**The knife** lives in its own third slot and is always yours; it is never looted, never reloads and
never runs dry. It hits for 58 inside 2.4 m with a 105 rpm swing, so it is a finisher, not a duelist's
weapon. Guns still fight over the two gun slots — picking one up can never displace the knife.

**The takedown** is the stealth kill: with the knife out, walk up behind someone who has not engaged
you (no shots at you in the last 2.5 s, and bots that are tracking you are excluded) and swing. It is
an instant elimination with a flash, a sting and a kill-feed entry — arcade, not graphic. A `FINISH`
chip appears above the crosshair when the server would allow it, so the mechanic is readable before
you commit. A successful takedown refunds 25 stamina, which usually pays for the escape slide.

Bots sprint, slide occasionally, and switch to the knife when they run dry in someone's face, so all
of this happens in a solo match too.

**The sniper** is the rarest find and the only weapon with an optic. Through the lens its cone
collapses from 5.2° of hip-fire spray to 0.05°, it reaches 220 m, and a headshot ends the fight
outright. The trade is movement: scoping caps you at 2.6 m/s and rules out sprinting and sliding,
and the bolt cycle is slow enough that a miss is a real problem. Firing from the hip at range is
mostly a way to give your position away. Bots that pick one up hold the range band it belongs in
rather than walking into SMG distance with it.

## How a match plays

1. **Lobby** — the first human to join starts a 5 s countdown and bots fill the lobby to 10.
2. **Drop** — everyone spawns unarmed with 3 s of spawn protection.
3. **Loot** — weapons, ammo, medkits and armor plates are scattered across the map.
4. **The circle** — holds, then closes, in five phases. Outside the ring you take escalating damage;
   the minimap and the off-screen arrow tell you where to run.
5. **Win** — last player standing. Results show for a few seconds, then a fresh match starts on a
   newly generated map. The room resets to a clean lobby when the last human leaves.

## Tuning

Every number that affects feel lives in one file: [`server/config.js`](server/config.js).

| What you want to change | Where |
| --- | --- |
| Weapon damage, rpm, spread, magazine, reload, range | `WEAPONS` |
| Movement speed, sprint, jump, gravity, HP, armor absorption | `PLAYER` |
| Stamina drain/regen, slide speed, duration, cooldown, hitbox height | `PLAYER` |
| Knife damage, reach, swing rate | `WEAPONS.knife` |
| Takedown range, rear arc, awareness window, stamina refund | `MELEE` |
| Zone phase timings, radii and damage-per-second | `ZONE_PHASES` |
| Lobby size, bot count, loot density, pickup radius | `MATCH` |
| **Difficulty** | `SIM.botSpreadPenalty` |

`SIM.botSpreadPenalty` is the main difficulty dial: it multiplies a bot's shot cone. `1` makes bots
laser-accurate; the shipped value is `7`. Also in `SIM`: view cone (`botFov`), hearing radius
(`botHearing`), reaction delay (`botReaction`) and burst length/pause (`botBurstShots`,
`botBurstPause`) — bots are not omniscient, they only see what is in front of them.

The server sends the weapon table and zone schedule to the browser on connect, so tuning those needs
only a server restart — no client changes.

## Tests

```bash
npm test
```

A headless suite (`test/smoke.test.js`, 35 checks) that drives the real simulation with no browser:
map generation, collision, raycasts, movement, stamina and slide physics, walls blocking bullets,
headshots, armor, the knife and the takedown rules, loot and reloads, zone damage, bots looting and
fighting, match reset, and one real WebSocket client joining and receiving state.

## Architecture

```
electron/main.js        desktop shell: boots the server in-process, opens the game window
shared/protocol.js      message shapes + constants shared by both sides
shared/avatar.js        avatar lists + validation, shared by client and server
server/config.js        every tunable
server/world.js         seeded map generation, AABB collision, raycasts, spawn/loot placement
server/sim.js           authoritative match: players, movement, damage, loot, zone, win condition
server/bots.js          bot decision making
server/index.js         static file server, WebSocket room, 30 Hz tick / 20 Hz snapshot loops
public/js/local-server.js  the same match driven in-page, for static hosting (no sockets)
public/js/net.js        transport: real server, or the local match; snapshot interpolation
public/js/avatar-mesh.js   the low-poly character, built from primitives
public/js/editor.js     lobby character editor + 3D preview
public/js/devices.js    platform detection, gamepad polling, which device is driving
public/js/touch.js      thumbstick, look drag and action buttons
public/js/input.js      turns any device into one stream of intents
public/js/main.js       frame loop, view assembly, events -> effects
scripts/build-static.mjs   dist/ for GitHub Pages
scripts/deploy-pages.mjs   publish dist/ to the gh-pages branch
```

**One simulation, two transports.** `public/js/local-server.js` mirrors what `server/index.js` does
over sockets — join, input, tick, snapshot — but delivers the messages through a socket-shaped object
that never touches the network. `Net` cannot tell the difference, so offline play runs the identical
client code path as real multiplayer, including interpolation.

**Authority.** Clients send intents only (`yaw`, `pitch`, movement axes, `fire`, `slide`, `reload`,
`interact`, `slot`). Position, stamina, hits, pickups, deaths and the winner are resolved on the
server. Every shot is a raycast against the server's world geometry, so bullets cannot pass through
walls, and a slide only exists because the server agreed you were fast enough and had the stamina.

**Netcode.** 30 Hz fixed-step simulation, 20 Hz snapshots. Your own rotation is instant and your own
position is eased toward the authoritative one; other players are interpolated ~100 ms in the past.
That is deliberately simple — on localhost and LAN it feels immediate, and it avoids the complexity
of full rewind and lag compensation.

**Why it can move to hosting later.** `sim.js`, `world.js` and `bots.js` contain no Node APIs and no
timers — only the transport in `index.js` knows about sockets. Running the same match inside a
Cloudflare Durable Object (Workers static assets for the client, a WebSocket ticket endpoint, the sim
ticked by the object's alarm loop) is a transport swap, not a rewrite.

## Not in v1

Squads, vehicles, destructible terrain, accounts and leaderboards, cross-server matchmaking, voice
chat, cosmetics, and hosted multiplayer (Pages is single-player against bots; the roadmap for real
hosting is the Durable Object transport swap described above).
