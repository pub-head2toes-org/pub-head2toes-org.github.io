/* Rummy PWA
 *   Phase 1: skeleton, connectivity, deal, state sync
 *   Phase 2: turn play / card arrangement
 *   Phase 3: rules, validation, scoring
 *   Phase 4: dedupe/ordering, reconnect, hand privacy, offline/a11y polish
 *
 * Sync model: one shared channel (send = PUT to sse_link, listen = SSE on the
 * same URL). The organizer holds authoritative state (`state0`) and broadcasts a
 * redacted *view* (hand counts only) plus per-player private `hand` messages.
 * Every instance -- organizer included -- renders from the view (`game`), so
 * there is a single render path.
 */
'use strict';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */
const SUITS = ['spade', 'heart', 'diamond', 'club'];
const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const TURN_MS = 2 * 60 * 1000; // 2:00 per turn
const REQUIRED_PARAMS = ['participants', 'organizer', 'player', 'sse_link'];
const RANK_VALUE = {
  '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
  '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13,
};
const DECK_ELEM = { table: 'table_deck', selection: 'selection_deck', hand: 'hand_deck' };
const SEEN_MAX = 500;
// Streak separator: 10 blank characters (visible/selectable, unlike an empty line).
const SEP = '          ';
function isSep(l) { return typeof l === 'string' && l.trim() === ''; }

/* ------------------------------------------------------------------ *
 * Runtime context + module state
 * ------------------------------------------------------------------ */
const ctx = {
  participants: [], organizer: '', player: '', sseLink: '',
  isOrganizer: false, source: null, opened: false,
};

let state0 = null;      // authoritative full state (organizer only)
let game = null;        // redacted view everyone renders from
let myHand = [];        // this player's own cards (private)
let work = null;        // local uncommitted arrangement for my turn
let lastVersion = null; // last applied state version (ordering guard)
let bellRungFor = null;  // turnEndsAt value the expiry bell already rang for

const seen = new Set(); // de-duplication of message ids
const seenQ = [];

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function getParams() {
  const params = new URLSearchParams(window.location.search);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker registered'))
      .catch((err) => console.warn('Service Worker registration failed', err));
  }
}

function $(id) { return document.getElementById(id); }

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function markSeen(id) {
  if (seen.has(id)) return false;
  seen.add(id);
  seenQ.push(id);
  if (seenQ.length > SEEN_MAX) seen.delete(seenQ.shift());
  return true;
}

/** Send an envelope over the shared channel (PUT on the SSE link URL). */
function put(obj) {
  const env = Object.assign({ id: uid(), from: ctx.player, ts: Date.now() }, obj);
  fetch(ctx.sseLink, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env),
  }).catch((err) => console.warn('PUT failed', obj.type, err));
  return env;
}

function audit(name, args) {
  return put({ type: 'action', name, args: args || null });
}

/* ------------------------------------------------------------------ *
 * Common commands (organizer; mutate state0, then broadcast)
 * ------------------------------------------------------------------ */
