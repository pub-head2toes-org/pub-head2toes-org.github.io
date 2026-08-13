# Northern — refactoring and improvement list

Findings from the code review that produced `FEATURES.md`, ordered by how much
damage they can do. Each numbered entry is referenced from the test that
documents it, where one exists.

Verified against the running code. **#3 and #6 — the two ways a single request
could kill the server — have been fixed, and #9's dead replication code has been
removed**; those entries record what was done. Everything else is still open.

---

## Correctness and security — fix first

### 1. Arbitrary file read through the file-system namespace
`Render.renderFromFS`, `renderStatic` and `renderMP4` paste the request path
straight into `path.join` with no normalisation check
(`Render.js:44-58, 67-68`):

```
GET /fs/get/../../package.json   ->  serves <repo>/package.json
GET /fs/get/../../../etc/passwd  ->  serves /etc/passwd
```

Everything the server process can read is reachable, including `server.key` and
the SQLite file. `renderMP4` is worse: it resolves against the *parent of the
repository* (`__dirname + "/../../../"`), so its root is outside the project
altogether.

**Fix**: resolve the path, then verify it is still inside the intended root:

```js
const root = path.resolve(__dirname, '..', 'fs');
const file = path.resolve(root, '.' + path.normalize(suffix));
if (!file.startsWith(root + path.sep)) { /* 403 */ }
```

Covered by a `todo` test in `tests/Render.test.js`.

### 2. On a fresh database the unique index is never created
The constructor fires two `db.run` calls back to back
(`SqliteDB.js:12-13`). `sqlite3` runs statements on one connection
in *parallel* mode by default, so `CREATE UNIQUE INDEX` reaches SQLite before
`CREATE TABLE` has committed and fails with `no such table: main.abcd` — the
error is discarded, because neither call passes a callback.

The consequence is not cosmetic: **auto-versioning (D2) is driven by the unique
constraint**, so on a database created by this code, re-posting a key silently
appends a second row with the same path instead of versioning, and `get`
returns whichever row SQLite picks. The production `abcd.db` does have the
index, so this only bites on new deployments — and it is why every test seeds
the schema itself (`tests/helpers/db.js`).

**Fix**: wrap start-up DDL in `db.serialize()` (or chain the callbacks) and log
failures. Consider `db.exec()` with both statements in one script.

### 3. Two endpoints crash the process — **FIXED**
`SqliteDB.insert` took `(path, type, value, author, group, cb)`, but two call
sites passed fewer arguments, so `cb` landed on `author` and the real callback
was `undefined`. The `cb(result)` then threw a `TypeError` from inside a sqlite3
callback — asynchronously, outside every `try/catch`, so it took the whole
server down:

* `SqliteDB.js:96,103` (before the fix) — `increment()` on a path that did not exist
  yet, i.e. the first ever `PUT /metrics/counter/<new>`.
* `Server.js:125` — `GET /db/insert?...`, the replica ingest endpoint, always.

**Fixed by**:

* `increment(path, author, group, cb)` now takes the caller's identity, so a new
  counter row can be filed under a real author, and reports errors through `cb`
  instead of falling into `insert`.
* A new `createCounter()` writes the row directly at `counter = 1`, so the first
  `PUT` counts. It deliberately does not go through `insert()`, whose duplicate
  key fallback is the versioning scheme and would be wrong for a counter. If two
  first-increments race, the loser retries as an update rather than erroring.
* `GET /db/insert` has been **removed** rather than repaired — see below.
* `Cluster.js` installs `uncaughtException`/`unhandledRejection` handlers, so
  the next async throw of this class costs one request rather than the node.
  Note this is a net, not a cure: the process continues in an unknown state, so
  the logs it writes need watching.

The previously `skip`ped tests are enabled and cover both paths, including
concurrent first increments and "the node is still serving afterwards".

