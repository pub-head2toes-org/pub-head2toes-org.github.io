# Plan: (PWA) Sezam — a REST API over the forum archive

A read-only REST API inside `northern` that exposes the five tables of the
Sezam BBS archive — `conference`, `topic`, `author`, `message`, `user` — so that
plain HTML/JS/CSS pages under `/pwa/sezam/` can read the forum the way it was
read in 1995: pick a conference, pick a topic, follow a thread.

This document is the plan. Nothing below has been built yet.

**Revision 1** reviews the *full* archive at `/home/pi5/share/sezam/sezam.db`
(773 MB, 572 645 messages) rather than the 10 000-message sample, and the
review overturns a good half of what the first draft assumed. The short
version: **the full database is already a built database.** It carries eleven
indexes and two FTS5 tables that the sample does not. Most of what the first
draft planned to build at build time is already there; what remains to build is
one thing, the thread sidecar, and it must go in its own file because the
700 MB archive is not ours to rewrite and never enters git.

## What the data actually is

Measured against `/home/pi5/share/sezam/sezam.db` on 2026-09-21, with the
sample kept alongside to show where the two differ:

| Table | Full DB | `db/sample.db` | Notes |
| --- | --- | --- | --- |
| `conference` | 104 | 104 | identical — `family` + `volume` (`ATARI.2`), `ord` for numeric sort, `date_from`/`date_to` populated on all 104, 27 families |
| `topic` | 1 405 | 1 405 | identical; 2 topics have no `first_ts`/`last_ts` |
| `author` | 3 901 | 3 901 | identical; 83 still have no `user_id` |
| `user` | 8 105 | 8 105 | identical; 6 565 carry Serbian diacritics, 6 473 have no `company` |
| `message` | **572 645** | 10 000 | 1989–1999, avg body 698 chars, max 32 767; 2 rows have no `ts`, none lack `epoch` |

So the sample is not a scaled-down archive. It is the **same four dimension
tables with a 1.7 % slice of the fact table**, produced by importing `csv/`,
and it predates the corrections the full archive has since received. Numbers
taken from it about `message` are not numbers about the corpus, and — finding
(1) below — its *shape* is not the corpus's shape either.

### What the full database already has that the sample does not

```sql
-- eleven indexes
ix_msg_author     message(author_id, epoch)      ix_msg_topic  message(topic_id, seq)
ix_msg_author_id  message(author_id, id)         ix_msg_epoch  message(epoch)
ix_msg_year       message(year)                  ix_msg_reply  message(topic_id, reply_seq)
ix_topic_conf     topic(conf_id)                 ix_conf_family conference(family, ord)
ix_user_city      user(city)                     ix_user_name  user(full_name)
ix_author_user    author(user_id)

-- two contentless FTS5 tables, both accent-blind
CREATE VIRTUAL TABLE search      USING fts5(body, author, topic, person,
                    content='', tokenize="unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE user_search USING fts5(username, full_name, city, company,
                    content='', tokenize="unicode61 remove_diacritics 2");
```

`search` has exactly 572 645 rows and its `rowid` **is** `message.id`;
`user_search` has 8 105 rows and its `rowid` **is** `user.id`. Both verified by
joining on `rowid` and reading the row back.

## Nine findings that shape the design

Findings 1–5 are revisions of the first draft. 6–9 are new.

1. **Roots are `NULL` in the full archive, `''` in the sample.**
   173 203 of 572 645 messages have `reply_seq IS NULL` and *zero* rows have
   `typeof(reply_seq) = 'text'`. In the sample, 3 213 roots are the empty
   string. The first draft made accommodating `''` an architectural
   decision; against the real data it is not needed. It stays only as a
   *defensive normalisation in the fixture builder*, because the sample is
   still a useful test input and the next CSV import may reintroduce it.

2. **`msg_count` is exact, and it is therefore a free total.** The first draft
   called it "metadata, never a pagination total" on the strength of 1 365
   sample mismatches. In the full archive `topic.msg_count`,
   `conference.msg_count` and `author.msg_count` each agree with `COUNT(*)`
   for **every single row** — 0 mismatches out of 1 405, 104 and 3 901. It is
   a correct, O(1), already-indexed total for the three unfiltered list
   cases, and `total=true` only has to run a real `COUNT(*)` when a filter is
   present. What is *not* trustworthy is `topic.declared_count` — the count
   the BBS header claimed — which disagrees for 1 225 of 1 405 topics.

3. **The structural damage is real but small, and it scales sub-linearly.**
   528 messages point forward or at themselves (`reply_seq >= seq`), and
   2 005 name a parent that is not in the table. Together 2 533 of 572 645,
   or 0.44 % — against 0.6 % in the sample. Both still have to be handled;
   neither is rare enough to ignore nor common enough to reshape the design.

