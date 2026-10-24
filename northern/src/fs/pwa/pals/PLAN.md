# Plan: (PWA) Pals — messaging among close friends

A PWA under `/fs/get/pwa/pals/`, served from its own host name
(`https://pals.<domain>/fs/get/pwa/pals/index.html`), for whoever is signed in
to Northern.

- `PROMPT.md` asked for the UI and for an evaluation of two architectures.
- `UPDATE_1.md` chose the architecture: push-only transport, discovery
  through `/pals/`, local groups.
- `UPDATE_2.md` moved sealing from the server into the browsers. It is built
  as reviewed in *Update 2 — review of the proposal*, with option A for the
  key, fingerprints now, and neither extra.

This document describes what is now built, where the build reads the updates
in a particular way, and what to know before it goes live. The evaluation that
came before Update 1 is condensed in the appendix.

**Read first: _Before it goes live_.** Item 1 there was a hole in the server,
older than Pals, that exposed the push keys; it is fixed, and says what to do
if the keys may have been seen.

Everything stated as a fact below is pinned by a test (`tests/pals.test.js`,
`tests/PushApi.test.js`), except what needs a real browser — see *Not verified*.

---

## The architecture, after Update 2

```
alice's page                    Northern (pals.<domain>)            push service     bob's service worker
  |-- GET /pals/?searchPlus=%/<bob> --> where bob's device is
  |   seal to bob's pinned key
  |   (alice's key ⨯ bob's key)
  |-- POST /push/api/send ---------->  from := alice's send proof, or cookie
  |    {to, subscription, sealed,      encrypt {v, from, to, id, part,
  |     id, part, parts}                 parts, sealed} for bob's device
  |                                    sign VAPID token -------------> holds it -----> push event
  |                                                                                     open with bob's key
  |                                                                                     (bob's key ⨯ alice's key)
  |                                                                                     inbox (IndexedDB)
  |                                                                                     notification
                                                                    bob's page files it in the Log
```

- **Transport: the push payload only** — option 1b of the evaluation. No
  message is stored on Northern. The push service holds it until bob's device
  is reachable.
- **Sealing: end to end, in the browsers** (Update 2). The AES key for each
  message comes from ECDH between the sender's and the receiver's Northern
  keys, through HKDF with a fresh salt and the direction. Only alice and bob
  can make it.
- **The private key** is kept on each device by `reg/keystore.js` when the ID
  Card is loaded there. It is not extractable and is usable for ECDH only
  (FEATURES J6).
- **Identity: the seal.** A message opens only with the key shared with the
  sender it names, so `from` is proven by the crypto, not by the server's
  word. The server still sets `from` itself, for routing and abuse control:
  from a send proof made with the kept key (Update 3), or else the verified
  cookie.
- **One VAPID key pair, the server's own** — V1 of the evaluation. It only
  proves to the push service that pushes come from this server; it protects no
  content.
- **Storage: IndexedDB.** The pals, groups and messages, the setup record, and
  an inbox the service worker fills.
- **Groups are local.** A group message goes to each member on their own, with
  its text starting `[<group name>] ` — inside the seal, so the server does not
  see group names.
- **Discovery: `/pals/<username>/<key>`.** `welcome.html` lists each device
  there once, and the *Add a pal* list is read from it. A pal's key is pinned
  when they are added, and can be checked by fingerprint.

### What this design trusts

- **The server cannot read or forge a message.** Neither can whoever gets its
  database, nor the push service. They see who writes to whom, when, and how
  long the parts are.
- **The server could still, at worst:**
  - drop or delay messages;
  - hand out a wrong key at the moment a pal is added. Comparing fingerprints
    and the *verified* mark close this;
  - **change the app it serves.** A changed `pals.js` could use the stored key
    or read the Log. No web app can rule this out: the zero-trust claim covers
    a curious server, a stolen database and the push service, not a server
    that changes the code.
- **The device** holds the Log unencrypted, and a key that any script on the
  `pals.` origin can use (but not read). The `pals.` host guard keeps everybody
  else's pages off that origin.

---

## What is built

| File | Purpose |
| --- | --- |
| `src/h2t/PushApi.js` | **New, server.** The push relay: VAPID config, `send`, RFC 8291 encryption, VAPID tokens. It reads no message |
| `src/fs/reg/keystore.js` | **New.** `NorthernKeys`: the ID Card's key in IndexedDB, not extractable, ECDH only. `session.js` keeps it when a card is loaded (`Reg.html`, `Signin.html`) and forgets it on `forget()` |
| `seal.js` | **New.** `PalsSeal`: sealing, opening and fingerprints, in WebCrypto, for the page and the service worker |
| `src/h2t/Server.js` | Mounts `/push/api/` (before the no-cookie redirect, so the API answers 401 in JSON), and the `pals.` host guard |
| `welcome.html`, `welcome.js` | The one-time setup screen |
| `index.html`, `pals.js` | The app: *Add a pal* from the directory; sealing and sending; opening and filing; *Send again*; *Key* (compare fingerprints, mark verified); a notice when the ID Card has not been loaded on this device |
| `model.js` | `PalsModel`: the directory, the wire record, splitting into parts, the group prefix, reassembly, delivery state. No DOM, storage or network; the service worker loads it too |
| `store.js` | **New.** `PalsStore`, a small IndexedDB wrapper the page and the service worker share |
| `views.js` | Groups by name; delivery state on a message; the directory list |
| `sw.js` | Opens each push with the key on the device, keeps it in the inbox, notifies, and tells open pages. It asks the server nothing |
| `styles.css` | The welcome panel, the delivery state, the header link |

### Server: `/push/api/`

| Route | Does |
| --- | --- |
| `GET /push/api/config/pub` | `{publicKey}`: the 65-byte VAPID point, base64url, as `pushManager.subscribe` takes it |
| `POST /push/api/send` | `{to, subscription, provider?, sealed, id, part, parts}`, with a send proof `{from, at, proof}` or signed in. Puts `{v: 2, from, to, id, part, parts, sealed}` - `from` being the proof's key, or else the cookie's - in a push encrypted for the subscription, and POSTs it to the push service with a VAPID token. Answers `{status:'OK', id, part, parts, ts, provider}` |

There is no `/push/api/open` any more: it answers 404, like any other path the
API does not have.

**The config row.** `/push/api/config` holds
`{"publicKey": "<b64url point>", "privateKey": "<b64url d>"}`, plus an
optional `"subject"` for the VAPID `sub` claim (the default is `https://`
followed by the request's host name).

- It is written straight into `abcd`, under author `northern:push`. No request
  can act as that author: a verified cookie makes the author a public key, and
  no cookie makes it `public`. So no request can update it.
- Its `public` column is a random secret, so no `?isGroup=` can read it.
- Every path under `/push/api/` belongs to the API, so a plain GET never
  reaches the row.
- If the row exists but somebody else wrote it, the API refuses with 503 and
  does not use it.

**The push payload is JSON text, never raw bytes.** Chrome decrypts a push
and then hands the payload to the service worker as a UTF-8 string. Blink
reads it with `String::FromUtf8` (`string_traits_wtf.cc`), and bytes that are
not valid UTF-8 come out as a null string, so `event.data` is `null`
(`push_message_data.cc`).
- The first live test showed this exactly: DevTools recorded *Push message
  received, Success: Yes, Was Encrypted: Yes* with the payload, and the worker
  got `null`.
- So the seal is base64url, and the payload is ASCII JSON. A test decodes it as
  strict UTF-8.

**The seal** is the one *Payload v2* in the Update 2 review describes, made
and opened by `seal.js` in the browsers. The server only checks it is
base64url of a sane length.

**The checks `send` makes:**
- A send proof that checks out, or - when the body has none - a signed
  session (401). A failed proof is not rescued by a live cookie.
- `Content-Type: application/json` (415), and an `Origin` header, if present,
  whose host is the request's own `Host` (403). Together these stop a form on
  another site sending as the visitor.
- A body of at most 16 KB (413). `to` must be a Northern key, `sealed`
  base64url of 60 to 3800 characters, `id` 1 to 40 letters, digits, `-` or
  `_`, and `1 <= part <= parts <= 100` (400).
- The payload must fit one push: at most 3993 characters (413). The server
  cannot see the text, so the 1000-character rule is the page's to keep; a
  test checks the largest part the page can make still fits.
- **The endpoint's host must be a known push service** (400). Otherwise the
  relay is an open proxy into anything the server can reach. The list covers
  FCM, Mozilla autopush, Apple and WNS, over https with no port or userinfo.
- When `provider` is given, it must name the service the endpoint belongs to.
- The push service's answer is reported: 404/410 become `410 Gone` (the device
  is no longer subscribed), 429 stays 429, and anything else becomes 502.

