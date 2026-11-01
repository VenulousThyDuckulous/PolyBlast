# Last Circle

A first-person, low-poly battle royale that runs on your machine. Drop in unarmed, scavenge a gun,
stay inside the circle, and be the last player standing.

- **Real multiplayer** — an authoritative Node server owns the match; browsers connect over WebSockets.
- **Bots fill the lobby**, so a solo drop still plays like a battle royale.
- **No external services, no accounts, no assets.** All geometry and all sound are generated in code.

## Run it

```bash
npm install       # first time only

npm run desktop   # desktop app: a Last Circle window, no browser needed
npm start         # browser mode: open http://localhost:3000 and hit DROP IN
npm run dev       # browser mode, restarting on server file changes
```

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

## Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| Left click | Fire |
| `Shift` | Sprint |
| `Space` | Jump |
| `R` | Reload |
| `E` | Pick up / swap weapon |
| `1` `2` | Weapon slots |
| `Esc` | Release mouse (pause overlay) |

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

A headless suite (`test/smoke.test.js`, 23 checks) that drives the real simulation with no browser:
map generation, collision, raycasts, movement, walls blocking bullets, headshots, armor, loot and
reloads, zone damage, bots looting and fighting, match reset, and one real WebSocket client joining
and receiving state.

## Architecture

```
electron/main.js        desktop shell: boots the server in-process, opens the game window
shared/protocol.js      message shapes + constants shared by both sides
server/config.js        every tunable
server/world.js         seeded map generation, AABB collision, raycasts, spawn/loot placement
server/sim.js           authoritative match: players, movement, damage, loot, zone, win condition
server/bots.js          bot decision making
server/index.js         static file server, WebSocket room, 30 Hz tick / 20 Hz snapshot loops
public/                 Three.js client: scene, input, netcode, HUD, minimap, procedural SFX
```

**Authority.** Clients send intents only (`yaw`, `pitch`, movement axes, `fire`, `reload`, `interact`,
`slot`). Position, health, hits, pickups, deaths and the winner are resolved on the server. Every shot
is a raycast against the server's world geometry, so bullets cannot pass through walls.

**Netcode.** 30 Hz fixed-step simulation, 20 Hz snapshots. Your own rotation is instant and your own
position is eased toward the authoritative one; other players are interpolated ~100 ms in the past.
That is deliberately simple — on localhost and LAN it feels immediate, and it avoids the complexity
of full rewind and lag compensation.

**Why it can move to hosting later.** `sim.js`, `world.js` and `bots.js` contain no Node APIs and no
timers — only the transport in `index.js` knows about sockets. Running the same match inside a
Cloudflare Durable Object (Workers static assets for the client, a WebSocket ticket endpoint, the sim
ticked by the object's alarm loop) is a transport swap, not a rewrite.

## Not in v1

Squads, vehicles, destructible terrain, accounts and leaderboards, cross-server matchmaking, mobile
touch controls, voice chat, cosmetics.
