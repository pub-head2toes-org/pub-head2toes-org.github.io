# Plan: (PWA) LoL — Laugh out Loud

A single-page, multiplayer top-down map explorer. Pure HTML/CSS/JS PWA under
`/pwa/lol/`, canvas-rendered viewport over a big raster map
(`maps/dota_map.jpg`, 5087×4916px). Each participant runs their own instance;
instances synchronize over one shared channel: **send** = HTTP `PUT` to
`sse_link`, **listen** = `EventSource` (SSE) on the same `sse_link`. Reuses
the `joint` PWA conventions (PUT/SSE helpers, PWA shell, blue theme), same as
`rummy`.

## Entry

`index.html?organizer=<str>&participants=<CSV>&sse_link=<url>&game_name=<str>`

- Hand-off from `joint`'s lobby `Start` button, same mechanism as Rummy.
- Missing any required param (`organizer`, `participants`, `sse_link`) →
  redirect to `error.html`.
- **This is the prompt's "lobby screen"**: shows a name input + `Enter`
  button. `joint`'s `Start` action doesn't currently pass a `player` param
  (same gap Rummy hit and documented) — the name entered here becomes
  `player`, added to the local `participants` list if not already present.
  `Enter` swaps the view (same page, no navigation) into the main screen.

## Architecture decisions

1. **Single page, two views.** Lobby and main screen are sections of one
   `index.html` toggled by JS — no second URL-driven page needed beyond
   joint's hand-off.
2. **Peer-broadcast, not organizer-authoritative.** Unlike Rummy (which needs
   one canonical state owner for shuffles/turns), Phase 1 has no shared state
   to arbitrate — each client owns and broadcasts only its own avatar
   (position, facing, walking) and its own chat lines. Every instance keeps a
   local `players` map keyed by name, updated from received envelopes, and
   renders whatever it currently knows.
3. **Message envelope** (JSON, one per PUT), same shape convention as Rummy:
   `{ type: 'join'|'move'|'chat', from, ts, ...}`
   - `join`  — sent once on entering the main screen: `{x, y}` start position.
   - `move`  — throttled while walking (~150–250ms) + one final on arrival:
     `{x, y, dir, walking}`.
   - `chat`  — `{m}` → appended to the chat overlay board as `from: m`.
4. **Canvas + camera.** The full map image is drawn cropped to a
   viewport-sized region centered on the local player's world position,
   clamped to map bounds. Redraw on `requestAnimationFrame` while walking or
   the camera moves.
5. **Movement.** Point/tap on canvas → screen coord converted to world coord
   (viewport offset + zoom) → sets a target; each frame steps the player
   toward it at constant speed; camera recenters as needed; stopping on
   arrival fires the final `move`.
6. **Character sprite — procedural placeholder** (per your choice): one draw
   routine (used for self and every remote player) renders a colored
   circle/diamond with a small directional tick plus an idle/walk
   bob-and-squash animation. No image assets required; swappable for real
   sprite sheets later without touching call sites.
7. **Minimap** (bottom-right): small canvas drawing a scaled-down full map, a
   rectangle for the current viewport, and one dot per known player
   (including self).
8. **Zoom in/out** (top-right icons): adjusts the world-px size of the
   viewport crop (smaller crop = more zoomed in), clamped to min/max.
9. **Ability icon bar** (bottom row): fixed set of empty bordered squares,
   non-functional placeholders per the prompt.
10. **Chat overlay**: bottom-left phone-booth icon toggles a panel — readonly
    message board, text input, `Send` — reusing the `chat` envelope over the
    same `sse_link`.

## Files

`index.html`, `lol.js` (state, camera, rendering, movement, sync, chat),
`styles.css`, `error.html`, `manifest.json`, `sw.js`, `icon-192.png`,
`icon-512.png`. Map asset stays at `maps/dota_map.jpg`, referenced as
`./maps/dota_map.jpg`. `sw.js` follows Rummy's generic pass-through-and-cache
fetch handler (never caches `/sub/` calls); the 9.4MB map is **not**
precached at install — it's cached opportunistically on first load like any
other asset, so install stays fast.

## Build order (Phase 1)

1. Scaffold: `manifest.json`, `sw.js`, `styles.css` shell, `error.html`.
2. Lobby view: parse/validate params, name input + `Enter`, `join` envelope,
   view swap.
