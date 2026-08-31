'use strict';

/**
 * The sixteen loops: the transport, the table that drives them, and the editor.
 *
 * `loops.js` holds the arithmetic and `smf.js` the file format; this file is
 * the wiring, the way `bandage.js` is the wiring for the keys.
 *
 * There are two transports here, because there are two jobs.
 *
 * The loops are scheduled here rather than by the library. `tinysynth` can play
 * a Standard MIDI File, but `loadMIDI` ends in `reset()` and `locateMIDI(0)` -
 * it resets all sixteen channels and silences them - and the synth holds
 * exactly one song. Sixteen loops that start and stop independently, under
 * hands that are still playing, cannot live in one song: starting the third
 * would cut off the other two and the player's chord with them.
 *
 * A whole song is the other job, and there the library's player is the right
 * one and ours is not - see the song section below. `smf.js` reads and writes
 * the file either way, which is what the library is best at.
 *
 * Scheduling is the usual Web Audio look-ahead: a coarse timer wakes often and
 * hands the synth every note due in the next fraction of a second, stamped with
 * the exact time it should sound. `noteOn(ch, note, velocity, when)` takes that
 * time, so the timer being late by a few milliseconds never makes a loop late.
 *
 *     wall clock   |----x----x----x----x----x----|   the timer, every 25ms
 *     audio clock  |--1--2--3--4--5--6--7--8--9--|   steps, exactly on time
 *                       \____ scheduled ahead, up to HORIZON
 */

const TIMER_MS = 25;              // how often the scheduler wakes
const HORIZON = 0.15;             // seconds of notes handed over each time
const EDIT_COLUMNS = 8;           // steps visible in the editor at once
const SONG_MS = 200;              // how often a playing song's position is read back

/** The three rows of the loop table, in the order they are drawn. */
const FUNCTIONS = [
  { key: 'play', label: 'Play', verb: 'Play', glyph: '\u25B6' },
  { key: 'record', label: 'Record', verb: 'Record', glyph: '\u25CF' },
  { key: 'edit', label: 'Edit', verb: 'Edit', glyph: '\u270E' }
];

const rec = {
  loops: loops.blank(),
  /** the loops sounding, by index */
  running: new Set(),
  /** the loop being recorded into, or null */
  recording: null,
  /** the loop open in the editor, or null */
  editing: null,
  /** the global step counter every loop reads off */
  tick: 0,
  /** the audio time of the next step to be scheduled */
  nextTime: 0,
  timer: null,
  /** where a recording's step 0 sits: the tick, and the audio time of it */
  originTick: 0,
  origin: 0,
  /** where the editor is writing, and the leftmost column it is showing */
  cursor: 0,
  offset: 0,
  /** one undo stack per loop */
  histories: [],
  /** the notes of the chord being entered in the editor */
  pending: new Set(),
  /** midi -> the step it was struck on, for keys still down while recording */
  held: new Map(),
  /** the loaded file, playable whole: {clock}, or null before one is read */
  song: null,
  songTimer: null,
  /** true while a finger is on the seek bar, so it is not dragged from under it */
  scrubbing: false,
  /** the last thing the transport line said, so it is not written every 25ms */
  said: '',
  elements: {}
};

const now = () => (app.synth && app.synth.actx ? app.synth.actx.currentTime : 0);
const history = (index) => rec.histories[index];

/** When a step of the clock falls, forwards or back from where it has got to. */
function tickTime(tick) {
  return rec.nextTime + ((tick - rec.tick) * loops.stepSeconds(app.bpm));
}

/* --------------------------------------------------------------- transport */

/** Wakes the scheduler. Idempotent: every loop shares the one clock. */
function startClock() {
  if (rec.timer !== null) {
    return;
  }
  rec.nextTime = now() + 0.05;
  rec.timer = setInterval(pump, TIMER_MS);
  pump();
}

