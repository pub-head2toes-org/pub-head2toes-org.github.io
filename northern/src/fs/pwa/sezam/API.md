# Sezam API reference

A read-only REST API over the Sezam BBS archive, mounted at `/api/sezam/`.
Every route is a `GET`, every response is JSON, and nothing writes: the
connection to the archive is opened `OPEN_READONLY`.

See `PLAN.md` for why it is built this way. This file is what a page needs to
call it.

## Setting it up

The archive (773 MB, 572 645 messages) is not in git and its location is not a
constant in the source. It is read from one row in `abcd.db`:

| column | value |
| --- | --- |
| `path` | `/config/sezam` |
| `type` | `json` |
| `value` | `{"db":"/home/pi5/share/sezam/sezam.db"}` |
| `author` | the operator's public key |
| `public` | the operator's public key — **never `public`** |

`value` may also carry `"thread"`; it defaults to the archive path with
`.db` replaced by `-thread.db`.

**The row must not be stored public.** `Render.render` serves any `abcd` row
whose `public` column is `public`, so a config row stored that way hands every
visitor a server filesystem path at `GET /config/sezam`. The loader refuses
such a row and logs why.

`SEZAM_DB` and `SEZAM_THREAD_DB` in the environment override the row.

Then build the thread sidecar — about 26 MB, five seconds:

```
npm run sezam:build                       # uses the configured paths
node src/h2t/SezamBuild.js <in.db> <out.db>
```

The archive is attached `mode=ro` during the build, so it cannot be written to
even by a mistake in the build's own SQL.

### When it is not set up

Every endpoint, including `/meta`, answers:

```
HTTP/1.1 503 Service Unavailable
Cache-Control: no-store

{"available": false,
 "error": {"code": "NotAvailable",
           "message": "Sezam archive is not configured on this node",
           "param": "/config/sezam"}}
```

`503` rather than `404` — the resource is not absent, this node just cannot
serve it — and `available` sits at the top level so a page can probe with one
request and branch on a field rather than a status code. The message never
names the configured path. A failed lookup is retried after 30 seconds, so
adding the row does not need a restart.

## Endpoints

| Method & path | Filters |
| --- | --- |
| `GET /api/sezam/meta` | — |
| `GET /api/sezam/conference` | `family`, `volume` |
| `GET /api/sezam/conference/:id` | |
| `GET /api/sezam/conference/:id/topic` | `name` |
| `GET /api/sezam/topic` | `conference` (id or volume), `name` |
| `GET /api/sezam/topic/:id` | |
| `GET /api/sezam/topic/:id/message` | `order`, `expand`, + message filters |
| `GET /api/sezam/topic/:id/message/:seq` | |
| `GET /api/sezam/topic/:id/thread/:root_seq` | — one complete chain, no limit |
| `GET /api/sezam/author` | `username` |
| `GET /api/sezam/author/:id` | |
| `GET /api/sezam/author/:id/message` | + message filters |
| `GET /api/sezam/user` | `full_name`, `city`, `company`, `username` |
| `GET /api/sezam/user/:id` | |
| `GET /api/sezam/message` | `topic`, `author`, `year`, `reply_author`, `q`, `person`, `from`, `to` |
| `GET /api/sezam/message/:id` | |

Every list endpoint also takes `limit`, `offset`, `after`, `total`, `fields`
and `sort`.

**An unknown parameter is a `400`, not something ignored.** A misspelled
`autor=` that was silently dropped would return the whole archive and look like
a working search.

**An empty parameter means "no filter".** A form with optional fields submits
all of them, so `city=` means the box was left blank.

## Paging

| Parameter | Meaning |
| --- | --- |
| `limit` | 1–500, default 50 |
| `offset` | 0–100 000; above that the error names the cursor |
| `after` | keyset cursor, valid only with the sort it is a key for |
| `total=true` | include `page.total` |
| `fields=a,b` | narrow each row to these keys |
| `sort=` | per resource, see below |