3. Canvas map viewport + camera centered on start position, resize handling.
4. Point-and-click movement + walking state + camera scroll.
5. Procedural sprite draw (self) with idle/walk animation.
6. Minimap (self first, then all players).
7. SSE connect + PUT send wiring; broadcast/receive `move`/`join`; render
   remote players.
8. Chat overlay (booth icon toggle + board + send) via `chat` envelope.
9. Zoom controls.
10. Ability icon placeholder row.

## Open assumptions

- Start position: bottom-left corner of the map in world coordinates (per
  the prompt), same fixed spawn for every player in Phase 1.
- Move-broadcast throttle (~150–250ms while walking, plus one on stop) is a
  starting point to avoid flooding PUT; tunable later.
- `sendMessage`/`EventSource` wiring is adapted directly from `joint.js`
  (`sse_link` arrives pre-built from `joint`, so no `buildSseLink` needed
  here — just PUT + `EventSource` against it).

## Phase 2 addendum — SSE-only state sync + in-page NPC bot

Per `UPDATE_1.md`, revised by `UPDATE_2.md`. The KV DB is explicitly
deferred ("can be developed at some later phase") and movement stays
SSE-only this phase. NPC bots are simplified to a single in-page example
bot (`Winnie`) rather than a standalone client — this supersedes the
DB-backed and Node-bot design from the original addendum below.

### Architecture decisions

11. **No KV DB this phase.** All state sync — including catching up a late
    joiner — happens over the existing SSE channel. No persistence layer,
    no organizer authority; still peer-broadcast only.
12. **Late-joiner catch-up via a `state_request` envelope.** A joining
    client sends `{type: 'state_request', from, ts}` right after its `join`.
    Every existing peer, on receiving a `state_request`, immediately
    re-emits its own current `move` envelope — bypassing the normal
    throttle — so the new joiner converges within one round trip instead of
    waiting on the next natural update. (This envelope shape isn't spelled
    out verbatim in `UPDATE_2.md`, just implied by "late comers could ask
    for state update over the SSE channel and receive updates... sent by
    each participant" — flagged as my proposed mechanism, see Open
    assumptions.)
13. **Idle heartbeat, independent of movement.** Today a stationary player
    broadcasts nothing after its final stop `move`. Per `UPDATE_2.md`'s
    500ms ceiling, add a heartbeat: any participant (human or bot) that
    hasn't broadcast in the last `HEARTBEAT_MS` (< 500ms, e.g. 400) re-sends
    its current `move` even while `walking: false`. This generalizes
    cleanly alongside the existing move-throttle, sharing the same
    `lastBroadcastTs` bookkeeping per participant.
14. **"All disconnect → state resets" needs no code.** It's already the
    natural consequence of no persistence — confirms the peer-only model is
    intentional, not a build task.
15. **NPC bots are in-page objects, not a separate process.** `bots.js`
    defines a global `Bot` namespace (`Bot.Winnie = { init(ctx), move(ctx)
    }`), loaded via `<script src="./bots.js"></script>` in `index.html`
    *before* `lol.js`'s own script tag so the namespace exists before the
    game loop wires up. Both are plain non-module scripts sharing one
    global scope — `bots.js` calls `lol.js`'s existing globals (`state`,
    `calcDir`, `clamp`, movement constants, `sendEnvelope`) directly; no
    Node, no `eventsource` package, no separate shared/build module needed.
16. **Bot activation gated by the `participants` list**, pattern
    `Bot.<name>`. On `enterGame()`, scan `state.participants` for entries
    matching `/^Bot\.(.+)$/`; for each match, resolve `window.Bot[name]`;
    skip with a `console.warn` if not found. **The `Bot.` prefix is
    stripped for the broadcast/display name** — `Bot.Winnie` in
    `participants` becomes player name `Winnie` in `join`/`move` envelopes
    and the on-screen label, so it renders identically to a human player
    with zero special-casing elsewhere (confirmed).