/** Stops the clock and everything it was sounding. */
function stopClock() {
  if (rec.timer !== null) {
    clearInterval(rec.timer);
    rec.timer = null;
  }
  for (let i = 0; i < loops.COUNT; i++) {
    app.synth.allSoundOff(loops.channel(i));
  }
  rec.tick = 0;
}

/** Nothing playing and nothing recording: no reason to keep a timer alive. */
function idleCheck() {
  if (rec.running.size === 0 && rec.recording === null) {
    stopClock();
  }
}

/** Hands the synth every step that falls inside the horizon, then draws. */
function pump() {
  const step = loops.stepSeconds(app.bpm);
  const limit = now() + HORIZON;
  let guard = 64;                        // a stall must not become a burst

  // A hang, or a tab put to the back, leaves the clock behind the audio. The
  // steps that were missed are skipped rather than fired off all at once, and
  // whole ones, so the loops come back in phase rather than merely in time.
  const late = now() - rec.nextTime;
  if (late > 0) {
    const skipped = Math.floor(late / step) + 1;
    rec.tick += skipped;
    rec.nextTime += skipped * step;
  }

  while (rec.nextTime < limit && guard-- > 0) {
    sound(rec.tick, rec.nextTime, step);
    rec.tick += 1;
    rec.nextTime += step;
  }
  showTransport();
}

/**
 * The runs of a strip, worked out once per edit rather than once per step.
 *
 * Every edit in `loops.js` returns a *new* array, so the array itself is the
 * cache key: a strip that has not been replaced has not changed.
 */
const runsOf = (() => {
  const seen = new WeakMap();
  return (steps) => {
    if (!seen.has(steps)) {
      seen.set(steps, loops.runs(steps, true));
    }
    return seen.get(steps);
  };
})();

/**
 * One step of every running loop, on its own channel and its own instrument.
 *
 * A note is struck only where its run begins, and stops at the end of the run,
 * so a note tied across four steps is one note four steps long rather than four
 * notes one step long. The gate leaves a hair of silence before the next step,
 * which is what keeps a repeated note from sounding tied.
 */
function sound(tick, at, step) {
  rec.running.forEach((index) => {
    const loop = rec.loops[index];
    const length = loop.steps.length;
    if (length === 0) {
      return;
    }
    const here = ((tick % length) + length) % length;
    const channel = loops.channel(index);

    runsOf(loop.steps).forEach((run) => {
      if (run.at !== here) {
        return;
      }
      app.synth.noteOn(channel, run.midi, loops.VELOCITY, at);
      app.synth.noteOff(channel, run.midi, at + ((run.length - 1 + loops.GATE) * step));
    });
  });
}

/* --------------------------------------------------------------------- song
 *
 * A loaded file is two things at once, and they want two different players.
 *
 * Split across the loops it is something to play with: take a part, edit it,
 * jam over it. That is `smf.decode`, and every channel of the file now has a
 * loop to land in - a loop's index is its channel - so nothing is dropped for
 * want of somewhere to go. It is still lossy: the grid is eighth notes where a
 * song is not, and velocity, bend and the rest of the controllers are not
 * things a loop holds.
 *
 * Played whole it is the song, and the library's own player is right for that
 * and ours is not: every channel including the drums, the file's own timing
 * rather than a grid, and its tempo map followed as it goes. The reason our
 * transport exists - loops starting and stopping under hands that are playing -
 * is not a thing a song needs. So the song gets `playMIDI`, and it owns the
 * synth while it runs: the loops stop, and the voices go back on afterwards.
 */

function songPlaying() {
  return !!(rec.song && app.synth.getPlayStatus && app.synth.getPlayStatus().play);
}

function playSong() {
  if (!rec.song || songPlaying()) {
    return;
  }
  stopAll();
  app.synth.playMIDI();
  if (rec.songTimer === null) {
    rec.songTimer = setInterval(watchSong, SONG_MS);
  }
  showSong();
}