### Client

- **`welcome.html`.**
  - A visitor who is not signed in goes to `Reg.html`, and back.
  - It needs a Northern user name; without one it says so and disables Go.
  - On a browser with no Push API, it says to install Pals to the Home Screen
    first, which is where iOS allows Push.
  - **Go** asks for notification permission, registers `sw.js` and fetches the
    VAPID key. It subscribes, reusing a subscription made with this key and
    unsubscribing one made with another.
  - It then lists the device at `/pals/<username>/<key>?isPublic=true` and
    records the setup in IndexedDB, then opens `index.html`.
  - `index.html` sends a user who has no setup record here, and says so when
    the browser's subscription no longer matches it. The header link *set up
    this device again* comes back here.
- **The directory.** `GET /pals/?searchPlus=%` reads up to 1100 rows, in pages
  of 100. A row counts only when:
  - its path is exactly `/pals/<name>/<key>` (history rows `…/<n>` do not);
  - its `author` is that key;
  - its JSON names the same key.

  The newest `ts` per key wins. *Add a pal* offers everybody else on the list.
- **Sending.**
  - Each receiver's device is looked up afresh by key
    (`searchPlus=%/<key>`), so a re-subscription or a new user name is picked
    up.
  - The text is split into parts of at most 1000 characters and 2600 bytes of
    JSON.

    This fits the payload: 3993 characters, less 284 for the keys and
    numbers around the seal, leaves 2781 bytes of seal, of which 75 go on its
    header, tag and `{ts}`. Plain, Latin or Cyrillic text reaches 1000
    characters first; CJK and emoji reach the byte limit first. Splits fall
    between whole characters, and each part leaves room for the group prefix.
  - Each part is sealed in the page, to the key stored with the pal when they
    were added. The directory only says where to push.
  - Sending needs the ID Card's key on this device. Without it, the page says
    so and links to `Reg.html`.
  - Every part carries the prefix, so a part that arrives alone still files
    under its group.
  - Parts go out in order, one push each, under one random id per message.
  - Each receiver's result is kept on the message: `sending`, `sent`, or the
    server's reason. The Log row says *sending…* or *not delivered*.
  - The overlay says why it was not delivered and offers *Send again*, which
    resends only to those it missed.
- **Receiving.**
  - The service worker opens each push with the receiver's key from
    `NorthernKeys`, and stores it in the inbox, opened or not. It asks the
    server nothing.
  - It always shows a notification (Chrome requires one). The notification
    names the sender and never shows the text.
  - The page drains the inbox on load and whenever the worker says a push came.
    It opens what the worker could not, and files each message. A sender who
    is not a pal is named from the directory.
  - Parts are put back together by sender and id, in any order, and a part
    seen before is dropped. A message still missing parts shows `[…]` where
    they go, and *n of m parts* in the Log.
  - When the ID Card's key is not on this device, messages wait in the inbox
    and the page says to load the card.
  - An inbox item addressed to another identity on the same browser is left
    for that identity. One that will not open is dropped after a week, and one
    sealed the Update 1 way at once.
- **Fingerprints.** *Key*, under Pals, shows the selected pal's fingerprint
  and the user's own: 30 digits from SHA-256 of the key. When both people's
  numbers match, *They match* marks the pal verified, shown as a ✓ in the
  list. The mark stays true because the pal's key never changes after it is
  added.
- **`welcome.html`** also needs the ID Card's key on the device. Without it, Go
  is disabled and a link leads to `Reg.html` and back.
- **Groups.**
  - A group is `{name, members}`, unique by name regardless of case, with no
    `[` or `]` in the name.
  - A received `[Name] …` is filed under the user's group of that name. When
    the user has none, the group is made, and its sender is added if they are
    a pal.

### The `pals.` host

`Server.js` treats any `Host` that starts with `pals.` as Pals' own origin:

- `/` redirects to the app.
- Every response carries `X-Content-Type-Options: nosniff`.
- **Every document other than `/fs/get/pwa/pals/` and `/fs/get/reg/` is
  served with `Content-Security-Policy: sandbox`.** It renders, but runs no
  script and gets an opaque origin, so it cannot reach Pals' IndexedDB or
  cookie. This covers database rows, which any user can write and which
  Northern serves as HTML when the key has no extension.
  - `pwa/pals/example/` is sandboxed too.
  - The path is normalised first, so `/fs/get/pwa/pals/../x` does not slip
    through.

Without this guard a subdomain would buy nothing, because rows are served on
every host name. Other host names behave exactly as before.

### Where the build reads the updates in a particular way

1. **`/push/api/send` also takes `to`**, the receiver's key, so the push says
   whose key opens it.
2. **(Update 1's `open` check is gone with `open`.)** The sender is now
   proven by the seal itself, and the server checks the cookie at `send`.
3. **The key in `/pals/<username>/<key>` is base64url.** Three Northern keys
   in four contain `/`. The name is percent-encoded, with `.` as `%2E`,
   because Northern reads text after a `.` as a file type.
4. **`welcome.html` writes with `PUT`, then `POST` if nothing is there.** A
   second `POST` to the same key files a version and leaves the row as it was,
   so a new subscription would never replace the old one.
5. **"1000 chars" is counted in characters (code points), and parts are also
   capped at 2600 bytes**, because 1000 emoji do not fit one push.
6. **Long messages carry `id`, `part` and `parts`** through `send` and inside
   the envelope, so they can be put back together.
7. **Groups are stored inside the user's state record**, as a list keyed by
   name, rather than one IndexedDB record per group. The page reads and writes
   one record, and the service worker never writes it.
8. **A received group message for a group the user lacks creates the group.**
   Otherwise there would be no group list to put it in.
9. **Update 2's "modify reg/sign"** is done in `session.js`, which both pages
   use: loading or creating an ID Card keeps the key, on any page that loads
   `reg/keystore.js`. `Reg.html` waits for it before moving on.
10. **Update 2's second option** (per-pal AES keys) was weighed and not built;
    see the review.

---

## Update 2 — review of the proposal (built: A, fingerprints, no extras)

`UPDATE_2.md` moves sealing and opening from the server to the browsers:

- the AES key comes from ECDH between the sender's private key and the
  receiver's public key;
- opening happens in the browser, not through `/push/api/open`;
- the private key is kept in IndexedDB as a non-extractable key when the ID
  Card is loaded (option A), or per-pal AES keys are derived and stored
  instead (option B).

**The direction is right.** With it the server can no longer read a message,
and can no longer forge one: only the two key holders can make the AES key.
This also proves who the sender is without a signature, which the Update 1
design lacked. But "zero trust" needs more than the proposal says. Below are
what it gets right, the gaps it must close, and the limits no change here
removes.

### Where the private key lives: option A, with constraints

| | Option A: the private key, non-extractable | Option B: per-pal AES keys |
| --- | --- | --- |
| What is stored | One `CryptoKey`, imported for **ECDH only** (`deriveBits`), not extractable | One non-extractable AES key per pal |
| A script running on the Pals origin can | derive a key with *any* public key: read every message, and write as you to anyone | use the stored keys: read every message, and write as you to existing pals only |
| Script can export the key | no | no |
| Adding a pal | nothing extra | needs the ID Card file every time |
| First message from somebody new | opens | cannot be opened until the ID Card is loaded |

**Recommended: A.** B's extra protection is narrow: a script on the origin
could not reach people you have never added. Its costs are daily ones. Both
fall the same way to script on the origin, which is why the `pals.` host guard
(only Pals runs there) matters as much as the crypto.

Constraints on A:
- **Import it as ECDH only**, never ECDSA. A key in IndexedDB then cannot sign
  a Northern cookie or a registration, so it is no way into the rest of
  Northern.
- **`session.js` stores it**, in its own IndexedDB database (`northern`,
  store `keys`, by public key), whenever an ID Card is loaded or created. That
  happens in `Reg.html` and `Signin.html`, and it has to happen on the
  `pals.` origin, because IndexedDB belongs to one origin. `session.forget()`
  deletes it.
- **FEATURES J6** changes from "the private key is never stored" to "the
  private key is never stored in a form any script can read".
  `browserIdentity.test.js` is extended to match: the only write of key
  material is `importKey(..., false, ['deriveBits'])` in `session.js`.

### Gaps the proposal must close

1. **Reflection.** ECDH(alice, bob) equals ECDH(bob, alice), so one key would
   cover both directions. The server could bounce alice's message to bob back
   to alice, and she would read her own words as bob's. **Fix:** derive with
   HKDF, binding sender then receiver, and a fresh salt per message:
   `info = "Pals v2" ‖ from ‖ to`. A per-message salt also gives every
   message its own key.
2. **Splicing and relabelling.** **Fix:** pass `v, from, to, id, part, parts`
   to AES-GCM as additional data. A part cannot then be moved into another
   message or given another sender. The receiver picks the key by `from`, so a
   forged `from` simply fails to open.
3. **The receiver's key comes from the server.** Pals reads it from `/pals/`
   when a pal is added. A malicious server could hand out its own key at that
   moment, open the message, and seal it again for the real receiver (a
   man in the middle).
   - Pals already pins the key after that: it seals to the key stored with the
     pal.
   - The first contact is still trust on first use, and the 5-letter tag
     (30 bits) is far too short to check a key by.
   - **Fix:** a fingerprint per pal (a safety number of about 20 digits) that
     two people compare in person or on a call, and a *verified* mark in Pals.
   - Without it, zero trust holds only if the server was honest the moment
     each pal was added.
4. **The server still delivers the code.** A server, or someone in control of
   it, can send a `pals.js` that uses the stored key or reads the Log. This is
   the limit of any web app that claims end-to-end encryption.
   - It can be narrowed: the service worker could serve the app from its own
     copy and change it only when the user accepts an update.
   - It cannot be removed.
   - **The plan should say plainly what zero trust covers:** a server that
     relays honestly but is curious, a stolen database, the push service. It
     does not cover a server that changes the app.
5. **The server keeps a job, and only that one.** `/push/api/send` takes
   `{to, subscription, payload}`. It checks the sender's cookie (rate limits,
   abuse), the size and the push-service allow-list, and encrypts and pushes
   as now. It sees an opaque payload.
   - `/push/api/open` and the server-side seal are removed.
   - The VAPID keys only authenticate the server to the push service; they
     protect no content.