function buildDeck() {
  const deck = [];
  for (let set = 0; set < 2; set++) {
    for (const suit of SUITS) for (const rank of RANKS) deck.push(`${rank} ${suit}`);
    deck.push('Joker');
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function initGameState() {
  state0 = {
    participants: ctx.participants.slice(),
    deck: buildDeck(),
    table: [],
    hands: {},
    currentPlayer: null,
    turnEndsAt: null,
    pauseRemainingMs: null,
    paused: false,
    phase: 'setup',
    winner: null,
    scores: null,
    version: 0,
  };
  ctx.participants.forEach((p) => { state0.hands[p] = []; });
  set_participants_random_order();
}

function set_participants_random_order() {
  state0.participants = shuffle(state0.participants.slice());
  audit('set_participants_random_order', { order: state0.participants });
}

function drawFromDeck(n) {
  const drawn = [];
  for (let i = 0; i < n && state0.deck.length > 0; i++) {
    const idx = Math.floor(Math.random() * state0.deck.length);
    drawn.push(state0.deck.splice(idx, 1)[0]);
  }
  return drawn;
}

function deal_14_cards() {
  state0.participants.forEach((p) => { state0.hands[p] = drawFromDeck(14); });
  audit('deal_14_cards', null);
  broadcastState();
}

function deal_1_card(player) {
  const p = player || state0.currentPlayer;
  if (!p) return;
  state0.hands[p] = (state0.hands[p] || []).concat(drawFromDeck(1));
  audit('deal_1_card', { player: p });
  broadcastState();
}

function get_current_game_state() {
  audit('get_current_game_state', null);
  return state0;
}

function start_next_turn() {
  const order = state0.participants;
  if (order.length === 0) return;
  let idx = order.indexOf(state0.currentPlayer);
  idx = (idx + 1) % order.length; // -1 -> 0 for the first turn
  state0.currentPlayer = order[idx];
  state0.phase = 'playing';
  state0.paused = false;
  state0.pauseRemainingMs = null;
  state0.turnEndsAt = Date.now() + TURN_MS;
  audit('start_next_turn', { currentPlayer: state0.currentPlayer });
  broadcastState();
}

function pause_game() {
  if (state0.paused) {
    state0.turnEndsAt = Date.now() + (state0.pauseRemainingMs || 0);
    state0.paused = false;
    state0.pauseRemainingMs = null;
  } else {
    state0.pauseRemainingMs = state0.turnEndsAt ? Math.max(0, state0.turnEndsAt - Date.now()) : TURN_MS;
    state0.paused = true;
  }
  audit('pause_game', { paused: state0.paused });
  broadcastState();
}

function end_game() {
  state0.phase = 'ended';
  state0.currentPlayer = null;
  state0.turnEndsAt = null;
  audit('end_game', null);
  broadcastState();
}

/**
 * Apply a player's committed arrangement after validating it. Only the current
 * player may commit; the resulting table must be all valid melds. Emptying the
 * hand wins the game.
 */
function commitTurn(msg) {
  if (msg.player !== state0.currentPlayer) return; // turn enforcement
  const groups = msg.table || [];
  const check = validateTable(groups);
  if (!check.ok) {
    audit('commit_rejected', { player: msg.player });
    put({ type: 'reject', player: msg.player, reason: check.reason });
    return; // turn not advanced; player keeps arranging
  }

  state0.table = groups;
  // The hand keeps any '' separators the player added (Update: don't remove them).
  state0.hands[msg.player] = msg.hand || state0.hands[msg.player] || [];
  audit('commit_turn', { player: msg.player });

  if (handCards(state0.hands[msg.player]).length === 0) {
    const scores = {};
    state0.participants.forEach((p) => { scores[p] = handPoints(state0.hands[p]); });
    state0.winner = msg.player;
    state0.scores = scores;
    end_game();
    const summary = state0.participants.map((p) => `${p}=${scores[p]}`).join(', ');
    put({ type: 'chat', m: `🏆 ${msg.player} wins! Deadwood: ${summary}` });
  } else {
    // Update: the player who just finished draws one card from the deck.
    state0.hands[msg.player] = state0.hands[msg.player].concat(drawFromDeck(1));
    audit('deal_1_card', { player: msg.player });
    start_next_turn(); // broadcasts the new state
  }
}

/* ------------------------------------------------------------------ *
 * Rules & validation
 * ------------------------------------------------------------------ */
function isJoker(card) { return card === 'Joker'; }

function parseCard(card) {
  const i = card.indexOf(' ');
  return { rank: card.slice(0, i), suit: card.slice(i + 1) };
}

/** Set/line: 3-4 cards of the same rank, distinct suits (jokers wild). */
function isValidSet(cards) {
  if (cards.length < 3 || cards.length > 4) return false;
  const reals = cards.filter((c) => !isJoker(c)).map(parseCard);
  if (reals.length === 0) return false;
  const rank = reals[0].rank;
  const suits = new Set();
  for (const c of reals) {
    if (c.rank !== rank) return false;
    if (suits.has(c.suit)) return false;
    suits.add(c.suit);
  }
  return true;
}

/** Run/streak: 3+ consecutive cards of one suit (jokers wild). */
function isValidRun(cards) {
  if (cards.length < 3) return false;
  const reals = cards.filter((c) => !isJoker(c)).map(parseCard);
  if (reals.length === 0) return false;
  const suit = reals[0].suit;
  const values = [];
  for (const c of reals) {
    if (c.suit !== suit) return false;
    const v = RANK_VALUE[c.rank];
    if (v == null) return false;
    values.push(v);
  }
  if (new Set(values).size !== values.length) return false;
  const span = Math.max(...values) - Math.min(...values);
  return span <= cards.length - 1;
}

function isValidMeld(cards) { return isValidSet(cards) || isValidRun(cards); }

function validateTable(groups) {
  for (let i = 0; i < groups.length; i++) {
    if (!isValidMeld(groups[i])) {
      return { ok: false, reason: `group ${i + 1} "${groups[i].join(', ')}" is not a valid run or set` };
    }
  }
  return { ok: true };
}

function cardPoints(card) {
  if (isJoker(card)) return 15;
  const v = RANK_VALUE[parseCard(card).rank];
  return v >= 11 ? 10 : v;
}

function handPoints(cards) {
  return (cards || []).filter((c) => !isSep(c)).reduce((a, c) => a + cardPoints(c), 0);
}

/** A hand may hold streak separators the player added; count only cards. */
function handCards(hand) { return (hand || []).filter((c) => !isSep(c)); }

function countHands(hands) {
  const out = {};
  for (const p in hands) out[p] = handCards(hands[p]).length;
  return out;
}

/** Produce the public, redacted view of the authoritative state. */
function redact(s) {
  return {
    participants: s.participants,
    table: s.table,
    currentPlayer: s.currentPlayer,
    turnEndsAt: s.turnEndsAt,
    paused: s.paused,
    pauseRemainingMs: s.pauseRemainingMs,
    phase: s.phase,
    winner: s.winner,
    scores: s.scores,
    handCounts: countHands(s.hands),
    version: s.version,
  };
}

/* ------------------------------------------------------------------ *
 * Broadcast + apply
 * ------------------------------------------------------------------ */
/** Organizer: broadcast a redacted view + per-player private hands. */
function broadcastState() {
  state0.version += 1;
  const view = redact(state0);

  const sEnv = put({ type: 'state', state: view, version: state0.version });
  markSeen(sEnv.id);
  applyState(view); // apply locally so the organizer renders without self-echo

  state0.participants.forEach((p) => {
    const hEnv = put({ type: 'hand', player: p, cards: state0.hands[p] || [] });
    if (p === ctx.player) { markSeen(hEnv.id); applyHand(p, state0.hands[p] || []); }
  });
}

/** Adopt a redacted view (ordering-guarded). */
function applyState(view) {
  if (view.version != null) {
    if (lastVersion != null && view.version <= lastVersion) return; // stale/out of order
    lastVersion = view.version;
  }
  game = view;
  syncWork();
  render();
}

/** Adopt my private hand; refresh a clean working copy if mid-turn. */
function applyHand(player, cards) {
  if (player !== ctx.player) return;
  myHand = (cards || []).slice();
  if (isMyTurn() && work && !work.dirty) startWork();
  render();
}

/* ------------------------------------------------------------------ *
 * Incoming messages
 * ------------------------------------------------------------------ */
function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }
  if (!msg || !msg.type) return;
  if (msg.id && !markSeen(msg.id)) return; // duplicate delivery

  switch (msg.type) {
    case 'chat':
      appendChat(`${msg.from}: ${msg.m}`);
      break;
    case 'state':
      applyState(msg.state);
      break;
    case 'hand':
      applyHand(msg.player, msg.cards);
      break;
    case 'action':
      if (ctx.isOrganizer) appendAudit(`${msg.from} -> ${msg.name}`);
      break;
    case 'reject':
      if (msg.player === ctx.player) appendChat(`⚠ ${msg.reason}`);
      break;
    case 'request':
      if (ctx.isOrganizer && state0) handleRequest(msg);
      break;
  }
}