4. **A depth ceiling of 64 would silently lose 55 messages.** The first draft
   picked 64 from a sample whose deepest chain was 31. The real archive's
   deepest chain is **81**. Run with `depth < 64`, the thread walk reaches
   572 590 rows and stops; run with `depth < 2000` it reaches all 572 645.
   The ceiling is set to **256**. And it is belt-and-braces only: because the
   recursive step requires `reply_seq < seq`, every hop strictly decreases
   `seq`, so a cycle is arithmetically impossible and the ceiling can never
   be the thing that terminates the walk.

5. **`reply_author` is denormalised and 575 rows disagree with the parent.**
   Where the parent exists, `reply_author` differs from the parent's
   `author.username` in 575 cases. It is also unindexed: `reply_author LIKE
   'rcol%'` is a full scan, 226 ms. Resolving the filter through the graph
   instead — find the named author's messages via `ix_msg_author_id`, then
   their children via the covering `ix_msg_reply` — is both exact and
   **8× faster**: 29 ms for `dejanr`, the archive's second-heaviest poster
   with 10 377 replies to his name. The filter is implemented as a join, and
   `message.reply_author` is carried in the payload as display text only.

6. **Both FTS tables are `content=''`, which costs three things.** Contentless
   FTS5 stores only the index, not the text — that is why a 773 MB archive
   has a searchable body at all. The consequences are structural, not
   incidental:
   - **`snippet()` and `highlight()` return the empty string.** Verified: no
     error, just nothing. Result excerpts must be cut from `message.body` in
     JavaScript after the join. This is not a regression — it lets the
     excerpt be diacritic-aware in the same way the tokenizer is, which
     `snippet()` would not have been.
   - **The index cannot be rebuilt.** `INSERT INTO search(search)
     VALUES('rebuild')` has no content to read, and `'integrity-check'`
     needs write access besides. If the index ever drifts from `message` it
     can only be regenerated by whatever produced the archive. The API
     therefore *verifies* rather than repairs: at startup,
     `COUNT(*) FROM search` must equal `COUNT(*) FROM message` (572 645 =
     572 645 today) and `COUNT(*) FROM user_search` must equal
     `COUNT(*) FROM user`. A mismatch is logged and degrades `q=` to the
     `LIKE` fallback; it does not take the API down.
   - **Deletes and updates are impossible without the original text**, which
     is fine — the archive is closed.

7. **`search` indexes four columns, and three of them are not `body`.**
   `search(body, author, topic, person)`, where `author` is the posting
   handle, `topic` is the topic name, and `person` is the handle *plus* the
   linked `user.full_name`. Confirmed by probe: `author:rcolic` → 87 (=
   `author.msg_count`), `author:colic` → 0, `person:colic` → 87,
   `person:"rastko colic"` → 87, and `person:ristanovic` and
   `person:ristanović` both → 13 160. So the tokenizer's
   `remove_diacritics 2` gives accent-blind name search for free, across the
   whole message table, indexed. Any `q=` that arrives unscoped is scoped to
   `body:` by the API; the other three columns are reachable through
   dedicated filters rather than by letting raw FTS syntax through.

8. **Accent-folded shadow columns on `user` are unnecessary.** The first
   draft proposed writing `full_name_norm`, `city_norm`, `company_norm`,
   `username_norm` because `LIKE` is ASCII-only and 80 % of the table has
   diacritics. Two measurements retire the idea. First, `user_search`
   already does this, indexed: `city:beogra*` → 4 310 in under a
   millisecond. Second, the table is 8 105 rows — a full `LIKE '%ograd%'`
   scan costs **4 ms** and found 4 308. So the fragment filters run as a
   two-step: FTS for the word-prefix case (accent-blind, what a user
   typing a name actually wants), a folded scan for true infix, and no new
   columns in a database we do not own.

9. **`seq` is still a sound reading order and a sound cursor**, and the
   indexes make every filter the brief asks for index-driven. Spot-checked
   on the full archive: page 100 of the largest topic (6 667 messages) by
   `seq`, 1 ms; `author_id` + `year`, 1 ms; a date range with
   `OFFSET 20000`, 2 ms; `q=` on a rare term, 2 ms. The one genuinely
   expensive shape is `ORDER BY bm25()` over a stopword-frequency term —
   `body:je` matches 349 334 messages and ranking them costs 728 ms. That is
   the number the `maxMatches` guard in Phase 5 exists for.

## Configuration: where the archive is, and what happens when it is not

The archive is 773 MB. It is not in git, it is not under `src/fs/` (everything
there is downloadable through `/fs/get/`), and its location is not a constant
in the source. It is a **configuration parameter read from `abcd.db`**, which
is the store `northern` already opens at boot.

One row, holding JSON:

| column | value |
| --- | --- |
| `path` | `/config/sezam` |
| `type` | `json` |
| `value` | `{"db":"/home/pi5/share/sezam/sezam.db","thread":"/home/pi5/share/sezam/sezam-thread.db"}` |
| `author` | the operator's public key |
| `public` | the operator's public key — **never `'public'`** |

`thread` is optional and defaults to `<db>` with `.db` replaced by
`-thread.db`, so the normal install sets one key.

Three points about this row:

