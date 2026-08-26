# Plan: (PWA) Bandage — 25 piano keys

A single-page PWA under `/pwa/bandage/`: 25 piano keys filling the lower two
thirds of the screen, played through
[webaudio-tinysynth](https://github.com/g200kg/webaudio-tinysynth) (Apache-2.0,
vendored). The upper third holds eight loop channels - record a part, and it
plays back under your hands while you play the next.

## Entry

`index.html` — no parameters, nothing to join, no network. Opening the page is
the whole hand-off. It is the first PWA here that stands on its own rather than
arriving from `joint`'s lobby.

`error.html` is reached only when the browser has no `AudioContext`, which is
the one condition that makes the app pointless to draw.

## Architecture decisions

1. **The arithmetic is separate from the page.** `keys.js` knows the layout —
   which notes, which are black, where each sits on a keyboard one unit wide,
   what a typed letter means. `loops.js` knows what a loop is — steps, notes to
   a step, what an edit does to a strip, how to take one back. `smf.js` knows
   the file format. None of the three touches the DOM or the synth; `bandage.js`
   and `recorder.js` are the wiring. This is the split `idcard.js`/`Reg.html`
   and `history.js`/`textedit.js` already use here, and it is what lets the
   whole model be tested as numbers (`tests/bandage.test.js`).
2. **25 keys means C to C.** Two octaves, 15 white and 10 black. That count only
   works from a C, so `keys.normalize` snaps any starting note down to one; the
   octave buttons move in twelves and clamp at C0 and C7.
3. **Geometry in fractions, not pixels.** `keys.layout` returns `left`, `width`
   and `height` as fractions of the board, written into CSS as percentages. The
   keyboard is then resolution-independent — phone, tablet or desktop, portrait
   or landscape — with no resize handler and no canvas. The stylesheet sets no
   key measurement at all: one file knows the geometry, and it knows all of it.
4. **A black key straddles the line between two white keys.** Centring it on
   that boundary puts the gaps at E–F and B–C by itself, with no table of
   exceptions. It runs 0.465 of the board deep, which leaves the wide part of
   each white key easy to hit with a thumb.
5. **Holders, not booleans.** A note stops when the last thing holding it lets
   go — a finger, a typed key, or the sustain latch. Without that, releasing a
   typed key would cut off a note a finger was still holding.
6. **Pointer events, not touch or mouse.** One code path covers mouse, pen and
   multi-touch; `pointerId` gives polyphony for free, and following a pointer
   across keys gives a glissando. `touch-action: none` keeps the page from
   scrolling under the fingers.
7. **Nothing off the network.** The synth is vendored and everything is cached
   by `sw.js`, so the app is fully playable offline — the point of a PWA, and
   the reason the library is a file in this folder rather than a CDN link.
8. **The keyboard does not know about the loops.** It announces what the player
   struck on `app.observers`; `recorder.js` listens. Which is why `strike` and
   `unstrike` exist beside `hold` and `letGo`: a note re-struck while the
   sustain latch is still holding it never reaches `hold`, and a recorder has to
   hear it.

## Layout

```
+-------------------------------------+
|  #stage        the loops, 33.3333%  |
|                (#editor covers it)  |
+-------------------------------------+
|  #toolbar      voice, octave,       |
|                volume, sustain,     |
|                tempo                |
|  #keyboard     the 25 keys, filling |
|                what is left         |
+-------------------------------------+
```

The panel is a flex item at `0 0 33.3333%`; the console takes the rest, so what
landed in the stage cannot push the keys off screen. The editor is absolutely
positioned over the same panel rather than beside it — a third of a phone has
room for one of them, not both.

## Controls

| Control | Does |
| --- | --- |
| Voice | 12 General MIDI programs, piano first |
| Octave &minus; / + | Moves the 25 keys by an octave, C0 to C7 |
| Volume | Master volume |
| Sustain | Notes keep ringing after release until it is switched off |
| _(name)_ | `BANDAGE` sits at the far end of the strip, out of the controls' way |
| Tempo | 40 to 240 bpm — one clock, shared by all four loops |
| Playing | The notes sounding, by name |