6. **Opening in the service worker.** The worker reads the key from
   IndexedDB and opens the message itself. The notification can then name the
   sender, and nothing goes to the server on receipt.
   - A device whose ID Card has not been loaded since the change keeps
     messages sealed in the inbox.
   - The page then says "load your ID Card to read N messages".
7. **What the server still learns.** Who writes to whom, when, and how much:
   the push payload's length gives the message length. Padding parts to a few
   fixed sizes hides the length; it costs bytes per push.

### What it does not change, and should say so

- **No forward secrecy.** The same key pair seals every message. Whoever later
  gets an ID Card file can open every message to or from it that they
  recorded. Northern stores none; the push service holds each one briefly.
- **One key for two jobs.** The identity key signs cookies (ECDSA) and would
  now also agree keys (ECDH). With HKDF's domain separation there is no known
  practical attack, but the textbook answer is a separate agreement key,
  signed by the identity key (K3 in the appendix's evaluation). Accept for
  now; revisit with multi-device.
- **Messages on the device are plain.** The Log in IndexedDB is readable by
  whoever has the unlocked browser profile. Encrypting it under a key kept
  next to it adds little.
- **Messages sealed the Update 1 way cannot be opened** after the change. Only
  test messages exist, so nothing needs migrating.

### Payload v2

```
push payload  = base64url( 2 | salt(16) | iv(12) | AES-256-GCM(inner) | tag(16) )
                plus `from` in clear - inside the push encryption, so only the
                receiving browser sees it
key           = HKDF-SHA256( ECDH(own private, other public), salt,
                             "Pals v2\0" ‖ from point ‖ to point, 32 )
additional    = "v2" ‖ from ‖ to ‖ id ‖ part ‖ parts
inner         = { ts, id, part, parts, body }     // body carries [Group]
```

It is about 300 bytes lighter than v1, so parts can stay at 2600 bytes or
grow.

### Decisions, as taken

| | Decision | Recommended — and chosen |
| --- | --- | --- |
| **U1** | Key storage: option A (ECDH-only, non-extractable) or B (per-pal AES keys) | A |
| **U2** | Fingerprints and a *verified* mark, now or later | Now. Without them the zero-trust claim rests on the moment each pal was added |
| **U3** | The service worker serves a pinned copy of the app, updated only on the user's say-so | Later. It narrows gap 4, but does not close it, and changes how updates reach users |
| **U4** | Pad payloads to fixed sizes | Later |

---

## Update 3 — an expired session

The `ssid` cookie lasts a day, and only a loaded ID Card can mint a new one.
Pals used to send a visitor without a live cookie to `Reg.html`, and
`/push/api/send` refused them, though the key that seals and opens every
message was still on the device.

- **The page stays.** It leaves for `Reg.html` only when the browser has no
  identity at all, or signed out. With the cookie gone - or one for somebody
  else - the header says *The session has expired: sign in again*, the link
  going to `Reg.html` and back. It is checked on every render and whenever
  the page comes back into view.
- **Sending goes on, with a send proof.** Each `send` carries
  `{from, at, proof}`: HMAC-SHA256 over `to, id, part, parts, at, endpoint,
  sealed`, keyed by HKDF over ECDH(the kept key, the server's VAPID key)
  (`PalsSeal.prove`, `PushApi.sendProof`). Only the holder of `from`'s key, or
  the server, can make it. The page sends one every time, cookie or not, and
  asks `/push/api/config/pub` for the key once per load.
- **What it lets through, and does not.** A proof is good for 5 minutes either
  side of the server's clock, for that one push; within that window the same
  request could be replayed, which pushes a part the receiver already has and
  drops as a duplicate. It needs no signing key, so FEATURES J6 holds. A
  script running as Pals could already seal with the kept key; it can now send
  after the cookie expires as well (see 3 below).
- **Still needs a live session:** *set up this device again* (it writes the
  `/pals/` row), and everything outside Pals.

## Update 4 — an expired session goes to sign in

A test user missed the *sign in again* notice of Update 3, wrote a message
anyway, and got *Not delivered*. So the notice is gone, and:

- **Pals leaves for `Reg.html`** whenever the session is not live - on load,
  when the page comes back into view, and before a message is written or sent
  again - and `Reg.html` sends the user back after. A message mid-send when
  the cookie runs out still goes, with its send proof, which stays.
- **`Reg.html` hides Reg** for a browser that knows its user but whose
  session has expired, and opens Sign in: signing in again with the same ID
  Card is what that user wants, not a new identity by mistake. A first visit,
  a live session and a browser that signed out still get Reg.
- **The version at the foot of the page.** `version.js` holds
  `PALS_VERSION`; `sw.js` names its cache `pals-v<version>` after it and the
  page shows `Pals v<version>`. Bump it whenever a cached file changes.
- **One version at a time, whatever caches it.** Cloudflare turns the
  server's `no-cache` on `.js` into `max-age=14400` (its Browser Cache TTL),
  while HTML passes through. A new `index.html` then ran a 4-hour-old
  `pals.js`, which threw on the element this update took out. So every script
  and the stylesheet in `index.html` and `welcome.html` is asked for as
  `?v=<version>` (a test holds them to `PALS_VERSION`), the worker precaches
  with `cache: 'reload'`, and it is registered with `updateViaCache: 'none'`.

## Update 5 — reply and correction

- **A bubble of three dots** (`...`, light grey) sits by the sender's name on
  every row of the Log: the message opens to more than reading.
- **Reply**, bottom left of an incoming message: a text area opens under the
  message and the button turns into *Send*, which sends the original, a line
  `Sent by: <name> on <date sent>`, a line `--- Reply ---`, then the reply - as a new message, to where the original
  came from: its group, or its sender. A sender who is not a pal cannot be
  answered (their key is not one the user chose); the overlay says so.
- **Correction**, bottom left of an outgoing message: the text area opens
  with a copy of the message to edit, and *Correct* sends the original, its
  `Sent by:` line, a line `--- Correction ---`, then the edited copy, to where the original went. A
  copy left as it was is not sent.
- Both are ordinary messages (`PalsModel.answer`), sealed and delivered as
  any other; the original stays as it was. Both go to `Reg.html` first when
  the session has expired, as writing a message does.
- `PALS_VERSION` is 8.

## Update 6 — a photo or a video with a message

- **New message** has a file picker (`image/*`, `video/*`, 50 MB at most).
  The text may then be empty.
- **Sending.** Before anything is pushed, the file is locked in the browser
  (`PalsSeal.lock`: AES-256-GCM under a fresh key of its own) and the locked
  bytes go to `POST /temp/api/upload` (`src/h2t/TempApi.js`). Northern holds
  only what it cannot open. The id it answers and the key go in the seal of
  **every part**, as `att: {id, key, type, name, size}`, so a part that
  arrives alone still brings it. A group message uploads once for every
  member. Parts are cut shorter by what `att` takes (at most 427 bytes); a
  test seals the worst case and checks it still fits one push.
- **An upload that fails sends nothing.** Every receiver is marked *the photo
  could not be sent: <why>*, and *Send again* uploads it before it pushes.
- **Receiving.** Once a message is filed, the page fetches
  `GET /temp/api/download/<id>` at once, since the first fetch marks the file
  for deletion on Northern. It unlocks it with the key from the seal and
  keeps it on the device. A fetch that fails is tried again on the next push
  or load. A file Northern no longer has (404), or one that will not unlock,
  is given up, and the overlay says why.
- **Where it is kept.** IndexedDB `pals` version 2 adds the `files` store,
  `<pub> <message id>` → `{name, type, bytes}`, apart from `state` so a save
  stays small. The sender keeps their own copy there too. An open tab of an
  older version closes its connection when the upgrade comes.
- **Shown.** A 📎 by the message in the Log, or its file name when there is no
  text. The overlay shows the photo or plays the video, from an object URL
  that is let go when the overlay closes, with a link to save it.
- **The service worker is unchanged.** It asks the server nothing; the page
  does the fetching.
- **What to know:**
  - Uploading needs a live session cookie. The page sends the user to sign in
    before writing, so this only matters if the cookie expires mid-send.
  - In a group, the first member to fetch marks the file for deletion. The
    others can still fetch it until the temp space runs short and purges it.
  - A receiving device fetches every attachment as soon as it arrives, up to
    50 MB each, on whatever network it is on.
  - Replies and corrections carry the text, not the attachment.
  - Files are kept on the device for good; nothing deletes them yet.
- `PALS_VERSION` is 9.

## UPDATE_6.md — less on the main screen

(The section above was built before `UPDATE_6.md` was written, under the
same number.)

- **The main screen** is a row with a gear, then *Pals* and *Groups* side by
  side (stacked on a phone), then the status line. The app name, *Signed in
  as*, *set up this device again* and the version moved to **Settings**,
  which the gear opens.
- **Layers** are `<dialog class="layer">` above the page, full screen on a
  phone:
  - **Messages** (the old Log; *show all* is gone) opens on a click on a pal,
    with `+` to write. The message overlay and *New message* open on top of it.
  - **Group members** opens on a click on a group, and right after a group is
    added. Its *Messages* button opens the group's messages, or only the
    picked member's.
  - The selection stays when a layer closes, so `−` and *Key* work on it.
- **No Incoming panel.** A message puts a bright green dot by its sender in
  the Pals list (`state.unread`, kept); opening their messages clears it, and
  what comes in while they are open is read as it comes. Somebody who wrote
  without being a pal is listed after the pals, in grey italics, with the dot:
  they are **not** made a pal, so the Update 2 pinning and the Update 5 rule
  (no answering a key the user did not choose) hold. `+` adds them; `−` takes
  them off the list, keeping what they wrote.
- *Groups* says *No groups* when there are none.
- `PALS_VERSION` is 10.

## UPDATE_7.md — writing in the Messages layer

- **No *New message* overlay.** Under the messages is the *New message*
  panel: a text area two rows high, then *Photo or video (50 MB at most)* and
  the file picker. *Add* (in place of `+`) sends it.
- **No *To* list.** A message goes to whoever the layer shows: the pal, or
  the group - the whole group, also when only one member's messages are
  shown (`PalsModel.writeTo`). Somebody who is not a pal cannot be written to
  until they are added; it says so under the text.
- What is wrong (nothing written, a file too large...) is said under the
  text, which stays to be put right. Once a message is on its way, the panel
  is emptied. What was written stays while the layer is closed and opened
  again on the same pal or group, and is dropped for another one.
- The layer is a fixed height (full screen on a phone); the list takes what
  the panel leaves.
- **A reply's row starts with *Re:*** - any message with the
  `--- Reply ---` line, sent or received (`PalsModel.isReply`).
- **The message overlay's text area** is only as tall as the message, up to
  12 rows (6 with Reply or Correction open), measured once the overlay is
  open.
- `PALS_VERSION` is 11.

## UPDATE_8.md — small details in the Messages layer

- **On a phone, Messages takes the whole screen**, edge to edge, padded
  clear of the notch and the home bar. Its list never scrolls sideways:
  the row under a message (sender, where, state, time) wraps instead.
- **The panel's button is *Send*** (it was *Add*).
- **A message's row shows all of it**, line breaks kept and long words
  broken, instead of its first 128 characters on one line
  (`PalsModel.excerpt` is gone).
- **The message overlay's *Correction* is *Edit***; once open it still
  turns into *Correct*, which sends it.
- **Still too wide on an iPhone 12 Pro (390 px) and SE (375 px)**, fine on
  an XR (414 px): an overlay's form was a grid with an `auto` column, as
  wide as its widest line that cannot break - the title with a long pal or
  group name in it, which as a flex item did not shrink. The column is now
  `minmax(0, 1fr)` in every overlay, and the name is cut with an ellipsis.
  The New message panel's own grid gets the same column, and a text area is
  never wider than what holds it (`min-width: 0; max-width: 100%`), so the
  text area's own width - 20 columns in Safari - cannot push it out either.
- `PALS_VERSION` is 14.

## Video calls with a pal (version 16; a switch since 17)

Brought over from InPerson, where calls were tried live first (2026-10-13,
through Cloudflare's TURN and directly): `../inPerson/PLAN.md` has the design,
the TURN spike and the step-by-step of a call. What it is in Pals:

- **Call** in a pal's Messages layer (not a group's). The call layer shows the
  pal's camera large and this device's small, how the call stands - *Calling*,
  *Ringing* once the push is out, *In a call* - and **Hang up**. **Key** opens
  *Compare keys* in the middle of the call, the moment two people can read
  their numbers to each other.
- **Only pals, only to the pinned key.** The ring and every signal are sealed
  to the key stored with the pal; the directory only says where to push. A
  ring from somebody who is not a pal never rings: it is a *Missed video call*
  in the log, and they are listed under the pals, to be added.
- **The ring is a push to the pal's Pals device**, by `/push/api/send` with
  the send proof, as a message is: one subscription, one worker, no second
  setup. The rest goes over Northern's `/sub/pals-call-<random id>`, sealed.
- **A signal is not a message.** It travels as the seal's `signal`
  (`seal.js`), beside a text that a Pals too old to know calls files instead:
  *Video call - this Pals needs updating to answer it*, or *Missed video
  call*. The worker shows *alice is calling* (it stays until it is dealt with)
  or *Missed call from alice*; the page hands signals to the call and never
  to `PalsModel.receive`.
- **Missed calls** - rung out, given up by the caller, or from somebody who
  is not a pal - are filed in the log once per call (`PalsModel.missedCall`),
  with the dot by the name.
- **One switch in Settings, *Video calls with my pals*, off until turned
  on** - kept on the device (the setup store, under `calls <key>`). Turning it
  on asks for the camera and microphone at once, and lets them go; refused,
  it stays off and says why. Off, there is no **Call**, and a pal's ring is a
  missed call - in the worker's notification and in the log.
- **Nothing to configure.** Every call takes TURN credentials from Northern
  (`/turn/api/ice`) and Cloudflare's STUN server; a call goes direct when the
  devices can reach each other, through TURN when not. Without TURN on the
  server, a call tries with STUN alone and says so. InPerson keeps the full
  STUN/TURN form and *Check*, for trying a TURN server out.
- **The session** never sends the page to `Reg.html` in the middle of a call.
- Files: `calls.js` (`PalsCalls`: STUN/TURN, the signals), `call.js`
  (`PalsCall`: WebRTC), the wiring in `pals.js`. Tests:
  `tests/palsCalls.test.js`.

## UPDATE_9.md — Backup and Restore (version 19)

- **Backup** and **Restore** in Settings. Backup makes one file of the pals,
  the groups, every message, and the photos and videos kept on this device;
  Restore adds one back.
- **Sealed as the messages were.** Pals keeps messages opened, so the file is
  sealed with the ID Card's key, the way a message is (`seal.js`): HKDF over
  ECDH - here of the key with its own public key - and AES-256-GCM. It opens
  only where that ID Card is loaded, on this device or another; to anybody
  else, and to wherever the file is kept, it shows nothing but its size.
- **The file** (`backup.js`): `Pals backup\n`, a version byte and a salt, then
  records, each sealed apart with its place in the file: the index first
  (the state, and which photo goes with which message), then one record per
  photo or video. Files are sealed one at a time, and a restore reads the
  file one slice at a time, never whole. A
  file cut short, changed, made with another ID Card or from a newer Pals is
  refused before anything is restored, and says why.
- **Saving it**: once made, the backup is a link - *Save
  pals-backup-alice-2026-10-19.pals, 3.2 MB* - which the user taps. iPhone
  asks before it saves a file, and drops a download a page starts on its own.
- **Restore adds; it never removes** (`PalsModel.restore`). Pals, groups and
  messages not here are added, each once - a message is known by its wire id
  and which way it went - so restoring twice is restoring once, and a device
  in use loses nothing. A name given here stays; a key verified in the backup
  stays verified. A message still being sent when the backup was made is not
  sent now: it says so, and *Send again* sends it. Photos and videos go back
  under the messages they belong to; Northern is asked for none meanwhile, and
  afterwards only for those the backup did not have.
- `PALS_VERSION` is 19.

## UPDATE_10.md — spike: calls of four, and sealing the frames

It started as a feasibility spike, whose one build was a measurement,
`example/frames/` (below). Calls of three and four are now built, with the
video sizes: see *Built: calls of three and four (version 20)* at the end of
this section. Browser support is from MDN's compatibility data (October
2026); bandwidth figures are estimates, not measured on a call.

**Short answers.**
- *Four in one call*: feasible as a **mesh** — every device connected to every
  other, six connections in all, three on each device. That is the practical
  ceiling for mesh. What limits it is each phone's upload and CPU, not a cap
  on connections. A capped call of four needs about **2 Mbit/s up and 2
  down on each phone**.
- *Sealing the media before it is sent*: possible, in every current browser,
  for a cost too small to notice — **1–3 % of one core** on the Pi 5, and
  about **18 kbit/s per stream**. But a one-to-one call is **already end to
  end** (see *What a one-to-one call already has*), so sealing frames adds
  little there. It becomes necessary only if calls ever go through a media
  server (an SFU).

### Calls of four: what limits a mesh

- **No hard limit on connections.** A page can hold many
  `RTCPeerConnection`s, and four people need three each. The limits are
  these:
  1. **Upload: each device sends its video once per pal in the call.** A
     browser encodes separately for every connection and cannot share one
     encoding between them, so three pals means three uploads.
  2. **CPU and battery: three encoders and three decoders at once** on each
     phone. This, and heat, is where phones give out first. Phones have few
     hardware encoders; the rest fall back to software.
  3. **TURN:** each connection that cannot go direct takes its own TURN
     allocation (Cloudflare's limits, per allocation, are far above this —
     see `../inPerson/PLAN.md`).
- **Past four**, the uploads and encoders grow with every person added. From
  five on, the usual answer is an SFU: each device sends once, and the server
  forwards. That changes what the server can see; see *Sealing the frames*.

**Bandwidth.** Each stream is the video plus 32 kbit/s of Opus audio. A device
sends and receives N−1 streams. Through TURN, the cost is Cloudflare's $0.05
per GB, and only for the connections that are relayed:

| Video per stream | One to one, each way | Four in a mesh, each phone up / down | All 12 streams relayed |
| --- | --- | --- | --- |
| 300 kbit/s (small tiles) | 0.33 Mbit/s | 1.0 / 1.0 Mbit/s | 1.8 GB an hour, $0.09 |
| **500 kbit/s (360p, recommended cap)** | 0.53 Mbit/s | **1.6 / 1.6 Mbit/s** | 2.9 GB an hour, $0.14 |
| 1,500 kbit/s (720p) | 1.53 Mbit/s | 4.6 / 4.6 Mbit/s | 8.3 GB an hour, $0.41 |

- **Today's calls are not capped.** `camera()` asks for `{facingMode:
  'user'}`, and the browser raises the bitrate as far as the line allows. In a
  call of four that is the 720p row, which is too much upload for many mobile
  connections and too much encoding for many phones.
- **So a call of three or four caps each sender.** It would ask for 640×360
  and set `maxBitrate` of 500 kbit/s through `RTCRtpSender.setParameters`,
  which every browser has. Mesh has one advantage here: each connection is
  encoded on its own, so the pal shown large can be sent a higher bitrate
  than the small tiles.

**What the code would need.**
- **`call.js` stays one connection to one pal.** A conference keeps one
  `PalsCall` per pal in the call. Hanging up says `bye` to each, and the call
  is over for a device when its last pal leaves.
- **One channel for the whole call: `/sub/pals-call-<id>`.** Everybody
  listens on it, and each signal names its `to`. `listen()` today drops
  anything not `from` the one pal; it would accept anyone on the call's list.
  That keeps one `EventSource` per device (finding 13: six connections per
  origin on HTTP/1.1). Every signal reaches every listener, but signals are
  few and small, and sealed to their `to`.
- **Who offers:** of any two, the smaller key. One who joins says *ready* to
  everybody in the call. Whoever hears it offers when theirs is the smaller
  key, and says *ready* back when it is not, so the one who joined offers.
  Two who join at once come to the same. One side of each pair offers, as in
  a call of two, and there is no glare. (As built; the spike first had the
  one already in the call always offer, which needs a tie-break.)
- **The ring names everybody.** The caller pushes one ring to each invitee,
  sealed as now, with the list of keys in the call. A late ring, a decline or
  *busy* affects that one connection, not the call.
- **Trust: who may be in the call.** Groups are local, so bob may be in
  alice's call with carol without having carol as a pal. There are two ways
  (decision **E7**):
  - *Pals only*: a device connects only to people who are its pals. Simple,
    but a call can then be four people where not everyone sees everyone.
  - *Introduced by the caller*: the ring is sealed by alice and carries
    carol's key as alice pinned it. bob takes it for this call only, and the
    tile says *introduced by alice*. Northern cannot change the key, but bob
    is trusting alice's pin. **Recommended.**
- **TURN credentials** from one `/turn/api/ice` serve all three connections.

### Calls of four on a phone

At 375–390 px wide, in portrait. Phones send portrait video, so tall tiles
waste little of the picture. The layout follows how many are in the call, with
CSS grid and `minmax(0, 1fr)` columns (see the iOS memory on narrow widths):

```
 two (as now)        three               four                four, one tapped