1. **It must not be readable through the key-value API.** `Render.render`
   serves any `abcd` row whose `public` is `'public'`, so a config row stored
   that way would hand every visitor a server filesystem path at
   `GET /config/sezam`. Stored under the operator's key it is invisible to
   the fallback route. The API reads it with a new
   `SqliteDB.getConfig(path)` — a deliberate, single-purpose bypass of the
   author/public filter, because here the reader is the server process, not a
   browser. One method, one comment saying exactly that, rather than a
   general-purpose escape hatch.
2. **Resolution is lazy and cached, with a retry window.** The path is
   resolved on the first `/api/sezam/` request, not at boot, so a node with no
   archive starts normally. The resolved handle is cached for the process
   lifetime; a *failed* resolution is cached for only 30 seconds, so an
   operator can insert the row and see the API come up without a restart.
3. **`SEZAM_DB` / `SEZAM_THREAD_DB` environment variables override the row.**
   This is how the tests point at a fixture, and how a second node reads the
   same archive without a second `abcd.db` edit. Precedence: environment,
   then `abcd`, then unavailable.

### The `NotAvailable` response

Config row missing, file missing, file unreadable, or schema unrecognised —
all four produce the same answer from **every** `/api/sezam/` endpoint:

```
HTTP/1.1 503 Service Unavailable
Cache-Control: no-store

{ "available": false,
  "error": { "code": "NotAvailable",
             "message": "Sezam archive is not configured on this node",
             "param": "/config/sezam" } }
```

`503` rather than `404`, because the resource is not absent — this node just
cannot serve it, and a cache must not remember that. `available: false` sits at
the top level so a page can probe with one request to `/api/sezam/meta` and
branch on a field rather than on a status code. The `message` names the
condition; it never echoes the configured path, which would defeat the point of
keeping the row private. The reason *is* logged server-side, where the operator
is.

`{ unavailable: … }` is the shape `SqliteDB.get` already returns for a missing
key, so the vocabulary is the house vocabulary; the API uses the richer
envelope because it has a status code and a param to report.

## Architecture decisions

1. **The archive is read-only input, and nothing writes to it, ever.** The
   connection is opened `OPEN_READONLY`. A 773 MB file that took an import
   pipeline to produce is not something a request handler gets to touch, and
   the FTS tables of finding (6) cannot be repaired if they are damaged.
2. **The build step shrinks to one job: the thread sidecar.** The first draft
   had `SezamBuild.js` normalising `''` → `NULL`, denormalising `year`,
   creating indexes and populating FTS. Findings (1), (5) and the index list
   show the archive arrives with all of that done. What it does *not* have is
   precomputed thread structure. So `SezamBuild.js` reads the archive and
   writes **one new file** containing two tables — and touches nothing else.
3. **The sidecar is a separate database file, attached at query time.**
   Writing into `sezam.db` would mean either a 773 MB rewrite or a write
   handle on the archive; both are worse than one `ATTACH`. The sidecar is
   27 MB, builds in **9 seconds**, and lives beside the archive, outside git
   and outside `src/fs/`. `SezamDB` looks for `message_thread` in the main
   database first and only attaches if it is absent — so a fixture that
   carries the sidecar tables inline works without special-casing, and so
   does a future archive that ships them built in.
4. **The sidecar stores an ordinal, not a materialised path.** The first
   draft's `path` column — ancestors' `seq` zero-padded and dotted — sorts a
   thread correctly with a plain `ORDER BY`, and it works: the real archive's
   longest is 573 characters. But storing it costs **61 MB**, against
   **20 MB** for the same table with the path replaced by
   `ord INTEGER` — the message's depth-first position within its thread,
   computed as `row_number() OVER (PARTITION BY topic_id, root_seq ORDER BY
   path)` during the build and then thrown away. `ORDER BY root_seq, ord` is
   the same order, a third of the size, and an integer comparison instead of
   a 573-byte string one. Both variants were built and measured; the build
   time is identical.

   ```sql
   CREATE TABLE message_thread(
     topic_id INTEGER NOT NULL, seq INTEGER NOT NULL,
     root_seq INTEGER NOT NULL, depth INTEGER NOT NULL, ord INTEGER NOT NULL,
     PRIMARY KEY(topic_id, seq)) WITHOUT ROWID;
   CREATE INDEX ix_mt_read  ON message_thread(topic_id, root_seq, ord);
   CREATE INDEX ix_mt_roots ON message_thread(topic_id, root_seq) WHERE depth = 0;
   ```

   The partial index on roots is what makes "the next page of threads" an
   index-only scan of 175 429 rows rather than of 572 645.
5. **A second sidecar table summarises each thread, so `expand=false` needs
   no counting.** 175 429 rows, +7 MB, built in the same pass:

   ```sql
   CREATE TABLE thread(
     topic_id INTEGER NOT NULL, root_seq INTEGER NOT NULL,
     size INTEGER NOT NULL, max_depth INTEGER NOT NULL,
     last_seq INTEGER NOT NULL, last_epoch INTEGER NOT NULL,
     PRIMARY KEY(topic_id, root_seq)) WITHOUT ROWID;
   CREATE INDEX ix_thread_last ON thread(topic_id, last_epoch);
   ```

   `size` makes `reply_count` free, and `ix_thread_last` gives the one
   ordering a forum index page actually wants — threads by most recent reply
   — which neither `seq` nor `root_seq` can express.
