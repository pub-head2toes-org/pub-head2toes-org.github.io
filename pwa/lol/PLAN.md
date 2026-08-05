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
