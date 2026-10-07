'use strict';

/**
 * What Rama knows: a recording and what the user wrote about it - its buzz,
 * type, reminder and essay - and how the two lists are searched and ordered.
 *
 * No DOM, no storage and no network - `rama.js` is the wiring, and this is
 * the part that can be tested as data (`tests/rama.test.js`), the split Pals
 * and Bandage use too. The service worker loads it to fire reminders.
 *
 * A note is `{id, owner, at, duration, mime, buzz, type, essay, remind}`:
 * `owner` is the Northern public key of whoever recorded it, `at` and
 * `remind` are epoch milliseconds, `duration` is in seconds. The sound itself
 * is kept apart from the note (`store.js`), so the lists stay light.
 */
const RamaModel = (function () {

    const api = {};

    api.REG = '/fs/get/reg/Reg.html';
    // Northern's name for somebody who gave none.
    api.UNKNOWN = 'UNKNOWN';
    // The types every user starts with; whatever else they type joins them.
    api.TYPES = ['TODO', 'Recipe', 'HOWTO'];
    api.BUZZ_MAX = 120;
    api.TYPE_MAX = 30;
    api.ESSAY_MAX = 20000;
    // setTimeout takes a signed 32-bit delay: a reminder further off than
    // ~24.8 days is waited for in steps of this.
    api.LONGEST_WAIT = 2147483647;
    // What the service worker is woken with, where the browser offers it.
    api.SYNC_TAG = 'rama-reminders';
    // What MediaRecorder is asked for, best first: Chrome and Firefox record
    // Opus in WebM or Ogg, Safari AAC in MP4.
    api.MIMES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

    /** Where a visitor with no session goes, carrying the way back. */
    api.regUrl = function (pathname, search, hash) {
        return api.REG + '#' + pathname + (search || '') + (hash || '');
    };

    /** The note a notification click asks for: `#note=<id>`. */
    api.noteFromHash = function (hash) {
        const found = /^#note=([A-Za-z0-9-]+)$/.exec(String(hash || ''));
        return found ? found[1] : '';
    };

    /** The first recording format this browser can make, or '' to let it choose. */
    api.mimeFor = function (supported) {
        return api.MIMES.find(type => supported(type)) || '';
    };

    // ---- notes -----------------------------------------------------------

    const oneLine = text => String(text == null ? '' : text).replace(/\s+/g, ' ').trim();

    /** An id that sorts by when it was made: base 36 time, then a random tail. */
    api.newId = function (now, random) {
        const tail = Math.floor((random || Math.random)() * 2176782336).toString(36);
        return Number(now).toString(36) + '-' + ('000000' + tail).slice(-6);
    };

    api.note = function (owner, id, at, duration, mime) {
        return {
            id: id, owner: owner, at: at, duration: Math.max(0, Number(duration) || 0), mime: mime || '',
            buzz: '', type: '', essay: '', remind: null
        };
    };

    const isTime = value => typeof value === 'number' && isFinite(value) && value > 0;

    /** A note as read from storage, or null when it is not one. */
    api.clean = function (value) {
        if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id
            || typeof value.owner !== 'string' || !isTime(value.at)) {
            return null;
        }
        const text = (field, max) => typeof value[field] === 'string' ? value[field].slice(0, max) : '';
        return {
            id: value.id, owner: value.owner, at: value.at,
            duration: typeof value.duration === 'number' && value.duration > 0 ? value.duration : 0,
            mime: typeof value.mime === 'string' ? value.mime : '',
            buzz: text('buzz', api.BUZZ_MAX), type: text('type', api.TYPE_MAX), essay: text('essay', api.ESSAY_MAX),
            remind: isTime(value.remind) ? value.remind : null
        };
    };

    /**
     * The note with what the overlay holds. A reminder that was moved must be
     * in the future; one left as it was may have passed. Throws what is wrong.
     */
    api.edit = function (note, fields, types, now) {
        let remind = null;
        if (oneLine(fields.remind)) {
            remind = api.fromLocalInput(fields.remind);
            if (remind === null) {
                throw new Error('The reminder is not a date and a time.');
            }
            if (remind !== note.remind && remind <= now) {
                throw new Error('That time has passed: set the reminder for later.');
            }
        }
        return Object.assign({}, note, {
            buzz: oneLine(fields.buzz).slice(0, api.BUZZ_MAX),
            type: api.cleanType(fields.type, types),
            essay: String(fields.essay == null ? '' : fields.essay).replace(/\s+$/, '').slice(0, api.ESSAY_MAX),
            remind: remind
        });
    };

    // ---- types -----------------------------------------------------------

    const same = (a, b) => a.toLowerCase() === b.toLowerCase();

    /** What was typed, on one line - spelled as the type it matches, case aside. */
    api.cleanType = function (text, types) {
        const clean = oneLine(text).slice(0, api.TYPE_MAX);
        return (types || []).find(type => same(type, clean)) || clean;
    };

    /** The three, then the ones the user added, then any a note has - once each. */
    api.types = function (known, notes) {
        const all = [];
        const add = function (type) {
            const clean = oneLine(type).slice(0, api.TYPE_MAX);
            if (clean && !all.some(have => same(have, clean))) {
                all.push(clean);
            }
        };
        api.TYPES.forEach(add);
        (known || []).forEach(add);
        (notes || []).forEach(note => add(note.type));
        return all;
    };

    /** True when the type is not one of `types` yet. */
    api.isNewType = function (type, types) {
        return !!type && !(types || []).some(have => same(have, type));
    };

    /** The types that go with what is typed: those it starts first, then those it is in. */
    api.suggest = function (types, typed) {
        const wanted = oneLine(typed).toLowerCase();
        if (!wanted) {
            return types.slice();
        }
        const starting = types.filter(type => type.toLowerCase().startsWith(wanted));
        const within = types.filter(type => !starting.includes(type) && type.toLowerCase().includes(wanted));
        return starting.concat(within);
    };

    // ---- search and the two lists ---------------------------------------

    /** Every text a note has, the times as the lists show them: what a search looks through. */
    api.text = function (note) {
        return [note.buzz, note.type, note.essay, api.stamp(note.at), note.remind ? api.stamp(note.remind) : '',
            api.clock(note.duration)].join('\n').toLowerCase();
    };

    /** True when every word of the query is somewhere in the note. */
    api.matches = function (note, query) {
        const words = oneLine(query).toLowerCase().split(' ').filter(Boolean);
        if (!words.length) {
            return true;
        }
        const text = api.text(note);
        return words.every(word => text.includes(word));
    };

    /** The lower list: every recording that matches, the last recorded first. */
    api.recordings = function (notes, query) {
        return notes.filter(note => api.matches(note, query))
            .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    };

    /** The upper list: what is still to come, soonest first, then what has passed, latest first. */
    api.reminders = function (notes, query, now) {
        const set = notes.filter(note => note.remind && api.matches(note, query));
        const coming = set.filter(note => note.remind > now).sort((a, b) => a.remind - b.remind);
        const past = set.filter(note => note.remind <= now).sort((a, b) => b.remind - a.remind);
        return coming.concat(past);
    };

    // ---- reminders -------------------------------------------------------

    /**
     * The notes whose reminder is due and was not shown yet. `fired` holds,
     * by note id, the reminder time that was last shown: a reminder moved
     * since is due again when its new time comes.
     */
    api.due = function (notes, fired, now) {
        return notes.filter(note => note.remind && note.remind <= now && fired[note.id] !== note.remind)
            .sort((a, b) => a.remind - b.remind);
    };

    /** When the next reminder is due, or null when none is to come. */
    api.next = function (notes, now) {
        const coming = notes.map(note => note.remind).filter(at => at && at > now);
        return coming.length ? Math.min.apply(null, coming) : null;
    };

    /** The notification a reminder shows: the buzz, or which recording it is. */
    api.notice = function (note) {
        return {
            title: note.type ? 'Rama: ' + note.type : 'Rama',
            options: {
                body: note.buzz || 'Your recording of ' + api.stamp(note.at),
                tag: 'rama-' + note.id,
                icon: './icon-192.png',
                data: { id: note.id }
            }
        };
    };

    // ---- time, as people read it ----------------------------------------

    const two = n => (n < 10 ? '0' : '') + n;

    /** 2026-10-06 21:09, in the device's time zone. */
    api.stamp = function (ms) {
        const d = new Date(ms);
        return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
    };

    /** What <input type="datetime-local"> takes: 2026-10-06T21:09. */
    api.localInput = function (ms) {
        return api.stamp(ms).replace(' ', 'T');
    };

    /** What <input type="datetime-local"> gives, as epoch milliseconds - or null. */
    api.fromLocalInput = function (text) {
        const found = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(oneLine(text));
        if (!found) {
            return null;
        }
        const [y, mo, d, h, mi] = found.slice(1).map(Number);
        const date = new Date(y, mo - 1, d, h, mi);
        // Rolled over - February 30th - is not a date.
        if (date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) {
            return null;
        }
        return date.getTime();
    };

    /** How long, as a player shows it: 0:07, 12:30, 1:02:03. */
    api.clock = function (seconds) {
        const all = Math.max(0, Math.floor(Number(seconds) || 0));
        const h = Math.floor(all / 3600);
        const m = Math.floor(all % 3600 / 60);
        const s = all % 60;
        return (h ? h + ':' + two(m) : String(m)) + ':' + two(s);
    };

    return api;
})();