+-------------+    +------+------+    +------+------+    +-------------+
|             |    | bob  | carol|    | bob  | carol|    |             |
|    bob      |    |      |      |    |      |      |    |    carol    |
|             |    +------+------+    +------+------+    |             |
|        +--+ |    |  +   | me   |    | dave | me   |    |             |
|        |me| |    | Add a|      |    |      |      |    +----+----+---+
|        +--+ |    |  pal |      |    |      |      |    |bob |dave| me|
+-------------+    +------+------+    +------+------+    +----+----+---+
 [Key] [Hang up]    [Mic] [Camera] [+] [Hang up]  (the same row under each)
```

- **Three and four are a 2×2 grid**, with this device's camera bottom right.
  With three, the free tile is **+ Add a pal**.
  Each tile is about 185 × 330 px: big enough for a face. A small picture in
  the corner would cover part of a tile that is already small.
- **Tap a tile to make it large**, with the others in a strip beneath. The
  large one can be sent at a higher bitrate (above).
- **Who is speaking** gets an outline, from
  `RTCRtpReceiver.getSynchronizationSources()` and its `audioLevel` (all
  browsers). No server is needed for that.
- **On each tile**: the name pill, ✓ once their key is compared, and how
  that connection stands (*connecting*, *reconnecting*). One pal's connection
  dropping greys only their tile.
- **Mic and Camera buttons** join Hang up. A call of four needs them more
  than a call of two. **Key** moves onto each tile, as a long press or a
  small button, because there is one key per pal.
- **Landscape**: four in a row, or the 2×2 grid. The call layer already takes
  the whole screen on a phone (`#dlg_call`).

