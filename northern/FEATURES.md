# Northern — implemented features

Inventory produced by reading `src/h2t` (the Node server) and `src/fs` (the
browser side served off the file system). Every entry names the code that
implements it and the test that covers it.

Server code is ~800 lines across 8 modules:

| Module | Lines | Role |
| --- | --- | --- |
| `src/h2t/Cluster.js` | 18 | process entry point |
| `src/h2t/Server.js` | 157 | HTTP/HTTPS listeners, routing, session handling |
| `src/h2t/Render.js` | 227 | response rendering, content types, file system serving, SSE |
| `src/h2t/SqliteDB.js` | 207 | key/value storage on SQLite |
| `src/h2t/Crypto.js` | 43 | ECDSA session verification |
| `src/h2t/Cookie.js` | 25 | cookie header parsing |
| `src/h2t/httpClient.js` | 36 | outbound HTTP — no longer called by the server |
| `src/h2t/sjclClass.js` | 110 | vendored SJCL crypto library |

---

## A. Process and listeners

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| A1 | Entry point starts one node on port 9090 against `abcd.db` (two more are commented out) | `Cluster.js:4` | — |
| A2 | Every node listens on plain HTTP *and* HTTPS (9443 by default), sharing one request handler and the `server.key`/`server.crt` pair | `Server.js:144-152` | `Server.test.js` › Server listeners |

## B. Request routing

The whole API is "the URL path is the key, the request body is the value".

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| B1 | `GET /` redirects to `/fs/get/home.html` (unless a `?search` is present) | `Server.js:103-106` | `Server.test.js` › GET / |
| B2 | Write requests without an `ssid` cookie are redirected to `/fs/get/reg/Reg.html#<path>`; the registration pages themselves are exempt so a new user can sign up | `Server.js:109-112` | `Server.test.js` › registration gate |
| B3 | `POST` creates, `PUT` updates; the body is buffered and dispatched on `end` | `Server.js:34-71, 118-122` | `Server.test.js` › POST then GET a key, PUT a key |
| B5 | `GET /sub/<key>` opens a server-sent-event subscription | `Server.js:124-125` | `Server.test.js` › SSE pub/sub |
| B6 | `GET /fs/get/<path>` serves files from `src/fs` | `Server.js:126-127`, `Render.js:44` | `Render.test.js`, `Server.test.js` › file system namespace |
| B7 | `GET /static/<path>` serves files from `src/static` | `Server.js:128-129`, `Render.js:53` | same |
| B8 | `GET /mp4/get/<path>` streams video with HTTP range support | `Server.js:130-131`, `Render.js:67` | `Render.test.js` › renderMP4 |
| B9 | Any other `GET` is a database read or search | `Server.js:132-134`, `Render.js:8` | `Render.test.js` › render query dispatch, `Server.test.js` › search over HTTP |
| B10 | Synchronous handler errors are caught and returned as a JSON body | `Server.js:136-140` | `Server.test.js` › answers a missing file with a JSON error |

