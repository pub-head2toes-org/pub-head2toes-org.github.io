'use strict';

/**
 * The four loops, as a Standard MIDI File.
 *
 * This is where `tinysynth`'s SMF ability is used - as the *format*, not the
 * engine. Its player cannot drive the loops: `loadMIDI` ends with `reset()`
 * and `locateMIDI(0)`, which silences all sixteen channels and resets every
 * program, and the synth holds exactly one song. Four loops that start and
 * stop independently, under hands that are still playing, need their own
 * transport - `recorder.js` has it.
 *
 * What the library is very good at is *reading* a MIDI file, so it is the
 * reader here: `synth.loadMIDI(bytes)` fills `synth.song.ev`, and `decode`
 * turns those events back into loops. Only the writer is ours.
 *
 * The file is a type 1: a tempo track, then one track per loop, each on its
 * own channel with its own program. Anything else that reads MIDI can open it.
 */
const smf = {};

smf.DIVISION = 96;               // ticks in a quarter note
smf.TICKS_PER_STEP = 48;         // a step is an eighth note
smf.END_MARKER = 119;            // an undefined CC, used to mark a loop's end

/* ----------------------------------------------------------------- writing */

/** A MIDI variable-length quantity: seven bits a byte, high bit says "more". */
smf.varLength = function (value) {
    const out = [value & 0x7f];
    let left = Math.floor(value / 128);
    while (left > 0) {
        out.unshift((left & 0x7f) | 0x80);
        left = Math.floor(left / 128);
    }
    return out;
};

smf.bytes32 = function (value) {
    return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

smf.bytes16 = function (value) {
    return [(value >> 8) & 0xff, value & 0xff];
};

smf.ascii = function (text) {
    return Array.from(String(text), character => character.charCodeAt(0) & 0x7f);
};

/** Wraps a run of events in an MTrk, closing it with End of Track. */
smf.track = function (events) {
    const body = [];
    let last = 0;
    events.slice().sort((a, b) => a.tick - b.tick).forEach((event) => {
        body.push(...smf.varLength(event.tick - last), ...event.bytes);
        last = event.tick;
    });
    body.push(0x00, 0xff, 0x2f, 0x00);          // End of Track
    return [...smf.ascii('MTrk'), ...smf.bytes32(body.length), ...body];
};

/**
 * One loop as a track: the program it plays on, then a note on and a note off
 * for every *run* of notes, then a marker at the end.
 *
 * A run is what a tie makes: a note struck once and held over several steps
 * goes into the file as one note of that length, which is what any other
 * program reading it would expect to find. `loops.runs` is what knows where
 * one ends, and it is left unwrapped here - a file has an end, a loop does not.
 *
 * The marker is what carries the loop's *length*. Trailing rests are real -
 * they are how a pattern is given room to breathe - and they leave no note
 * behind to be counted, so without it a loop edited to end in silence would
 * come back short. End of Track would say it, but `tinysynth`'s parser stops
 * at that event rather than recording it, so an undefined controller is used:
 * harmless to anything else that reads the file, and it survives the read.
 */
smf.loopTrack = function (loop, index, model) {
    const channel = index + 1;
    const steps = (loop && loop.steps) || [];
    const gap = Math.max(1, Math.round(smf.TICKS_PER_STEP * 0.1));
    const events = [{ tick: 0, bytes: [0xc0 | channel, (loop && loop.program) || 0] }];

    model.runs(steps).forEach((run) => {
        const tick = run.at * smf.TICKS_PER_STEP;
        events.push({ tick: tick, bytes: [0x90 | channel, run.midi, 100] });
        events.push({
            tick: tick + (run.length * smf.TICKS_PER_STEP) - gap,
            bytes: [0x80 | channel, run.midi, 0]
        });
    });

    events.push({
        tick: steps.length * smf.TICKS_PER_STEP,
        bytes: [0xb0 | channel, smf.END_MARKER, 0]
    });
    return smf.track(events);
};

/** The four loops and the tempo they were played at, as file bytes. */
smf.encode = function (all, bpm, model) {
    const tracks = (all || []).map((loop, index) => smf.loopTrack(loop, index, model));
    const tempo = Math.round(60000000 / (bpm || 120));
    const head = [
        ...smf.ascii('MThd'), ...smf.bytes32(6),
        ...smf.bytes16(1),                       // format 1
        ...smf.bytes16(tracks.length + 1),       // the tempo track, then the loops
        ...smf.bytes16(smf.DIVISION)
    ];
    const conductor = smf.track([{
        tick: 0,
        bytes: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff]
    }]);

    const out = [...head, ...conductor];
    tracks.forEach(track => out.push(...track));
    return new Uint8Array(out);
};

/* ----------------------------------------------------------------- reading */

/**
 * The loops held in a song that `tinysynth` has already parsed - pass it
 * `synth.song` after `synth.loadMIDI(bytes)`.
 *
 * Ticks come back in the file's own units and the timebase the library keeps
 * is four times the division it read, so a step is `timebase / 8` ticks.
 */
/**
 * Where a tick falls in a song, in seconds, following its tempo map.
 *
 * The player reads tempo changes as it goes and rewrites `song.tempo` while it
 * runs, so a position cannot be worked out from whatever that says at the time.
 * The changes are walked once here instead, at the moment the file is read,
 * and what comes back is good for the life of the song.
 */
