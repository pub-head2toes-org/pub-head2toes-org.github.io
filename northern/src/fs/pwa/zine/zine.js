/* Zine PWA - LoL's map walk, as a gallery: the issue's floor plan and the
   works laid out on it, open to everybody signed in to Northern. */
'use strict';

const DEFAULT_ISSUE = 'current';
const DEFAULT_SSE_LINK = '/sub/joint/zine';
const REG = '/fs/get/reg/Reg.html';
const UNKNOWN = 'UNKNOWN';
const LOT_LIMIT = 100;               // participants in one issue at a time
const LOT_FULL = 'Lot full';
const STALE_MS = 3000;               // not heard from for this long: gone (everybody heartbeats every HEARTBEAT_MS)
const ROSTER_WAIT_MS = 1000;         // listening this long hears everybody already in
const ROSTER_TICK_MS = 1000;         // how often the roster is pruned and the lot checked

const MOVE_SPEED = 220;              // world px / second
const MOVE_BROADCAST_MS = 200;       // throttle for in-motion position PUTs
const HEARTBEAT_MS = 400;            // max gap between broadcasts while idle (< 500ms per spec)
const START_MARGIN = 300;            // world px from the bottom-left corner: the door
const ZOOM_MIN = 500;
const ZOOM_MAX = 3000;
const ZOOM_DEFAULT = 1200;
const ZOOM_STEP = 1.25;
const AVATAR_RADIUS = 36;            // world px
const FOOTPRINT_DEPTH = 1 / 3;       // an obstacle's default footprint: the bottom third of its image
const PATH_PAD = 2;                  // world px a route keeps clear of an obstacle's walk-around edge

/** Parse the current URL's query string into a plain object. */
function getParams() {
  const params = new URLSearchParams(window.location.search);
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

/** The issue to show and the channel to meet on, from the URL. `issue`
 *  (default `current`) names the map in maps/ and the objects list in
 *  objects/, so it may only hold letters, digits, `-` and `_`: null otherwise. */
function readSettings(params) {
  const issue = params.issue || DEFAULT_ISSUE;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(issue)) return null;
  return { issue, sseLink: params.sse_link || DEFAULT_SSE_LINK };
}

function mapSrc(issue) { return `./maps/${issue}.png`; }
function objectsSrc(issue) { return `./objects/${issue}.json`; }

/** Send an envelope from this tab's participant to the channel via HTTP PUT.
 *  Every envelope says who (Northern public key and name), in which issue,
 *  and since when they are in - what the lot is ranked by. */
function sendEnvelope(type, extra, options) {
  const body = Object.assign({
    type, from: state.me.id, name: state.me.name, issue: state.issue, since: state.since, ts: Date.now(),
  }, extra);
  return fetch(state.sseLink, Object.assign({
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, options)).catch((err) => console.warn('send failed', err));
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker registered'))
      .catch((err) => console.warn('Service Worker registration failed', err));
  }
}

/** Deterministic hue per participant so avatars/dots stay a stable color. */
function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
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
  issue: DEFAULT_ISSUE,
  sseLink: DEFAULT_SSE_LINK,
  me: { id: '', name: UNKNOWN }, // Northern public key, and the name signed in with
  joined: false,
  since: 0,             // when this tab joined (ms): its place in the lot
  roster: {},           // id -> { name, since, lastSeen } of everybody else heard in the issue
  setUp: false,
  loadError: '',

  mapImg: new Image(),
  mapReady: false,
  mapW: 0,
  mapH: 0,

  players: {},          // id -> { name, x, y, dir, walking, lastBroadcastTs, ... }
  objects: [],          // map objects from objectsSrc(issue), sorted by z (lowest first)
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
  // Zine is for whoever is signed in to Northern; anybody else signs in
  // first, and Reg.html sends them back here - as Pals does.
  if (!session.signedIn()) {
    window.location.replace(`${REG}#${window.location.pathname}${window.location.search}${window.location.hash}`);
    return;
  }
  const settings = readSettings(getParams());
  if (!settings) {
    window.location.href = './error.html';
    return;
  }
  state.issue = settings.issue;
  state.sseLink = settings.sseLink;
  state.me = { id: session.pub(), name: session.userName() || UNKNOWN };

  document.getElementById('lobby_issue').textContent = state.issue;
  document.getElementById('lobby_player').textContent = state.me.name;

  // Listen from the start, to know how many are in before joining them.
  const rosterReady = setupSSE();
  setInterval(() => updateRoster(Date.now()), ROSTER_TICK_MS);
  updateRoster(Date.now());

  const enterBtn = document.getElementById('enter_btn');
  enterBtn.addEventListener('click', () => {
    enterBtn.disabled = true;
    showLobbyError('');
    rosterReady.then(() => {
      enterBtn.disabled = false;
      if (lotFull()) showLobbyError(LOT_FULL);
      else enterGame();
    });
  });
  enterBtn.focus();
}