function stopSong() {
  if (!rec.song) {
    return;
  }
  // A song that has run off its own end is no longer playing, and still has to
  // be cleared up after: the timer is what says a run is in progress, not the
  // player. Its last notes are left to ring rather than being cut off.
  const running = rec.songTimer !== null || songPlaying();
  if (songPlaying()) {
    app.synth.stopMIDI();
  }
  if (rec.songTimer !== null) {
    clearInterval(rec.songTimer);
    rec.songTimer = null;
  }
  if (running) {
    restoreVoices();
  }
  showSong();
}

/**
 * A song sends its own program changes and channel volumes, on every channel it
 * touches, and stopping it does not take them back. So the loops' voices go on
 * again after one: otherwise each loop comes back as whatever the song left on
 * its channel.
 *
 * The keys are not touched here. They are on their own synth now, and a song
 * played on the loops' one cannot reach them.
 */
function restoreVoices() {
  for (let index = 0; index < loops.COUNT; index++) {
    const channel = loops.channel(index);
    app.synth.resetAllControllers(channel);
    app.synth.setChVol(channel, 100);
  }
  setVolume(Number(app.elements.volume.value) / 100);
  rec.loops.forEach((loop, index) =>
    app.synth.setProgram(loops.channel(index), loop.program));
}

/** The song runs itself; this only reads where it has got to, and notices the end. */
function watchSong() {
  if (rec.song && !songPlaying()) {
    stopSong();                            // it reached the end on its own
    return;
  }
  showSong();
}

function seekSong(fraction) {
  if (!rec.song) {
    return;
  }
  const ticks = app.synth.getPlayStatus().maxTick || rec.song.clock.ticks;
  app.synth.locateMIDI(Math.round(Math.min(1, Math.max(0, fraction)) * ticks));
  showSong();
}

/* ------------------------------------------------------------------ buttons */

function togglePlay(index) {
  stopSong();                            // one transport at a time
  if (rec.recording === index) {
    return;                              // it is being recorded, not played
  }
  if (rec.running.has(index)) {
    rec.running.delete(index);
    app.synth.allSoundOff(loops.channel(index));
    idleCheck();
  } else {
    if (rec.loops[index].steps.length === 0) {
      return;                            // nothing recorded yet
    }
    app.synth.setProgram(loops.channel(index), rec.loops[index].program);
    rec.running.add(index);
    startClock();
  }
  showTable();
}

/**
 * Every loop with something in it, from one press - and everything stopped from
 * the same press. A song split across the loops needs all sixteen going
 * together, and sixteen taps to start it means fifteen of them join late.
 *
 * From a standstill the clock starts at step 0, so the parts begin together.
 */
function toggleAll() {
  stopSong();
  if (rec.running.size > 0 || rec.recording !== null) {
    stopAll();
    return;
  }
  rec.loops.forEach((loop, index) => {
    if (loop.steps.length === 0) {
      return;
    }
    app.synth.setProgram(loops.channel(index), loop.program);
    rec.running.add(index);
  });
  if (rec.running.size > 0) {
    startClock();
  }
  showTable();
}

/**
 * Record clears the loop and writes what is played into it, quantised. The
 * other loops keep going underneath, which is what makes this an overdub: the
 * player hears the parts already down while adding the next.
 *
 * The instrument is taken from the Voice selector as recording starts, so the
 * loop plays back as the part sounded while it was being played.
 */
function toggleRecord(index) {
  stopSong();
  if (rec.recording === index) {
    finishRecording();
    showTable();
    return;
  }
  if (rec.recording !== null) {
    finishRecording();
  }
  closeEditor();

  const program = Number(app.elements.voice.value) || 0;
  rec.held.clear();
  rec.loops[index] = loops.create(program);
  rec.running.delete(index);
  app.synth.allSoundOff(loops.channel(index));
  app.synth.setProgram(loops.channel(index), program);
  rec.recording = index;

  // Punching in on the bar: with the clock already running, the loops underneath
  // are the beat to come in on, and a part that starts anywhere else would be
  // out of step with them. From stopped, the clock starts here and now.
  const fresh = rec.timer === null;
  startClock();
  rec.originTick = fresh ? 0 : Math.ceil(rec.tick / loops.BAR) * loops.BAR;
  rec.origin = tickTime(rec.originTick);
  showTable();
}

