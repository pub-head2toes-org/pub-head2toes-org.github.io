# Plan: (PWA) Bandage — 25 piano keys

A single-page PWA under `/pwa/bandage/`: 25 piano keys filling the lower two
thirds of the screen, played through
[webaudio-tinysynth](https://github.com/g200kg/webaudio-tinysynth) (Apache-2.0,
vendored). The upper third is left empty, reserved for what comes next.

## Entry

`index.html` — no parameters, nothing to join, no network. Opening the page is
the whole hand-off. It is the first PWA here that stands on its own rather than
arriving from `joint`'s lobby.

`error.html` is reached only when the browser has no `AudioContext`, which is
the one condition that makes the app pointless to draw.

## Architecture decisions

1. **The arithmetic is separate from the page.** `keys.js` knows the layout —
   which notes, which are black, where each sits on a keyboard one unit wide,
   what a typed letter means — and touches neither DOM nor synth. `bandage.js`
   is the wiring. This is the split `idcard.js`/`Reg.html` and
   `history.js`/`textedit.js` already use here, and it is what lets the layout
   be tested as numbers (`tests/bandage.test.js`).
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

## Layout

```
+-------------------------------------+
|  #stage        reserved, 33.3333%   |
+-------------------------------------+
|  #toolbar      voice, octave,       |
|                volume, sustain      |
|  #keyboard     the 25 keys, filling |
|                what is left         |
+-------------------------------------+
```

The reserved panel is a flex item at `0 0 33.3333%`; the console takes the rest,
so anything that lands in the stage later cannot push the keys off screen.

## Controls

| Control | Does |
| --- | --- |
| Voice | 12 General MIDI programs, piano first |
| Octave &minus; / + | Moves the 25 keys by an octave, C0 to C7 |
| Volume | Master volume |
| Sustain | Notes keep ringing after release until it is switched off |
| Playing | The notes sounding, by name |

Keys can be played by touch (polyphonic), mouse, or the computer keyboard:
`z s x d c v g b h n j m` for the lower octave, `q 2 w 3 e r 5 t 6 y 7 u i` for
the upper, arrow keys for the octave shift.

## Audio

The synth is created at load but a browser will not start audio outside a
gesture, so `wakeAudio` resumes the context on the first touch or key press.
Notes are all stopped on `visibilitychange` and `blur`: a note left ringing
while the phone is elsewhere is the worst bug a piano can have.

## The vendored synth

`webaudio-tinysynth.js` is taken verbatim from
`https://raw.githubusercontent.com/g200kg/webaudio-tinysynth/master/webaudio-tinysynth.js`
(fetched 2026-08-18, 62,036 bytes, Apache-2.0 — the same licence as this
project, which already vendors SJCL the same way). It is unmodified, so it can
be re-fetched and diffed. The parts used are `new WebAudioTinySynth(opts)`,
`setMasterVol`, `setProgram`, `noteOn`, `noteOff`, `allSoundOff` and `actx`.

## Not done yet

* The reserved third is empty by design — that is the next piece of work.
* No recording, no MIDI in/out, no metronome. `tinysynth` can play SMF, which
  makes a recorder the cheapest of those to add.
* Velocity is fixed at 100: a touch screen reports `pressure`, but it is not
  meaningful on most hardware.