function showLobbyError(text) {
  const el = document.getElementById('lobby_error');
  el.textContent = text;
  el.hidden = !text;
}

function showView(main) {
  document.body.classList.toggle('view-lobby', !main);
  document.body.classList.toggle('view-main', main);
  document.getElementById('lobby_view').classList.toggle('hidden', main);
  document.getElementById('game_view').classList.toggle('hidden', !main);
}

// ---------------------------------------------------------------------------
// Main (game) view
// ---------------------------------------------------------------------------

function enterGame() {
  showView(true);
  document.getElementById('hud_player').textContent = state.me.name;
  document.getElementById('hud_issue').textContent = state.issue;
  state.joined = true;
  state.since = Date.now();

  if (state.setUp) {
    if (state.mapReady) spawn();
    return;
  }
  state.setUp = true;
  setupCanvas();
  setupZoomControls();
  setupChat();
  loadMap();
  loadObjects();

  requestAnimationFrame(tick);
}

/** Back to the lobby, saying why. */
function leaveGame(reason) {
  sendEnvelope('leave', {});
  state.joined = false;
  delete state.players[state.me.id];
  showView(false);
  showLobbyError(reason);
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
  const me = state.players[state.me.id];
  if (!state.mapReady || !me) return;
  const rect = state.canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left) * (state.canvas.width / rect.width);
  const sy = (e.clientY - rect.top) * (state.canvas.height / rect.height);
  const v = state.view;
  me.targetX = clamp(v.srcX + sx / v.mapScale, 0, state.mapW);
  me.targetY = clamp(v.srcY + sy / v.mapScale, 0, state.mapH);
  me.walking = true;
}

function loadMap() {
  const src = mapSrc(state.issue);
  state.mapImg.onload = () => {
    state.mapW = state.mapImg.naturalWidth;
    state.mapH = state.mapImg.naturalHeight;
    state.mapReady = true;
    if (state.joined) spawn();
  };
  state.mapImg.onerror = () => {
    state.loadError = `Issue "${state.issue}" not found`;
    console.error('Failed to load map image', src);
  };
  state.mapImg.src = src;
}

/** In at the door (bottom-left), and ask whoever is in already to say where
 *  they are rather than wait on their heartbeat. */
function spawn() {
  const startX = START_MARGIN;
  const startY = state.mapH - START_MARGIN;
  state.players[state.me.id] = {
    name: state.me.name, x: startX, y: startY, targetX: startX, targetY: startY,
    dir: 'down', walking: false, lastBroadcastTs: performance.now(),
  };
  sendEnvelope('join', { x: startX, y: startY });
  sendEnvelope('state_request', {});
}

// ---------------------------------------------------------------------------
// Map objects (objectsSrc(issue): 2D images standing on the big map)
// ---------------------------------------------------------------------------

/** Read the objects file. Each entry stands on the map at world `x`/`y` - the
 *  bottom-center of its image, where it touches the ground - with `src`
 *  relative to the objects file and `w`/`h` defaulting to the image's own size.
 *  `"type": "obstacle"` makes it something to walk around, not through: its
 *  `footprint` (`{ w, h }`, standing on the same x/y) is the ground it takes up.
 *  `"type": "cover"` puts it over every player wherever they stand - a sign
 *  on a roof, say.
 *  An object's Z-index is its Y: the list comes back sorted so the ones
 *  higher up the map are drawn first (lowest) and the ones lower down over them. */