function handleRequest(msg) {
  switch (msg.name) {
    case 'get_state': broadcastState(); break;
    case 'start_next_turn': start_next_turn(); break;
    case 'commit_turn': commitTurn(msg); break;
    default: break;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */
function appendChat(line) {
  const board = $('chat_board');
  board.value += (board.value ? '\n' : '') + line;
  board.scrollTop = board.scrollHeight;
}

function appendAudit(line) {
  const box = $('organizer_log');
  if (!box) return;
  box.value += (box.value ? '\n' : '') + line;
  box.scrollTop = box.scrollHeight;
}

function handCount(p) {
  return (game && game.handCounts && game.handCounts[p] != null) ? game.handCounts[p] : 0;
}

function render() {
  if (!game) return;

  $('participants_list').value = (game.participants || []).map((p) => {
    const tags = [];
    if (p === ctx.organizer) tags.push('organizer');
    if (p === game.currentPlayer) tags.push('turn');
    const label = tags.length ? `${p} (${tags.join(', ')})` : p;
    return `${label} — ${handCount(p)} cards`;
  }).join('\n');

  $('current_turn').textContent = game.currentPlayer || '-';
  $('phase').textContent = game.phase
    + (game.paused ? ' (paused)' : '')
    + (game.winner ? ` — winner: ${game.winner}` : '');

  renderDecks();
  updateClock();
}

function renderDecks() {
  if (isMyTurn() && work) {
    $('table_deck').value = work.table.join('\n');
    $('selection_deck').value = work.selection.join('\n');
    $('hand_deck').value = work.hand.join('\n');
    highlightActive();
  } else {
    $('table_deck').value = groupsToLines(game.table || []).join('\n');
    $('selection_deck').value = '';
    $('hand_deck').value = myHand.join('\n');
  }
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateClock() {
  const el = $('clock');
  if (!game || game.turnEndsAt == null) { el.textContent = '2:00'; return; }
  const remaining = game.paused
    ? (game.pauseRemainingMs || 0)
    : Math.max(0, game.turnEndsAt - Date.now());
  el.textContent = formatClock(remaining);

  // Ring the bell once when a running turn clock hits zero.
  if (!game.paused && remaining <= 0 && game.phase === 'playing'
      && bellRungFor !== game.turnEndsAt) {
    bellRungFor = game.turnEndsAt;
    playBell();
  }
}

/** Synthesize a short two-tone bell (no external asset; CSP-safe). */
function playBell() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = playBell._ac || (playBell._ac = new Ctx());
    if (ac.state === 'suspended') ac.resume();
    const now = ac.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ac.destination);
      const t = now + i * 0.15;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
      osc.start(t);
      osc.stop(t + 0.85);
    });
  } catch (e) { /* audio unavailable */ }
}

