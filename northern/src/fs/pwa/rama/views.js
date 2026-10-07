'use strict';

/**
 * What Rama shows, as HTML text. Every function takes data and returns a
 * string, so the markup is tested without a browser; `rama.js` puts the
 * strings on the page and listens for the clicks.
 *
 * Everything the user typed goes through `esc` before it reaches the page.
 *
 * Depends on model.js.
 */
const RamaViews = (function () {

    const api = {};

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    api.esc = function (text) {
        return String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, c => ESCAPES[c]);
    };
    const esc = api.esc;

    api.empty = function (text) {
        return '<p class="empty">' + esc(text) + '</p>';
    };

    const time = ms => '<time datetime="' + new Date(ms).toISOString() + '">' + esc(RamaModel.stamp(ms)) + '</time>';
    const buzz = note => note.buzz
        ? '<span class="buzz">' + esc(note.buzz) + '</span>'
        : '<span class="buzz none">No buzz yet</span>';
    const type = note => note.type ? '<span class="type">' + esc(note.type) + '</span>' : '';
    const row = (note, extra, inner) => '<button type="button" class="row' + extra + '" data-id="' + esc(note.id) + '">' + inner + '</button>';

    const nothing = function (query, none) {
        return query && query.trim() ? 'Nothing matches “' + query.trim() + '”.' : none;
    };

    /** The upper list: when, what, and its type; one that has passed is marked so. */
    api.reminders = function (notes, query, now) {
        if (!notes.length) {
            return api.empty(nothing(query, 'No reminders yet. Open a recording to set one.'));
        }
        return notes.map(note => row(note, note.remind <= now ? ' past' : '',
            '<span class="when">' + time(note.remind) + '</span>' + buzz(note) + '<span class="tags">' + type(note) + '</span>'
        )).join('');
    };

    /** The lower list: when it was recorded, what, its type, a bell if it reminds, and how long it is. */
    api.recordings = function (notes, query) {
        if (!notes.length) {
            return api.empty(nothing(query, 'No recordings yet. Peel back to the recorder and press Record.'));
        }
        return notes.map(note => row(note, '',
            '<span class="when">' + time(note.at) + '</span>' + buzz(note) + '<span class="tags">' + type(note) +
            (note.remind ? '<span class="bell" title="Reminds ' + esc(RamaModel.stamp(note.remind)) + '" aria-label="Has a reminder">&#128276;</span>' : '') +
            '<span class="length">' + esc(RamaModel.clock(note.duration)) + '</span></span>'
        )).join('');
    };

    /** The types that go with what is typed, under the field; `active` is the one the arrow keys are on. */
    api.suggestions = function (types, active) {
        return types.map((type, i) => '<li role="option" id="type_option_' + i + '" class="suggestion" data-type="' + esc(type) +
            '" aria-selected="' + (i === active ? 'true' : 'false') + '">' + esc(type) + '</li>').join('');
    };

    return api;
})();