function parseObjects(data, baseUrl) {
  const list = Array.isArray(data) ? data : (data && data.objects) || [];
  const images = {};
  const objects = [];
  for (const entry of list) {
    if (!entry || typeof entry.src !== 'string' || !Number.isFinite(entry.x) || !Number.isFinite(entry.y)) {
      console.warn('Zine: skipping map object', entry);
      continue;
    }
    const src = new URL(entry.src, baseUrl).href;
    if (!images[src]) {
      images[src] = new Image();
      images[src].src = src;
    }
    const fp = entry.footprint;
    objects.push({
      id: entry.id || src, img: images[src], x: entry.x, y: entry.y,
      w: entry.w > 0 ? entry.w : 0, h: entry.h > 0 ? entry.h : 0, z: entry.y,
      obstacle: entry.type === 'obstacle', cover: entry.type === 'cover',
      footprint: fp && fp.w > 0 && fp.h > 0 ? { w: fp.w, h: fp.h } : null,
    });
  }
  return objects.sort((a, b) => a.z - b.z);
}

function loadObjects() {
  const url = new URL(objectsSrc(state.issue), window.location.href).href;
  return fetch(url, { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => { state.objects = parseObjects(data, url); })
    .catch((err) => console.warn('Zine: map objects not loaded', url, err));
}

/** The world rect an object covers, or null while its image is still loading. */
function objectRect(o) {
  if (!o.img.complete || !o.img.naturalWidth) return null;
  const w = o.w || o.img.naturalWidth;
  const h = o.h || o.img.naturalHeight;
  return { left: o.x - w / 2, top: o.y - h, w, h };
}

/** The ground an obstacle takes up: its footprint, by default the full width
 *  and bottom third of its image. Null for other objects, and while the size
 *  is still unknown. */
function footprintRect(o) {
  if (!o.obstacle) return null;
  let w, h;
  if (o.footprint) {
    ({ w, h } = o.footprint);
  } else {
    const r = objectRect(o);
    if (!r) return null;
    w = r.w;
    h = r.h * FOOTPRINT_DEPTH;
  }
  return { left: o.x - w / 2, top: o.y - h, w, h };
}

/** Where an avatar's center cannot go: every footprint grown by its radius. */
function blockedRects(objects) {
  const rects = [];
  for (const o of objects) {
    const f = footprintRect(o);
    if (f) {
      rects.push({
        left: f.left - AVATAR_RADIUS, top: f.top - AVATAR_RADIUS,
        right: f.left + f.w + AVATAR_RADIUS, bottom: f.top + f.h + AVATAR_RADIUS,
      });
    }
  }
  return rects;
}

function insideRect(x, y, r) {
  return x > r.left && x < r.right && y > r.top && y < r.bottom;
}

/** Whether the segment a-b passes through the inside of r (Liang-Barsky);
 *  running along an edge or touching a corner does not count. */
function segmentHitsRect(ax, ay, bx, by, r) {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, ax - r.left], [dx, r.right - ax], [-dy, ay - r.top], [dy, r.bottom - ay]]) {
    if (p === 0) {
      if (q <= 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 >= t1) return false;
  }
  return t1 - t0 > 1e-9;
}

/** The nearest point outside every rect, within the map: where a click on a
 *  building leads, and where someone standing in one steps out to. */
function pushOut(x, y, rects, mapW, mapH) {
  for (let i = 0; i <= rects.length; i++) {
    const r = rects.find((r) => insideRect(x, y, r));
    if (!r) break;
    const exits = [[r.left - PATH_PAD, y], [r.right + PATH_PAD, y], [x, r.top - PATH_PAD], [x, r.bottom + PATH_PAD]]
      .filter(([ex, ey]) => ex >= 0 && ex <= mapW && ey >= 0 && ey <= mapH);
    if (!exits.length) break;
    [x, y] = exits.reduce((a, b) => (Math.hypot(a[0] - x, a[1] - y) <= Math.hypot(b[0] - x, b[1] - y) ? a : b));
  }
  return [x, y];
}

/** The shortest walk from one point to another around the blocked rects: the
 *  waypoints to visit in turn, ending at the target (or the nearest point
 *  outside an obstacle, when the target is on one). Null when there is no
 *  way through. A* over the corners of the rects, each node linked straight
 *  to every other it can see. */