**`GET /db/insert` was deleted.** Fixing the crash would have turned it into a
working unauthenticated write to any key: it is served from the `GET` branch, so
the "must be registered" gate in `Server.js:109` — which only guards `POST` and
`PUT` — never applied to it. Its only purpose was to receive replica writes, and
replication does not work at all (#9). The path now falls through to the
ordinary read handler, so `GET /db/insert` reads a key of that name and writes
nothing.

If replication is ever implemented, the ingest endpoint should come back as a
`POST` behind the session check plus an allow-list of replica hosts, not as a
side effect of a `GET`.

### 4. Writes are fire-and-forget: `PUT` never reports success or failure
`SqliteDB.update` returns the result object from inside the `db.serialize`
callback, not from the method, so it always returns `undefined`
(`SqliteDB.js:60-74`). `Server.js:64-68` then serialises that into
an empty 200. Errors from `stmt.run` are never inspected either — an update that
matches no row, or that is rejected by the author check, looks identical to a
successful one.

**Fix**: give `update` a callback (or return a promise) like `insert` has, pass
the `stmt.run` error through, and answer with the row count.

Covered by `todo` tests in `tests/SqliteDB.test.js` and
`tests/Server.test.js`.

### 5. The `public` author is both "anonymous" and "everyone"
Unauthenticated writes are filed under the author `public`
(`Server.js:82`), and the ACL grants access when `author = ?`
(`SqliteDB.js:133`) or when the row's group is `'public'`. Two
consequences:

* an anonymous row tagged to a private group is still readable by every
  anonymous caller, because they all *are* the author;
* the update rule `author = ? or author = 'public'`
  (`SqliteDB.js:64`) lets **any** caller overwrite **any**
  anonymous row.

Add to that: the write gate only checks that an `ssid` cookie is *present*
(`Server.js:109`), never that it verifies. A cookie of `ssid=x` is enough to
write to any key as `public`.

**Fix**: use a sentinel that cannot be an identity (e.g. `NULL` author with an
explicit `anonymous` group), reject writes whose signature does not verify, and
drop `or author = 'public'` from the update predicate.

### 6. `HttpClient` calls back per chunk and throws on non-JSON — **FIXED**
`httpClient.js:9-15` parsed each `data` chunk on its own: the callback fired
once per TCP chunk, a response split across chunks never parsed, and a non-JSON
body threw out of the listener (unhandled — same crash class as #3).

**Fixed by** buffering the body and parsing once on `end` inside a `try/catch`,
so a parse failure reaches the callback as `(err, null)` like any other error.
The three previously `skip`ped tests in `tests/httpClient.test.js` now cover a
chunked response, a non-JSON response and the one-callback-per-response rule.

**Still worth doing**: replace the whole class with `fetch`, built in since
Node 18. It would also bring timeouts, which this client does not have.

### 7. The subscriber count is not a subscriber count
`PUT /sub/<key>` answers `{clients: Object.keys(sub).length}`
(`Server.js:58`) — the number of *keys* that have subscribers anywhere on the
node, not the number of receivers of this message. Should be
`sub[tmpKey].length`.

Related: nothing ever bounds `sub`. Keys are created on subscribe and their
arrays are emptied on disconnect, but the keys themselves are never deleted, and
there is no cap on subscribers, no heartbeat and no idle timeout. A long-running
node leaks one entry per key ever subscribed.

### 8. Dead crypto branch
`Crypto.verify`'s RSA path reads an undefined variable `body`
(`Crypto.js:37`) and shadows its own `msg` parameter, so any ssid tagged with a
non-`EC` algorithm throws and is rejected. It also uses the deprecated
`new Buffer()`.

**Fix**: delete it, or finish it using `crypto.createVerify` over the actual
message. Marked `todo` in `tests/Crypto.test.js`.

### 9. The replication story does not work — **REMOVED**
`SqliteDBWithReplicas` was named for a feature it did not have:

* the `/info` read in the constructor passed a `(err, data)` callback to a
  method that calls back with `(row)`, so `info.replicaSet` was always
  `undefined`;
* `insertReplicas` read a free variable `replicaSet` that did not exist in
  scope, and its loop counter `i` was undeclared;
* the only call site was commented out;
* the ingest endpoint it targeted, `GET /db/insert`, has been deleted (see #3).

**Removed**: `insertReplicas`, the commented-out call site, the `/info`
start-up read and the `info` object it filled, and the now-unused `HttpClient`
import. `src/h2t/SqliteDBWithReplicas.js` is renamed to `src/h2t/SqliteDB.js`,
matching the class name it always had; `tests/SqliteDBWithReplicas.test.js`
follows it to `tests/SqliteDB.test.js`. No behaviour changed — every line
removed was unreachable, broken, or both.

`src/h2t/httpClient.js` is now called by nothing in the server. It is left in
place with its tests, since it is the obvious starting point if replication is
picked up again.

**If replication is implemented for real**, it needs conflict handling: the
versioning scheme is not commutative, so two nodes that accept writes to the
same key independently cannot be merged by replaying inserts.

### 10. No transactions, no atomicity on the versioning path
The duplicate-key path does read → insert → update as three independent
statements on a connection in parallel mode
(`SqliteDB.js:32-48`). Two concurrent `POST`s to the same key can
both read counter *n* and race for `<path>/n`. `db.serialize()` is called but
only wraps the statement *queueing*, not the callbacks that run later.

**Fix**: do it in one `BEGIN IMMEDIATE` transaction, or express it as a single
`INSERT ... ON CONFLICT DO UPDATE` with `RETURNING`.

### 11. Every response is 200 (or 302)
There is no 404, 403, 400 or 500 anywhere. A missing key returns
`{unavailable}` with a 200, a missing file returns an ENOENT dump with a 200
(`Server.js:139-143`), a rejected write returns an empty 200. Caches, crawlers
and `fetch` callers cannot tell success from failure.

**Fix**: map the outcomes onto status codes; keep the JSON bodies.

### 12. Vendored SJCL is unseeded under ESM
`sjclClass.js:53` seeds `sjcl.random` only when `module.exports` or `window`
exists — neither is true in this ESM server, so the PRNG is left unseeded. It
happens to be harmless today because the server only *verifies* signatures, but
anything that reaches for randomness will throw `NOT READY`. The tests have to
seed it by hand (`tests/Crypto.test.js`).

**Fix**: seed from `node:crypto` at start-up, or drop SJCL server-side and
verify P-256 with `crypto.verify` — Node has supported it natively for years,
and 110 lines of minified vendor code would leave the repository.

---

## Structure and maintainability

### 13. `Server.init` is one 130-line closure
Routing, session handling, body buffering, SSE fan-out and error handling all
live in nested function expressions inside `init`, closing over `db` and the
module-level `sub`. Nothing is exported, so nothing can be unit tested — the
suite has to boot a real server on real ports for every routing assertion.

**Fix**: split into `router.js` (path → handler), `handlers/*.js` (one function
per feature, `(req, res, ctx)`), and `session.js`. Make `Server` a thin object
that wires them together and exposes `close()`.

Two changes were made during this review to make the suite runnable at all:
the HTTPS port is now a constructor argument (`new Server(port, db, sslPort)`,
default 9443 — `Cluster.js` is unaffected), and `init` stores `this.httpServer`,
`this.sslServer` and `this.db` so tests can shut the node down. Everything else
in `src/` is untouched.

### 14. Browser code has no module boundary
`src/fs/js/cli_v2.js` and friends are top-level scripts that reach for
`document` and globals like `clip` and `footer`, so the command parser, the
token handling and the fetch calls cannot be tested without a DOM. Extracting
the command parsing into an ES module with no DOM references would make the
console's dozen commands (I1) testable in Node.

`doEval`/`eval` on editor content (`cli_v2.js:25-32`) is intentional in a
console, but note that it also runs whatever `/fs/get` serves.

### 15. `Render.renderData` is a 14-branch if/else chain
`Render.js:172-226` repeats `data.type && data.type === 'x'` fourteen times.
Replace with a lookup table:

```js
const TYPES = { html: 'text/html', md: 'text/html', json: 'application/json', ... };
```

That also fixes a real gap: extensions outside the list fall through to
`JSON.stringify(data)`, which for a file read as a `Buffer` emits
`{"type":"Buffer","data":[137,80,...]}`. Real files in the repository hit this —
`/fs/get/games/rainbow.csv`, `/fs/get/favicon.ico` and every `.svg`, `.woff` or
`.wasm` that gets added later. A default of `application/octet-stream` for
buffers would be correct.

### 16. Blocking I/O on the request path
`renderFromFS` and `renderStatic` use `fs.readFileSync` (`Render.js:47,55`),
blocking the event loop for every asset on a server that also holds long-lived
SSE connections. There is no `Content-Length`, `ETag`, `Last-Modified` or
`Cache-Control` on those responses either.

**Fix**: `fs.createReadStream(...).pipe(res)` with a `stat`-derived
`Content-Length` and an `ETag`; the `mp3`/`m4a`/`mp4` branches already do this
and can share one helper with `renderMP4`.

### 17. Dead code
* `Render.renderWellKnown()` — never routed, although `src/.well-known/` exists
  and ACME renewal presumably needs it. Either wire it up or delete both.
* `Render.renderMP4`'s `res.on('close')` handler reads `res.fileStream`, which
  is never assigned (`:100-108`).
* The RSA branch (#8), `src/fs/style.css.old`, `src/fs/js/.beautify.js.swp`.
* `SqliteDB.getDBPath()` returned a bare `dbPath` — a missing `this.` — so it
  threw `ReferenceError` on any call. Corrected to `this.dbPath` while the
  surrounding constructor was being cleaned up in #9. It still has no callers.
* `insertReplicas` — **removed**, see #9.

### 18. Leftover debug logging
`console.log('searchPlus='...)`, `db.path=`, `db.keyword=`, `init::` and
`response closed` fire on every matching request
(`Render.js:20,29`, `SqliteDB.js:166,186-187`, `Server.js:22`,
`Render.js:101`). They log user-supplied search patterns to stdout with no
redaction and no way to turn them off.

**Fix**: one small logger with levels, off by default.

### 19. Style drift
`var`/`let`/`const` mixed inside the same function, tabs and spaces mixed in
`Render.js` and `SqliteDB.js`, `'use strict'` in ESM files where it
is redundant, `_this = this` alongside arrow functions, callbacks alongside
promises. `url.parse` (`Server.js:99`) has been deprecated for years in favour
of `new URL()`.

**Fix**: adopt one style and enforce it — `.editorconfig` plus ESLint with
`eslint:recommended` would catch #9's undeclared `i` and `replicaSet`, #17's
`dbPath`, and #8's `body` on their own.

### 20. Packaging and operations
* `package.json` says `"name": "nothern"` (typo) and `"main": "src/h2t/Cluster.js"`.
* No `engines` field, though the code needs Node 18+ (`import.meta.dirname`
  needs 20.11+).
* No CI. The repository-root `.gitignore` is the stock Node one and covers
  `node_modules/` only, so `abcd.db` (the live database), `server.key` and
  `server.crt` are all tracked in git — confirmed with `git ls-files`.
  **A private key that has been committed should be treated as compromised and
  rotated**, and the database does not belong in version control either.
* Ports (9090, 9443), the database path and the certificate paths are hard-coded
  across `Cluster.js` and `Server.js`; they belong in environment variables.
* No graceful shutdown, no restart supervisor, no health endpoint.

### 21. Test suite gaps
The suite added here covers the server modules. Still uncovered:

* the browser applications (I1–I6) — needs a DOM harness (#14);
* HTTPS request handling (only the listener is asserted);
* concurrency: parallel writes to one key (#10);
* the SSE path under load — many subscribers, slow consumers, abrupt drops;
* `tests/Example.test.js` tests a `formatFileSize` function declared inside the
  test file itself. It belongs to no feature and can go.