### The call of four, step by step

It builds on what a call of two already has: **Call**, the *is calling*
dialog, *Missed video call* in the log, the switch in Settings.

**Starting it.**
- **From a group's Messages layer**, **Call** rings its members, up to three.
  A larger group first shows a short picker: up to three ticks, then **Ring**.
- **From a call already running**, the free tile **+ Add a pal** rings one
  more, so a call of two grows to four without hanging up.

**The ring** is one push per invitee, sealed to that pal's pinned key, as now.
The group's name and the list of people travel inside the seal, so Northern
sees neither, as it sees no group prefix:

```
{ t: 'ring', call: <id>, ts, group: 'Family',
  with: [ {pub: bob, name: 'bob'}, {pub: carol, name: 'carol'}, {pub: dave, name: 'dave'} ] }
```

A pal is named as this device names them; somebody introduced, by the name the
caller gave.

**The caller** sees the grid at once, every invitee's tile already there:

```
+------------+------------+
|    bob     |   carol    |
| Ringing…   | Ringing…   |
+------------+------------+
|    dave    |    me      |
| Ringing…   |  (camera)  |
+------------+------------+
  [Mic] [Camera] [+] [Hang up]
```

**An invitee:**
- The worker's notification: *alice is calling — with carol, dave*.
- The *is calling* dialog lists everyone in the call: a name pill each, ✓ for a
  key compared, *introduced by alice* for somebody who is not their pal (E7).
  Then **Decline** or **Answer**.