Every list response carries `page.next` when there is more; following it is the
supported way to page. It uses a cursor where the sort allows one and an offset
where it does not.

`total` is opt-in, but it is free where it can be: an unfiltered list of a
topic's or an author's messages reads `msg_count`, which agrees with
`COUNT(*)` for every row in the archive. `topic.declared_count` — what the BBS
header claimed — disagrees for 1 225 of 1 405 topics and is never used as a
total.

| Resource | `sort` | cursor |
| --- | --- | --- |
| conference | `id`, `volume`, `family`, `ord` | `id` |
| topic | `id`, `name`, `messages` | `id` |
| author | `id`, `username`, `messages` | `id` |
| user | `id`, `username`, `full_name`, `city` | `id` |
| message | `id`, `epoch`, `seq`, `year`, `relevance` | `id`, or `seq` within a topic |

## Reading a topic

`order` on `/topic/:id/message`:

| `order` | The limit counts | Guarantee |
| --- | --- | --- |
| `seq` *(default)* | messages | chronological reading has no subtree to cut |
| `thread` | **threads** | a returned thread is always complete |
| `recent` | **threads** | threads by most recent reply |

A `LIMIT` cuts a list, and a thread is not a list — it is a subtree — so a
limit counted in messages can land in the middle of one. `order=thread` counts
the limit in threads instead: ask for 20, get 20 complete threads.
`page.threads` and `page.count` report both units.

`expand=false` returns the roots only, each with `size`, `reply_count`,
`max_depth`, `last_epoch` and a link to its thread — plus the root message's
`author`, `ts` and `opener`, its first 300 characters. A list of threads needs
a line to show and a name to show it under, and the sidecar holds neither;
cutting the body server-side keeps a 40-row list from carrying 40 whole
messages, some of which are 32 KB.

Because the promise of these modes is completeness, they **cannot be combined
with a message filter** — filtering removes messages from the middle of a
thread. Use `order=seq`, or `/api/sezam/message` for a flat filtered list.

A page of threads stops before crossing 2 000 messages and sets
`page.truncated`. A single thread larger than that is still returned whole and
flagged `page.oversizeThread`: half a thread is the failure these modes exist
to prevent. In practice neither fires — the archive's largest thread is 1 731
messages and the mean is 3.26.

## Message filters

| Parameter | Accepts |
| --- | --- |
| `topic` | an id, or repeated for several |
| `author` | an id, or a handle |
| `year` | `1997`, or `1995-1997` |
| `reply_author` | a handle fragment |
| `q` | keyword search, see below |
| `person` | a handle or a real name |
| `from` / `to` | `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, widened to the edge of the unit |

`reply_author` is resolved through the graph — the named author's messages,
then the messages that reply to them — not through `message.reply_author`. That
column disagrees with the parent's real author on 575 rows and carries no
index. It is still returned, as display text.

## Keyword search

`q` takes a small grammar, not raw FTS5:

```
word         a term
word*        a prefix
"two words"  a phrase
-word        excluded
```

Anything else is a `400` naming `q`. Terms are folded before they are sent, so
`Ristanović` and `Ristanovic` find the same messages, and `Đurić` finds
`Đurić` — which it would not if the term were passed through, because the
index holds folded text and `đ` is not a combining mark.

`person` searches handles and real names together across every message.

Results carry an `excerpt`:

```json
"excerpt": { "text": "…the original body around the match…",
             "offset": 281, "truncatedStart": true, "truncatedEnd": true,
             "matches": [[12, 22]] }
