'use strict';

/**
 * Bandage - 25 piano keys over webaudio-tinysynth.
 *
 * The layout arithmetic lives in keys.js, which knows nothing about the DOM;
 * this file is the wiring: it builds the keys, turns pointers and typing into
 * notes, and hands those to the synth.
 *
 * Notes are held in `sounding`, a Map of midi -> how many things are holding it
 * down (a finger, a typed key, the sustain latch). A note stops only when the
 * last holder lets go, so sliding a finger off a key that the keyboard is also
 * holding does not cut it short.
 */

const CHANNEL = 0;

const app = {
  synth: null,
  lowest: keys.DEFAULT_LOWEST,
  sustain: false,
  /** midi -> holder count */
  sounding: new Map(),
  /** pointerId -> midi, so a finger can slide from key to key */
  pointers: new Map(),
  /** the notes the computer keyboard is holding */
  typed: new Set(),
  /** the notes the sustain latch is holding */
  latched: new Set(),
  elements: {}
};

/* ---------------------------------------------------------------- sounding */

/** Adds a holder to a note, starting it if it was silent. */
function hold(midi) {
  const held = app.sounding.get(midi) || 0;
  app.sounding.set(midi, held + 1);
  if (held === 0) {
    app.synth.noteOn(CHANNEL, midi, 100);
    paint(midi, true);
  }
  showReadout();
}

/** Drops a holder, stopping the note when the last one lets go. */
function release(midi) {
  const held = app.sounding.get(midi) || 0;
  if (held <= 1) {
    app.sounding.delete(midi);
    app.synth.noteOff(CHANNEL, midi);
    paint(midi, false);
  } else {
    app.sounding.set(midi, held - 1);
  }
  showReadout();
}

/**
 * What a released key does: with sustain on the note keeps ringing, held by the
 * latch instead of by the finger, until sustain is switched off.
 */
function letGo(midi) {
  if (app.sustain && !app.latched.has(midi)) {
    app.latched.add(midi);
    hold(midi);                     // the latch takes over as a holder
  }
  release(midi);
}

/** Stops everything: used on octave change, on sustain off, and when hidden. */
function silence() {
  app.pointers.clear();
  app.typed.clear();
  app.latched.clear();
  app.sounding.clear();
  app.synth.allSoundOff(CHANNEL);
  const board = app.elements.keyboard;
  Array.prototype.forEach.call(board.querySelectorAll('.key.down'),
    (key) => key.classList.remove('down'));
  showReadout();
}

/* -------------------------------------------------------------------- view */

function paint(midi, down) {
  const key = app.elements.keyboard.querySelector(`[data-midi="${midi}"]`);
  if (key) {
    key.classList.toggle('down', down);
  }
}

function showReadout() {
  const playing = [...app.sounding.keys()].sort((a, b) => a - b).map(keys.name);
  app.elements.readout.textContent = playing.length ? playing.join(' ') : '—';
}

/** Builds the 25 keys from the geometry keys.js works out. */
function drawKeyboard() {
  const board = app.elements.keyboard;
  board.innerHTML = '';

  keys.layout(app.lowest).forEach((key) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `key ${key.black ? 'black' : 'white'}`;
    element.style.left = `${key.left * 100}%`;
    element.style.width = `${key.width * 100}%`;
    element.dataset.midi = key.midi;
    element.setAttribute('aria-label', key.name);
    if (key.midi === 60) {
      element.classList.add('anchor');         // middle C
    }

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = key.name;
    element.appendChild(label);

    board.appendChild(element);
  });

  const layout = keys.layout(app.lowest);
  app.elements.range.textContent =
    `${layout[0].name}–${layout[layout.length - 1].name}`;
}

/** The note under a point on the screen, or null between keys. */
function noteAt(x, y) {
  const element = document.elementFromPoint(x, y);
  const key = element && element.closest ? element.closest('.key') : null;
  return key ? Number(key.dataset.midi) : null;
}

/* ------------------------------------------------------------------ input */

/**
 * Audio may only start inside a gesture, so the context is resumed on the first
 * touch or key press rather than at load.
 */
function wakeAudio() {
  const context = app.synth && app.synth.actx;
  if (context && context.state === 'suspended') {
    context.resume();
  }
}