- **Answer**: their device listens on the call's one channel and says *ready*
  to everybody. Each one already in the call offers to them. Their tiles go
  from *Connecting…* to video one at a time. They may see alice before carol;
  each tile says how it stands, so that is fine.

**What a tile shows:**

| State | The tile |
| --- | --- |
| Ringing, connecting | the name on their pill colour, *Ringing…* or *Connecting…* |
| In the call | their video, filling the tile; the name pill bottom left |
| Speaking | an outline (the audio level the browser reports) |
| Mic off | a mic-off mark |
| Camera off | their initials on their pill colour |
| Line dropped | greyed, *Reconnecting…* (that tile only) |
| Declined, busy, no answer | *Declined*, *On another call* or *No answer* for a few seconds, then **+ Add a pal** |
| Left | *Left* for a few seconds, then gone |

Mic off and camera off are said over each connection's data channel.

**Using it:**
- This device's tile stays bottom right, mirrored.
- **Tap a tile** to make it large, the others in a strip beneath; tap again
  for the grid. The one made large is sent a higher bitrate.
- **Long press a tile** for *Compare keys* (one key per pal) and *Make large*.
- **Mic, Camera, + and Hang up** under the grid; **+** is off at four.
- The screen stays on (Screen Wake Lock; Safari since 16.4).

**As people come and go:** four is the grid; three, the grid with **+ Add a
pal**; two, back to today's layout, the pal large and this device small in the
corner; one, the call ends with *everybody left*.

**Ending it:**
- **There is no host.** **Hang up** means *I leave*. If alice leaves, bob,
  carol and dave go on: in a mesh no server holds the call.
- **Ringing stops** with a *cancel* from the caller to whoever is still
  ringing when nobody answers. Otherwise a ring ends after the minute it has
  now, and is filed as missed.
- **Joining late.** A missed group call in the log offers **Join** for a
  while. **Join** listens on the call's channel and says *ready*. Anybody
  still in the call offers to them; when nobody does within 20 s, it says
  *the call is over*. Northern keeps no record of calls, so this is the only
  way to know.

**The log** has one entry in the group's log, not one per pal: *Call with
bob, carol, dave — 12 min*, or *Missed call from alice — with carol, dave*,
with **Join**.

**Two things to settle:**
- **E7** decides the grid. With *pals only*, bob would simply have no tile for
  carol, and the grid would differ from one device to the next. That is why
  *introduced by the caller* is recommended.
- **Who may add.** If anybody in the call can press **+**, the newcomer is
  *introduced by* whoever added them, not by alice. It works the same way;
  the tile names who added them.

### Video size in a call of four

Yes, the resolution is kept lower once there are more than two. It is the
cheapest thing that makes a call of four work, since every phone encodes its
video once per pal.

- **The camera is asked for once, at 720p** (`PalsCalls.CAMERA`). Then each
  connection gets its own size and bitrate, on its own video sender, while
  the call goes on - no new offer:
  ```js
  const p = sender.getParameters();
  p.encodings[0].scaleResolutionDownBy = 2;   // 720p capture -> 360p sent
  p.encodings[0].maxBitrate = 500000;         // 500 kbit/s
  p.encodings[0].maxFramerate = 24;
  sender.setParameters(p);
  ```
- **Each connection is on its own**, so the pal shown large can be sent more
  than the small tiles.
- **Smaller is cheaper to encode.** The cost goes with the pixels, so 360p is
  about a quarter of 720p, for each of the three encoders. That matters more
  than the bandwidth.

| In the call | Sent to each pal (`PalsCalls.videoFor`) | Each phone up / down |
| --- | --- | --- |
| Two | 720p, 1.5 Mbit/s, 30 fps | 1.5 / 1.5 Mbit/s |
| Three or four, the grid | 360p, 500 kbit/s, 24 fps | about 1.6 / 1.6 Mbit/s with four |
| Four, one made large | the large one 720p, 1.2 Mbit/s; the strip 180p, 150 kbit/s, 15 fps | depends on who is large |

- **360p is enough for a tile.** A tile in the grid is about 185 × 330 CSS
  pixels; a 360 × 640 portrait stream roughly fills it at 2× pixel density.
  On a 3× iPhone it is a little soft, which hardly shows at that size.
- **When it changes:** every time the number in the call changes. The third
  person coming in moves every connection to 360p; going back to two moves
  it back. **A tap on a tile** sends `size` over each data channel: *large*
  to the pal tapped, *small* to the others, and *grid* again on a second tap.
- **The browser still lowers it on its own** when the CPU or the line cannot
  keep up; the caps make that predictable. A browser that refuses
  `maxFramerate` is asked again without it, so the bitrate and size still
  hold.

### What a one-to-one call already has

- **The media is already encrypted from one browser to the other.** WebRTC
  encrypts it with DTLS-SRTP, with keys agreed between the two browsers. A
  TURN server relays packets it cannot read.
- **And the keys are the right ones.** Each side's DTLS fingerprint is in its
  SDP. The SDP travels sealed between the two pinned Northern keys (`signal`
  in `seal.js`). Northern cannot swap the fingerprint to put itself in the
  middle without breaking the seal.
- **So sealing every frame on top protects against nothing new** in a
  one-to-one call, or in a mesh, which is the same thing three times over.
  Neither layer protects against a server that changes the app it serves (*What
  this design trusts*): a changed `pals.js` can switch either off.
- **It matters once a media server is in the path.** An SFU (Cloudflare's
  Realtime SFU, or one at home, for calls of five or more) ends DTLS itself,
  so it sees every frame. Sealing the frames is then what keeps the video
  from the SFU.

### Sealing the frames: how it would be done

**Not the captured video: the encoded frames.** Sealing frames *before* the
encoder would leave nothing for it to compress, since ciphertext is noise. So
the seal goes between the encoder and the packetizer, on each encoded frame,
and is opened on the other side before the decoder:

```
camera -> encoder -> [seal in a worker] -> RTP, DTLS-SRTP -> ... -> [open in a worker] -> decoder -> video
```