Keys can be played by touch (polyphonic), mouse, or the computer keyboard:
`z s x d c v g b h n j m` for the lower octave, `q 2 w 3 e r 5 t 6 y 7 u i` for
the upper, arrow keys for the octave shift.

## The loops

Eight of them, laid out as the spec asks: the functions down the side, the
channels across.

| Loop | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Play** | ▶ | ▶ | ▶ | ▶ | ▶ | ▶ | ▶ | ▶ |
| **Record** | ● | ● | ● | ● | ● | ● | ● | ● |
| **Edit** | ✎ | ✎ | ✎ | ✎ | ✎ | ✎ | ✎ | ✎ |

The table is built by `recorder.js` from `loops.COUNT`, the way the keys are
built from `keys.layout`. A table typed into the page by hand would be a second
place that says how many loops there are, and one of the two would eventually be
wrong.

1. **A loop is a strip of steps; a step is up to four notes at once.** A step is
   an eighth note, so a rest is a real thing that takes up room — which is what
   makes the editor's insert and delete of an empty step the way a rhythm is
   written, rather than a curiosity. A slot holds nothing, a note struck, or a
   **tie** — the note before it going on ringing, written as the pitch made
   negative so that a strip stays an array of numbers.
2. **One loop is one MIDI channel is one instrument.** Loops take channels 1 to
   8 and the player's hands keep channel 0, so a loop starting can never cut off
   a note being held. A MIDI channel is polyphonic, so four notes at once needs
   no plumbing at all. The instrument is whatever the Voice selector says when
   Record is pressed, so a part plays back as it sounded while it was played.

   Eight is the ceiling, and channel 9 is why: `tinysynth` makes it the drum
   channel in `reset`, so a ninth loop would play a kit instead of a pitch. The
   synth is opened with 48 voices, which is eight loops of four notes with room
   for two hands on top.
3. **One clock, not four.** Every loop reads its step off one counter, wrapping
   at its own length — `steps[tick % length]`. Four transports would drift; one
   counter cannot.
4. **Recording is real time, quantised.** Each note lands on the nearest step,
   which is both how a player wants to record and exactly the grid the editor
   draws. The strip is then trimmed of trailing silence and rounded up to a
   whole bar of 8 steps, so loops of different lengths still come round together.
5. **How long a key was held is kept as a strike and then ties.** A key held
   across four steps is struck on the first and tied across the other three
   (`loops.holdNote`), so it comes back the length it was played *and* as one
   note rather than four. The tie is what keeps that apart from a note genuinely
   played four times over — without one, `[60, 60, 60, 60]` would have to mean
   both, and a held note came back as a stutter. Notes are sorted low to high
   within each step when the recording ends (`loops.tidy`): they are written as
   keys are let go, so a chord released out of order would otherwise read ragged
   from one column to the next.
6. **`loops.runs` is the only thing that knows what a tie means.** It reads a
   strip as runs — a pitch, the step it starts on, how many steps it rings — and
   both the player and the file writer go through it. A run may carry past the
   end of the loop and round to the start, which is where a punched-in part can
   land once the strip has been turned. A tie with nothing left to carry on is
   struck rather than dropped, so no edit can silence a note without showing it.
7. **Punching in waits for the bar.** With the clock already running, the loops
   underneath are the beat to come in on. The strip is then turned so the step
   the punch-in landed on becomes step 0 (`loops.rotate`) — the part plays back
   against what it was played against, and nothing has to carry an offset around
   afterwards.
8. **Edits are whole strips.** Every function in `loops.js` returns a new step
   array and leaves the one it was given alone, so undo is a matter of keeping
   the old array rather than working out how to reverse a change. The history is
   the same shape as `src/fs/js/history.js`, rewritten here rather than
   imported: that file is about text and selections, and lives outside the
   folder `sw.js` caches — a PWA that reaches out of its own directory is a PWA
   that breaks offline.

## The editor