B4 was `GET /db/insert?path=&type=&value=`, the replica ingest endpoint. It has
been removed: it was an unauthenticated write over `GET` — the session gate in
`Server.js:109` only applies to `POST`/`PUT` — serving a replication feature
that does not work (REFACTORING #9). The numbering is left as it was so the
other entries keep their identity.

## C. Content types

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| C1 | The type is the file extension of the key, defaulting to `txt` | `Render.js:120` | `Render.test.js` › getType |
| C2 | `html`, `md`, `txt`, `tsv`, `xml`, `json`, `js`, `css`, `png`, `jpg`, `jpeg`, `zip` and `counter` each get their own `Content-Type`; anything else is dumped as JSON | `Render.js:172-226` | `Render.test.js` › renderData content types |
| C3 | `mp3`/`m4a` are streamed off disk with a `Content-Length` | `Render.js:194-203` | same |
| C4 | Because the type follows the key, a stored value can be an HTML page, a stylesheet or a script — the database doubles as a web server | `Render.js:172` | `Server.test.js` › derives the content type from the key extension |

## D. Storage (SQLite)

Single table `abcd (path, type, value, counter, author, public)` with a unique
index on `path`.

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| D1 | Schema and unique index are created on start-up if missing | `SqliteDB.js:12-13` | `SqliteDB.test.js` › schema |
| D2 | **Auto-versioning**: re-posting an existing key does not overwrite it. The unique-index violation is caught, the new value is written to `<path>/<counter>`, and the original row's counter is bumped. The original key keeps the first value; each later write lands on the next numbered key | `SqliteDB.js:26-49` | `SqliteDB.test.js` › insert versioning, `Server.test.js` › versioning over HTTP |
| D3 | `PUT` updates value, type and group in place, but only for the row's author (or rows authored by `public`) | `SqliteDB.js:60-74` | `SqliteDB.test.js` › update |
| D4 | Reads are access-controlled: a row is visible to its author, to everybody when its group is `public`, or to the group named in the request | `SqliteDB.js:133` | `SqliteDB.test.js` › access control |
| D5 | `?search=<pattern>` — prefix/LIKE search returning keys and metadata but not values, newest path first, 100 per page | `SqliteDB.js:147`, `Render.js:11` | `SqliteDB.test.js` › search modes |
| D6 | `?searchPlus=<pattern>` — the same, with values included | `SqliteDB.js:165` | same |
| D7 | `?keyword=<pattern>` — full-value search inside a key prefix | `SqliteDB.js:185` | same |
| D8 | `?offset=` pages through results | `Render.js:12-15` | same |
| D9 | Missing keys answer `{unavailable, author}` rather than an error | `SqliteDB.js:140` | same |
| D10 | Counters: `PUT /metrics/counter/...` increments a row and flags its type as `counter`, which is then served as a bare number. The first PUT creates the row already counting itself, filed under the caller's author and group | `Server.js:59-62`, `SqliteDB.js:76-128` | `SqliteDB.test.js` › increment, `Server.test.js` › metrics counters |

D11 was replica fan-out over HTTP to a `replicaSet` read from the `/info` key.
It never worked — the call site was commented out and the code referenced
variables that were not in scope — and has been removed along with the `/info`
start-up read (REFACTORING #9). The module is now `src/h2t/SqliteDB.js`.

## E. Publish / subscribe (server-sent events)

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| E1 | `GET /sub/<key>` registers a subscriber under `<key>` and immediately sends `{"status":"OK"}` | `Render.js:134-165` | `Server.test.js` › SSE pub/sub |
| E2 | `PUT /sub/<key>` broadcasts the body to every subscriber of that key without storing anything | `Server.js:53-58` | same |
| E3 | A `PUT` to an ordinary key also broadcasts to anyone subscribed to it, so stored values can be watched live | `Server.js:65-67` | same |
| E4 | Subscribers are dropped when their connection closes | `Render.js:156-162` | `Render.test.js` › renderSub |

## F. Identity and authentication

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| F1 | The `ssid` cookie is parsed out of the `Cookie` header | `Cookie.js:4` | `Cookie.test.js` |
| F2 | An ssid is `<public key>.<timestamp>.<signature>` — an ECDSA P-256 signature over `sha256(pubkey.timestamp)`, verified with the vendored SJCL. Keys are generated in the browser, never leave it, and are never stored by it (see J6) | `Crypto.js:9-41`, `src/fs/reg/*` | `Crypto.test.js` |
| F3 | The verified public key *is* the author identity; an absent or invalid signature falls back to the shared author `public` | `Server.js:80-96` | `Crypto.test.js`, `Server.test.js` › files anonymous writes under the public author |
| F4 | Writes are scoped: private to the author by default, `?isPublic=true` for everybody, `?isGroup=<name>` for a named group | `Server.js:87-92` | `Server.test.js` › group scoping |
| F5 | An RSA branch for Windows Hello — present but dead code | `Crypto.js:35-40` | `Crypto.test.js` (todo) |

## G. ActivityPub-flavoured `/pub/` namespace

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| G1 | `POST /pub/...` with a `"type":"Delete"` activity is acknowledged with `{status:'OK'}` and deliberately not stored; every other activity is stored normally | `Server.js:39-46` | `Server.test.js` › /pub/ namespace |

## H. Outbound HTTP

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| H1 | `HttpClient.execute(options, cb)` issues a request and hands the parsed JSON back to a callback | `httpClient.js:7` | `httpClient.test.js` |

## I. Browser-side applications (served from `src/fs`, no server code)

Not covered by the test suite — these are DOM programs with no module
boundaries, and testing them would need a browser harness (see REFACTORING #14).

| # | Feature | Code |
| --- | --- | --- |
| I1 | Console + editor: a command line (`get`, `put`, `put2`, `post`, `search`, `match`, `last`, `open`, `eval`, `llm`, `llmo`, `s`) over the Fetch API, with a two-pane editor, an on-screen keyboard and Ctrl+Enter execution | `fs/keyboard.html`, `fs/js/cli_v2.js`, `fs/js/keyboard.js`, `fs/js/keyboard-helper.js` |
| I2 | Registration and sign-in: generates the ECDSA key pair, stores it locally with the user name, builds the `ssid` cookie, registers the ID Card, and downloads it as a file — optionally AES-256 encrypted under a passphrase (see J below) | `fs/reg/Reg.html`, `fs/reg/idcard.js`, `fs/reg/oo.js`, `fs/Signin.html`, `fs/Logout.html` |
| I3 | Admin console, sharing pages, home page, manifesto, RSS feed | `fs/AdminConsole.html`, `fs/Share.html`, `fs/Shared.html`, `fs/home.html`, `fs/rss.xml` |
| I4 | PWAs backed by the SSE pub/sub: `lol` (multiplayer map game with bots), `rummy`, `joint` — each with a manifest, service worker and offline page | `fs/pwa/lol/*`, `fs/pwa/rummy/*`, `fs/pwa/joint/*` |
| I5 | Music and game pages: chord player, musical grids, go board, tonal.js, audio samples | `fs/games/*`, `fs/simon/*` |
| I6 | Diagnostics page | `fs/diagnostics/tests.html` |

---

## J. The ID Card (browser side, `src/fs/reg`)

The identity a user carries between devices. Held in `localStorage`, registered
in the database as a public record, and saved to a file the user keeps.

| # | Feature | Code | Tests |
| --- | --- | --- | --- |
| J1 | The card holds the user name alongside the key pair, in local storage (`pub`, `pub_name` — never `priv`, see J6) and in the file. A visitor who types no name is stored, registered and named in the file as `UNKNOWN`; an unnamed v1 card keeps the stored name only when it belongs to that same public key | `reg/idcard.js:26-46`, `reg/Reg.html` | `idcard.test.js`, `Reg.test.js` › user name |
| J2 | Registering posts only the public half — `{pub, pub_name}` — to `/id/<ts>/<pub>.json?isPublic=true`. The private key never leaves the device | `reg/idcard.js:publicRecord`, `reg/Reg.html:saveIdCard` | `idcard.test.js` › publicRecord, `Reg.test.js` › never sends the private key |
| J3 | The downloaded file is named after the user: `alice.20260814T103000.id.txt` | `reg/idcard.js:fileName` | `idcard.test.js` › fileName, `Reg.test.js` › download |
| J4 | An optional passphrase encrypts the file with AES-256-CBC, keyed by PBKDF2-SHA256 through `oo.js`. The file name is marked with `*`: `alice*.20260814T103000.id.txt`. The passphrase is typed twice, and the encrypted file is decrypted once before it is handed over, so an unreadable card cannot be produced | `reg/idcard.js:encrypt,toFile`, `reg/oo.js:idme` | `idcard.test.js` › encryption, `Reg.test.js` › passphrase |
| J6 | **The private key is never stored.** It lives in a closure inside `session.js` for the life of the page and nowhere else; local storage holds only `pub` and `pub_name`. A key left in local storage by an earlier version is taken into memory and scrubbed the first time `session.js` loads | `reg/session.js` | `browserIdentity.test.js`, `Reg.test.js` › the private key never reaches local storage |
| J7 | Because the key is not stored, a page can only mint a cookie while an ID Card is loaded. The cookie lasts a day; when it expires the user loads their ID Card again. `A.html` and `Remote.html` ride on the live cookie and redirect to `Reg.html` when there is none | `reg/session.js`, `reg/A.html`, `reg/Remote.html` | `browserIdentity.test.js` › reg/A.html, reg/Remote.html |
| J8 | A newly generated identity exists only in the page until its ID Card is downloaded, so `Save Id Card & Continue` is the only way on from a first visit and the page warns before it is left | `reg/Reg.html` | `Reg.test.js` › first visit |
| J9 | Reg.html is one page of three sections under a single `pub.head2toes.org` banner: a read-only, full-width **message board** carrying everything the page has to say; **Sign in**, with its own optional passphrase and one `Load Id Card & Continue` control; and **Reg**, with the user name, the passphrase typed twice, the generated public key in a read-only field, and `Save Id Card & Continue`. Each button carries the visitor on to the fragment path. The Sign in section also carries a `Continue as <name>` button for a visitor whose session cookie is still live, since they need no file; it stays hidden while a freshly generated identity is unsaved, when leaving would lose the key (J8) | `reg/Reg.html`, `reg/style.css` | `Reg.test.js` › layout, returning visitor |
| J10 | The Reg section drafts a key pair on every visit and offers its public half, so `Save Id Card & Continue` always has something to write — a live session cookie is not a loaded key, and before this the button failed for anyone signed in without their card. The draft belongs to nobody until the card is built: saving it downloads the card, makes the pair this browser's identity, re-signs the cookie and registers it, replacing whoever was signed in (whose own ID Card file still opens). With a card loaded, Save saves that card instead | `reg/session.js:draft,adopt`, `reg/Reg.html:currentDraft,currentIdCard` | `Reg.test.js` › saving without a card loaded |
| J5 | Uploading accepts all three formats — encrypted envelope, plain v2 JSON, and the original v1 `<pub>.<priv>` — restores the user name, and mints a fresh session cookie. A bad file or wrong passphrase is reported without disturbing the stored identity | `reg/idcard.js:open,parse`, `reg/Reg.html` | `idcard.test.js` › open, `Reg.test.js` › upload |

File formats:

```
v1  <pub>.<priv>
v2  {"v":2,"username":"alice","pub":"<base64>","priv":"<base64>"}
v2* {"v":2,"enc":"AES-256-CBC","kdf":"PBKDF2-SHA256-1000","ct":"<base64>"}
```

Where the identity lives:

```
the ID Card file  the private key, kept by the user
the page          the private key while a card is loaded (session.js closure)
local storage     pub, pub_name — never the private key
the cookie        <pub>.<timestamp>.<signature>, one day
the database      {pub, pub_name} at /id/<ts>/<pub>.json
```

## Test suite

`npm test` (`node --test`) — 257 tests over 10 files:

| File | Covers |
| --- | --- |
| `tests/Cookie.test.js` | F1 |
| `tests/Crypto.test.js` | F2, F3, F5 |
| `tests/Render.test.js` | B6–B9, C1–C4, E1, E4 |
| `tests/SqliteDB.test.js` | D1–D10 |
| `tests/httpClient.test.js` | H1 |
| `tests/Server.test.js` | A2, B1–B10, D2, D10, E1–E3, F3, F4, G1 |
| `tests/idcard.test.js` | J1–J5 (the ID Card format, in isolation) |
| `tests/Reg.test.js` | J1–J10 through the real `Reg.html`, loaded into a DOM stub |
| `tests/Signin.test.js` | J5–J6 through the real `Signin.html` |
| `tests/browserIdentity.test.js` | J6–J7: the no-stored-key invariant across every file in `src/fs`, plus `A.html` and `Remote.html` |
| `tests/Example.test.js` | pre-existing placeholder, tests a function defined inside itself |

The four remaining `todo` tests describe behaviour the code is meant to have but
does not, and each names the entry in `REFACTORING.md` that explains why
(#1 path traversal, #4 silent writes, #8 the dead RSA branch).