| Option | Where it runs | Verdict |
| --- | --- | --- |
| **`RTCRtpScriptTransform`** (WebRTC Encoded Transform, the standard) | Chrome 141, Firefox 117, Safari 15.4 — every browser on iOS 15.4+; Baseline since October 2025 | **The one to use.** One worker script, for sending and receiving, in every browser |
| `createEncodedStreams()` (Chrome's older Insertable Streams) | Chrome 86+ only, with `encodedInsertableStreams: true` | Only as a fallback for Chrome before 141; probably not worth carrying |
| Safari's `SFrameTransform` (built-in SFrame, RFC 9605) | WebKit only | Not cross-browser |
| WebCodecs encoding, sealed, over a data channel | everywhere WebCodecs is | Rejected: it gives up what RTP does for a call — congestion control, jitter buffer, lip sync, loss recovery |

**The transform.** It is what `example/frames/frames.js` does to made-up
frames:
- **AES-128-GCM** with a counter IV, a key per direction. The codec's first
  bytes stay clear and are bound as additional data (VP8: 10 bytes on a key
  frame, 3 on others; Opus: 1). That is how WebRTC's own sample and Jitsi do
  it. A frame that will not open is dropped, and the decoder asks for a new
  key frame itself.
- **The keys come the way a photo's do.** A photo's `lock` travels inside the
  seal; here, the offer and the answer would each carry a random key for that
  direction, sealed with the SDP. That is no new key exchange, and a fresh
  key per call. The worker gets the `CryptoKey` through the transform's
  options; a key can be passed that way without being exportable.
- **VP8 and Opus, chosen with `setCodecPreferences`** (all browsers). With
  H.264 the packetizer reads NAL units out of the frame, and a sealed frame
  has none. Safari prefers H.264, and on an iPhone VP8 is encoded in software,
  which costs some battery.
- **Both ends must have it.** The offer would say it seals frames; a device
  without `RTCRtpScriptTransform` would say so in its answer. The call then
  either goes without or is refused (part of decision **E8**).

**What it costs — measured.** `node example/frames/frames.js` on this Pi 5
(Cortex-A76, 2.4 GHz, with AES instructions), Node 24's WebCrypto. Ten
seconds of a call: 30 video frames a second with a key frame every 3 s, and
50 Opus frames. Each frame is sealed, and opened on the way back, one at a
time as a transform stream hands them over. Two runs:

| Call | Frames sealed and opened | Time a frame | Share of one core |
| --- | --- | --- | --- |
| One to one, 600 kbit/s | 1,600 | 68–100 µs | 1.1–1.6 % |
| One to one, 1,500 kbit/s | 1,600 | 61–72 µs | 1.0–1.2 % |
| Four in a mesh, 600 kbit/s | 4,800 | 52–57 µs | 2.5–2.7 % |
| Four in a mesh, 1,500 kbit/s | 4,800 | 53–55 µs | 2.5 % |

- **The cost is per frame, not per byte.** A frame 2.5 times larger costs no
  more; nearly all the time is the asynchronous WebCrypto call. The slowest
  single frame took 1–5.5 ms, still inside the 33 ms between video frames.
- **Next to the encoder it is nothing.** Encoding a 360p video in software
  alone takes a good part of a core.
- **The bytes: +17.9 kbit/s per stream** (a 12-byte IV and a 16-byte tag on
  each of 80 frames a second). Video hardly notices (~1 % of 600 kbit/s). For
  audio, 11 kbit/s on 32 is a third more. Sending a 4-byte counter in place of
  the IV brings it to 12.8 kbit/s in all.
- **On a phone it is not measured yet.** `example/frames/frames.html` runs
  the same thing in a worker, which is where a transform runs. Open it on the
  main host name, not `pals.`: there `example/` is served sandboxed and runs no
  script. It prints the browser and the same lines.

### Built: calls of three and four (version 20)

- **`conference.js`, new** (`PalsConference`): the mesh, with no DOM and no
  network, as `call.js` is. One `PalsCall` per pal in the call; who offers
  (above); everybody's status (*calling, ringing, waiting, connecting,
  connected, reconnecting*, then *declined, busy, no answer, left, away,
  failed*); the data channel's messages (`with`, `mic`, `camera`, `size`);
  the sizes; and when the call is over. A call of two is now a conference of
  one other, and goes as it did.
- **`call.js`**: `video(encoding)` sets the video sender's size, now and once
  connected; `say(text)` sends over the data channel, held until it opens;
  `on.message` hears anything but `bye`.
- **`calls.js`**: the ring's `with` (two others at most, each a valid key and
  a name) and `group`, checked like everything else; `names`, `videoFor`,
  `CAMERA`, `MAX` (4).
- **`pals.js`**:
  - **Call** in a group's Messages layer when it has members. With more than
    three, a picker (`dlg_pick`) takes up to three first.
  - The ring goes to each, sealed, naming the others. The channel is shared,
    and signals are told apart by sender and id, since each sender numbers
    their own.
  - Four fixed tiles (`tile_1`–`tile_3`, `tile_self`) and **+ Add a pal**.
    Tiles are placed as people come, and a tile says why someone went for 4
    seconds before it is freed.
  - Tap to make large; **Key** on each tile; **Mic**, **Camera** and **+**
    under the call.
  - Who is speaking comes from `getSynchronizationSources()`, twice a second.
  - The screen is kept on (Screen Wake Lock), and asked again when the page
    comes back.
- **E7 as recommended: introduced by the caller.** Somebody who is not a pal
  is in the call as introduced by whoever rang them or added them, says so on
  the tile and in the *is calling* dialog, has no **Key**, and is never made a
  pal.
- **`+` works for anybody in the call.** Their new ring names everybody in it,
  and everybody connected is told over the data channel, so the newcomer is
  *introduced by* whoever added them.
- **The worker** says *alice is calling - with carol and dave*.
- **The caller's ringing stops** (`cancel`) for whoever never answered,
  when the caller gives up or hangs up; a decline ends only that person.
- `PALS_VERSION` is 20, with every `?v=` in both pages.

**Not built yet:**
- **Join** on a missed group call, while it is still going.
- **One log entry per call** (*Call with bob, carol, dave — 12 min*). A missed
  call is still filed per caller, as before.
- **Frame sealing**, which stays tied to an SFU (E8).

**Next steps:**
1. A live check of a call of three on real phones; see *Not verified*.
2. Join, and the one log entry per call.
3. **Frame sealing only with an SFU.** If calls of five or more are wanted,
   build the SFU and frame sealing together. Do not build frame sealing for
   one-to-one calls on their own (E8).

## Before it goes live

1. **Fixed — the database could be downloaded.**
   `Render.renderFromFS` joins the request path without checking it, so
   `GET /fs/get/../../../abcd.db`, sent raw (a browser tidies `..` away; curl
   with `--path-as-is` does not), returns the whole SQLite file.
   - Measured on a throwaway instance: the response holds the file, and the
     VAPID private key with it. Whoever has that key can push to every Pals
     device as the server. Under Update 1 they could also have opened any
     sealed message they came by; since Update 2 the key opens nothing.
   - This was REFACTORING.md #1. `Render.fileUnder` now confines `/fs/get/`,
     `/static/` and `/mp4/get/` to their folders and answers 404 otherwise.
   - On the public host name Cloudflare already refused `..` paths. The
     server's own ports were open to anybody who could reach them. If they
     could be reached from outside, assume the VAPID key was seen: replace it
     (delete the `/push/api/config` row and restart) and run *set up this
     device again* on every device.
2. **A session cookie never expires on the server.** `verifySsid` checks the
   signature, not the timestamp. Since Update 2 a copied `ssid` reads nothing;
   it can still send through `/push/api/send` as its owner, though what it
   sends opens for nobody without the owner's key. Checking the age (a day, as
   `session.js` mints it) would be a one-line change to `PushApi.session`.
3. **The kept key outlives the cookie.** Pals keeps working on a device after
   the cookie expires: the service worker still opens what arrives, though
   since Update 4 the page itself goes to sign in. On a shared device, signing out must call
   `session.forget()` on the `pals.` host, or the key stays. Pals has no
   *Sign out* of its own yet; `Logout.html` only clears the cookie.
4. **Anybody signed in can message anybody listed.** Anyone can register a key,
   and `/pals/` is public, so a stranger can push to every listed device. The
   receiver files the message - it opens, with the stranger's key - and names
   the stranger from the directory. The
   options are to drop messages from non-pals, to rate-limit `send`, or both.
5. **Subscriptions are public.** A subscription is useless without the
   server's VAPID key, but the directory reveals which push service each user
   uses, and when they set up.
6. **One device per user.** The newest row per key wins, so a second device
   takes over from the first. A row per device (`/pals/<name>/<key>/<device>`)
   would fix that. Each send would then go to every device; each device holds
   the same key once the ID Card is loaded there.
7. **The `Origin` check assumes no proxy rewrites `Host`.** Behind one, set
   `Host` through, or relax the check.
8. **A direct message that starts with `[something] `** is filed by the
   receiver as a group message. This follows from carrying the group in the
   text, as Update 1 does.
9. **No forward secrecy, and the app's code comes from the server.** Both are
   accepted with the design (see *What this design trusts* and the Update 2
   review).

## Not verified

Headless Chromium cannot load pages from where this was built (see memory).
Until somebody opens the app in a browser, these are untested:
- layout and the `<dialog>` overlays;
- service worker registration;
- `pushManager.subscribe` with the server's key;
- a real push from FCM, Mozilla, Apple or WNS reaching the worker (done for
  Update 1 on Android and ChromeOS, by hand; not yet for Update 2);
- `reg/keystore.js` keeping the key in a real browser, and the worker using
  it with no page open;
- iOS's Home Screen requirement;
- for UPDATE_10, nothing was tried on a real call:
  - three encoders and decoders at once on a phone;
  - an iPhone playing three pals' videos with sound (WebKit allows audible
    autoplay while the page is using the camera, which a call always is; not
    tried);
  - `setParameters` sizes and bitrates as each browser takes them, before and
    after connecting;
  - the grid at 375–390 px wide, and landscape;
  - Screen Wake Lock;
  - the audio levels behind *speaking*;
  - VP8 on an iPhone's battery, and `example/frames/frames.html` on a phone.

Everything around those is tested: the RFC 8291 encryption against the RFC's
own vector and a WebCrypto decryption, the VAPID token against a verifier, and
the page and worker against stubs. **First live check:**
1. Restart Northern, and on each device load the ID Card through Pals'
   sign-in link, so the key is kept on that device.
2. Reload Pals (DevTools → Cache storage shows `pals-v4`); IndexedDB →
   `northern` → `keys` holds one record per identity, its `key` marked
   *extractable: false*.
