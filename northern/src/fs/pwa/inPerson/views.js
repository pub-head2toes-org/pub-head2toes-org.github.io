'use strict';

/**
 * What InPerson shows, as HTML text: functions of data that return strings,
 * so the markup is tested without a browser. Names are chosen by other
 * people, so everything goes through `esc`.
 *
 * Depends on model.js.
 */
const InPersonViews = (function () {

    const api = {};

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    api.esc = function (text) {
        return String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, c => ESCAPES[c]);
    };
    const esc = api.esc;

    /** A colour for a key: the same person is the same colour here as in Pals. */
    api.hue = function (pub) {
        let hue = 0;
        const text = String(pub || '');
        for (let i = 0; i < text.length && i < 16; i++) {
            hue = (hue * 31 + text.charCodeAt(i)) % 360;
        }
        return hue;
    };

    /** A name and the head of its key on an oval in that key's colour. */
    api.pill = function (name, pub) {
        return '<span class="pill" style="--hue:' + api.hue(pub) + '">' + esc(InPersonModel.label(name, pub)) + '</span>';
    };

    /**
     * The contacts. Somebody who has not set InPerson up yet is listed, in
     * grey, but cannot be called until they do.
     */
    api.contacts = function (contacts, selected) {
        if (!contacts.length) {
            return '<p class="empty">Nobody yet. A contact shows up here once they have set up Pals or InPerson.</p>';
        }
        return contacts.map(function (c) {
            const away = c.device ? '' : ' <span class="away">not set up for calls</span>';
            return '<button type="button" role="option" class="row' + (c.device ? '' : ' unreachable') +
                '" aria-selected="' + (c.pub === selected ? 'true' : 'false') + '" data-pub="' + esc(c.pub) + '">' +
                api.pill(c.name, c.pub) + away + '</button>';
        }).join('');
    };

    /** What the call bar says. */
    api.callState = function (state, name) {
        const who = esc(name);
        return {
            calling: 'Calling ' + who + '…',
            connecting: 'Connecting to ' + who + '…',
            connected: 'In a call with ' + who,
            reconnecting: 'The line to ' + who + ' dropped - reconnecting…'
        }[state] || '';
    };

    return api;
})();