`Edit` lays a grid over the same panel: four rows for the four notes that can
sound at once, eight step columns of the sequence at a time.

| Button | Does |
| --- | --- |
| ◀ ▶ | Moves the cursor, scrolling the window when it reaches the edge |
| Ins / Del | Opens or closes an empty step — this is how a rhythm is written |
| Tie | Holds whatever was ringing in the step before through this one, and moves on, so a note is made longer by tapping |
| ↶ ↷ | Undo and redo, per loop |

◀ and ▶ come first in the bar and are the widest things in it, with a gap as
wide as they are between them. They are what a hand reaches for most in here,
and a mis-hit steps the wrong way through the sequence; the gap is there to be
missed into. The octave pair on the main toolbar is the same width, from the
same `--thumb`. Where a phone is too narrow for one row of buttons the bar wraps
onto two rather than shrinking them — the height is the point.

Playing the keys writes into the cursor step: the first note of a chord clears
what was there, the rest fill the rows beside it, and letting go of the last one
moves on. Tapping a cell only moves the cursor there. It used to clear the note
under the finger as well, which made aiming an edit and every misjudged tap a
lost note; a tap is for pointing. A step is changed by playing over it, or taken
out with Del.

A run reads across a row as `C4 — — —`, the way a piano roll draws it: the name
where it is struck, the fill carrying on through its ties.

## The transport, and why it is not the library's

`tinysynth` can play a Standard MIDI File, which looked like the cheapest way to
build a recorder. It is not, for two reasons that are plain in the source:
`loadMIDI` ends with `this.reset(); this.locateMIDI(0);` — it resets all sixteen
channels and silences every one of them — and the synth holds exactly one
`song`. Loops that start and stop independently cannot live in one song:
pressing Play on the third would cut off the other two and the player's chord
with them, and reset the voice they were using.

So the loops are scheduled here, in `recorder.js`, with the usual Web Audio
look-ahead: a 25 ms timer hands the synth every note due in the next 150 ms,
each stamped with the exact time it should sound. `noteOn(ch, note, vel, when)`
takes that time, so a late timer never makes a late loop.

A file carries a track per loop, so one saved when there were fewer of them
still opens: the channels it has fill the loops they name and the rest stay
empty.

```
wall clock   |----x----x----x----x----x----|   the timer, roughly every 25ms
audio clock  |--1--2--3--4--5--6--7--8--9--|   steps, exactly on time
                  \____ scheduled ahead, up to HORIZON
```

What the library is very good at is *reading* a MIDI file, so that is what it is
used for. `smf.js` writes the four loops as a type 1 file — a tempo track, then
one track per loop on its own channel with its own program — and Load hands the
bytes back to `synth.loadMIDI()` and reads the loops out of `synth.song.ev`.
A run goes in as one note of that length, which is what anything else reading
the file would expect to find, and comes back out as a strike and its ties.
Only the writer is ours. A loop's length is carried by an undefined controller
(CC 119) at its last tick: End of Track would say it, but the library's parser
stops at that event rather than recording it, and without it a loop edited to
end in silence would come back short.

Because `loadMIDI` resets the synth, Load puts the app's own state back
afterwards: master volume, the voice the hands are playing, and each loop's
program.

`Play all` starts every loop that has something in it, and stops everything when
pressed again. From a standstill the clock starts at step 0, so the parts begin
together — eight taps to start a song means seven of them join late.

## A whole song is the other job

A loaded file is two things at once, and they want two different players.

Split across the loops it is something to play with: take a part, edit it, jam
over it. That is `smf.decode`, and it is **lossy on purpose**. Eight loops have
eight channels between them where a song has sixteen, so channel 0 and the drums
on channel 9 have nowhere to go, and the grid is eighth notes where a song is
not. Measured on a real five minute file, of 8436 note-ons:

| | |
| --- | --- |
| on channels 1–8, the only ones a loop can hold | 4527 |
| lost with channel 0 and 9–15 — the lead, and the whole kit | 3909 |
| lost to the four-notes-a-step ceiling | 94 |
| distinct onsets merged onto the eighth note grid | 32% |