function planPath(fromX, fromY, toX, toY, rects, mapW, mapH) {
  const start = pushOut(fromX, fromY, rects, mapW, mapH);
  const goal = pushOut(toX, toY, rects, mapW, mapH);
  const lead = start[0] !== fromX || start[1] !== fromY ? [start] : [];
  const clear = (a, b) => !rects.some((r) => segmentHitsRect(a[0], a[1], b[0], b[1], r));
  if (clear(start, goal)) return lead.concat([goal]);

  const nodes = [start, goal];
  for (const r of rects) {
    for (const [cx, cy] of [
      [r.left - PATH_PAD, r.top - PATH_PAD], [r.right + PATH_PAD, r.top - PATH_PAD],
      [r.left - PATH_PAD, r.bottom + PATH_PAD], [r.right + PATH_PAD, r.bottom + PATH_PAD],
    ]) {
      if (cx < 0 || cx > mapW || cy < 0 || cy > mapH) continue;
      if (rects.some((o) => insideRect(cx, cy, o))) continue;
      nodes.push([cx, cy]);
    }
  }

  const dist = (i, j) => Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
  const cost = nodes.map(() => Infinity);
  const prev = nodes.map(() => -1);
  const done = nodes.map(() => false);
  cost[0] = 0;
  for (;;) {
    let cur = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (done[i] || cost[i] === Infinity) continue;
      if (cur < 0 || cost[i] + dist(i, 1) < cost[cur] + dist(cur, 1)) cur = i;
    }
    if (cur < 0) return null;
    if (cur === 1) break;
    done[cur] = true;
    for (let i = 0; i < nodes.length; i++) {
      if (done[i]) continue;
      const c = cost[cur] + dist(cur, i);
      if (c < cost[i] && clear(nodes[cur], nodes[i])) {
        cost[i] = c;
        prev[i] = cur;
      }
    }
  }

  const route = [];
  for (let i = 1; i !== 0; i = prev[i]) route.unshift(nodes[i]);
  return lead.concat(route);
}

/** The waypoints left on a participant's way to its target, planned again
 *  whenever the target changes (a click, a bot's move()) or another
 *  obstacle's footprint becomes known. */
function routeFor(p) {
  const rects = blockedRects(state.objects);
  const key = `${p.targetX},${p.targetY},${rects.length}`;
  if (p.routeKey !== key) {
    p.routeKey = key;
    p.route = planPath(p.x, p.y, p.targetX, p.targetY, rects, state.mapW, state.mapH) || [];
  }
  return p.route;
}

/** An avatar's Z-index: the Y of its feet, on the same scale as an object's z. */
function avatarZ(p) { return p.y + AVATAR_RADIUS; }

function avatarOverlaps(p, r) {
  return p.x + AVATAR_RADIUS > r.left && p.x - AVATAR_RADIUS < r.left + r.w &&
    p.y + AVATAR_RADIUS > r.top && p.y - AVATAR_RADIUS < r.top + r.h;
}

/** Where an avatar stands among the objects it collides with: in front of
 *  each one whose base is at or above its feet, behind each one whose base is
 *  below them - and behind every cover, wherever. Re-evaluated every frame,
 *  so walking past a tree takes the avatar from behind it to in front of it. */
function spriteLayer(p, objects) {
  const z = avatarZ(p);
  const behind = [];
  for (const o of objects) {
    if (!o.cover && o.z <= z) continue;
    const r = objectRect(o);
    if (r && avatarOverlaps(p, r)) behind.push(o);
  }
  return { z, behind };
}

// ---------------------------------------------------------------------------
// Movement / animation loop
// ---------------------------------------------------------------------------

function tick(now) {
  const dt = state.lastFrameTs ? (now - state.lastFrameTs) / 1000 : 0;
  state.lastFrameTs = now;
  state.animT += dt;

  if (state.joined && state.mapReady && state.players[state.me.id]) {
    stepParticipant(state.me.id, dt, now);
    render();
    renderMinimap();
  } else if (state.joined) {
    renderLoading();
  }

  requestAnimationFrame(tick);
}