6. **Damaged edges are promoted to roots, losslessly.** A message whose
   `reply_seq` is `>= seq`, or names a parent that does not exist, becomes a
   root of its own thread rather than being dropped, and keeps `reply_seq`
   and `reply_author` in its payload so the page can still say "reply to 41".
   After this, all 572 645 messages belong to exactly one of 175 429 threads
   and nothing is unreachable — verified by `COUNT(*)` on the built sidecar.
7. **Search uses the two FTS tables that are already there.** No new FTS is
   built, no `message_fts` external-content table, no second tokenizer. `q=`
   is `search MATCH 'body:…'` joined on `rowid = message.id`; the user
   fragment filters use `user_search` per finding (8). A `LIKE` fallback
   stays for a database built without them, and is what the count check in
   finding (6) degrades to.
8. **One new URL namespace, `/api/sezam/`, dispatched before the key-value
   fallback.** `Server.js` currently routes `/sub/`, `/fs/get`, `/static/`,
   `/mp4/get` and sends everything else to the `abcd` store; `/api` is unused
   today. Three lines in `app()` and one lazily constructed `SezamDB`. The
   registration redirect only fires on non-`GET`, so a read-only API needs no
   session.

## The limit problem, and what "optimal" means here

> *"consider finding an optimal way to apply a limit on retrieving messages in
> a way so that the message reply string is not broken"*

A `LIMIT` cuts a list. A thread is not a list — it is a subtree — so any limit
counted in **messages** can land in the middle of one. The fix is not a bigger
limit or a look-ahead; it is to **count the limit in the unit the caller is
reading in**. Three modes, chosen by `order`:

| `order` | Limit counts | Guarantee | Cost |
| --- | --- | --- | --- |
| `seq` *(default)* | messages | none needed — chronological reading has no subtree to cut | index-only on `ix_msg_topic` |
| `thread` | **threads** | a returned thread is always complete | one keyset scan of `ix_mt_roots` + one `IN` fetch |
| `thread&expand=false` | threads | roots only, each with `reply_count` from `thread.size` | `thread` table alone |

`order=thread` runs two statements:

```sql
-- 1. the page of roots: limit applies here, to whole threads
SELECT root_seq, size FROM x.thread
 WHERE topic_id = ? AND root_seq > ?          -- cursor
 ORDER BY root_seq LIMIT ?;

-- 2. every message in those threads, already in reading order
SELECT m.*, t.depth, t.root_seq
  FROM x.message_thread t JOIN message m ON m.topic_id = t.topic_id AND m.seq = t.seq
 WHERE t.topic_id = ? AND t.root_seq IN (…)
 ORDER BY t.root_seq, t.ord;
```

Both plans were checked on the archive's largest topic (6 667 messages):
statement 1 is `SEARCH USING INDEX ix_mt_roots`, statement 2 is
`SEARCH USING COVERING INDEX ix_mt_read` joined to
`COVERING INDEX ix_msg_topic`. Nothing recursive, nothing to reassemble, no
temp B-tree, and the boundary of a page is by construction a thread boundary.
Reading `size` in statement 1 means the ceiling below is enforced *before*
statement 2 runs, not discovered after.

Two numbers are reported separately, so the caller can see which unit the limit
was spent in: `page.threads` (roots returned) and `page.count` (messages
returned). A `maxMessages` ceiling (default 2 000) is a safety valve, not a
normal path. The real distribution: **175 429 threads, mean 3.26 messages,
largest 1 731, and 116 threads over 200.** So the default ceiling admits every
thread in the archive whole — zero exceed it — while still bounding a page of
many. When the next whole thread would cross the ceiling the page stops
*before* it and sets `page.truncated`; when a single thread exceeds it on its
own it is still returned whole, flagged `page.oversizeThread`. Completeness
wins over the ceiling, because a half thread is the one thing this mode exists
to prevent.

**Cross-topic results are always flat.** A search for "author X in 1997" spans
topics, and a thread only coheres inside one, so `/api/sezam/message` returns a
flat list — every row carrying `root_seq`, `depth` and a link to its thread,
which is what a result list needs anyway.

**Both `offset` and a cursor.** `limit` + `offset` are required by the brief
and are what a page-number UI wants; `after` is a keyset cursor (`seq` in flat
mode, `root_seq` in thread mode) that stays O(1) where `OFFSET 400000` does
not. `offset` is capped at 100 000 with the cursor named in the error.

## The composite key

`message` is addressed by `(id, topic_id, seq, reply_seq)`. `id` is the primary
key and `UNIQUE(topic_id, seq)` already exists, as does `(topic_id, reply_seq)`
— the first draft planned to create that index; the archive ships it as
`ix_msg_reply`. Every message in every response carries all four, under `key`,
plus the derived `root_seq`/`depth`, and is reachable two ways:

```
GET /api/sezam/message/:id                    canonical
GET /api/sezam/topic/:topic_id/message/:seq   positional — what reply_seq gives you
```

so a client holding `reply_seq` can fetch the parent without a search.

## Endpoints

Common to all list endpoints: `limit`, `offset`, `after`, `total=true`,
`fields=`.

| Method & path | Filters |
| --- | --- |
| `GET /api/sezam/meta` | `available`, counts, build id, corpus date range, FTS health |
| `GET /api/sezam/conference` | `family`, `volume` |
| `GET /api/sezam/conference/:id` | |
| `GET /api/sezam/conference/:id/topic` | `name` |
| `GET /api/sezam/topic` | **`conference`** (id or volume), `name` |
| `GET /api/sezam/topic/:id` | |
| `GET /api/sezam/topic/:id/message` | `order=seq\|thread\|recent`, `expand`, + all message filters |
| `GET /api/sezam/topic/:id/message/:seq` | |
| `GET /api/sezam/topic/:id/thread/:root_seq` | one complete chain, no limit |
| `GET /api/sezam/author` | **`username`** (fragment) |
| `GET /api/sezam/author/:id` | |
| `GET /api/sezam/author/:id/message` | + all message filters |
| `GET /api/sezam/user` | **`full_name`**, **`city`**, **`company`**, **`username`** (all fragments) |
| `GET /api/sezam/user/:id` | |
| `GET /api/sezam/message` | **`topic`**, **`author`**, **`year`**, **`reply_author`**, **`q`**, **`from`**, **`to`** |
| `GET /api/sezam/message/:id` | |

Bold names are the filters the brief asks for; the rest follow from them.
`order=recent` on a topic is new in this revision — threads by `last_epoch`
descending off `ix_thread_last`, which is how a forum index reads and which
decision (5) makes free.

### Message filters

| Param | Accepts | Implementation |
| --- | --- | --- |
| `topic` | id, or repeated for several | `topic_id IN (…)`, `ix_msg_topic` |
| `author` | id or username | resolved to `author_id`, `ix_msg_author` |
| `year` | `1997`, or `1995-1997` | `year` column, `ix_msg_year` |
| `reply_author` | username, or fragment | **self-join through `ix_msg_reply`** — finding (5) |
| `q` | words, phrases, `-word` | `search MATCH 'body:…'`, accent-blind, `rowid = message.id` |
| `person` | name or handle fragment | `search MATCH 'person:…'` — free from finding (7) |
| `from` / `to` | `YYYY`, `YYYY-MM`, `YYYY-MM-DD` | widened to a range, compared on `epoch`, `ix_msg_epoch` |
| `sort` | `seq`, `epoch`, `relevance` | `relevance` is `ORDER BY rank`; only legal with `q` |

Every value is bound, never interpolated. `order`, `sort`, `fields` and any
sort column are matched against a whitelist — an unknown name is a `400`, not a
passthrough. `q` is parsed and re-emitted from a small grammar (bare words,
`"phrases"`, leading `-`, trailing `*`); raw FTS5 syntax never reaches SQLite,
so a stray `"` is a `400` and not an `fts5: syntax error` surfacing as a `500`.

### Result excerpts

Finding (6) rules out `snippet()`. After the join, the API cuts a ±120
character window around the first match in `message.body`, locating it by
folding both body and term the way `unicode61 remove_diacritics 2` does
(NFD-decompose, strip combining marks, lower-case) so that `Ristanovic`
highlights `Ristanović`. Offsets are mapped back to the original string, and
the excerpt returned is the *original* text with match ranges reported
separately as `[start, end]` pairs — markup is the page's business, not the
API's.

## Response shape

```json
{
  "data": [ { "key": { "id": 2, "topic_id": 1, "seq": 4, "reply_seq": 3 },
              "root_seq": 3, "depth": 1,
              "author": { "id": 2, "username": "rcolic" },
              "ts": "1995-03-11T00:25", "epoch": 794881500, "year": 1995,
              "reply_author": "sazalakazu",
              "body": "Sto se tice SyberStorm-a: …" } ],
  "page": { "limit": 50, "offset": 0, "count": 37, "threads": 12,
            "hasMore": true, "next": "/api/sezam/topic/1/message?order=thread&after=118" },
  "filters": { "topic": 1, "order": "thread" }
}
```

`total` is opt-in (`total=true`), but finding (2) makes it cheap in the common
case: an unfiltered list of a topic's, conference's or author's messages reads
`msg_count` and returns in O(1). Only a *filtered* total runs a real
`COUNT(*)`, and only a filtered total behind an FTS join is expensive.

Errors are `{"error": {"code", "message", "param"}}` with a real status —
`400` malformed or unknown parameter, `404` no such row, `503` `NotAvailable`,
`500` otherwise. `Render.renderJSON` writes `200` unconditionally today, so it
gains an optional third argument, `status = 200`, which leaves all existing
callers unchanged.

