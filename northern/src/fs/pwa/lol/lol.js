/* LoL PWA - Phase 1 */
'use strict';

const MAP_SRC = './maps/dota_map.jpg';
const REQUIRED_PARAMS = ['organizer', 'participants', 'sse_link'];

const MOVE_SPEED = 220;              // world px / second
const MOVE_BROADCAST_MS = 200;       // throttle for in-motion position PUTs
const HEARTBEAT_MS = 400;            // max gap between broadcasts while idle (< 500ms per spec)
const BOT_TICK_MS = 2000;            // how often a registered bot's move() is called
const START_MARGIN = 300;            // world px from the bottom-left corner
const ZOOM_MIN = 500;
const ZOOM_MAX = 3000;
const ZOOM_DEFAULT = 1200;
const ZOOM_STEP = 1.25;
const AVATAR_RADIUS = 36;            // world px

/** Parse the current URL's query string into a plain object. */
function getParams() {
  const params = new URLSearchParams(window.location.search);
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

/** Send an envelope to the shared channel via HTTP PUT, on behalf of `from`
 *  (the local player's name, or a registered bot's name). */
function sendEnvelope(sseLink, type, from, extra) {
  const body = Object.assign({ type, from, ts: Date.now() }, extra);
  return fetch(sseLink, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((err) => console.warn('send failed', err));
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker registered'))
      .catch((err) => console.warn('Service Worker registration failed', err));
  }
}

/** Deterministic hue per player name so avatars/dots stay a stable color. */
function colorFor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 65%, 50%)`;
}

function calcDir(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'down' : 'up';
}

function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

const state = {
  organizer: null,
  participants: [],
  sseLink: null,
  gameName: 'LoL',
  player: null,

  mapImg: new Image(),
  mapReady: false,
  mapW: 0,
  mapH: 0,

  players: {},          // name -> { x, y, dir, walking, lastBroadcastTs, ... }
  bots: [],             // [{ name, def }] registered `Bot.<name>` participants
  zoomSpan: ZOOM_DEFAULT,

  canvas: null,
  ctx: null,
  minimapCanvas: null,
  minimapCtx: null,

  lastFrameTs: 0,
  animT: 0,

  view: { srcX: 0, srcY: 0, worldViewW: 0, worldViewH: 0, mapScale: 1 },
};

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function initLobby() {
  const params = getParams();
  const missing = REQUIRED_PARAMS.filter((k) => !params[k]);
  if (missing.length) {
    window.location.href = './error.html';
    return;
  }

  state.organizer = params.organizer;
  state.sseLink = params.sse_link;
  state.gameName = params.game_name || 'LoL';
  state.participants = params.participants.split(',').map((s) => s.trim()).filter(Boolean);

  document.getElementById('lobby_game_name').textContent = state.gameName;
  document.getElementById('lobby_organizer').textContent = state.organizer;
  document.getElementById('lobby_participants').textContent = state.participants.join(', ');

  const input = document.getElementById('player_input');
  const enterBtn = document.getElementById('enter_btn');

  const doEnter = () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    state.player = name;
    if (!state.participants.includes(name)) state.participants.push(name);
    enterGame();
  };

  enterBtn.addEventListener('click', doEnter);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doEnter(); });
  input.focus();
}

// ---------------------------------------------------------------------------
// Main (game) view
// ---------------------------------------------------------------------------

function enterGame() {
  document.body.classList.remove('view-lobby');
  document.body.classList.add('view-main');
  document.getElementById('lobby_view').classList.add('hidden');
  document.getElementById('game_view').classList.remove('hidden');
  document.getElementById('hud_player').textContent = state.player;

  setupCanvas();
  setupZoomControls();
  setupChat();
  setupSSE();
  if (isOrganizer()) setupBotLoop();
  loadMap();

  requestAnimationFrame(tick);
}

/** Only the organizer's tab runs NPC bots — otherwise every participant's
 *  tab would independently spawn and broadcast the same bot name, racing
 *  each other. Every other tab still sees bots normally, as ordinary
 *  remote players received over SSE. */
function isOrganizer() {
  return !!state.player && state.player === state.organizer;
}

function setupCanvas() {
  state.canvas = document.getElementById('game_canvas');
  state.ctx = state.canvas.getContext('2d');
  state.minimapCanvas = document.getElementById('minimap_canvas');
  state.minimapCtx = state.minimapCanvas.getContext('2d');

  const resize = () => {
    state.canvas.width = window.innerWidth;
    state.canvas.height = window.innerHeight;
  };
  window.addEventListener('resize', resize);
  resize();

  state.canvas.addEventListener('pointerdown', onCanvasPointerDown);
}

function onCanvasPointerDown(e) {
  if (!state.mapReady) return;
  const rect = state.canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (state.canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (state.canvas.height / rect.height);
  const v = state.view;
  const wx = clamp(v.srcX + sx / v.mapScale, 0, state.mapW);
  const wy = clamp(v.srcY + sy / v.mapScale, 0, state.mapH);

  const me = state.players[state.player];
  me.targetX = wx;
  me.targetY = wy;
  me.walking = true;
}

function loadMap() {
  state.mapImg.onload = () => {
    state.mapW = state.mapImg.naturalWidth;
    state.mapH = state.mapImg.naturalHeight;

    const startX = START_MARGIN;
    const startY = state.mapH - START_MARGIN;
    state.players[state.player] = {
      x: startX, y: startY, targetX: startX, targetY: startY,
      dir: 'down', walking: false, lastBroadcastTs: 0,
    };

    state.mapReady = true;
    sendEnvelope(state.sseLink, 'join', state.player, { x: startX, y: startY });
    state.players[state.player].lastBroadcastTs = performance.now();

    if (isOrganizer()) registerBots();

    // Ask peers already on the channel to re-announce their position, so we
    // (and every bot the organizer's tab just registered) catch up without
    // waiting on the idle heartbeat or the next natural move.
    sendEnvelope(state.sseLink, 'state_request', state.player, {});
  };
  state.mapImg.onerror = () => console.error('Failed to load map image', MAP_SRC);
  state.mapImg.src = MAP_SRC;
}

// ---------------------------------------------------------------------------
// NPC bots (Bot.<name> in `participants` → bots.js's `Bot[name]`)
// ---------------------------------------------------------------------------

/** Names of participants driven locally by this tab: the human player plus
 *  every registered bot. Used to step/broadcast them each frame and to
 *  recognize (and ignore) our own envelopes echoed back over SSE. */
function getLocalParticipantNames() {
  const names = [];
  if (state.player) names.push(state.player);
  for (const bot of state.bots) names.push(bot.name);
  return names;
}

function makeBotCtx(name) {
  return { name, self: state.players[name], mapW: state.mapW, mapH: state.mapH, players: state.players };
}

/** Resolve `Bot.<name>` entries in `participants` against bots.js's `Bot`
 *  namespace, spawn each as a local participant, and run its `init`. The
 *  `Bot.` prefix is stripped: a bot broadcasts and renders under its plain
 *  name, indistinguishable from a human player. Only called on the
 *  organizer's tab (see isOrganizer()) — every other participant just sees
 *  the bot as an ordinary remote player over SSE. */
function registerBots() {
  for (const entry of state.participants) {
    const match = /^Bot\.(.+)$/.exec(entry);
    if (!match) continue;
    const name = match[1];
    const def = window.Bot && window.Bot[name];
    if (!def || typeof def.init !== 'function' || typeof def.move !== 'function') {
      console.warn(`LoL: bot "${name}" not found in Bot namespace (bots.js)`);
      continue;
    }
    if (state.players[name]) continue;

    const startX = clamp(START_MARGIN + Math.random() * 200, 0, state.mapW);
    const startY = clamp(state.mapH - START_MARGIN - Math.random() * 200, 0, state.mapH);
    state.players[name] = {
      x: startX, y: startY, targetX: startX, targetY: startY,
      dir: 'down', walking: false, lastBroadcastTs: 0, isBot: true,
    };

    def.init(makeBotCtx(name));

    const p = state.players[name];
    sendEnvelope(state.sseLink, 'join', name, { x: p.x, y: p.y });
    p.lastBroadcastTs = performance.now();

    state.bots.push({ name, def });
  }
}

/** Separate, coarser loop from the per-frame render/step tick: calls each
 *  registered bot's move() on a regular interval so it can pick a new
 *  target. Actual stepping toward that target and broadcasting happens in
 *  stepParticipant(), same as the human player - move() only decides. */
function setupBotLoop() {
  setInterval(() => {
    for (const bot of state.bots) {
      try {
        bot.def.move(makeBotCtx(bot.name));
      } catch (err) {
        console.warn('LoL: bot move() failed', bot.name, err);
      }
    }
  }, BOT_TICK_MS);
}

// ---------------------------------------------------------------------------
// Movement / animation loop
// ---------------------------------------------------------------------------

function tick(now) {
  const dt = state.lastFrameTs ? (now - state.lastFrameTs) / 1000 : 0;
  state.lastFrameTs = now;
  state.animT += dt;

  if (state.mapReady) {
    for (const name of getLocalParticipantNames()) stepParticipant(name, dt, now);
    render();
    renderMinimap();
  } else {
    renderLoading();
  }

  requestAnimationFrame(tick);
}

/** Advance one locally-owned participant (the human player, or a bot) toward
 *  its target and broadcast as needed: throttled while walking, plus one
 *  final message on arrival, plus an idle heartbeat (< HEARTBEAT_MS gap)
 *  so a stationary participant still keeps peers - and late joiners -
 *  caught up without a KV store. */
function stepParticipant(name, dt, now) {
  const p = state.players[name];
  if (!p) return;

  if (p.walking) {
    const dx = p.targetX - p.x;
    const dy = p.targetY - p.y;
    const dist = Math.hypot(dx, dy);
    const step = MOVE_SPEED * dt;

    if (dist <= step || dist < 1) {
      p.x = p.targetX;
      p.y = p.targetY;
      p.walking = false;
      sendEnvelope(state.sseLink, 'move', name, { x: p.x, y: p.y, dir: p.dir, walking: false });
      p.lastBroadcastTs = now;
    } else {
      p.dir = calcDir(dx, dy);
      p.x += (dx / dist) * step;
      p.y += (dy / dist) * step;
      if (now - p.lastBroadcastTs > MOVE_BROADCAST_MS) {
        sendEnvelope(state.sseLink, 'move', name, { x: p.x, y: p.y, dir: p.dir, walking: true });
        p.lastBroadcastTs = now;
      }
    }
  } else if (now - p.lastBroadcastTs > HEARTBEAT_MS) {
    sendEnvelope(state.sseLink, 'move', name, { x: p.x, y: p.y, dir: p.dir, walking: false });
    p.lastBroadcastTs = now;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderLoading() {
  const ctx = state.ctx;
  if (!ctx) return;
  ctx.fillStyle = '#0b1116';
  ctx.fillRect(0, 0, state.canvas.width, state.canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = '16px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Loading map...', state.canvas.width / 2, state.canvas.height / 2);
}

function computeView() {
  const canvas = state.canvas;
  let worldViewW = state.zoomSpan;
  let worldViewH = worldViewW * (canvas.height / canvas.width);
  // Guard against source rects taller than the map itself (e.g. a very
  // tall/narrow window at max zoom-out) by re-deriving from the clamped
  // height so the aspect ratio - and therefore mapScale - stays uniform.
  if (worldViewH > state.mapH) {
    worldViewH = state.mapH;
    worldViewW = worldViewH * (canvas.width / canvas.height);
  }
  const me = state.players[state.player];

  const srcX = clamp(me.x - worldViewW / 2, 0, Math.max(state.mapW - worldViewW, 0));
  const srcY = clamp(me.y - worldViewH / 2, 0, Math.max(state.mapH - worldViewH, 0));
  const mapScale = canvas.width / worldViewW;

  state.view = { srcX, srcY, worldViewW, worldViewH, mapScale };
}

function worldToScreen(wx, wy) {
  const v = state.view;
  return [(wx - v.srcX) * v.mapScale, (wy - v.srcY) * v.mapScale];
}

function render() {
  const ctx = state.ctx;
  const canvas = state.canvas;
  computeView();
  const v = state.view;

  ctx.drawImage(
    state.mapImg,
    v.srcX, v.srcY, v.worldViewW, v.worldViewH,
    0, 0, canvas.width, canvas.height
  );

  for (const name of Object.keys(state.players)) {
    const p = state.players[name];
    const [sx, sy] = worldToScreen(p.x, p.y);
    if (sx < -60 || sy < -60 || sx > canvas.width + 60 || sy > canvas.height + 60) continue;
    drawAvatar(ctx, sx, sy, v.mapScale, name, p, name === state.player);
  }
}

function drawAvatar(ctx, sx, sy, mapScale, name, p, isSelf) {
  const radius = AVATAR_RADIUS * mapScale;
  let bobY = 0, scaleX = 1, scaleY = 1;
  if (p.walking) {
    const wobble = Math.sin(state.animT * 10);
    bobY = wobble * 4 * mapScale;
    scaleX = 1 + wobble * 0.06;
    scaleY = 1 - wobble * 0.06;
  }

  ctx.save();
  ctx.translate(sx, sy + bobY);
  ctx.scale(scaleX, scaleY);

  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fillStyle = colorFor(name);
  ctx.fill();
  ctx.lineWidth = isSelf ? 3 : 2;
  ctx.strokeStyle = isSelf ? '#fff' : 'rgba(0,0,0,0.45)';
  ctx.stroke();

  const tickLen = radius * 0.9;
  let tx = 0, ty = 0;
  if (p.dir === 'up') ty = -tickLen;
  else if (p.dir === 'down') ty = tickLen;
  else if (p.dir === 'left') tx = -tickLen;
  else tx = tickLen;
  ctx.beginPath();
  ctx.arc(tx, ty, radius * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();
  ctx.restore();

  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(name, sx, sy - radius - 8);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, sx, sy - radius - 8);
}

function renderMinimap() {
  const ctx = state.minimapCtx;
  const canvas = state.minimapCanvas;
  const sx = canvas.width / state.mapW;
  const sy = canvas.height / state.mapH;

  ctx.drawImage(state.mapImg, 0, 0, state.mapW, state.mapH, 0, 0, canvas.width, canvas.height);

  const v = state.view;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(v.srcX * sx, v.srcY * sy, v.worldViewW * sx, v.worldViewH * sy);

  for (const name of Object.keys(state.players)) {
    const p = state.players[name];
    const isSelf = name === state.player;
    ctx.beginPath();
    ctx.arc(p.x * sx, p.y * sy, isSelf ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = colorFor(name);
    ctx.fill();
    if (isSelf) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

function setupZoomControls() {
  document.getElementById('zoom_in_btn').addEventListener('click', () => {
    state.zoomSpan = clamp(state.zoomSpan / ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
  });
  document.getElementById('zoom_out_btn').addEventListener('click', () => {
    state.zoomSpan = clamp(state.zoomSpan * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
  });
}

// ---------------------------------------------------------------------------
// Chat overlay
// ---------------------------------------------------------------------------

function setupChat() {
  const boothBtn = document.getElementById('booth_btn');
  const overlay = document.getElementById('chat_overlay');
  const input = document.getElementById('chat_input');
  const sendBtn = document.getElementById('chat_send_btn');

  boothBtn.addEventListener('click', () => overlay.classList.toggle('open'));

  const doSend = () => {
    const m = input.value.trim();
    if (!m) return;
    sendEnvelope(state.sseLink, 'chat', state.player, { m });
    input.value = '';
  };
  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
}

function appendChat(from, m) {
  const board = document.getElementById('chat_board');
  board.value += `${from}: ${m}\n`;
  board.scrollTop = board.scrollHeight;
}

// ---------------------------------------------------------------------------
// Multiplayer sync (SSE listen, PUT send)
// ---------------------------------------------------------------------------

function setupSSE() {
  const es = new EventSource(state.sseLink);
  es.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch (err) { return; }
    handleEnvelope(data);
  };
  es.onerror = (err) => console.warn('SSE error', err);
}

function handleEnvelope(data) {
  if (!data || !data.type || !data.from) return;

  if (data.type === 'chat') {
    appendChat(data.from, data.m);
    return;
  }

  if (data.type === 'state_request') {
    handleStateRequest(data);
    return;
  }

  // Locally-owned participants' positions are client-predicted; ignore
  // echoes of them to avoid overwriting a more up-to-date locally-simulated
  // position.
  if (getLocalParticipantNames().includes(data.from)) return;

  if (data.type === 'join') {
    state.players[data.from] = {
      x: data.x, y: data.y, targetX: data.x, targetY: data.y, dir: 'down', walking: false,
    };
  } else if (data.type === 'move') {
    const existing = state.players[data.from] || {};
    state.players[data.from] = Object.assign(existing, {
      x: data.x, y: data.y, dir: data.dir, walking: data.walking,
    });
  }
}

/** A peer (late joiner) asked the channel for a state catch-up: re-announce
 *  every locally-owned participant's current position immediately,
 *  bypassing the normal broadcast throttle. */
function handleStateRequest(data) {
  const localNames = getLocalParticipantNames();
  if (localNames.includes(data.from)) return;

  const now = performance.now();
  for (const name of localNames) {
    const p = state.players[name];
    if (!p) continue;
    sendEnvelope(state.sseLink, 'move', name, { x: p.x, y: p.y, dir: p.dir, walking: p.walking });
    p.lastBroadcastTs = now;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  registerSW();
  initLobby();
});