/** Advance this tab's participant along its route to its target, around any
 *  obstacle, and broadcast as needed:
 *  throttled while walking, plus one final message on arrival (or when there
 *  is no way through), plus an idle heartbeat (< HEARTBEAT_MS gap) so a
 *  stationary participant still keeps peers - and late joiners - caught up
 *  without a KV store. */
function stepParticipant(id, dt, now) {
  const p = state.players[id];
  if (!p) return;

  if (p.walking) {
    const route = routeFor(p);
    let step = MOVE_SPEED * dt;
    while (route.length && step > 0) {
      const [wx, wy] = route[0];
      const dx = wx - p.x;
      const dy = wy - p.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= step || dist < 1) {
        p.x = wx;
        p.y = wy;
        step -= dist;
        route.shift();
      } else {
        p.dir = calcDir(dx, dy);
        p.x += (dx / dist) * step;
        p.y += (dy / dist) * step;
        step = 0;
      }
    }

    if (!route.length) {
      p.walking = false;
      p.routeKey = null;
      sendEnvelope('move', { x: p.x, y: p.y, dir: p.dir, walking: false });
      p.lastBroadcastTs = now;
    } else if (now - p.lastBroadcastTs > MOVE_BROADCAST_MS) {
      sendEnvelope('move', { x: p.x, y: p.y, dir: p.dir, walking: true });
      p.lastBroadcastTs = now;
    }
  } else if (now - p.lastBroadcastTs > HEARTBEAT_MS) {
    sendEnvelope('move', { x: p.x, y: p.y, dir: p.dir, walking: false });
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
  ctx.fillText(state.loadError || 'Loading map...', state.canvas.width / 2, state.canvas.height / 2);
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
  const me = state.players[state.me.id];

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

  // Objects and avatars share one stack ordered by z; on a tie the avatar
  // is in front. Covers go over that stack, and names over everything, so
  // nobody is lost behind a tree.
  const layers = [];
  const covers = [];
  const labels = [];

  for (const o of state.objects) {
    const r = objectRect(o);
    if (!r) continue;
    const [sx, sy] = worldToScreen(r.left, r.top);
    const sw = r.w * v.mapScale;
    const sh = r.h * v.mapScale;
    if (sx > canvas.width || sy > canvas.height || sx + sw < 0 || sy + sh < 0) continue;
    const draw = () => ctx.drawImage(o.img, sx, sy, sw, sh);
    if (o.cover) covers.push(draw);
    else layers.push({ z: o.z, order: 0, draw });
  }

  for (const id of Object.keys(state.players)) {
    const p = state.players[id];
    const [sx, sy] = worldToScreen(p.x, p.y);
    if (sx < -60 || sy < -60 || sx > canvas.width + 60 || sy > canvas.height + 60) continue;
    const isSelf = id === state.me.id;
    const layer = spriteLayer(p, state.objects);
    layers.push({ z: layer.z, order: 1, draw: () => drawAvatar(ctx, sx, sy, v.mapScale, id, p, isSelf) });
    labels.push(() => {
      if (isSelf && layer.behind.length) drawHiddenOutline(ctx, sx, sy, v.mapScale);
      drawAvatarLabel(ctx, sx, sy, v.mapScale, p.name || UNKNOWN);
    });
  }

  layers.sort((a, b) => a.z - b.z || a.order - b.order);
  for (const layer of layers) layer.draw();
  for (const cover of covers) cover();
  for (const label of labels) label();
}

function drawAvatar(ctx, sx, sy, mapScale, id, p, isSelf) {
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
  ctx.fillStyle = colorFor(id);
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
}

function drawAvatarLabel(ctx, sx, sy, mapScale, name) {
  const radius = AVATAR_RADIUS * mapScale;
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.strokeText(name, sx, sy - radius - 8);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, sx, sy - radius - 8);
}