Played whole it is the song, and there the library's player is right and ours is
not: every channel including the drums, the file's own timing rather than a
grid, and its tempo map followed as it goes. The reason our transport exists —
loops starting and stopping under hands that are still playing — is not
something a song needs. So the song gets `playMIDI`, and the song bar under the
loops is `playMIDI` / `stopMIDI` / `locateMIDI` with `getPlayStatus` read back
every 200 ms.

Two things follow from the song owning the synth while it runs:

* Starting it stops the loops, and starting a loop stops it. One transport at a
  time — they would otherwise be sending on the same channels.
* A song sends its own program changes and channel volumes and stopping it does
  not take them back, so the app's voices go on again afterwards. That happens
  when a song runs off its own end as well as when it is stopped, which is why
  it is the watcher's timer rather than the player that says a run is in
  progress.

Where a song is in seconds is worked out by `smf.clock`, once, when the file is
read: the player rewrites `song.tempo` as it goes, so the position cannot be
had from whatever that says at the time. The parser multiplies the file's
division by four, so `timebase` counts ticks to a whole note — which is where
the four in `4 * 60 / bpm / timebase` comes from, in that function and in the
library's own `tick2Time`.

Parts of a file that nothing marked the end of are somebody else's song rather
than loops we wrote, and they all get the length of the longest. Left at their
own lengths each comes round at a different moment and the song comes apart —
the shortest part first, and after that never in phase again. Our own files
carry CC 119 at every loop's end, so they keep the lengths they were saved with:
a one bar loop under a four bar one is the point of them.

## Audio

The synth is created at load but a browser will not start audio outside a
gesture, so `wakeAudio` resumes the context on the first touch or key press.
Notes are all stopped on `visibilitychange` and `blur` — `panic`, which stops
the loops too: a note left ringing while the phone is elsewhere is the worst bug
a piano can have. That is separate from `silence`, which the octave buttons use:
the board moving under the hands has nothing to do with a loop playing.

## The vendored synth

`webaudio-tinysynth.js` is taken verbatim from
`https://raw.githubusercontent.com/g200kg/webaudio-tinysynth/master/webaudio-tinysynth.js`
(fetched 2026-08-18, 62,036 bytes, Apache-2.0 — the same licence as this
project, which already vendors SJCL the same way). It is unmodified, so it can
be re-fetched and diffed. The parts used are `new WebAudioTinySynth(opts)`,
`setMasterVol`, `setProgram`, `noteOn`, `noteOff`, `allSoundOff`, `loadMIDI`,
`song` and `actx`.

The test suite builds a real one over a stub Web Audio for the round trip, so
the file the app writes is proved against the library's own parser rather than
against a second implementation of the same idea.

## Not done yet

* No MIDI in or out over Web MIDI, and no metronome — a count-in is the punch-in
  bar, which is only a count-in when something is already playing.
* Note lengths are whole steps. A note cannot start or stop between two of them,
  which is what quantising to a grid costs.
* Eight columns is a lot to fit across a third of a phone in portrait. It works,
  but the buttons are near the smallest a thumb wants; a ninth loop would need
  the panel laid out differently, not just `loops.COUNT` raised.
* One note of a chord cannot be taken out on its own any more: a step is
  rewritten by playing over it, or removed whole with Del. `loops.clearCell` is
  still there, and still tested, for the day that gets a button of its own.
* Reading a file is no longer quadratic — `loops.writer` writes into one strip
  instead of copying it once per note, and a five minute song went from 1.75 s
  to 49 ms — but the loops it fills are still on an eighth note grid at one
  tempo. Song mode is the answer to that, not a finer grid.
* A song plays every channel, so it plays over the hands as well: while one
  runs, channel 0 is the song's and the Voice selector is not what is heard.
* Velocity is fixed at 100: a touch screen reports `pressure`, but it is not
  meaningful on most hardware.
* Loops live in memory and in whatever `.mid` file you saved. Nothing is written
  to storage on its own.