/**
 * Ends a recording: the trailing silence is trimmed off and the strip rounded
 * up to a whole bar, so loops of different lengths still come round together
 * instead of drifting apart, and then it starts playing.
 */
function finishRecording() {
  const index = rec.recording;
  if (index === null) {
    return;
  }
  // A key still down when Record is pressed again ends here, not nowhere.
  [...rec.held.keys()].forEach(releaseIntoLoop);
  rec.recording = null;

  const loop = rec.loops[index];
  loop.steps = loops.padToBar(loops.trim(loops.tidy(loop.steps)));
  loop.steps = loops.rotate(loop.steps, rec.originTick);
  rec.histories[index] = loops.history(loop.steps);

  if (loop.steps.length > 0) {
    rec.running.add(index);
    startClock();
  } else {
    idleCheck();
  }
}

/** Everything stops: the page was hidden, or the keys were silenced. */
function stopAll() {
  rec.recording = null;
  rec.running.clear();
  rec.pending.clear();
  rec.held.clear();
  stopClock();
  showTable();
}

/* -------------------------------------------------------------------- input
 *
 * What the player strikes, as `bandage.js` announces it. Where it goes depends
 * on what is open: the editor writes it into the grid, a recording quantises it
 * onto the clock, and otherwise it is just a note being played.
 */

function observe(kind, midi) {
  if (kind === 'silence') {
    rec.pending.clear();
    stopSong();
    stopAll();
    return;
  }
  if (rec.editing !== null) {
    editorInput(kind, midi);
    return;
  }
  if (rec.recording === null) {
    return;
  }
  if (kind === 'on') {
    strikeIntoLoop(midi);
  } else {
    releaseIntoLoop(midi);
  }
}

/** The step the clock is on now, as the recording counts them. */
function recordingStep() {
  return loops.quantise(now() - rec.origin, app.bpm);
}

/**
 * A key struck: the note goes down on the step it was played on, so the player
 * sees it at once, and the step is kept so that letting go can fill in the rest.
 */
function strikeIntoLoop(midi) {
  const elapsed = now() - rec.origin;
  if (elapsed < -(loops.stepSeconds(app.bpm) / 2)) {
    return;                              // still counting in to the bar
  }
  if (rec.held.has(midi)) {
    return;                              // two fingers on one key: the first holds it
  }
  const at = loops.quantise(elapsed, app.bpm);
  rec.held.set(midi, at);
  const loop = rec.loops[rec.recording];
  loop.steps = loops.setNote(loop.steps, at, null, midi);
  showTransport();
}

/**
 * A key let go: every step from the one it was struck on to the one before the
 * release gets the note, so a long press comes back as a long note rather than
 * as a blip in a single slot.
 */
function releaseIntoLoop(midi) {
  if (!rec.held.has(midi)) {
    return;
  }
  const from = rec.held.get(midi);
  rec.held.delete(midi);
  const loop = rec.loops[rec.recording];
  loop.steps = loops.holdNote(loop.steps, from, recordingStep() - 1, midi);
  showTransport();
}

/* ------------------------------------------------------------------- editor */

function openEditor(index) {
  if (rec.recording === index) {
    finishRecording();
  }
  rec.editing = index;
  rec.cursor = 0;
  rec.offset = 0;
  rec.pending.clear();
  if (!rec.histories[index]) {
    rec.histories[index] = loops.history(rec.loops[index].steps);
  }
  rec.elements.editor.hidden = false;
  rec.elements.editorTitle.textContent = `Loop ${index + 1}`;
  drawEditor();
  showTable();
}

function closeEditor() {
  if (rec.editing === null) {
    return;
  }
  rec.editing = null;
  rec.pending.clear();
  rec.elements.editor.hidden = true;
  showTable();
}