/** The player's own avatar, outlined over the object hiding it. */
function drawHiddenOutline(ctx, sx, sy, mapScale) {
  ctx.save();
  ctx.setLineDash([6, 4]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(sx, sy, AVATAR_RADIUS * mapScale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
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

  for (const id of Object.keys(state.players)) {
    const p = state.players[id];
    const isSelf = id === state.me.id;
    ctx.beginPath();
    ctx.arc(p.x * sx, p.y * sy, isSelf ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = colorFor(id);
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
    sendEnvelope('chat', { m });
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
// Roster: who is in the issue, and the lot
// ---------------------------------------------------------------------------

/** Someone was heard on the channel: in, as of now. */
function noteParticipant(data, now) {
  state.roster[data.from] = {
    name: data.name || UNKNOWN,
    since: Number.isFinite(data.since) ? data.since : now,
    lastSeen: now,
  };
}

/** Somebody gone: off the roster and off the map. */
function forget(id) {
  delete state.roster[id];
  delete state.players[id];
}

/** Forget whoever has not been heard from in STALE_MS, show how many are in,
 *  and step out when this tab turns out to be one too many. */
function updateRoster(now) {
  for (const id of Object.keys(state.roster)) {
    if (now - state.roster[id].lastSeen > STALE_MS) forget(id);
  }
  const count = document.getElementById('lobby_count');
  if (count) count.textContent = `${Object.keys(state.roster).length + (state.joined ? 1 : 0)} / ${LOT_LIMIT}`;
  if (state.joined && overLimit()) leaveGame(LOT_FULL);
}

/** No room for one more: LOT_LIMIT are in already. */
function lotFull() {
  return Object.keys(state.roster).length >= LOT_LIMIT;
}

/** Whether this tab is one too many. Everybody in ranks by when they joined
 *  (then by key, for a tie) and the first LOT_LIMIT stay: two joining at once
 *  as the last one in both saw room, and this settles which of them stays. */
function overLimit() {
  const ranked = Object.keys(state.roster).map((id) => [state.roster[id].since, id]);
  ranked.push([state.since, state.me.id]);
  ranked.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return ranked.findIndex(([, id]) => id === state.me.id) >= LOT_LIMIT;
}

// ---------------------------------------------------------------------------
// Multiplayer sync (SSE listen, PUT send)
// ---------------------------------------------------------------------------

/** Listen on the channel. Resolves once it has listened long enough to have
 *  heard everybody already in - they heartbeat every HEARTBEAT_MS. */
function setupSSE() {
  const es = new EventSource(state.sseLink);
  es.onmessage = (evt) => {
    let data;
    try { data = JSON.parse(evt.data); } catch (err) { return; }
    handleEnvelope(data, Date.now());
  };
  es.onerror = (err) => console.warn('SSE error', err);
  return new Promise((resolve) => {
    es.onopen = () => setTimeout(resolve, ROSTER_WAIT_MS);
    // With no channel there is nobody to count: let them in all the same.
    setTimeout(resolve, ROSTER_WAIT_MS * 5);
  });
}

function handleEnvelope(data, now) {
  if (!data || !data.type || !data.from || data.issue !== state.issue) return;

  // Our own envelopes echoed back: this tab's position is client-predicted
  // and more up to date than the echo.
  if (data.from === state.me.id) return;

  if (data.type === 'leave') {
    forget(data.from);
    return;
  }
  noteParticipant(data, now);

  if (data.type === 'chat') {
    appendChat(data.name || UNKNOWN, data.m);
    return;
  }

  if (data.type === 'state_request') {
    handleStateRequest();
    return;
  }

  const name = data.name || UNKNOWN;
  if (data.type === 'join') {
    state.players[data.from] = {
      name, x: data.x, y: data.y, targetX: data.x, targetY: data.y, dir: 'down', walking: false,
    };
  } else if (data.type === 'move') {
    const existing = state.players[data.from] || {};
    state.players[data.from] = Object.assign(existing, {
      name, x: data.x, y: data.y, dir: data.dir, walking: data.walking,
    });
  }
}

/** A late joiner asked the channel for a catch-up: say where this tab's
 *  participant is right away, past the broadcast throttle. */
function handleStateRequest() {
  const p = state.players[state.me.id];
  if (!state.joined || !p) return;
  sendEnvelope('move', { x: p.x, y: p.y, dir: p.dir, walking: p.walking });
  p.lastBroadcastTs = performance.now();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// Closing the tab: tell the others now, rather than leave them to notice the silence.
window.addEventListener('pagehide', () => {
  if (state.joined) sendEnvelope('leave', {}, { keepalive: true });
});

document.addEventListener('DOMContentLoaded', () => {
  registerSW();
  initLobby();
});