The archive is immutable, so every response carries
`Cache-Control: public, max-age=86400` and an `ETag` of
`<build id>-<path+query hash>`, with `304` on `If-None-Match`. The build id
comes from the sidecar, not the archive, so rebuilding the thread tables
invalidates every cached page. `NotAvailable` responses carry `no-store`
instead.

## Files

| File | Holds |
| --- | --- |
| `src/h2t/SezamBuild.js` | the sidecar build: promote damaged edges, walk threads to depth 256, write `message_thread` + `thread` + indexes + `build_info`. CLI: `node src/h2t/SezamBuild.js [<archive.db> [<sidecar.db>]]`, defaulting to the configured paths, wired as `npm run sezam:build` |
| `src/h2t/SezamConfig.js` | resolve the archive path: env, then `abcd`, then unavailable; lazy, cached, 30 s negative TTL |
| `src/h2t/SezamDB.js` | read-only connection, the `ATTACH`, the startup FTS count check, promise-returning query methods, one per resource |
| `src/h2t/SezamApi.js` | route table, parameter parsing and validation, the `q` grammar, excerpts, envelope, ETag |
| `src/h2t/SqliteDB.js` | `+getConfig(path)` — the one deliberate bypass of the author/public filter |
| `src/h2t/Server.js` | +3 lines: the `/api/sezam/` branch |
| `src/h2t/Render.js` | `renderJSON(data, res, status = 200)` |
| `tests/sezam.test.js` | the API, against a fixture |
| `tests/helpers/sezamDb.js` | builds the fixture the way `helpers/db.js` does |

`SezamDB` returns promises rather than taking callbacks — `SqliteDB` already
grew `getRow`/`runSql` for exactly that reason, and there is no legacy caller
here to keep happy.

### The fixture

The first draft's fixture was `db/sample.db`. Finding (1) retires that as the
*primary* fixture: the sample has no indexes, no FTS, and `''` roots, so tests
built on it would exercise a shape the production archive does not have and
would miss every FTS path.

`tests/helpers/sezamDb.js` instead **emits a miniature of the full archive's
schema** — same DDL, same eleven indexes, same two contentless FTS5 tables —
populated by inserting a few hundred rows with explicit rowids
(`INSERT INTO search(rowid, body, author, topic, person) VALUES(…)`, which is
legal on a contentless table) so `rowid = message.id` holds exactly as it does
in production. Seeded into it: an empty-string root, a self-reference, a
forward reference, an orphan, a 70-deep chain, a diacritic name and its
ASCII spelling. `db/sample.db` remains in the repository as *source* data and
as the input to one test — that the builder copes with the pre-correction
shape.

## Tests

Beyond one test per endpoint and one per filter:

- a thread page is never cut — for every page of `order=thread`, each
  `root_seq` present appears with a message count equal to its `thread.size`;
- the pages of a topic, concatenated, equal the topic, with nothing repeated
  and nothing missing, under all three orders, with `offset` and with `after`;
- the empty-string roots of finding (1) are threaded as roots by the builder;
- the forward references and orphans of finding (3) appear in the output,
  promoted, with `reply_seq` preserved in the payload;
- the 70-deep chain survives — a regression test for finding (4), which the
  first draft's ceiling of 64 would have failed;
- `SUM(size) FROM thread` equals `COUNT(*) FROM message`, and every message
  has exactly one `message_thread` row;
- `reply_author=` resolved by join returns the graph's answer, not the
  denormalised column's, for a row where finding (5) says the two disagree;
- `Ristanovic` finds `Ristanović` in `user.full_name`, in `person:` and in
  the excerpt's match offsets;
- with no `/config/sezam` row and no `SEZAM_DB`, every endpoint returns `503`
  `NotAvailable` with `available: false`, the body does not contain a
  filesystem path, and `Cache-Control` is `no-store`;
- a config row stored with `public = 'public'` is the one thing the config
  loader refuses, loudly — the leak in decision-note (1) cannot be configured
  into existence;
- inserting the row after a failed probe makes the API available within the
  negative TTL, with no restart;
- an archive whose `search` count disagrees with its `message` count still
  serves, with `q=` degraded to `LIKE` and the mismatch in `/meta`;
- `limit=0`, `limit=10000`, `offset=-1`, `year=abc`, `order=body; DROP`, and a
  `q` full of FTS operators all return `400`, not a stack trace;
- `topic.declared_count` is never used as a pagination total — `msg_count` is.

## Phases

