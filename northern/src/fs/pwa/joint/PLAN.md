# Plan: "Joint" PWA (multiplayer onboarding / reception)

Pure HTML/CSS/JS Progressive Web App under `/pwa/joint/`, matching sibling PWA
conventions (`fabric`, `muse`): per-page `.html` files, one shared
`manifest.json` + `sw.js`, shared `styles.css`, blue theme (`#005E7A`).

## Files

| File | Purpose |
|------|---------|
| `index.html` | Reception screen |
| `join.html` | Join form |
| `organize.html` | Organize form (auto-generates comm channel) |
| `lobby.html` | Live lobby with SSE chat |
| `error.html` | Missing-param error page |
| `joint.js` | Shared helpers |
| `styles.css` | Shared styling |
| `manifest.json` | PWA manifest |
| `sw.js` | Service worker (cache-first, mirrors `fabric/sw.js`) |
| `icon-192.png`, `icon-512.png` | App icons |

## Shared `joint.js` helpers

- `generateCommChannel()` -> `YYYY-MM-DD-N` (today + random int 1-64), e.g. `2026-07-28-17`.
- `getParams()` -> parse `URLSearchParams`.
- `buildLobbyLink(data)` -> "Enter Lobby" link: `/pwa/joint/lobby.html` with all
  5 lobby params. `window.location.origin` as host (covers `git.head2toes.org`
  and `localhost`), all values `encodeURIComponent`'d.
- `buildInviteLink(data)` -> shareable invite link: `/pwa/joint/join.html` with
  `[organizer, game_name, game_url, comm_channel]` (no participant - invitee
  fills in their own name on the join page).
- `buildSseLink(comm_channel)` -> `https://pub.head2toes.org/sub/joint/<COMM_CHANNEL>` (constant `SUB_HOST`).
- `sendMessage(sseLink, participant, m)` -> `fetch(sseLink, {method:'PUT', body: JSON.stringify({participant, m})})`.
- `registerSW()`.

## Pages

**index.html** - Title `Joint`, subtitle `Reception`; span with `Join` ->
`join.html` and `Organize` -> `organize.html`.

**join.html** - Title `Joint`; sub-header `Joining the party:`; inputs
`Organizer`, `Comm Channel`, `Participant`, `game_name`, `game_url`; button
`Enter Lobby` -> `lobby.html?` with all 5 params. On load, prefill
`[organizer, game_name, game_url, comm_channel]` from any incoming params
(so invite links land pre-filled).

**organize.html** - On load `generateCommChannel()` fills a hidden `comm_channel`
input. Title `Joint`; inputs `organizer`, `game_name`, `game_url`, hidden
`comm_channel`; button `Enter Lobby`. Organizer has no participant field, so
**participant = organizer** (gives the organizer the `Start` button).

**lobby.html**
1. On load: read params; if any of `organizer, participant, game_name,
   game_url, comm_channel` missing -> redirect to `error.html`.
2. UI: Title `Joint`; sub-header `Lobby`; read-only `<textarea id="msg_board">`;
   span with text input `msg` + `Send` button; div with two rows: read-only
   invite-link input, and `Start` button.
3. Init: `const participants = []`, push request `participant`; compute the
   shareable invite link to `join.html` (fill read-only input) and SSE link.
4. `EventSource(sseLink)`; on message: JSON-parse `{participant,m}`, add
   participant if new, append `PARTICIPANT: MSG` to `msg_board`.
5. After listener set up, PUT entry confirmation `{participant, m:"Entered the Lobby"}`.
6. `Send` -> PUT `{participant, m: msg}`, clear input.
7. `Start` shown only if `organizer === participant`; on click opens `game_url`
   in a new tab with `participants` (comma-separated), `organizer`, `sse_link`.

**error.html** - Title `Joint`, message about missing lobby parameters, link
back to `index.html`.

## Notes / assumptions

- Invite-link host uses `window.location.origin` (works on both
  `git.head2toes.org` and `http://localhost`).
- `SUB_HOST` (SSE + PUT) is a constant `https://pub.head2toes.org` per the prompt.
- PUT and `EventSource` both target the SSE link.
- Icons: minimal generated placeholders.
