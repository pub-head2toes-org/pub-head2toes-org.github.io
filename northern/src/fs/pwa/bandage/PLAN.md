# Plan: (PWA) Bandage — 25 piano keys

A single-page PWA under `/pwa/bandage/`: 25 piano keys filling the lower two
thirds of the screen, played through
[webaudio-tinysynth](https://github.com/g200kg/webaudio-tinysynth) (Apache-2.0,
vendored). The upper third holds four loop channels - record a part, and it
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
3. **Geometry in fractions, not pixels.** `keys.layout` returns `left`/`width`
   as fractions of the board, written into CSS as percentages. The keyboard is
   then resolution-independent — phone, tablet or desktop, portrait or
   landscape — with no resize handler and no canvas.
4. **A black key straddles the line between two white keys.** Centring it on
   that boundary puts the gaps at E–F and B–C by itself, with no table of
   exceptions.
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
| Tempo | 40 to 240 bpm — one clock, shared by all four loops |
| Playing | The notes sounding, by name |

Keys can be played by touch (polyphonic), mouse, or the computer keyboard:
`z s x d c v g b h n j m` for the lower octave, `q 2 w 3 e r 5 t 6 y 7 u i` for
the upper, arrow keys for the octave shift.

## The loops

Four of them, laid out as the spec asks: the functions down the side, the four
channels across.

| | Loop 1 | Loop 2 | Loop 3 | Loop 4 |
| --- | --- | --- | --- | --- |
| **Play** | ▶ | ▶ | ▶ | ▶ |
| **Record** | ● | ● | ● | ● |
| **Edit** | ✎ | ✎ | ✎ | ✎ |

1. **A loop is a strip of steps; a step is up to four notes at once.** A step is
   an eighth note, so a rest is a real thing that takes up room — which is what
   makes the editor's insert and delete of an empty step the way a rhythm is
   written, rather than a curiosity.
2. **One loop is one MIDI channel is one instrument.** Loops take channels 1 to
   4 and the player's hands keep channel 0, so a loop starting can never cut off
   a note being held. A MIDI channel is polyphonic, so four notes at once needs
   no plumbing at all. The instrument is whatever the Voice selector says when
   Record is pressed, so a part plays back as it sounded while it was played.
3. **One clock, not four.** Every loop reads its step off one counter, wrapping
   at its own length — `steps[tick % length]`. Four transports would drift; one
   counter cannot.
4. **Recording is real time, quantised.** Each note lands on the nearest step,
   which is both how a player wants to record and exactly the grid the editor
   draws. The strip is then trimmed of trailing silence and rounded up to a
   whole bar of 8 steps, so loops of different lengths still come round together.
5. **Punching in waits for the bar.** With the clock already running, the loops
   underneath are the beat to come in on. The strip is then turned so the step
   the punch-in landed on becomes step 0 (`loops.rotate`) — the part plays back
   against what it was played against, and nothing has to carry an offset around
   afterwards.
6. **Edits are whole strips.** Every function in `loops.js` returns a new step
   array and leaves the one it was given alone, so undo is a matter of keeping
   the old array rather than working out how to reverse a change. The history is
   the same shape as `src/fs/js/history.js`, rewritten here rather than
   imported: that file is about text and selections, and lives outside the
   folder `sw.js` caches — a PWA that reaches out of its own directory is a PWA
   that breaks offline.

## The transport, and why it is not the library's

`tinysynth` can play a Standard MIDI File, which looked like the cheapest way to
build a recorder. It is not, for two reasons that are plain in the source:
`loadMIDI` ends with `this.reset(); this.locateMIDI(0);` — it resets all sixteen
channels and silences every one of them — and the synth holds exactly one
`song`. Four loops that start and stop independently cannot live in one song:
pressing Play on the third would cut off the other two and the player's chord
with them, and reset the voice they were using.

So the loops are scheduled here, in `recorder.js`, with the usual Web Audio
look-ahead: a 25 ms timer hands the synth every note due in the next 150 ms,
each stamped with the exact time it should sound. `noteOn(ch, note, vel, when)`
takes that time, so a late timer never makes a late loop.

```
wall clock   |----x----x----x----x----x----|   the timer, roughly every 25ms
audio clock  |--1--2--3--4--5--6--7--8--9--|   steps, exactly on time
                  \____ scheduled ahead, up to HORIZON
```

What the library is very good at is *reading* a MIDI file, so that is what it is
used for. `smf.js` writes the four loops as a type 1 file — a tempo track, then
one track per loop on its own channel with its own program — and Load hands the
bytes back to `synth.loadMIDI()` and reads the loops out of `synth.song.ev`.
Only the writer is ours. A loop's length is carried by an undefined controller
(CC 119) at its last tick: End of Track would say it, but the library's parser
stops at that event rather than recording it, and without it a loop edited to
end in silence would come back short.

Because `loadMIDI` resets the synth, Load puts the app's own state back
afterwards: master volume, the voice the hands are playing, and each loop's
program.

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
* A loop's notes are one step long. No ties, no note lengths in the editor.
* Velocity is fixed at 100: a touch screen reports `pressure`, but it is not
  meaningful on most hardware.
* Loops live in memory and in whatever `.mid` file you saved. Nothing is written
  to storage on its own.