| Phase | Delivers | |
| --- | --- | --- |
| 0 | `SezamConfig` + `SqliteDB.getConfig` + the `NotAvailable` path, end to end, before any data is read — a node with no archive answers correctly first | **done** |
| 1 | `SezamBuild.js` and the fixture builder; findings (1)–(5) verified as tests against both | **done** |
| 2 | `SezamDB`, `SezamApi`, the `Server.js` branch, `/meta` and the four lookup resources with limit/offset and fragment filters | **done** |
| 3 | `/message` flat: the composite key, the six brief filters incl. the `reply_author` join, cursor | **done** |
| 4 | `order=thread`, `order=recent`, `expand=false`, `/thread/:root_seq` — the limit problem | **done** |
| 5 | `q=` and `person=` over the shipped FTS tables, the `q` grammar, excerpts, the `LIKE` fallback, the `maxMatches` guard for finding (9)'s 728 ms case | **done** |
| 6 | ETag/caching, `total=true` off `msg_count`, parameter hardening, API reference in this folder | **done** — `API.md` |
| 7 | the HTML/JS/CSS pages — a separate prompt, and the reason the API exists | **done** |

## Appendix: measurements

Taken 2026-09-21 on the Pi, `sqlite3` 3.40.1 CLI and the bundled
`sqlite3@5` (SQLite 3.44.2) from Node. Both agree.

| What | Result |
| --- | --- |
| Archive size / page size / freelist | 773 566 464 B / 4 096 / 0 |
| Node `sqlite3@5`: `OPEN_READONLY`, `ATTACH`, FTS5, cross-database join | all verified working |
| Thread walk, whole archive, `depth < 64` | 2.75 s, **572 590** rows — 55 lost |
| Thread walk, whole archive, no effective ceiling | 2.05 s, 572 645 rows, max depth **81** |
| Sidecar with `path TEXT` (max 573 chars) | 61 MB, 5.1 s |
| Sidecar with `ord INTEGER` | **20 MB**, 5.7 s |
| … plus the `thread` summary table | **27 MB**, 9 s total |
| `q=amiga` (2 058 hits), `MATCH` + join + `bm25` + `year` | 2 ms |
| `q=je` (349 334 hits), `COUNT` | 45 ms |
| `q=je`, `ORDER BY bm25` `LIMIT 50` | **728 ms** — the worst case |
| `q=je`, `ORDER BY epoch` `LIMIT 50 OFFSET 10000` | 245 ms |
| `reply_author LIKE 'rcol%'` (full scan) | 226 ms |
| same filter resolved by join, heaviest author (10 377 replies) | **29 ms** |
| `user` full `LIKE '%ograd%'` scan (8 105 rows) | 4 ms |
| `user_search MATCH 'city:beogra*'` | <1 ms |
| Topic page 100 of the largest topic (6 667 messages) | 1 ms |
| `snippet()` on a contentless table | returns `''`, no error |


## As built

All seven phases are implemented, in 155 tests — 104 in `tests/sezam.test.js`
for the API, 51 in `tests/sezamPage.test.js` for the pages. What building it
changed about the plan above:

### A tenth finding, which the plan had backwards

**The search index is ASCII-folded, and a typed query term is not.** The plan
said `remove_diacritics 2` gives accent-blindness "for free". It does, for
č ć š ž — those are a base letter plus a combining mark, so NFD strips them on
both sides and `čolić` and `colic` both find Čolić. **đ is not.** U+0111 is its
own letter, not d plus a mark, so neither NFD nor unicode61 touches it. The
index holds `duric` for Đurić because whatever built the archive folded it, but
a query for `đuric` tokenizes to `đuric` and matches **nothing at all** — no
error, just an empty result that looks like an answer. 704 users carry đ.

So every term the API sends to `MATCH` is folded first, by `fold()` in
`SezamText.js`, which maps đ explicitly. Verified: all 8 102 users with a name
are found by the fold of that name.

### Folded lookup tables, in the sidecar

Finding (8) said shadow columns were unnecessary because `user_search` is
already accent-blind. That is true for a *prefix*, which is what FTS matches —
but the brief asks for a **fragment**, and `ograd` has to find `Beograd`. FTS
cannot do infix, the archive cannot be written to, and `node-sqlite3` cannot
register a folding function for SQL to call. So the sidecar carries
`user_norm`, `author_norm` and `topic_norm` — folded copies, about a megabyte,
scanned in 2 ms. (23 topic names carry diacritics; author handles and
conference families are pure ASCII today, but fold the same way so an import
that changes it needs no new code.)

### Corrections found while building

- **A bare `ANALYZE` writes to every attached database.** The build attaches
  the archive through a `file:…?mode=ro` URI, so this failed loudly with
  `SQLITE_READONLY` instead of editing the corpus, and the build now runs
  `ANALYZE main`. The guard is worth more than the statement.
- **`summariseThreads` was 17.8 s of the first 21.8 s build.** A correlated
  subquery per thread, 175 429 of them; as one grouped join it is 2 s, and the
  whole build is **5.0 s for 26 MB** — better than the 9 s the plan estimated.
- **A missing sidecar means `message_thread` does not exist**, and a `LEFT
  JOIN` to a table that is not there is a hard error, not a null. `SezamDB`
  selects `root_seq`/`depth` as `NULL` and omits the join when unthreaded, so
  such a node still serves every message, flat.
- **An FTS5 table cannot be given an alias** — `MATCH` and `bm25()` both need
  its own name — so the search join appears unaliased.

### Decisions the plan left open

