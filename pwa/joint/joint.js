/* Joint PWA - shared helpers */
'use strict';

// Host used for the SSE subscribe endpoint and message PUTs.
const SUB_HOST = 'https://pub.head2toes.org';

// Base path of the lobby page used when building invite links.
const LOBBY_BASE = '/pwa/joint/lobby.html';

// Parameters required by the lobby page.
const LOBBY_PARAMS = ['organizer', 'participant', 'game_name', 'game_url', 'comm_channel'];

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
 * Build the lobby invite link.
 * Host comes from the current origin so it works both on
 * https://git.head2toes.org and http://localhost.
 */
function buildInviteLink(data) {
  const query = LOBBY_PARAMS
    .map((key) => `${key}=${encodeURIComponent(data[key] != null ? data[key] : '')}`)
    .join('&');
  return `${window.location.origin}${LOBBY_BASE}?${query}`;
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