/** Keeps the cursor inside the window the editor is showing. */
function follow() {
  if (rec.cursor < rec.offset) {
    rec.offset = rec.cursor;
  }
  if (rec.cursor >= rec.offset + EDIT_COLUMNS) {
    rec.offset = rec.cursor - EDIT_COLUMNS + 1;
  }
  if (rec.offset < 0) {
    rec.offset = 0;
  }
}

/**
 * The notes under the cursor, sounded as the loop would sound them: its own
 * channel and instrument, one step long, gated like playback.
 *
 * Moving the cursor is reading the part, and a part is read by ear. The grid
 * says which pitches are in a column but not what they are together, and a tie
 * says a note goes on ringing without saying what it is - so a column of ties
 * sounds too. What is heard is what is sounding at that point in the loop.
 *
 * Nothing is sounded while the loop being edited is already playing, or while
 * the song is: it can be heard, and an audition on a channel something else is
 * using would cut its notes off at the gate rather than let them ring.
 */
function audition() {
  const step = rec.loops[rec.editing].steps[rec.cursor];
  if (!step || rec.running.has(rec.editing) || songPlaying()) {
    return;                              // past the end, or already sounding
  }
  const channel = loops.channel(rec.editing);
  const at = now();
  const until = at + (loops.stepSeconds(app.bpm) * loops.GATE);

  app.synth.setProgram(channel, rec.loops[rec.editing].program);
  step.forEach((note) => {
    if (note === null) {
      return;
    }
    app.synth.noteOn(channel, loops.pitch(note), loops.VELOCITY, at);
    app.synth.noteOff(channel, loops.pitch(note), until);
  });
}

function moveCursor(by) {
  if (rec.editing === null) {
    return;
  }
  rec.cursor = Math.max(0, rec.cursor + by);
  follow();
  drawEditor();
  audition();
}

/** An edit, recorded so that one Undo takes it back. */
function applyEdit(change) {
  if (rec.editing === null) {
    return;
  }
  const loop = rec.loops[rec.editing];
  loop.steps = change(loop.steps);
  history(rec.editing).record(loop.steps);
  drawEditor();
}

function undoEdit(redo) {
  if (rec.editing === null) {
    return;
  }
  const stack = history(rec.editing);
  const steps = redo ? stack.redo() : stack.undo();
  if (steps !== null) {
    rec.loops[rec.editing].steps = steps;
  }
  drawEditor();
}

/**
 * Notes played while the editor is open are written into the cursor column.
 * The first note of a chord clears what was there - that is the overwrite -
 * and the rest fill the rows beside it. Letting go of the last one moves on,
 * so a part can be entered chord by chord without touching the screen.
 */
function editorInput(kind, midi) {
  const loop = rec.loops[rec.editing];

  if (kind === 'on') {
    if (rec.pending.size === 0) {
      const cleared = loops.extend(loop.steps, rec.cursor);
      cleared[rec.cursor] = loops.emptyStep();
      loop.steps = cleared;
    }
    rec.pending.add(midi);
    loop.steps = loops.setNote(loop.steps, rec.cursor, null, midi);
    drawEditor();
    return;
  }

  rec.pending.delete(midi);
  if (rec.pending.size === 0) {
    history(rec.editing).record(loop.steps);
    rec.cursor += 1;
    follow();
    drawEditor();
  }
}

/* --------------------------------------------------------------------- view */

function showTable() {
  for (let i = 0; i < loops.COUNT; i++) {
    const playing = rec.running.has(i);
    const empty = rec.loops[i].steps.length === 0;
    const play = rec.elements.play[i];
    const record = rec.elements.record[i];
    const edit = rec.elements.edit[i];

    play.setAttribute('aria-pressed', String(playing));
    play.disabled = empty && !playing;
    record.setAttribute('aria-pressed', String(rec.recording === i));
    record.classList.toggle('armed', rec.recording === i);
    edit.setAttribute('aria-pressed', String(rec.editing === i));
  }

  const anything = rec.running.size > 0 || rec.recording !== null;
  const all = rec.elements.all;
  all.textContent = anything ? 'Stop all' : 'Play all';
  all.setAttribute('aria-pressed', String(anything));
  all.disabled = !anything && rec.loops.every(loop => loop.steps.length === 0);
  showTransport();
}

