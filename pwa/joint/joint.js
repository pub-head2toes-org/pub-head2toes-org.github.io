/* Joint PWA - shared helpers */
'use strict';

// Host used for the SSE subscribe endpoint and message PUTs.
const SUB_HOST = 'https://pub.head2toes.org';

// Base path of the lobby page (navigated to via "Enter Lobby").
const LOBBY_BASE = '/pwa/joint/lobby.html';

// Base path of the join page (target of the shareable invite link).
const JOIN_BASE = '/pwa/joint/join.html';

// Parameters required by the lobby page.
const LOBBY_PARAMS = ['organizer', 'participant', 'game_name', 'game_url', 'comm_channel'];

// Parameters carried by the shareable invite link (no participant - the
// invitee fills in their own participant name on the join page).
const INVITE_PARAMS = ['organizer', 'game_name', 'game_url', 'comm_channel'];

/**
 * Generate a communication channel string.
 * Default: current date followed by a random number 1..64, dash separated.
 * Example: 2026-07-28-17
 */
function generateCommChannel() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(Math.random() * 64) + 1; // 1..64
  return `${yyyy}-${mm}-${dd}-${rand}`;
}

/** Parse the current URL's query string into a plain object. */
function getParams() {
  const params = new URLSearchParams(window.location.search);
  const out = {};
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

/**
 * Build a link on the current origin from a base path and a list of keys.
 * Host comes from the current origin so it works both on
 * https://git.head2toes.org and http://localhost. Values are URL encoded.
 */
function buildLink(base, keys, data) {
  const query = keys
    .map((key) => `${key}=${encodeURIComponent(data[key] != null ? data[key] : '')}`)
    .join('&');
  return `${window.location.origin}${base}?${query}`;
}

/** Build the "Enter Lobby" link (lobby.html with all lobby parameters). */
function buildLobbyLink(data) {
  return buildLink(LOBBY_BASE, LOBBY_PARAMS, data);
}

/** Build the shareable invite link (join.html, without participant). */
function buildInviteLink(data) {
  return buildLink(JOIN_BASE, INVITE_PARAMS, data);
}

/** Build the SSE subscribe link for a given comm channel. */
function buildSseLink(commChannel) {
  return `${SUB_HOST}/sub/joint/${encodeURIComponent(commChannel)}`;
}

/**
 * Send a message to the comm channel via an HTTP PUT on the SSE link URL.
 * Payload is JSON: {"participant": <participant>, "m": <m>}.
 */
function sendMessage(sseLink, participant, m) {
  return fetch(sseLink, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ participant, m }),
  });
}

/** Register the service worker (best effort). */
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker registered'))
      .catch((err) => console.warn('Service Worker registration failed', err));
  }
}
