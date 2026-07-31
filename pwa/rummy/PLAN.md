# Plan: (PWA) Rummy

A single-page, multiplayer Rummy card game. Pure HTML/CSS/JS PWA under
`/pwa/rummy/`. Each participant runs their own instance; instances synchronize
over one shared channel: **send** = HTTP `PUT` to `sse_link`, **listen** =
`EventSource` (SSE) on the same `sse_link`. Reuses the `joint` PWA conventions
(PUT/SSE helpers, PWA shell, blue theme).

## Entry

`index.html?participants=<CSV>&organizer=<str>&player=<str>&sse_link=<url>`

- `participants` — comma-separated player names.
- `organizer` — name of the organizer.
- `player` — this instance's own identity.
- `sse_link` — fully-formed pub/sub URL (e.g. `https://pub.head2toes.org/sub/joint/<channel>`).
- If `player === organizer`, this instance shows the **organizer commands** and
  owns authoritative state init.
- Missing any required param → redirect to `error.html`.

> **TODO (follow-up, `joint` framework):** the `joint` "Start" hand-off
> currently passes `participants`, `organizer`, `sse_link` but **not** `player`.
> Each launched Rummy instance must know which participant it is, so `joint`'s
> `lobby.html` Start action needs to also pass `player=<this participant>` in
> the `game_url` query. Tracked as a separate change to the `joint` app; Rummy
> Phase 1 is built to read `player` from its entry URL and will work once
> `joint` is updated (and is testable now via a hand-crafted entry URL).

## Architecture decision: organizer-authoritative broadcast

The organizer instance holds the **canonical game state** and broadcasts full
state snapshots. Players are (mostly) renderers that request changes; every
instance refreshes UI on each received message. This avoids the determinism/
ordering problems of pure event-sourcing (e.g. shared shuffle) and matches the
prompt: organizer does state init + random order + card set, players "listen
for the initial state updates". Chosen over event-sourcing for correctness with
least code.

### Message envelope (JSON, one per PUT)

```
{ "type": "state|chat|action|request", "from": "<player>", "ts": <ms>, ... }
```

- `chat`   — `{ m }` → appended to chat board as `from: m`.
- `state`  — full snapshot from organizer (below); every instance replaces local state.
- `action` — audit of a command/turn action `{ name, args }` (the audit log).
- `request`— player asks organizer to mutate (e.g. draw/end turn) → organizer
  applies, then broadcasts a new `state`.

Every command function emits an `action` audit PUT on execution (per prompt
line 32/42). State-changing commands additionally trigger a `state` broadcast
from the organizer.

### Game state object (`get_current_game_state`)

```
{ participants:[ordered], deck:[card...], table:[[streak...]...],
  hands:{ player:[card...] }, currentPlayer, turnEndsAt, paused, phase }
```

Cards are header strings: `"7 spade"`, `"K heart"`, `"1 diamond"`, `"Joker"`.
Deck = two 52-card sets + 2 jokers = **106**.

## UI (single page, sections per prompt)

1. **Header** — "Rummy", player name, role (Organizer/Player), Pause button.
2. **Info** — Participants list (textarea), current player's turn, game clock
   (`2:00` countdown), organizer commands textarea/buttons (organizer only).
3. **Chat** — message board (textarea), input, Send.
4. **Decks** — Table deck / Selection deck / Hand deck (textareas, one card per
   line, empty line separates streaks).
5. **Deck buttons** — Up, Down, Pick, Streak, Line, Lay, Esc.
6. **Turn** — Abort play, End turn.

## Files

`index.html`, `rummy.js` (state, protocol, commands, UI), `styles.css`,
`error.html`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png`.
Shared helpers (`buildSseLink`-style PUT/SSE, `registerSW`) adapted from `joint`.

---

## Phases

### Phase 1 — First playable version (skeleton + connectivity + deal)
Goal: everyone connects, organizer deals, all instances see participants, their
hand, current player, a running clock, and can chat.

- Scaffold files + PWA shell (manifest, sw, icons, styles).
- Parse & validate entry params; role detection; error redirect.
- Render all six UI sections statically; organizer-only controls hidden for players.
- SSE connect (`EventSource`) + PUT sender + message envelope + audit plumbing.
- Chat send/receive.
- Commands: `set_participants_random_order`, build 106-card deck,
  `deal_14_cards`, `get_current_game_state`, `start_next_turn`, `pause_game`,
  `end_game`. Organizer buttons: Deal cards, Start first turn, Pause/Un-pause,
  End game.
- Organizer broadcasts full `state`; all instances render participants list,
  own Hand deck, Table deck, current player, 2:00 countdown clock.
- Late-join resync: on load a player sends `request:get_state`; organizer
  rebroadcasts current `state`.

Deferred in P1: real card-arrangement mechanics (decks render read-only from
state), meld validation, scoring.

### Phase 2 — Turn play mechanics (card arrangement)
- Deck focus (which of Table/Selection/Hand is active) + card cursor.
- Up/Down (move cursor), Pick (card → Selection), Streak (run to empty line →
  Selection), Line (insert streak separator), Lay (Selection → position in
  selected deck), Esc (cancel selection).
- Draw (from table) / discard, End turn → `start_next_turn` advances
  `currentPlayer`, `deal_1_card`. Abort play reverts to last committed state.
- Audit every arrangement action; player turn actions go via `request` →
  organizer applies → `state` broadcast.

### Phase 3 — Rules & validation
- Meld validation: runs (Streak), sets (Line), lay-off (Lay) onto table melds.
- Turn enforcement (only current player acts; pause gates actions).
- Win detection, scoring, end-of-game summary.

### Phase 4 — Polish & robustness
- Message dedupe/ordering (by `ts`/id), reconnect handling.
- Private hands (broadcast only own hand / redact others) — P1 shows all hands
  for simplicity; revisit here.
- Offline shell caching, styling/accessibility pass.

## Open assumptions (proceeding with these defaults)
- **Full-state broadcast in P1** (hands visible to all); privacy deferred to P4.
- **`Line`** = insert a streak-separator (empty line) to start a new meld group;
  will confirm against play-testing in P2.
- Clock is a **2:00 per-turn** countdown driven by `turnEndsAt` in state.