/** The song bar: hidden until a file has been read, then where it has got to. */
function showSong() {
  const bar = rec.elements.songBar;
  if (!bar) {
    return;
  }
  bar.hidden = !rec.song;
  if (!rec.song) {
    return;
  }
  const status = app.synth.getPlayStatus();
  const ticks = status.maxTick || rec.song.clock.ticks;
  const playing = !!status.play;

  rec.elements.songTime.textContent =
    `${smf.mmss(rec.song.clock.at(status.curTick))} / ${smf.mmss(rec.song.clock.seconds)}`;
  rec.elements.songPlay.textContent = playing ? '\u25A0' : '\u25B6';
  rec.elements.songPlay.setAttribute('aria-pressed', String(playing));
  rec.elements.songPlay.setAttribute('aria-label', playing ? 'Stop the song' : 'Play the whole song');
  if (!rec.scrubbing) {
    rec.elements.songSeek.value =
      String(ticks ? Math.round(1000 * status.curTick / ticks) : 0);
  }
}

/** One line saying what the transport is doing, and where in the bar it is. */
function showTransport() {
  let text = 'Stopped';
  if (rec.recording !== null) {
    const steps = rec.loops[rec.recording].steps.length;
    text = rec.tick < rec.originTick
      ? `Loop ${rec.recording + 1} · in on the bar`
      : `Recording loop ${rec.recording + 1} · ${steps} steps`;
  } else if (rec.running.size > 0) {
    const beat = (rec.tick % loops.BAR) + 1;
    text = `Playing ${rec.running.size} · step ${beat}/${loops.BAR}`;
  }
  if (text !== rec.said) {
    rec.said = text;
    rec.elements.transport.textContent = text;
  }
}

/** The grid: a row per note that can sound at once, a column per step. */
function drawEditor() {
  if (rec.editing === null) {
    return;
  }
  const loop = rec.loops[rec.editing];
  const body = rec.elements.grid;
  body.innerHTML = '';

  for (let row = 0; row < loops.ROWS; row++) {
    const line = document.createElement('tr');
    for (let column = 0; column < EDIT_COLUMNS; column++) {
      const at = rec.offset + column;
      const step = loop.steps[at];
      const note = step ? step[row] : null;

      const empty = note === null || note === undefined;
      const tied = loops.isTie(note);

      const cell = document.createElement('td');
      cell.className = 'cell';
      // A run reads across the row as `C4 — — —`, the way a piano roll draws it
      cell.textContent = empty ? '·' : (tied ? '—' : keys.name(note));
      cell.dataset.step = at;
      cell.dataset.row = row;
      cell.classList.toggle('at', at === rec.cursor);
      cell.classList.toggle('past', at >= loop.steps.length);
      cell.classList.toggle('filled', !empty);
      cell.classList.toggle('tied', tied);
      if (!empty) {
        cell.setAttribute('aria-label',
          `${keys.name(loops.pitch(note))}${tied ? ' held' : ''}`);
      }
      if (at % loops.BAR === 0) {
        cell.classList.add('bar');                 // where a bar begins
      }
      line.appendChild(cell);
    }
    body.appendChild(line);
  }

  const stack = history(rec.editing);
  rec.elements.undo.disabled = !stack.canUndo();
  rec.elements.redo.disabled = !stack.canRedo();
  rec.elements.editorTitle.textContent =
    `Loop ${rec.editing + 1} · ${rec.cursor + 1}/${loop.steps.length}`;
}

/* ------------------------------------------------------------- save and load
 *
 * Loops in memory are gone on reload, so they go out as a Standard MIDI File -
 * readable by anything, and re-read here by the library's own parser.
 */