3. Send a message each way; the notification names the sender.
4. Send a 2,500-character message, and send to a group.
5. Compare keys with a pal under *Key*, and mark them verified.

## Decisions that are still yours

| | Decision | Recommended |
| --- | --- | --- |
| **E1** | ~~Fix the path traversal (item 1)~~ | Done |
| **E2** | What to do with messages from people who are not pals (item 3) | File them, as now, but add a *block* later; rate-limit `send` per sender |
| **E3** | One device per user, or several (item 5) | Several, once the first device works |
| **E4** | Check the `ssid` age in the push API (item 2) | Yes, one day |
| **E6** | A *Sign out* in Pals that forgets the kept key (item 3) | Yes, before a shared device uses Pals |
| **E5** | The VAPID `subject`: set one in the config row, a `mailto:` or the site's URL | Set it; Apple rejects tokens whose `sub` it cannot use |
| **E7** | In a call of four, whom a device connects to: its own pals only, or also those the caller introduces (UPDATE_10) | Introduced by the caller, for that call only, marked on the tile |
| **E8** | Seal every frame of a call, on top of DTLS-SRTP (UPDATE_10) | Not for one-to-one or mesh calls; together with an SFU, if calls of five or more are ever built |

Update 1 settled the old D1 (nothing stored on the server), D2 (the `pals.`
host), D4 (V1) and D6 (no invite link). The old D5 (shared groups) became the
prefix scheme. Update 2 settled D3: the key is kept non-extractable (K2 of the
evaluation, limited to ECDH), and the browsers seal.

---

## Testing

| File | Tests | Covers |
| --- | --- | --- |
| `tests/pals.test.js` | 97 | the model (directory, splitting, prefix, compose and pushes, reassembly, the log, storage, the verified mark); **the seal** (round trip; refusal for the wrong receiver, a relabelled sender, a reflected message, a moved part, a changed byte; the key not extractable and unable to sign; fingerprints); the views; the shell (both pages, cached files, `sw.js` in a stubbed worker opening with the kept key and asking the server nothing); `pals.js` and `welcome.js` with the real identity scripts, an in-memory IndexedDB and real WebCrypto: sealing to the pinned key, opening in the page, the notice when the ID Card is not on the device, comparing keys; the premises below, with a directory round trip on a real server |
| `tests/palsConference.test.js` | 15 | UPDATE_10: the ring's `with` and `group`, and what is refused; names; the video sizes; the worker naming who else is in a call; then three, four and five devices on one fake network: everybody rung and told who else is in it, six and twelve connections with the smaller key offering, the grid, tap to make large (sizes per connection), mic and camera, one leaving and the last, somebody introduced, the picker of three, one added in the middle of a call of two, a decline and no answer |
| `tests/PushApi.test.js` | 21 | RFC 8291 byte for byte against Appendix A, and opened by WebCrypto; the VAPID token; the provider list (with the page agreeing); then through `Server.js` on a throwaway DB: the config row made, kept and unreadable, one written by somebody else refused, every refusal of `send`, the exact payload limit and the largest part the page makes, a full round trip of a browser-sealed message (the payload strict UTF-8, `from` taken from the cookie, the seal untouched, and opening only for bob), no `/push/api/open`, the push service's answers, the database file out of reach, and the `pals.` host guard |

`tests/browserIdentity.test.js` also pins the new J6: only `reg/keystore.js`
imports a private key, non-extractable, for `deriveBits` only, and never
exports it.

The full suite has 1,388 tests (as of version 20). The ones that fail were
failing before this change: 98 in `bandage.test.js`, one flaky test in
`grinder.test.js` (it passes on some runs), and `browserIdentity.test.js`, which flags
`example/OpenChannel/msg.html` for rebuilding the SJCL key from
`localStorage.priv`. The example is reference material and was left as it
came. On the `pals.` host it is now sandboxed.

---

## Appendix — the evaluation before Update 1

Update 1 chose option **1b** below with a server-held VAPID key (V1) and
server-side sealing, which avoided the key-custody question. These were the
measurements the evaluation rested on. They still hold, and the premise tests
still pin them.

### What was measured

Findings 1–4 are about keys, 5–9 about Northern, 10–13 about the browser.

1. **The Northern key is a VAPID key.** Same curve (P-256), same signature
   (ES256). The 64-byte public key Northern stores is the 65-byte
   `applicationServerKey` with its leading `0x04` taken off. A JWT signed with
   a Northern key — by SJCL or by WebCrypto — verifies the way a push service
   verifies it.
2. **WebCrypto and SJCL agree.** A signature made by either verifies in the
   other, and an `ssid` cookie minted by WebCrypto passes `Crypto.verifySsid`
   on the server. So nothing forces the private key to stay in SJCL's format.
3. **RFC 8291 is forty lines of WebCrypto.** The encryption Web Push uses for
   its payload — ephemeral ECDH, HKDF-SHA256, AES-128-GCM — opens the RFC's own
   test vector, and seals a message to a Northern key at a cost of 103 bytes.
   No library is needed for "the same mechanism VAPID uses".
4. **There is no private key in the page.** This is Northern working as
   designed (FEATURES J6, J7): the key lives in a closure in `session.js` on
   the page where the ID Card was loaded, and is gone by the time `Reg.html`
   has forwarded to Pals. What survives is a cookie. `session.js` also exposes
   no `sign`, and `tests/browserIdentity.test.js` holds every page to signing
   through the session. Both options needed to sign and to decrypt in the
   page; Update 1 moved both to the server instead.
5. **`/sub/` is open in both directions.** Anybody can listen with no session.
   Anybody with *any* `ssid` cookie — a made-up one included — can publish.
   A message on it proves nothing unless it is signed and hides nothing unless
   it is sealed.
6. **`/sub/` cannot say whether anybody heard.** The answer to a `PUT` is
   `{"clients": n}`, where `n` counts channels on the server, not listeners on
   this one. Delivery needs an acknowledgement from the receiver.
7. **A line break splits an event.** `sendSSE` writes the body after `data: `
   as it came; an `EventSource` then reads the second line as a field name and
   hands the page only the first. Payloads must be one line.
8. **Northern never forgets.** There is no `DELETE` — the verb falls through
   to a read and returns the row. Overwriting with `PUT` copies the old value
   to `<path>/<n>`, where it can still be read. A row written under the
   `public` author can be overwritten by anybody. And a request body has no
   size limit: 2 MB was accepted.
9. **A group row is guarded by its name.** `?isGroup=<name>` on a read is the
   whole check, with no session needed — a bearer secret that travels in the
   URL. A search under it lists the `author` of every row, which for a mailbox
   is the key of every sender.
10. **A service worker registration holds one push subscription**, bound to
    one `applicationServerKey`. Subscribing again with another key is an
    error. This is the platform's rule, not measured here.
11. **A service worker has no `localStorage`, and is stopped when idle** — so
    it cannot keep an `EventSource` open. Whatever it must read or write — the
    pals list to name a sender, a message that arrives in a push — has to be
    in IndexedDB. Also the platform's rule, not measured here.
12. **Somebody has to call the push service, and it is not the browser.** FCM,
    Mozilla, Apple and WNS are built for servers and are not expected to
    answer a page's cross-origin request. Northern made no outbound call
    before this change (`httpClient.js` is unused, `GET`-only and plain
    HTTP); `PushApi.js` is that new server code.
13. **Six connections per origin.** Northern speaks HTTP/1.1, where a browser
    allows six connections to one host, across all tabs, and an `EventSource`
    holds one. So the design is one inbound channel per user — never one per
    pal.

### Side by side

| | Option 1 | Option 1b | Option 2 |
| --- | --- | --- | --- |
| Reaches a pal whose app is closed | no — both online at once | yes, while the push service holds it | yes |
| Stored on Northern | nothing | nothing | ciphertext, until deleted |
| Stored elsewhere | nothing | ciphertext at the push service, briefly | nothing |
| Server work | relay | relay | relay + mailbox namespace + `DELETE` + limits |
| Message size | unlimited | 3993 bytes (1000 characters per part, per Update 1) | whatever the cap is set to |
| Groups | online members only | yes | yes |
| Several devices | whoever is listening | every subscribed device | yes, with a box per device |
| Works with no push permission | yes, when both are in the app | no | yes, on the next visit |
| Northern learns | who is online; sealed traffic per channel | who pushes to which endpoint | the same, plus a durable mailbox |
| What goes wrong | messages wait, silently, for an overlap | a push is dropped (the sender sees *not delivered* only when the push service refuses it outright) | rows pile up if nobody deletes |