16a. **Only the organizer's tab runs bots** (`isOrganizer(): state.player
    === state.organizer`). Every participant's tab independently parses
    `participants`, so without this gate each human's tab would spawn its
    own copy of the same bot and race to broadcast under the same name.
    Non-organizer tabs never call `registerBots()`/the bot `setInterval`
    loop — they just see the bot as an ordinary remote player over SSE,
    same as any human.
17. **Two loops, two responsibilities — not one.** The existing
    `requestAnimationFrame` tick keeps doing per-frame stepping + throttled
    broadcast + heartbeat, generalized from `updateLocalPlayer(dt, now)`
    into a per-participant step function reused for the human player *and*
    every active bot each frame. A **separate** `setInterval` — the "game
    loop" `UPDATE_2.md` describes — calls each registered bot's `init` once
    and `move(ctx)` on a coarser, regular cadence. `move()`'s job is only to
    **decide/update the bot's target** (`targetX`/`targetY`, `walking`); the
    per-frame step function still owns actual movement + broadcast, so bots
    and the human player can never drift onto different movement/broadcast
    code paths. (Flagged as my interpretation of "call move... in regular
    intervals" — see Open assumptions.)
18. **`ctx` is the integration seam** passed into `init`/`move`: the bot's
    own name, its live sub-state (`state.players[name]`, the same map
    everyone else uses, so bots render on canvas/minimap with no extra
    code), map bounds, and a read-only view of `state.players` to decide
    from. No transport/stepping logic is duplicated inside `bots.js`.
19. **Winnie's behavior lives entirely in `move()`** — no separate state
    machine module needed for a single bot. Roam / remember visited places
    & players / pick-and-seek a favorite / follow / randomly switch
    (`UPDATE_1.md`'s "pet robot" example) all read/write a small memory
    object `init` attaches via closure or `ctx`, and just update the target
    each tick.

### Files

- `bots.js` — new. `window.Bot = { Winnie: { init(ctx), move(ctx) } }`,
  Winnie's roam/remember/favorite/follow logic inside `move`.
- `index.html` — add `<script src="./bots.js"></script>` before the
  existing `<script src="./lol.js"></script>` tag.
- `lol.js` — add: generalize `updateLocalPlayer` into a per-participant
  step function (human + bots) with heartbeat; `state_request` send-after-
  join and reply-on-receive in `handleEnvelope`; bot registration in
  `enterGame()` (parse `Bot.<name>` out of `participants`, strip prefix,
  look up in `window.Bot`, seed `state.players[name]`, call `init`); the
  `setInterval` bot-decision loop calling `move(ctx)` per registered bot.

### Build order (Phase 2)

1. Generalize `updateLocalPlayer` into a per-participant step function; add
   the idle heartbeat timer. Regression-check against Phase 1 (human-only
   movement/broadcast behavior unchanged).
2. Add the `state_request` envelope: send after `join`; reply-on-receive in
   `handleEnvelope`.
3. Add `bots.js` with `Bot.Winnie` (`init`/`move`); include it in
   `index.html` ahead of `lol.js`.
4. Wire bot registration in `enterGame()`: parse `Bot.<name>` entries,
   strip the prefix, look up in `window.Bot`, seed `state.players[name]`,
   call `init(ctx)`.
5. Wire the `setInterval` bot-decision loop calling `move(ctx)` per
   registered bot; confirm the target it sets feeds into the same
   per-participant step function from step 1, so stepping/broadcast/
   heartbeat stays single-sourced between bots and humans.
6. Manual test: single tab with `...&participants=You,Bot.Winnie` — confirm
   Winnie renders/moves labeled "Winnie" with no user input; second tab
   without the bot entry — confirm it still sees Winnie via SSE; join a
   third tab mid-session and confirm `state_request` + heartbeat catch it
   up without a DB.

### Open assumptions (Phase 2)

- `state_request`/reply is my proposed mechanism for `UPDATE_2.md`'s "late
  comers could ask for state update over the SSE channel" line, not a
  shape given verbatim in either update doc — confirm before build step 2.
- Heartbeat interval defaulted to ~400ms (under the required 500ms
  ceiling); exact value tunable.
- `move()` is assumed to only retarget the bot, with actual stepping/
  broadcast reused from the human player's per-frame function (decision
  17). `UPDATE_2.md`'s "call move... in regular intervals" could also be
  read as `move()` owning full per-tick movement itself — revisit if that's
  not the intended shape once bots.js is being built.
- Bot decision-tick interval (how often `move()` fires) isn't specified
  beyond "regular intervals" — this is separate from the <500ms heartbeat,
  which governs idle broadcast, not retargeting frequency. Defaulting to
  something coarser (~1.5–2.5s), tunable.