function saveLoops() {
  const bytes = smf.encode(rec.loops, app.bpm, loops);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'bandage.mid';
  link.click();
  // Let the click be handled before the object url stops meaning anything.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function loadLoops(file) {
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    stopSong();
    stopAll();
    closeEditor();
    app.synth.loadMIDI(reader.result);      // the library reads the file...
    const read = smf.decode(app.synth.song, loops);   // ...and we read the library
    rec.loops = read.loops;
    rec.histories = rec.loops.map(loop => loops.history(loop.steps));

    // loadMIDI resets all sixteen channels of the loops' synth, so their state
    // goes back on. The keys are on the other synth and were never disturbed.
    setVolume(Number(app.elements.volume.value) / 100);
    rec.loops.forEach((loop, index) =>
      app.synth.setProgram(loops.channel(index), loop.program));
    setTempo(read.bpm);

    // The same bytes, kept whole. The loops are what was got out of the file;
    // this is the file itself, for playing as it was written.
    rec.song = { clock: smf.clock(app.synth.song) };
    showTable();
    showSong();
  };
  reader.readAsArrayBuffer(file);
}

/* --------------------------------------------------------------------- boot */

/**
 * Draws the loop table: the functions down the side, one column per loop.
 *
 * Sixteen columns across a phone leaves each button about as wide as a pencil,
 * so they go in banks of eight, one block above the other. Every loop is on the
 * table at once - a part is picked out of a song by looking for it, and half of
 * them behind a switch is half a song you cannot see.
 *
 * It is built rather than written out because `loops.COUNT` is what says how
 * many loops there are, and a table typed into the page by hand is a second
 * place to say it - one that can disagree.
 */
const BANK = 8;                          // loops to a block - see buildTable

function buildTable() {
  const table = document.getElementById('loop_table');
  FUNCTIONS.forEach((fn) => {
    rec.elements[fn.key] = [];
  });

  for (let from = 0; from < loops.COUNT; from += BANK) {
    const upto = Math.min(from + BANK, loops.COUNT);
    // A tbody a bank, each with its own row of numbers at the top: a thead
    // can only be had once, and the second block needs its numbers as much
    // as the first - eight buttons with nothing over them is a guess.
    const bank = document.createElement('tbody');
    bank.className = 'bank';

    const across = document.createElement('tr');
    across.className = 'bank-head';
    const corner = document.createElement('th');
    corner.setAttribute('scope', 'col');
    corner.textContent = 'Loop';
    across.appendChild(corner);

    for (let i = from; i < upto; i++) {
      const heading = document.createElement('th');
      heading.setAttribute('scope', 'col');
      heading.textContent = String(i + 1);
      // Channel 9 is the drum channel every MIDI file is written to, and
      // the synth plays a kit on it rather than a pitch. Worth saying:
      // otherwise this loop is the one that records as noise.
      if (loops.channel(i) === 9) {
        heading.classList.add('drums');
        heading.title = 'Drum channel';
      }
      across.appendChild(heading);
    }
    bank.appendChild(across);

    FUNCTIONS.forEach((fn) => {
      const row = document.createElement('tr');

      const label = document.createElement('th');
      label.setAttribute('scope', 'row');
      label.textContent = fn.label;
      row.appendChild(label);

      for (let i = from; i < upto; i++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `loop-button ${fn.key}`;
        button.id = `${fn.key}_${i}`;
        button.textContent = fn.glyph;
        button.setAttribute('aria-label', `${fn.verb} loop ${i + 1}`);
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => press(fn.key, i));

        const cell = document.createElement('td');
        cell.appendChild(button);
        row.appendChild(cell);
        rec.elements[fn.key].push(button);
      }
      bank.appendChild(row);
    });
    table.appendChild(bank);
  }
}

/** What a button in the table does, by the row it sits in. */
function press(what, index) {
  if (what === 'play') {
    togglePlay(index);
  } else if (what === 'record') {
    toggleRecord(index);
  } else {
    return rec.editing === index ? closeEditor() : openEditor(index);
  }
}