```

`matches` are `[start, end)` offsets **into `excerpt.text`**, not into `body`.
Markup is the page's business. The excerpt is cut here rather than by
`snippet()`, which returns the empty string on a contentless FTS table.

Searches are ranked by relevance by default. A query matching more than 50 000
messages is served in date order instead, with `page.ranked: false`,
`page.matches` and `page.rankedReason` — ranking is linear in matches and a
common word should still be searchable.

`page.search` says `fts` or `like`. `like` means the index disagreed with its
source and the API fell back; it matches only what is spelled the same way, and
`person` is unavailable in that state.

## Response shape

```json
{ "data": [ { "key": { "id": 2, "topic_id": 1, "seq": 4, "reply_seq": 3 },
              "root_seq": 3, "depth": 1,
              "thread": "/api/sezam/topic/1/thread/3",
              "author": { "id": 2, "username": "rcolic" },
              "ts": "1995-03-11T00:25", "epoch": 794881500, "year": 1995,
              "reply_author": "sazalakazu",
              "body": "Sto se tice SyberStorm-a: …" } ],
  "page": { "limit": 50, "offset": 0, "count": 37, "threads": 12,
            "hasMore": true, "next": "/api/sezam/topic/1/message?order=thread&after=118" },
  "filters": { "topic": 1, "order": "thread", "sort": "seq" } }
```

Every message carries its whole composite key, so a client holding a
`reply_seq` can fetch the parent positionally without a search:

```
GET /api/sezam/message/:id                    canonical
GET /api/sezam/topic/:topic_id/message/:seq   positional
```

`root_seq`, `depth` and `thread` are `null` on a node whose sidecar has not
been built; everything else still works.

## Errors

`{"error": {"code", "message", "param"}}` with a real status:

| Status | Code | When |
| --- | --- | --- |
| 400 | `BadRequest` | a malformed or unknown parameter; `param` names it |
| 404 | `NotFound` | no such row, or no such endpoint |
| 503 | `NotAvailable` | no archive configured, or no thread index for a threaded mode |
| 500 | `ServerError` | anything else; the detail goes to the log, not the caller |

## Caching

The archive is immutable, so every `200` carries
`Cache-Control: public, max-age=86400` and an `ETag` of
`"<build id>-<hash of path and query>"`, with `304` on `If-None-Match`. The
build id comes from the sidecar, so rebuilding it invalidates every cached
page. Errors and `NotAvailable` carry no validator.


## The pages

`/fs/get/pwa/sezam/index.html` is a reader built on this API: vanilla HTML, CSS
and JS, no build step, hash routed.

| Route | |
| --- | --- |
| `#/` | the 104 conferences, grouped by family |
| `#/conference/:id` | its topics, with a name filter |
| `#/topic/:id` | its threads, most recently replied to first |
| `#/topic/:id/threads` | its threads in order |
| `#/topic/:id/read` | the topic straight through, chronologically |
| `#/topic/:id/thread/:root` | one complete thread, indented by depth |
| `#/topic/:id/message/:seq` | a message named positionally; redirects into its thread |
| `#/search?q=&person=&from=&to=` | keyword search, hits marked |
| `#/people?full_name=&city=&company=&username=` | the member directory |
| `#/user/:id`, `#/author/:id` | a member, and a handle's messages |

| File | |
| --- | --- |
| `index.html` | the shell: header, breadcrumb, one `#view` |
| `api.js` | every call to `/api/sezam/`, and what an error is |
| `format.js` | escaping, quote depth, dates, excerpt marking, thread titles |
| `router.js` | the hash routes, as pure functions |
| `views.js` | each view, as HTML |
| `sezam.js` | the wiring: navigate, render, append |
| `styles.css`, `manifest.json`, `sw.js`, `error.html`, `icon-*.png` | |

Two details worth knowing when changing them:

- **Message bodies are kept in a `<pre>`, never reflowed.** Every line was hard
  wrapped for an 80 column terminal, and the archive is full of ASCII tables
  and signatures that rewrapping would destroy. Quoted lines are dimmed by
  depth, read from the marker: the corpus quotes as `>`, `>>`, `+>`, `-->`,
  `>> >` and a dozen other shapes, all meaning the same thing.
- **The service worker never caches `/api/sezam`.** The API already answers
  with an `ETag` and a day of `max-age`, so the browser's own cache
  revalidates properly, and a stale search result is worse than a slow one.