- **A query too broad to rank is served, not refused.** Ranking is linear in
  matches: 12 141 costs 37 ms, 349 334 costs 525 ms, while *counting* them
  costs 28 ms. Above 50 000 matches the page comes back in date order with
  `page.ranked: false`, `page.matches` and `page.rankedReason`. A common word
  should still be searchable, and the caller is told what it got.
- **An unknown parameter is a 400.** A misspelled `autor=` that was silently
  dropped would return the whole archive and look like a working search.
- **An empty parameter means "no filter".** A form with optional fields submits
  all of them, so `city=` means the box was blank, not that the caller erred.
- **`order=thread` refuses message filters.** Its promise is that a returned
  thread is complete, and filtering removes messages from the middle of one.
  The error names the two ways to get what was wanted.
- **`SezamText.js` was added** to the file list, holding the fold, the `q`
  grammar and the excerpt cutter. The plan put these in `SezamApi.js`, which
  is already 1 000 lines of routing and validation.

### Verified against the whole archive, not the fixture

- Every page of `order=thread` over topics 1303, 47, 1286 and 1 — 306 pages,
  17 727 messages, 12 158 threads — returned every thread complete, with no
  gaps and no repeats.
- The sidecar's invariants hold on all 572 645 messages: one thread row each,
  `sum(size)` equal to the message count, `ord` dense from 0 within every
  thread, every reply one level below its parent and in the same thread, and
  2 226 damaged edges promoted to roots rather than dropped.
- The API was driven over real HTTP from a second node reading the config row
  out of `abcd.db`, including the negative: `GET /config/sezam` returns
  `unavailable`, because the row is stored under the operator's key.

### Measured, as built

| | |
| --- | --- |
| Sidecar build | 5.0 s, 26.2 MB |
| `/meta`, first call (opens the archive, checks both FTS tables) | 67 ms |
| `/meta`, after that | 2 ms |
| Topic page, `order=thread`, largest topic | 1–2 ms |
| `q=cyberstorm` (18 matches), ranked, with excerpts | 9 ms |
| `q=amiga` (2 058), ranked | 9 ms |
| `q=disk` (12 141), ranked | 44 ms |
| `q=je` (349 334), degraded to date order | 478 ms |
| `reply_author` through the graph, heaviest author | 29 ms |
| Unfiltered `total=true` off `msg_count` | 1 ms |
| Same total, filtered, counted | 10 ms |
| Fragment filter over 8 105 folded users | 2–5 ms |


## The pages, as built

Vanilla HTML, CSS and JS under `src/fs/pwa/sezam/`, hash routed, no build step
— the house pattern for a PWA in this repo. `API.md` lists the routes and
files. Three things are worth recording here.

**The API gained one field while the pages were built.** `expand=false`
returned a thread's shape but not its substance: `root_seq`, `size`,
`reply_count`. A list of threads needs a line to show and a name to show it
under, and the only ways to get them were N requests for N roots or
`expand=true`, which downloads every message of every thread on the page. So
the endpoint now joins the root message and returns its `author`, `ts` and the
first 300 characters of its body. Cutting it server-side is the point: a 40-row
list should not carry 40 whole messages, some of which are 32 KB.

**A thread title is not the first line.** A good share of the archive opens
with an ASCII-art banner, so the obvious rule produced a list of conversations
titled `.▀▀▀▀▀▀▀šdiViDE+▀▀▀▀▀▀▀.`. `Format.firstLine` skips quoted lines, then
lines that are mostly not letters, then lines holding a run of box-drawing
characters or a rule of `=`/`-`; if nothing qualifies it takes the first line
anyway, because a bad title beats no title. An ellipsis and a `-->` stay prose.

**Bodies are never reflowed.** Every line was hard wrapped for an 80 column
terminal and the corpus is full of ASCII tables and signatures, so the text
stays in a `<pre>`. Quote depth is read from the marker — the archive quotes as
`>`, `>>`, `+>`, `->`, `-->`, `>>>`, `>> >`, `:>`, `|>` and more, all meaning
the same thing — and dims each level, which is what makes a long reply
readable.

### Testing a page without a browser

`tests/sezamPage.test.js` runs the page's scripts in a `vm`, the way the other
PWA tests here do. Routing, formatting and the views are pure functions and are
tested directly — which is why `router.js` exists at all, rather than the route
table living inside `sezam.js` where nothing could reach it.

`sezam.js` is wiring, so it is driven through a small string-backed DOM shim
whose `fetch` is a live `SezamApi` over a fixture database: the page's own code
navigates, fetches, renders and appends against the real API and real SQLite.
That is how the tests check that following *Load more* to the end of a topic
yields all 70 messages, once each, in order. The shim is not a browser and does
not pretend to be; anything needing real layout or event bubbling is not tested
here.

It found two real faults while being written: `router.js` was never added to
`index.html` or the service worker, which would have broken the page on load,
and the test that should have caught it only checked the scripts already listed
in `index.html`. It now asserts both directions — every script shipped is
loaded, and every script loaded is cached.