function initRecorder() {
  if (!app.synth) {
    return;                              // no Web Audio: bandage.js has left the page
  }
  rec.elements = {
    transport: document.getElementById('transport'),
    editor: document.getElementById('editor'),
    editorTitle: document.getElementById('editor_title'),
    grid: document.getElementById('edit_grid').querySelector('tbody'),
    undo: document.getElementById('edit_undo'),
    redo: document.getElementById('edit_redo'),
    file: document.getElementById('loop_file'),
    all: document.getElementById('loop_all'),
    songBar: document.getElementById('song_bar'),
    songPlay: document.getElementById('song_play'),
    songTime: document.getElementById('song_time'),
    songSeek: document.getElementById('song_seek')
  };

  buildTable();
  rec.histories = rec.loops.map(loop => loops.history(loop.steps));

  document.getElementById('edit_left').addEventListener('click', () => moveCursor(-1));
  document.getElementById('edit_right').addEventListener('click', () => moveCursor(1));
  // A bar rather than the eight the window happens to show: the jump then lands
  // on the same beat of the bar before or after, which is where an edit belongs,
  // and on a bar line the grid has already drawn.
  document.getElementById('edit_bar_left')
    .addEventListener('click', () => moveCursor(-loops.BAR));
  document.getElementById('edit_bar_right')
    .addEventListener('click', () => moveCursor(loops.BAR));
  document.getElementById('edit_insert').addEventListener('click', () =>
    applyEdit(steps => loops.insertStep(steps, rec.cursor)));
  document.getElementById('edit_delete').addEventListener('click', () =>
    applyEdit(steps => loops.deleteStep(steps, rec.cursor)));
  // Tie: what is ringing in the step before goes on ringing here, and the
  // cursor moves along, so a note is made longer by tapping it repeatedly.
  document.getElementById('edit_tie').addEventListener('click', () => {
    if (rec.editing === null || rec.cursor === 0) {
      return;
    }
    applyEdit(steps => loops.tieStep(steps, rec.cursor));
    moveCursor(1);
  });
  rec.elements.undo.addEventListener('click', () => undoEdit(false));
  rec.elements.redo.addEventListener('click', () => undoEdit(true));
  document.getElementById('edit_close').addEventListener('click', closeEditor);

  // A tap on a cell puts the cursor there and does nothing else. It used to
  // clear the note under the finger as well, so pointing at a step was an edit
  // and pointing at the wrong one was a lost note; a tap is for aiming. What
  // the cell holds is changed by playing over it, or by Del.
  rec.elements.grid.addEventListener('click', (event) => {
    const cell = event.target && event.target.closest ? event.target.closest('.cell') : null;
    if (!cell || rec.editing === null) {
      return;
    }
    rec.cursor = Number(cell.dataset.step);
    follow();
    drawEditor();
    audition();
  });

  rec.elements.all.addEventListener('click', toggleAll);

  rec.elements.songPlay.addEventListener('click', () =>
    (songPlaying() ? stopSong() : playSong()));
  // The bar is written to every couple of hundred milliseconds while a song
  // plays, which would drag the handle out from under a finger; it stops while
  // one is on it, and the move is made when it comes off.
  rec.elements.songSeek.addEventListener('input', () => { rec.scrubbing = true; });
  rec.elements.songSeek.addEventListener('change', (event) => {
    rec.scrubbing = false;
    seekSong(Number(event.target.value) / 1000);
  });

  document.getElementById('loop_save').addEventListener('click', saveLoops);
  document.getElementById('loop_load').addEventListener('click', () =>
    rec.elements.file.click());
  rec.elements.file.addEventListener('change', (event) => {
    loadLoops(event.target.files && event.target.files[0]);
    event.target.value = '';                 // so the same file can be loaded twice
  });

  app.observers.push(observe);
  showTable();
  showSong();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRecorder);
  } else {
    initRecorder();
  }
}