/* ------------------------------------------------------------------ *
 * Turn play mechanics: local card arrangement
 *
 * A "line" is either a card string ("7 spade") or '' (a streak separator).
 * Each deck is a flat array of lines with an insertion cursor in [0, len].
 * ------------------------------------------------------------------ */
function isMyTurn() {
  return !!(game && game.phase === 'playing' && !game.paused && game.currentPlayer === ctx.player);
}

function groupsToLines(groups) {
  const lines = [];
  (groups || []).forEach((g, i) => { if (i > 0) lines.push(SEP); g.forEach((c) => lines.push(c)); });
  return lines;
}

function linesToGroups(lines) {
  const groups = [];
  let cur = [];
  for (const l of lines) {
    if (isSep(l)) { if (cur.length) { groups.push(cur); cur = []; } }
    else cur.push(l);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function trimSeps(lines) {
  let a = 0, b = lines.length;
  while (a < b && isSep(lines[a])) a++;
  while (b > a && isSep(lines[b - 1])) b--;
  return lines.slice(a, b);
}

function startWork() {
  work = {
    table: groupsToLines(game.table || []),
    hand: myHand.slice(),
    selection: [],
    active: 'hand',
    cursor: { table: 0, selection: 0, hand: 0 },
    dirty: false,
  };
}

function syncWork() {
  if (isMyTurn()) { if (!work) startWork(); }
  else { work = null; }
}

function clampCursor(deck) {
  work.cursor[deck] = Math.max(0, Math.min(work.cursor[deck], work[deck].length));
}

function highlightActive() {
  if (!work) return;
  const deck = work.active;
  const ta = $(DECK_ELEM[deck]);
  const lines = work[deck];
  clampCursor(deck);
  let start = 0;
  for (let k = 0; k < work.cursor[deck] && k < lines.length; k++) start += lines[k].length + 1;
  const end = start + ((lines[work.cursor[deck]] || '').length);
  ta.focus();
  ta.setSelectionRange(start, end);
}

function focusDeck(deck) {
  if (!isMyTurn() || !work) return;
  const ta = $(DECK_ELEM[deck]);
  const pos = ta.selectionStart || 0;
  work.active = deck;
  work.cursor[deck] = ta.value.slice(0, pos).split('\n').length - 1;
  clampCursor(deck);
  render();
}

function moveCursor(delta) {
  if (!isMyTurn() || !work) return;
  work.cursor[work.active] += delta;
  clampCursor(work.active);
  render();
}

function pick() {
  if (!isMyTurn() || !work) return;
  const deck = work.active;
  const i = work.cursor[deck];
  const card = work[deck][i];
  if (card === undefined || isSep(card)) return;
  work[deck].splice(i, 1);
  work.selection.push(card);
  work.dirty = true;
  clampCursor(deck);
  audit('pick', { deck, card });
  render();
}

function streak() {
  if (!isMyTurn() || !work) return;
  const deck = work.active;
  const lines = work[deck];
  const i = work.cursor[deck];
  if (lines[i] === undefined || isSep(lines[i])) return;
  let n = 0;
  while (i + n < lines.length && !isSep(lines[i + n])) n++;
  const run = lines.splice(i, n);
  if (work.selection.length && !isSep(work.selection[work.selection.length - 1])) work.selection.push(SEP);
  run.forEach((c) => work.selection.push(c));
  work.dirty = true;
  clampCursor(deck);
  audit('streak', { deck, count: run.length });
  render();
}

/** Toggle a streak separator at the cursor: remove it if present, else add one. */
function line() {
  if (!isMyTurn() || !work) return;
  const deck = work.active;
  const arr = work[deck];
  const i = work.cursor[deck];
  if (isSep(arr[i])) {
    arr.splice(i, 1);            // remove the separator already here
    clampCursor(deck);
  } else {
    arr.splice(i, 0, SEP);       // add a separator, advancing past it
    work.cursor[deck] = i + 1;
  }
  work.dirty = true;
  audit('line', { deck });
  render();
}

function lay() {
  if (!isMyTurn() || !work) return;
  if (work.selection.length === 0) return;
  const deck = work.active;
  const i = work.cursor[deck];
  const cards = trimSeps(work.selection);
  work[deck].splice(i, 0, ...cards);
  work.selection = [];
  work.cursor[deck] = i + cards.length;
  work.dirty = true;
  audit('lay', { deck, count: cards.length });
  render();
}

function abortPlay() {
  if (!isMyTurn() || !work) { render(); return; }
  startWork();
  audit('abort_play', null);
  render();
}

function endTurn() {
  if (!isMyTurn() || !work) return;
  if (work.selection.length) {
    work.hand.push(...work.selection.filter((l) => !isSep(l)));
    work.selection = [];
  }
  put({
    type: 'request',
    name: 'commit_turn',
    player: ctx.player,
    table: linesToGroups(work.table),
    hand: work.hand, // keep the player's '' separators (dividers) intact
  });
}

/* ------------------------------------------------------------------ *
 * Wiring / init
 * ------------------------------------------------------------------ */
function wireControls() {
  $('send_btn').addEventListener('click', sendChat);
  $('chat_input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  $('pause_btn').addEventListener('click', () => { if (ctx.isOrganizer) pause_game(); });

  $('end_turn_btn').addEventListener('click', endTurn);
  $('abort_btn').addEventListener('click', abortPlay);

  $('up_btn').addEventListener('click', () => moveCursor(-1));
  $('down_btn').addEventListener('click', () => moveCursor(1));
  $('pick_btn').addEventListener('click', pick);
  $('streak_btn').addEventListener('click', streak);
  $('line_btn').addEventListener('click', line);
  $('lay_btn').addEventListener('click', lay);

  Object.keys(DECK_ELEM).forEach((deck) => {
    $(DECK_ELEM[deck]).addEventListener('click', () => focusDeck(deck));
  });

  if (ctx.isOrganizer) {
    $('deal_btn').addEventListener('click', () => deal_14_cards());
    $('start_btn').addEventListener('click', () => start_next_turn());
    $('endgame_btn').addEventListener('click', () => end_game());
  }
}

function sendChat() {
  const input = $('chat_input');
  const m = input.value.trim();
  if (!m) return;
  put({ type: 'chat', m });
  input.value = '';
  input.focus();
}

function connect() {
  ctx.source = new EventSource(ctx.sseLink);
  ctx.source.onmessage = (e) => handleMessage(e.data);
  ctx.source.onopen = () => {
    if (ctx.opened) {
      // Reconnected: resync. Organizer rebroadcasts; players re-request.
      if (ctx.isOrganizer && state0) broadcastState();
      else put({ type: 'request', name: 'get_state' });
    }
    ctx.opened = true;
  };
  ctx.source.onerror = (err) => console.warn('SSE error', err);
}

function init() {
  const p = getParams();
  if (REQUIRED_PARAMS.some((k) => !p[k])) { location.replace('./error.html'); return; }

  ctx.participants = p.participants.split(',').map((s) => s.trim()).filter(Boolean);
  ctx.organizer = p.organizer;
  ctx.player = p.player;
  ctx.sseLink = p.sse_link;
  ctx.isOrganizer = ctx.player === ctx.organizer;

  $('player_name').textContent = ctx.player;
  $('role').textContent = ctx.isOrganizer ? 'Organizer' : 'Player';
  document.body.classList.toggle('is-organizer', ctx.isOrganizer);

  registerSW();
  wireControls();
  connect();

  if (ctx.isOrganizer) {
    initGameState();
    broadcastState();
  } else {
    put({ type: 'request', name: 'get_state' });
  }

  setInterval(updateClock, 1000);
}

document.addEventListener('DOMContentLoaded', init);
