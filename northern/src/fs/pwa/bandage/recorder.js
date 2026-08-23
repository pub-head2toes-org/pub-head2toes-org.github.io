'use strict';

/**
 * The four loops: the transport, the table that drives them, and the editor.
 *
 * `loops.js` holds the arithmetic and `smf.js` the file format; this file is
 * the wiring, the way `bandage.js` is the wiring for the keys.
 *
 * The transport is ours rather than the library's. `tinysynth` can play a
 * Standard MIDI File, but `loadMIDI` ends in `reset()` and `locateMIDI(0)` -
 * it resets all sixteen channels and silences them - and the synth holds
 * exactly one song. Four loops that start and stop independently, under hands
 * that are still playing, cannot live in one song: starting the third would
 * cut off the other two and the player's chord with them. So the loops are
 * scheduled here, note by note, and `smf.js` uses the library for what it is
 * good at - reading and writing the file.
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

/** Wakes the scheduler. Idempotent: four loops share the one clock. */
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

/** One step of every running loop, on its own channel and its own instrument. */
function sound(tick, at, step) {
  rec.running.forEach((index) => {
    const channel = loops.channel(index);
    loops.notesAt(rec.loops[index], tick).forEach((midi) => {
      app.synth.noteOn(channel, midi, loops.VELOCITY, at);
      app.synth.noteOff(channel, midi, at + (step * loops.GATE));
    });
  });
}

/* ------------------------------------------------------------------ buttons */

function togglePlay(index) {
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
 * Record clears the loop and writes what is played into it, quantised. The
 * other loops keep going underneath, which is what makes this an overdub: the
 * player hears the parts already down while adding the next.
 *
 * The instrument is taken from the Voice selector as recording starts, so the
 * loop plays back as the part sounded while it was being played.
 */
function toggleRecord(index) {
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
  rec.recording = null;

  const loop = rec.loops[index];
  loop.steps = loops.padToBar(loops.trim(loop.steps));
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
    stopAll();
    return;
  }
  if (rec.editing !== null) {
    editorInput(kind, midi);
    return;
  }
  if (rec.recording === null || kind !== 'on') {
    return;
  }
  const step = loops.stepSeconds(app.bpm);
  const elapsed = now() - rec.origin;
  if (elapsed < -step / 2) {
    return;                              // still counting in to the bar
  }
  const loop = rec.loops[rec.recording];
  loop.steps = loops.setNote(loop.steps, loops.quantise(elapsed, app.bpm), null, midi);
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

function moveCursor(by) {
  if (rec.editing === null) {
    return;
  }
  rec.cursor = Math.max(0, rec.cursor + by);
  follow();
  drawEditor();
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
  showTransport();
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

/** The grid: four rows of notes, one column per step, a window at a time. */
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

      const cell = document.createElement('td');
      cell.className = 'cell';
      cell.textContent = note === null || note === undefined ? '·' : keys.name(note);
      cell.dataset.step = at;
      cell.dataset.row = row;
      cell.classList.toggle('at', at === rec.cursor);
      cell.classList.toggle('past', at >= loop.steps.length);
      cell.classList.toggle('filled', note !== null && note !== undefined);
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
  const bytes = smf.encode(rec.loops, app.bpm);
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
    stopAll();
    app.synth.loadMIDI(reader.result);      // the library reads the file...
    const read = smf.decode(app.synth.song, loops);   // ...and we read the library
    rec.loops = read.loops;
    rec.histories = rec.loops.map(loop => loops.history(loop.steps));

    // loadMIDI resets all sixteen channels, so the app's own state goes back on.
    app.synth.setMasterVol(Number(app.elements.volume.value) / 100);
    app.synth.setProgram(0, Number(app.elements.voice.value) || 0);
    rec.loops.forEach((loop, index) =>
      app.synth.setProgram(loops.channel(index), loop.program));
    setTempo(read.bpm);
    showTable();
  };
  reader.readAsArrayBuffer(file);
}

/* --------------------------------------------------------------------- boot */

function pick(prefix) {
  const found = [];
  for (let i = 0; i < loops.COUNT; i++) {
    found.push(document.getElementById(`${prefix}_${i}`));
  }
  return found;
}

function initRecorder() {
  if (!app.synth) {
    return;                              // no Web Audio: bandage.js has left the page
  }
  rec.elements = {
    play: pick('play'),
    record: pick('record'),
    edit: pick('edit'),
    transport: document.getElementById('transport'),
    editor: document.getElementById('editor'),
    editorTitle: document.getElementById('editor_title'),
    grid: document.getElementById('edit_grid').querySelector('tbody'),
    undo: document.getElementById('edit_undo'),
    redo: document.getElementById('edit_redo'),
    file: document.getElementById('loop_file')
  };

  rec.histories = rec.loops.map(loop => loops.history(loop.steps));

  rec.elements.play.forEach((button, i) =>
    button.addEventListener('click', () => togglePlay(i)));
  rec.elements.record.forEach((button, i) =>
    button.addEventListener('click', () => toggleRecord(i)));
  rec.elements.edit.forEach((button, i) =>
    button.addEventListener('click', () =>
      (rec.editing === i ? closeEditor() : openEditor(i))));

  document.getElementById('edit_left').addEventListener('click', () => moveCursor(-1));
  document.getElementById('edit_right').addEventListener('click', () => moveCursor(1));
  document.getElementById('edit_insert').addEventListener('click', () =>
    applyEdit(steps => loops.insertStep(steps, rec.cursor)));
  document.getElementById('edit_delete').addEventListener('click', () =>
    applyEdit(steps => loops.deleteStep(steps, rec.cursor)));
  rec.elements.undo.addEventListener('click', () => undoEdit(false));
  rec.elements.redo.addEventListener('click', () => undoEdit(true));
  document.getElementById('edit_close').addEventListener('click', closeEditor);

  // A tap on a cell takes that note back out, which is the one edit the keys
  // cannot make: they can only write.
  rec.elements.grid.addEventListener('click', (event) => {
    const cell = event.target && event.target.closest ? event.target.closest('.cell') : null;
    if (!cell || rec.editing === null) {
      return;
    }
    rec.cursor = Number(cell.dataset.step);
    applyEdit(steps => loops.clearCell(steps, rec.cursor, Number(cell.dataset.row)));
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
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRecorder);
  } else {
    initRecorder();
  }
}
