# Plan: (PWA) Rama — audio notes to remember, and to be reminded of

A PWA under `/fs/get/pwa/rama/`, for whoever is signed in to Northern, built
as `PROMPT.md` describes. This document says what is built, where the build
reads the prompt in a particular way, and what only a real browser can show.

Everything stated as a fact below is pinned by a test (`tests/rama.test.js`),
except what is listed under *Not verified*.

---

## Files

| File | What it is |
| --- | --- |
| `index.html` | The two pages, the overlay, and the scripts, each asked for by `?v=<version>` |
| `version.js` | `RAMA_VERSION`: the cache is named after it, the page shows it |
| `model.js` | `RamaModel`: notes, types, search, the two lists, reminders, time. No DOM, no storage — tested as data |
| `views.js` | `RamaViews`: the list rows and the type suggestions, as HTML text, everything escaped |
| `store.js` | `RamaStore`: IndexedDB, reachable from the page and the service worker |
| `remind.js` | `RamaRemind.fire`: shows what is due, once — run by the page and the worker alike |
| `rama.js` | The wiring: session, recorder, peeling, lists, overlay, reminders |
| `sw.js` | The offline shell, periodic sync, and notification clicks |
| `styles.css`, `manifest.json`, `icon-*.png` | Look, install, icons |

The split is the one Pals and Bandage use: whatever has logic worth testing is
in a DOM-free script, and the wiring is tested in a DOM stub.

## Signed in, or off to Reg

`rama.js` starts with `session.signedIn()` (a live `ssid` cookie that belongs to
the stored public key). Without one the page goes to
`/fs/get/reg/Reg.html#<this page><hash>`, and Reg comes back here after sign
in — as Pals does. The cookie lasts a day, so the check runs again whenever the
page comes back into view, and before a recording starts or a note is updated.

Rama needs no ID Card on the device: nothing is signed or sealed.

## Storage — IndexedDB `rama`

| Store | Key | Value |
| --- | --- | --- |
| `notes` | note id | `{id, owner, at, duration, mime, buzz, type, essay, remind}` |
| `audio` | note id | `{type, bytes}` — the recording, an `ArrayBuffer` |
| `fired` | note id | the reminder time last shown |
| `meta` | public key | `{types}` — the types this user added |

- The sound is apart from the note, so the lists are read without it.
- Bytes rather than a `Blob`: older Safari could not keep Blobs in IndexedDB.
- `owner` is the Northern public key: the page lists only the signed-in user's
  notes, so two people who sign in on one device do not see each other's.
- Ids are base-36 time plus a random tail, so they sort by when they were made.
- The page alone writes `notes`, `audio` and `meta`; the worker writes only
  `fired`, so neither overwrites the other's work.

## The UI

**The recorder** — one round button in the middle. Record asks for the
microphone, and turns into Stop with the elapsed time under it. On Stop the
recording and a fresh note are saved; an empty recording is not. The format is
the first of Opus/WebM, AAC/MP4 (Safari), Opus/Ogg, WebM that the browser can
make. The length is measured while recording: MediaRecorder's WebM does not
state it, so a player would otherwise show ∞ until played through.

**Peeling** — the top right corner of each page is drawn as a folded-down
corner showing the other page's paper (a 64 px button, 84 px on hover or focus).
A click lifts the page off from that corner, turning on its bottom left
(650 ms, `--peel` in the CSS and `PEEL_MS` in `rama.js`), and the page under
it comes forward. The other corner peels back. The page underneath is `inert`;
with *reduce motion* the swap is instant.

**Search and the lists** — the search field filters both lists as it is typed:
every word must be somewhere in a note's buzz, type, essay, recording time,
reminder time or length, case aside.

- *Reminders* (upper): notes with a reminder; those still to come soonest
  first, then those that have passed, latest first and struck through.
- *Recordings* (lower): every recording, the last recorded first.

Both scroll on their own. The prompt calls them "two lists horizontally
arranged" and then "upper" and "lower": they are built stacked, each the full
width — the upper/lower wording is the more specific.

**The overlay** — opened by a click on a row of either list:

- *Recording* and its timestamp; *Play* (Play/Pause on one button), a slider to
  go anywhere in it, and the time — over an `<audio>` element made from the
  stored bytes, its object URL let go when the overlay closes.
- *Buzz* — one line, 120 characters at most.
- *Type* — a combobox: focusing it lists every type; typing narrows it to those
  that start with the text, then those that have it inside. Click, or the
  arrow keys and Enter, picks one; Escape closes the list and not the overlay.
  Whatever is typed may be new: it is kept in `meta` and suggested from then on,
  for every recording, even once no recording has it any more. A typed type
  that matches one there is, case aside, is spelled as that one.
- *Reminder* — `datetime-local`. A reminder moved into the past is refused;
  one left as it was may have passed.
- *Essay* — free text.
- *Update* saves and closes; *Close* closes without saving.

## Reminders

A web page cannot set an alarm the browser keeps when the page is closed: the
Notification Triggers API that would have done it was abandoned. Rama does
what can be done without a server:

1. **While the page is open** a timer runs to the next reminder (in steps of at
   most 24.8 days, setTimeout's limit) and shows it as a notification — through
   the service worker, which Android requires, or the page's own when there is
   none — and as a line on the page.
2. **When the page opens or comes back into view** it shows what came due in
   the meantime.
3. **When the app is installed in Chrome** the page registers for periodic
   background sync (`rama-reminders`, 15 minutes at the least); Chrome then
   wakes the worker now and then — how often is Chrome's choice, by how much the
   app is used — and it shows what is due.

`fired` keeps, by note, the reminder time last shown: whichever of the page and
the worker comes first shows it, the other does not, and a reminder moved
since is shown again at its new time. Both use the tag `rama-<id>`, so even a
race shows one notification.

Notification permission is asked when a reminder is first set, from the Update
click as browsers require. Without it the reminder is kept and shows in the
list only, and the page says so.

A click on a reminder's notification opens its recording: the worker tells an
open page (`rama:open`), or opens `index.html#note=<id>`, which opens the lists
and the overlay at once.

The worker knows no user: it shows the reminders of everybody who records on
the device. The page shows only its own user's.

**To be reminded on time with every browser closed** would take a push from a
server at the reminder time — Northern's push API (as Pals uses it) plus a
scheduler, which would mean the reminder's text leaving the device. Not built;
the prompt keeps everything in IndexedDB.

## Service worker

The Pals worker, cut down: it caches the page's own files and the Northern
identity scripts it loads, network first, filled past the HTTP cache; every
asset is asked for by `?v=<version>` (Cloudflare keeps `.js` for 4 hours).
On activation it deletes only its own old `rama-*` caches — the cache store
belongs to the origin, which Rama shares with the other apps.

**Bump `RAMA_VERSION` and every `?v=` in `index.html` together** whenever a
cached file changes.

## Not verified

What needs a real browser, which the sandbox here cannot run:

- the microphone, MediaRecorder's formats, and playback and seeking of what it
  made (the WebM it makes has no cues, so a seek may take a moment);
- the look of the corner and of the peel;
- notifications appearing, and periodic background sync firing at all;
- the `<dialog>` and focus.

## Not built

- Deleting a recording — the prompt gives the overlay Update and Close only.
- Reminders from a server (above).