function onPointerDown(event) {
  const midi = noteAt(event.clientX, event.clientY);
  if (midi === null) {
    return;
  }
  event.preventDefault();
  wakeAudio();
  app.pointers.set(event.pointerId, midi);
  hold(midi);
}

/** A finger sliding across the board: a glissando, not a drag. */
function onPointerMove(event) {
  if (!app.pointers.has(event.pointerId)) {
    return;
  }
  const was = app.pointers.get(event.pointerId);
  const now = noteAt(event.clientX, event.clientY);
  if (now === was) {
    return;
  }
  event.preventDefault();
  if (now === null) {
    app.pointers.delete(event.pointerId);
  } else {
    app.pointers.set(event.pointerId, now);
    hold(now);
  }
  letGo(was);
}

function onPointerUp(event) {
  if (!app.pointers.has(event.pointerId)) {
    return;
  }
  const midi = app.pointers.get(event.pointerId);
  app.pointers.delete(event.pointerId);
  letGo(midi);
}

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
    return;
  }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    changeOctave(event.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  const midi = keys.fromTyped(event.key, app.lowest);
  if (midi === null || app.typed.has(midi)) {
    return;
  }
  event.preventDefault();
  wakeAudio();
  app.typed.add(midi);
  hold(midi);
}

function onKeyUp(event) {
  const midi = keys.fromTyped(event.key, app.lowest);
  if (midi === null || !app.typed.has(midi)) {
    return;
  }
  app.typed.delete(midi);
  letGo(midi);
}

/* ---------------------------------------------------------------- controls */

function changeOctave(octaves) {
  const moved = keys.shift(app.lowest, octaves);
  if (moved === app.lowest) {
    return;
  }
  silence();                        // held notes belong to the old range
  app.lowest = moved;
  drawKeyboard();
}

function setSustain(on) {
  app.sustain = on;
  app.elements.sustain.setAttribute('aria-pressed', String(on));
  app.elements.sustain.textContent = on ? 'On' : 'Off';
  if (!on) {
    // The latch lets go of everything it was holding; fingers keep theirs.
    [...app.latched].forEach((midi) => {
      app.latched.delete(midi);
      release(midi);
    });
  }
}

function fillVoices() {
  const select = app.elements.voice;
  keys.VOICES.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.program;
    option.textContent = voice.name;
    select.appendChild(option);
  });
  select.value = String(keys.VOICES[0].program);
}

/* -------------------------------------------------------------------- boot */

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker registered'))
      .catch((err) => console.warn('Service Worker registration failed', err));
  }
}

function init() {
  app.elements = {
    keyboard: document.getElementById('keyboard'),
    voice: document.getElementById('voice_select'),
    range: document.getElementById('range_label'),
    readout: document.getElementById('readout'),
    sustain: document.getElementById('sustain'),
    volume: document.getElementById('volume')
  };

  // No Web Audio, no instrument: say so on the page kept for it.
  if (typeof WebAudioTinySynth === 'undefined' ||
      !(window.AudioContext || window.webkitAudioContext)) {
    window.location.replace('./error.html');
    return;
  }

  app.synth = new WebAudioTinySynth({ quality: 1, useReverb: 1, voices: 24 });
  app.synth.setMasterVol(Number(app.elements.volume.value) / 100);
  app.synth.setProgram(CHANNEL, keys.VOICES[0].program);

  fillVoices();
  drawKeyboard();
  setSustain(false);

  const board = app.elements.keyboard;
  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('pointermove', onPointerMove);
  // Up and cancel go on the window: a finger can leave the board still down.
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  // A long press on a key would otherwise offer to copy it.
  board.addEventListener('contextmenu', (event) => event.preventDefault());

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  app.elements.voice.addEventListener('change', (event) => {
    app.synth.setProgram(CHANNEL, Number(event.target.value));
  });
  app.elements.volume.addEventListener('input', (event) => {
    app.synth.setMasterVol(Number(event.target.value) / 100);
  });
  app.elements.sustain.addEventListener('click', () => setSustain(!app.sustain));
  document.getElementById('octave_down').addEventListener('click', () => changeOctave(-1));
  document.getElementById('octave_up').addEventListener('click', () => changeOctave(1));

  // Leaving the page with a note held would leave it ringing on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      silence();
    }
  });
  window.addEventListener('blur', silence);

  registerServiceWorker();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