smf.clock = function (song) {
    const events = (song && song.ev) || [];
    const timebase = (song && song.timebase) || smf.DIVISION;
    // The parser multiplies the file's division by four, so `timebase` counts
    // ticks to a whole note rather than to a beat - which is why there is a
    // four here, and in `tick2Time` in the library itself.
    const perTick = bpm => 4 * 60 / bpm / timebase;

    // Each mark is a tempo change: the tick it happens on, the second it falls
    // on, and the rate from there until the next one.
    const marks = [{ tick: 0, at: 0, bpm: 120 }];
    events.forEach((event) => {
        const message = event.m || [];
        if (message[0] !== 0xff51) {
            return;
        }
        const last = marks[marks.length - 1];
        const at = last.at + ((event.t - last.tick) * perTick(last.bpm));
        if (event.t === last.tick) {
            marks[marks.length - 1] = { tick: event.t, at: at, bpm: message[1] };
        } else {
            marks.push({ tick: event.t, at: at, bpm: message[1] });
        }
    });

    const at = function (tick) {
        const wanted = Math.max(0, tick || 0);
        let mark = marks[0];
        for (let i = marks.length - 1; i >= 0; i--) {
            if (marks[i].tick <= wanted) {
                mark = marks[i];
                break;
            }
        }
        return mark.at + ((wanted - mark.tick) * perTick(mark.bpm));
    };

    const last = events.length ? events[events.length - 1].t : 0;
    return { at: at, ticks: last, seconds: at(last) };
};

/** Seconds as a player reads them: 0:07, 5:09. */
smf.mmss = function (seconds) {
    const whole = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

smf.decode = function (song, model) {
    const made = model.blank();
    if (!song || !Array.isArray(song.ev)) {
        return { loops: made, bpm: model.DEFAULT_BPM };
    }

    const perStep = Math.max(1, Math.round((song.timebase || smf.DIVISION * 4) / 8));
    const lengths = new Array(made.length).fill(0);
    const written = made.map(() => model.writer());
    const open = new Map();                      // 'channel:note' -> the step it began on
    let marked = false;                          // did anything say where it ends?
    let bpm = song.tempo || model.DEFAULT_BPM;

    /** A note that has ended: the steps it covered get it, tied after the first. */
    const close = (index, note, endStep) => {
        const key = `${index}:${note}`;
        if (!open.has(key)) {
            return;
        }
        const from = open.get(key);
        open.delete(key);
        const to = Math.max(from, endStep - 1);
        written[index].hold(from, to, note);
        lengths[index] = Math.max(lengths[index], to + 1);
    };

    /**
     * A note struck. `open` is keyed by channel and pitch, so a second strike
     * arriving while the first is still ringing has to say what becomes of the
     * one already there - left to overwrite it, the earlier strike would be
     * closed by the wrong note off and the later one dropped for having no
     * start left to close.
     *
     * A player striking a key again means the note starts over, so the one
     * ringing ends where the new one begins.
     *
     * Unless both land on the same step. A step is an eighth note and a file is
     * written in ticks, so two strikes a tick apart - a part doubled, or a note
     * released and caught again - round to the same column, and a column holds
     * one of a pitch. Restarting there would write a note of no length and then
     * a second strike the grid has no room for. They are one note instead, held
     * until whichever note off comes last, which is what it sounded like.
     */
    const strike = (index, note, at) => {
        const key = `${index}:${note}`;
        if (!open.has(key)) {
            open.set(key, at);
            return;
        }
        if (at <= open.get(key)) {
            return;                              // the same column: one note
        }
        close(index, note, at);                  // it ends where the new one starts
        open.set(key, at);
    };

    song.ev.forEach((event) => {
        const message = event.m || [];
        if (message[0] === 0xff51) {
            bpm = message[1];
            return;
        }
        const index = (message[0] & 0x0f) - 1;
        if (index < 0 || index >= made.length) {
            return;                              // channel 0 is the hands, not a loop
        }
        const at = Math.round(event.t / perStep);

        switch (message[0] & 0xf0) {
        case 0xc0:
            made[index].program = message[1];
            break;
        case 0x90:
            // A note on at zero velocity is a note off; the format allows both.
            if (message[2] > 0) {
                strike(index, message[1], at);
            } else {
                close(index, message[1], at);
            }
            break;
        case 0x80:
            close(index, message[1], at);
            break;
        case 0xb0:
            if (message[1] === smf.END_MARKER) {
                lengths[index] = Math.max(lengths[index], at);
                marked = true;
            }
            break;
        }
    });

    // A file that ends mid-note: it stops where the loop does.
    [...open.keys()].forEach((key) => {
        const [index, note] = key.split(':').map(Number);
        close(index, note, lengths[index] || 1);
    });

    // Nobody said where anything ends, so this is somebody else's song rather
    // than loops we wrote: its parts are one piece of music and have to stay in
    // step with each other. Left at their own lengths they each come round at a
    // different moment and the song comes apart - the shortest part first, and
    // after that never in phase again. So they all end where the longest does.
    const whole = !marked;
    if (whole) {
        const longest = Math.max(0, ...lengths);
        lengths.fill(longest);
    }

    // The marker says where a loop ends; the rests up to it are put back.
    made.forEach((loop, index) => {
        const strip = written[index].steps();
        loop.steps = lengths[index] > 0
            ? model.extend(strip, lengths[index] - 1).slice(0, lengths[index])
            : [];
    });

    return { loops: made, bpm: bpm, whole: whole };
};

if (typeof module === 'object' && module.exports) {
    module.exports = smf;
}
