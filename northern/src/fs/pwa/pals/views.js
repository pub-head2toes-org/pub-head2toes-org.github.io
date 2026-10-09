'use strict';

/**
 * What Pals shows, as HTML text. Every function takes data and returns a
 * string, so the markup is tested without a browser; `pals.js` puts the
 * strings on the page and listens for the clicks.
 *
 * Names and messages are written by other people. Everything that reaches the
 * page goes through `esc` first.
 *
 * Depends on model.js.
 */
const PalsViews = (function () {

    const api = {};

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

    api.esc = function (text) {
        return String(text === undefined || text === null ? '' : text).replace(/[&<>"']/g, c => ESCAPES[c]);
    };
    const esc = api.esc;

    /** A colour for a key: the same pal is the same colour everywhere. */
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
        return '<span class="pill" style="--hue:' + api.hue(pub) + '">' +
            esc(PalsModel.label(name, pub)) + '</span>';
    };

    api.empty = function (text) {
        return '<p class="empty">' + esc(text) + '</p>';
    };

    const row = function (attrs, selected, inner) {
        return '<button type="button" role="option" class="row" aria-selected="' + (selected ? 'true' : 'false') +
            '" ' + attrs + '>' + inner + '</button>';
    };

    const time = PalsModel.time;
    api.time = time;

    /** By a name: there are messages from them the user has not opened yet (UPDATE_6). */
    const dot = function (state, pub) {
        return PalsModel.isUnread(state, pub) ? '<span class="dot" role="img" aria-label="new messages" title="New messages"></span>' : '';
    };

    /**
     * The pals, then whoever wrote without being one - set apart, as they
     * cannot be answered until they are added.
     */
    api.pals = function (state, selected, me) {
        const others = PalsModel.others(state);
        if (!state.pals.length && !others.length) {
            return api.empty('Nobody yet. Add a pal with +.');
        }
        return state.pals.map(p =>
            row('data-pub="' + esc(p.pub) + '"', p.pub === selected, esc(PalsModel.label(p.name, p.pub)) +
                (p.verified ? ' <span class="verified" title="Key compared in person">&#10003;</span>' : '') + dot(state, p.pub))
        ).concat(others.map(pub =>
            row('data-pub="' + esc(pub) + '" title="Not a pal: add them with + to answer"', pub === selected,
                '<span class="other">' + esc(PalsModel.label(PalsModel.nameOf(state, pub, me), pub)) + '</span>' + dot(state, pub))
        )).join('');
    };

    /**
     * A message takes two rows: how it starts, then who sent it - with a
     * bubble of three dots by the name, as there is more to do once it is
     * opened: reply, or send a correction (UPDATE_5).
     */
    api.log = function (messages, state, me) {
        if (!messages.length) {
            return api.empty('Nothing here yet.');
        }
        return messages.map(m => {
            // A photo with no words shows its file name instead.
            const text = PalsModel.excerpt(m.body) || (m.attachment ? m.attachment.name : '');
            const more = Array.from(m.body.replace(/\s+/g, ' ').trim()).length > PalsModel.EXCERPT;
            const clip = m.attachment ? '<span class="clip" title="' + esc(api.kind(m.attachment) + ': ' + m.attachment.name) + '">&#128206;</span>' : '';
            // The name a pal has now, or the one they had when the message was filed.
            const known = PalsModel.nameOf(state, m.from, me);
            const name = known === '?' && m.fromName ? m.fromName : known;
            const where = m.to.kind === 'group' ? 'in ' + m.to.name
                : m.out ? 'to ' + PalsModel.label(m.to.name, m.to.id) : '';
            const status = api.status(m);
            return row('data-message="' + esc(m.id) + '"', false,
                '<span class="line">' + clip + esc(text) + (more ? '&hellip;' : '') + '</span>' +
                '<span class="line meta">' + api.pill(name, m.from) +
                '<span class="more" title="' + (m.out ? 'Open to send a correction' : 'Open to reply') + '">...</span>' +
                (where ? '<span class="where">' + esc(where) + '</span>' : '') +
                (status ? '<span class="state ' + status.kind + '">' + esc(status.text) + '</span>' : '') +
                '<time>' + esc(time(m.ts)) + '</time></span>');
        }).join('');
    };

    /** 'Photo' or 'Video'. */
    api.kind = function (att) {
        return String(att && att.type).indexOf('video/') === 0 ? 'Video' : 'Photo';
    };

    /** A file's size in words: 820 bytes, 34 KB, 2.5 MB. */
    api.size = function (bytes) {
        const n = Number(bytes) || 0;
        return n < 1024 ? n + ' bytes' : n < 1024 * 1024 ? Math.round(n / 1024) + ' KB'
            : (Math.round(n / 1024 / 1024 * 10) / 10) + ' MB';
    };

    /**
     * The photo or video that goes with a message, for the overlay. `url` is
     * where the page put the file kept on this device (an object URL); without
     * one it says how the file stands: not sent yet, being fetched, or why it
     * could not be.
     */
    api.attachment = function (m, url) {
        const att = m.attachment;
        if (!att) {
            return '';
        }
        const what = esc(api.kind(att) + ': ' + att.name + ', ' + api.size(att.size));
        if (url) {
            const media = api.kind(att) === 'Video'
                ? '<video controls playsinline preload="metadata" src="' + esc(url) + '"></video>'
                : '<img src="' + esc(url) + '" alt="' + esc(att.name) + '">';
            return media + '<a class="link" href="' + esc(url) + '" download="' + esc(att.name) + '">Save ' + what + '</a>';
        }
        const status = m.out
            ? (att.id ? 'This device no longer has it.' : 'Not sent yet.')
            : att.error ? 'It could not be fetched: ' + att.error : 'Fetching it…';
        return '<p class="file">' + what + '. ' + esc(status) + '</p>';
    };

    /** How a message stands, when there is anything to say: sending, not delivered, incomplete. */
    api.status = function (m) {
        if (m.out) {
            const state = PalsModel.deliveryOf(m);
            return state === 'sending' ? { kind: 'sending', text: 'sending…' }
                : state === 'failed' ? { kind: 'failed', text: 'not delivered' } : null;
        }
        if (m.parts && !m.complete) {
            const have = m.parts.filter(p => p !== null).length;
            return { kind: 'partial', text: have + ' of ' + m.parts.length + ' parts' };
        }
        return null;
    };

    /** Who a message did not reach, and why - for the overlay. '' when it reached everybody. */
    api.failures = function (m, state, me) {
        const failed = Object.keys(m.delivery || {}).filter(pub => m.delivery[pub] !== 'sent' && m.delivery[pub] !== 'sending');
        return failed.map(pub => PalsModel.label(PalsModel.nameOf(state, pub, me), pub) + ': ' + m.delivery[pub]).join('\n');
    };

    api.groups = function (state, selected) {
        if (!state.groups.length) {
            return api.empty('No groups');
        }
        const chosen = String(selected || '').toLowerCase();
        return state.groups.map(g =>
            row('data-group="' + esc(g.name) + '"', g.name.toLowerCase() === chosen, esc(g.name))
        ).join('');
    };

    api.members = function (state, groupName, selected) {
        if (!PalsModel.group(state, groupName)) {
            return api.empty('Pick a group to see who is in it.');
        }
        const members = PalsModel.members(state, groupName);
        if (!members.length) {
            return api.empty('Nobody in this group yet.');
        }
        return members.map(p =>
            row('data-pub="' + esc(p.pub) + '"', p.pub === selected, esc(PalsModel.label(p.name, p.pub)))
        ).join('');
    };

    /** The <option>s of the "To" list: every group, then every pal. */
    api.targets = function (state, filter) {
        const f = filter || {};
        const group = (f.kind === 'group' || f.kind === 'member') ? PalsModel.group(state, f.id) : null;
        const chosen = f.kind === 'pal' ? 'pal:' + f.pub : group ? 'group:' + group.name : '';
        const option = (value, text) => '<option value="' + esc(value) + '"' +
            (value === chosen ? ' selected' : '') + '>' + esc(text) + '</option>';
        return state.groups.map(g => option('group:' + g.name, 'Group: ' + g.name))
            .concat(state.pals.map(p => option('pal:' + p.pub, PalsModel.label(p.name, p.pub))))
            .join('');
    };

    /** Reads a "To" value back into what `PalsModel.compose` takes. */
    api.target = function (value) {
        // Only the first colon splits: a group name may have one of its own.
        const at = String(value || '').indexOf(':');
        return at === -1 ? null : { kind: value.slice(0, at), id: value.slice(at + 1) };
    };

    api.candidates = function (state, groupName) {
        return PalsModel.candidates(state, groupName).map(p =>
            '<option value="' + esc(p.pub) + '">' + esc(PalsModel.label(p.name, p.pub)) + '</option>'
        ).join('');
    };

    /** The <option>s of the "Add a pal" list: everybody in the directory who is not a pal yet. */
    api.strangers = function (entries) {
        return entries.map(e =>
            '<option value="' + esc(e.pub) + '">' + esc(PalsModel.label(e.name, e.pub)) + '</option>'
        ).join('');
    };

    /** What the Messages layer is showing, in words. '' when it is showing everything. */
    api.context = function (state, filter, me) {
        const f = filter || { kind: 'all' };
        const who = pub => PalsModel.label(PalsModel.nameOf(state, pub, me), pub);
        const group = PalsModel.group(state, f.id);
        if (f.kind === 'pal') {
            return who(f.pub);
        }
        if (f.kind === 'group') {
            return group ? group.name : '';
        }
        if (f.kind === 'member') {
            return (group ? group.name + ', ' : '') + 'from ' + who(f.pub);
        }
        return '';
    };

    return api;
})();
