'use strict';

/**
 * What Pals knows: who the pals are, which groups they are in, what was said
 * and who has been knocking - and the shapes that go over the wire: the row a
 * device is listed under in `/pals/`, and a message cut into pushes.
 *
 * No DOM, no storage and no network - `pals.js` and `welcome.js` are the
 * wiring, and this is the part that can be tested as data
 * (`tests/pals.test.js`). It is the split `idcard.js`/`Reg.html` and
 * `keys.js`/`bandage.js` already use here. The service worker loads it too.
 *
 * A pal is identified by their Northern public key, exactly as `session.pub()`
 * gives it: 64 bytes, x then y, in standard base64. The user name is only what
 * the key's owner chose to call it.
 */
const PalsModel = (function () {

    const api = {};

    api.VERSION = 1;
    // How much of a public key is shown next to a name.
    api.TAG = 5;
    // How much of a message its row in the log shows.
    api.EXCERPT = 128;
    api.NAME_MAX = 40;
    // What one push may carry (UPDATE_1); /push/api/send holds to it as well.
    api.MAX_CHARS = 1000;
    // And in bytes: a push holds 3993 characters of JSON. The keys, ids and
    // part numbers around the seal take 284 of them, the seal is base64url
    // (2781 bytes), and its header, tag and {ts} take 75 of those - which
    // leaves 2706 for the text. Only text in 3- and 4-byte characters - CJK,
    // emoji - or full of control characters gets here before 1000 characters.
    api.MAX_BYTES = 2600;
    // A message in more pushes than this is not a message among friends.
    api.MAX_PARTS = 100;
    // Northern's name for somebody who gave none.
    api.UNKNOWN = 'UNKNOWN';
    // Where a part that never arrived shows in a message.
    api.MISSING = '[…]';
    api.REG = '/fs/get/reg/Reg.html';
    // Where every device that set Pals up is listed: /pals/<username>/<key>.
    api.DIRECTORY = '/pals/';

    api.empty = function () {
        return { v: api.VERSION, seq: 0, pals: [], groups: [], messages: [], incoming: [] };
    };

    // ---- keys ----------------------------------------------------------

    // 64 bytes of base64: 86 characters that carry bits, then the padding.
    const STD = /^[A-Za-z0-9+/]{86}==$/;
    const URL_SAFE = /^[A-Za-z0-9_-]{86}$/;

    api.isPub = function (text) {
        return typeof text === 'string' && STD.test(text);
    };

    /** The first letters of a key, which is how a pal is told from a namesake. */
    api.tag = function (pub) {
        return String(pub || '').slice(0, api.TAG);
    };

    api.label = function (name, pub) {
        return (name || api.UNKNOWN) + ' (' + api.tag(pub) + ')';
    };

    /**
     * A key as it goes in a path. Standard base64 carries `/`, `+` and `=`,
     * and three keys in four have a `/` in them - which in a path is a separator.
     */
    api.urlKey = function (pub) {
        return String(pub || '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    };

    api.pubFromUrlKey = function (key) {
        return URL_SAFE.test(key) ? key.replace(/-/g, '+').replace(/_/g, '/') + '==' : '';
    };

    /** Where a visitor with no session goes, carrying the way back. */
    api.regUrl = function (pathname, search, hash) {
        return api.REG + '#' + pathname + (search || '') + (hash || '');
    };

    // ---- the directory: /pals/<username>/<key> ----------------------------

    /**
     * Who runs which push service. The endpoint says it; the name travels with
     * the subscription because UPDATE_1 asks for it, and /push/api/send checks
     * the two agree. The same table is in src/h2t/PushApi.js.
     */
    const PROVIDERS = {
        google: [/^fcm\.googleapis\.com$/],
        mozilla: [/^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/],
        apple: [/^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/],
        microsoft: [/^[a-z0-9-]+\.notify\.windows\.com$/]
    };

    api.providerOf = function (endpoint) {
        const found = /^https:\/\/([a-z0-9.-]+)\//i.exec(String(endpoint || ''));
        if (!found) {
            return '';
        }
        const host = found[1].toLowerCase();
        return Object.keys(PROVIDERS).find(id => PROVIDERS[id].some(re => re.test(host))) || '';
    };

    /** A name as one path segment: no `/`, and no `.`, which Northern reads as a file type. */
    const segment = function (name) {
        return encodeURIComponent(name).replace(/\./g, '%2E');
    };

    api.palPath = function (name, pub) {
        return api.DIRECTORY + segment(api.cleanName(name) || api.UNKNOWN) + '/' + api.urlKey(pub);
    };

    /** What welcome.html files at `palPath`: enough for a pal to push to this device. */
    api.palRecord = function (me, subscription, ts) {
        const sub = subscription || {};
        const keys = sub.keys || {};
        return {
            pub: me.pub,
            username: api.cleanName(me.name) || api.UNKNOWN,
            provider: api.providerOf(sub.endpoint),
            subscription: { endpoint: String(sub.endpoint || ''), keys: { p256dh: String(keys.p256dh || ''), auth: String(keys.auth || '') } },
            ts: ts
        };
    };

    const ROW = /^\/pals\/([^/]+)\/([A-Za-z0-9_-]{86})$/;

    /**
     * Search rows from `/pals/` as a list of devices, newest per key. A row
     * counts only when the key in its path wrote it: anybody may post under
     * /pals/, and the `author` column is the key the server verified.
     */
    api.directory = function (rows) {
        const newest = {};
        (Array.isArray(rows) ? rows : []).forEach(function (row) {
            const path = row && ROW.exec(row.path);
            const pub = path && api.pubFromUrlKey(path[2]);
            if (!pub || row.author !== pub) {
                return;
            }
            let record;
            try {
                record = JSON.parse(row.value);
            } catch (e) {
                return;
            }
            const sub = record && record.subscription;
            if (!record || record.pub !== pub || !sub || !sub.endpoint || !sub.keys) {
                return;
            }
            const entry = {
                pub: pub,
                name: api.cleanName(record.username) || api.UNKNOWN,
                provider: String(record.provider || ''),
                subscription: { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh || ''), auth: String(sub.keys.auth || '') } },
                ts: Number(record.ts) || 0
            };
            if (!newest[pub] || entry.ts > newest[pub].ts) {
                newest[pub] = entry;
            }
        });
        return Object.keys(newest).map(k => newest[k])
            .sort((a, b) => a.name.localeCompare(b.name) || a.pub.localeCompare(b.pub));
    };

    // ---- pals ----------------------------------------------------------

    api.cleanName = function (name) {
        return String(name === undefined || name === null ? '' : name)
            .replace(/\s+/g, ' ').trim().slice(0, api.NAME_MAX);
    };

    api.pal = function (state, pub) {
        return state.pals.find(p => p.pub === pub) || null;
    };

    /** Adds a pal, or renames the one already there. */
    api.addPal = function (state, pub, name, me) {
        if (!api.isPub(pub)) {
            throw new Error('pick a pal from the list');
        }
        if (me && pub === me.pub) {
            throw new Error('that is you');
        }
        const clean = api.cleanName(name) || api.UNKNOWN;
        const known = api.pal(state, pub);
        if (known) {
            known.name = clean;
            return known;
        }
        // The key is pinned from here on: messages are sealed to this one,
        // whatever the directory says later.
        const pal = { pub: pub, name: clean, verified: false };
        state.pals.push(pal);
        return pal;
    };

    /**
     * Marks a pal's key as compared with them in person - or unmarks it. The
     * key itself never changes once added, so the mark stays true.
     */
    api.verify = function (state, pub, verified) {
        const pal = api.pal(state, pub);
        if (!pal) {
            throw new Error('pick a pal first');
        }
        pal.verified = !!verified;
        return pal;
    };

    /** A pal who leaves, leaves every group too. What they said stays in the log. */
    api.removePal = function (state, pub) {
        state.pals = state.pals.filter(p => p.pub !== pub);
        state.groups.forEach(g => { g.members = g.members.filter(m => m !== pub); });
        state.incoming = state.incoming.filter(p => p !== pub);
    };

    /** The directory, less the user and the pals they have already. */
    api.strangers = function (state, entries, me) {
        return (entries || []).filter(e => e.pub !== (me && me.pub) && !api.pal(state, e.pub));
    };

    /**
     * What to call a key: the pal's name, the user's own, or - for somebody
     * who wrote without being a pal - the name they had when they did.
     */
    api.nameOf = function (state, pub, me) {
        if (me && pub === me.pub) {
            return me.name || api.UNKNOWN;
        }
        const pal = api.pal(state, pub);
        if (pal) {
            return pal.name;
        }
        for (let i = state.messages.length - 1; i >= 0; i--) {
            if (state.messages[i].from === pub && state.messages[i].fromName) {
                return state.messages[i].fromName;
            }
        }
        return '?';
    };

    // ---- groups --------------------------------------------------------
    //
    // A group is a name and a list of pals, and lives only here (UPDATE_1).
    // Nobody else has it: a message to a group goes to each member on their
    // own, its text starting with [<group name>], and whoever receives it
    // files it under a group of that name of their own.

    const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

    api.group = function (state, name) {
        return name ? state.groups.find(g => same(g.name, name)) || null : null;
    };

    api.groupName = function (name) {
        const clean = api.cleanName(name);
        if (!clean) {
            throw new Error('a group needs a name');
        }
        if (/[\[\]]/.test(clean)) {
            throw new Error('a group name cannot have [ or ] in it');
        }
        return clean;
    };

    api.addGroup = function (state, name) {
        const clean = api.groupName(name);
        if (api.group(state, clean)) {
            throw new Error('there is already a group called ' + clean);
        }
        const group = { name: clean, members: [] };
        state.groups.push(group);
        return group;
    };

    api.removeGroup = function (state, name) {
        state.groups = state.groups.filter(g => !same(g.name, name));
    };

    const needGroup = function (state, name) {
        const group = api.group(state, name);
        if (!group) {
            throw new Error('pick a group first');
        }
        return group;
    };

    api.addMember = function (state, name, pub) {
        const group = needGroup(state, name);
        if (!api.pal(state, pub)) {
            throw new Error('only a pal can join a group');
        }
        if (group.members.indexOf(pub) === -1) {
            group.members.push(pub);
        }
        return group;
    };

    api.removeMember = function (state, name, pub) {
        const group = needGroup(state, name);
        group.members = group.members.filter(m => m !== pub);
        return group;
    };

    api.members = function (state, name) {
        const group = api.group(state, name);
        return group ? group.members.map(pub => api.pal(state, pub)).filter(Boolean) : [];
    };

    /** The pals who could still be added to a group. */
    api.candidates = function (state, name) {
        const group = api.group(state, name);
        return group ? state.pals.filter(p => group.members.indexOf(p.pub) === -1) : [];
    };

    api.prefix = function (name) {
        return '[' + name + '] ';
    };

    const PREFIX = /^\[([^\[\]]{1,40})\] ?/;

    /** A received text taken apart: the group it names, and the rest. */
    api.unprefix = function (text) {
        const found = PREFIX.exec(String(text || ''));
        const name = found ? api.cleanName(found[1]) : '';
        return name ? { group: name, text: text.slice(found[0].length) } : { group: '', text: String(text || '') };
    };

    // ---- messages ------------------------------------------------------

    /** One line of a message: its first 128 characters, line breaks flattened. */
    api.excerpt = function (body) {
        return Array.from(String(body || '').replace(/\s+/g, ' ').trim()).slice(0, api.EXCERPT).join('');
    };

    // What a character costs inside the JSON a push carries: its UTF-8 bytes,
    // or more where JSON escapes it.
    const cost = function (ch) {
        const escaped = JSON.stringify(ch).slice(1, -1);
        if (escaped !== ch) {
            return escaped.length;
        }
        const cp = ch.codePointAt(0);
        return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    };
    const costOf = text => Array.from(text).reduce((sum, ch) => sum + cost(ch), 0);

    /**
     * A text cut into pieces that fit one push each, `reserve` characters and
     * bytes short of the limit (for the group prefix). Cuts fall between whole
     * characters, never inside an emoji.
     */
    api.split = function (text, reserve) {
        const before = String(reserve || '');
        const room = { chars: api.MAX_CHARS - Array.from(before).length, bytes: api.MAX_BYTES - costOf(before) };
        const parts = [];
        let part = '';
        let chars = 0;
        let bytes = 0;
        Array.from(String(text)).forEach(function (ch) {
            const c = cost(ch);
            if (chars + 1 > room.chars || bytes + c > room.bytes) {
                parts.push(part);
                part = '';
                chars = 0;
                bytes = 0;
            }
            part += ch;
            chars += 1;
            bytes += c;
        });
        if (part) {
            parts.push(part);
        }
        return parts;
    };

    const file = function (state, message) {
        state.seq += 1;
        message.id = 'm' + state.seq;
        state.messages.push(message);
        return message;
    };

    /**
     * A message the user wrote. `target` is `{kind: 'pal', id: <pub>}` or
     * `{kind: 'group', id: <group name>}`; the name is copied in, so the log
     * can still say where a message went after the pal or the group is gone.
     * `wire` is the id it travels under - random, so a pal never takes it for
     * one they had before.
     */
    api.compose = function (state, me, target, body, ts, wire) {
        let name;
        let to;
        if (target && target.kind === 'pal' && api.pal(state, target.id)) {
            name = api.pal(state, target.id).name;
            to = [target.id];
        } else if (target && target.kind === 'group' && api.group(state, target.id)) {
            const group = api.group(state, target.id);
            name = group.name;
            to = group.members.slice();
        } else {
            throw new Error('pick a pal or a group to write to');
        }
        const text = String(body || '');
        if (!text.trim()) {
            throw new Error('there is nothing to send');
        }
        if (!to.length) {
            throw new Error('nobody is in ' + name + ' yet');
        }
        const reserve = target.kind === 'group' ? api.prefix(name) : '';
        if (api.split(text, reserve).length > api.MAX_PARTS) {
            throw new Error('that is too long to send');
        }
        const delivery = {};
        to.forEach(pub => { delivery[pub] = 'sending'; });
        return file(state, {
            ts: ts,
            out: true,
            wire: wire,
            from: me.pub,
            fromName: me.name || api.UNKNOWN,
            to: { kind: target.kind, id: target.kind === 'group' ? name : target.id, name: name },
            body: text,
            delivery: delivery
        });
    };

    /**
     * The pushes a message makes: one per part, per receiver. A group message
     * goes to each member separately, every part starting with the prefix, so
     * a part that arrives alone still says which group it belongs to.
     */
    api.pushes = function (message, pubs) {
        const group = message.to.kind === 'group' ? api.prefix(message.to.name) : '';
        const parts = api.split(message.body, group);
        const out = [];
        (pubs || Object.keys(message.delivery || {})).forEach(function (to) {
            parts.forEach(function (text, i) {
                out.push({ to: to, id: message.wire, part: i + 1, parts: parts.length, message: group + text });
            });
        });
        return out;
    };

    /** How a message got on with one receiver: 'sending', 'sent' or what went wrong. */
    api.delivered = function (state, id, pub, status) {
        const m = api.message(state, id);
        if (m && m.delivery && Object.prototype.hasOwnProperty.call(m.delivery, pub)) {
            m.delivery[pub] = status;
        }
        return m;
    };

    /** 'sending', 'sent', or 'failed' - the whole of a message, for its row in the log. */
    api.deliveryOf = function (message) {
        const all = Object.keys(message.delivery || {}).map(k => message.delivery[k]);
        if (!all.length) {
            return '';
        }
        if (all.some(s => s === 'sending')) {
            return 'sending';
        }
        return all.every(s => s === 'sent') ? 'sent' : 'failed';
    };

    const joined = parts => parts.map(p => p === null ? api.MISSING : p).join('');

    /**
     * An envelope PalsSeal.open returned: `{from, to, ts, id, part, parts,
     * body}`. It opened with the key shared with `from` alone, so `from` is
     * who wrote it.
     *
     * Parts of one message share an `id`, and come in any order or not at all:
     * the message is filed when its first part comes, and filled in as the rest
     * do. `fromName` is what the directory calls the sender, for somebody who
     * is not a pal. Returns the message, or null for a part already seen.
     */
    api.receive = function (state, me, envelope, fromName) {
        const e = envelope || {};
        if (!api.isPub(e.from) || typeof e.body !== 'string') {
            throw new Error('not a message');
        }
        const parts = Math.min(Math.max(Number(e.parts) || 1, 1), api.MAX_PARTS);
        const part = Math.min(Math.max(Number(e.part) || 1, 1), parts);
        const wire = e.from + ' ' + String(e.id || '');
        const read = api.unprefix(e.body);
        let group = read.group ? api.group(state, read.group) : null;
        if (read.group && !group) {
            // A group the user does not have comes into being with the message,
            // and starts with its sender when they are a pal.
            group = api.addGroup(state, read.group);
            if (api.pal(state, e.from)) {
                group.members.push(e.from);
            }
        }

        let m = e.id ? state.messages.find(x => !x.out && x.wire === wire) : null;
        if (m) {
            if (m.parts[part - 1] !== null) {
                return null;
            }
        } else {
            const known = api.nameOf(state, e.from, me);
            m = file(state, {
                ts: Number(e.ts) || 0,
                out: false,
                wire: wire,
                from: e.from,
                fromName: known !== '?' ? known : api.cleanName(fromName) || '?',
                to: group ? { kind: 'group', id: group.name, name: group.name }
                          : { kind: 'pal', id: me.pub, name: me.name || api.UNKNOWN },
                parts: Array.from({ length: parts }, () => null),
                body: ''
            });
        }
        m.parts[part - 1] = read.text;
        m.body = joined(m.parts);
        m.complete = m.parts.every(p => p !== null);
        api.noteIncoming(state, e.from);
        return m;
    };

    /** Somebody wrote: their key goes to the top of the incoming list, once. */
    api.noteIncoming = function (state, pub) {
        if (!pub) {
            return state.incoming;
        }
        state.incoming = [pub].concat(state.incoming.filter(p => p !== pub));
        return state.incoming;
    };

    /**
     * What the Log panel shows, oldest first.
     *
     *   {kind: 'all'}                     everything
     *   {kind: 'pal', pub}                what was said with one pal: direct
     *                                     messages both ways, and whatever they
     *                                     said in a group
     *   {kind: 'group', id}               one group, by name
     *   {kind: 'member', id, pub}         one group, only what that member sent
     */
    api.log = function (state, filter) {
        const f = filter || { kind: 'all' };
        const direct = m => m.to.kind === 'pal';
        const inGroup = m => m.to.kind === 'group' && same(m.to.id, f.id);
        const keep = {
            all: () => true,
            pal: m => m.from === f.pub || (m.out && direct(m) && m.to.id === f.pub),
            group: inGroup,
            member: m => inGroup(m) && m.from === f.pub
        }[f.kind];
        if (!keep) {
            return [];
        }
        // The sort is stable, so messages of one instant stay in arrival order.
        return state.messages.filter(keep).sort((a, b) => a.ts - b.ts);
    };

    api.message = function (state, id) {
        return state.messages.find(m => m.id === id) || null;
    };

    // ---- keeping it ----------------------------------------------------

    /** Reads stored state, and starts empty rather than fail on a damaged one. */
    api.load = function (stored) {
        const state = api.empty();
        if (typeof stored === 'string') {
            try {
                stored = JSON.parse(stored);
            } catch (e) {
                return state;
            }
        }
        if (!stored || typeof stored !== 'object') {
            return state;
        }
        const list = value => Array.isArray(value) ? value : [];

        state.pals = list(stored.pals).filter(p => p && api.isPub(p.pub))
            .map(p => ({ pub: p.pub, name: api.cleanName(p.name) || api.UNKNOWN, verified: p.verified === true }));
        list(stored.groups).forEach(function (g) {
            const name = g && api.cleanName(g.name);
            if (name && !/[\[\]]/.test(name) && !api.group(state, name)) {
                state.groups.push({ name: name, members: list(g.members).filter(api.isPub) });
            }
        });
        state.messages = list(stored.messages)
            .filter(m => m && m.id && m.to && typeof m.body === 'string' && typeof m.from === 'string');
        state.incoming = list(stored.incoming).filter(p => typeof p === 'string');
        state.seq = Math.max(Number(stored.seq) || 0, state.messages.length);
        return state;
    };

    return api;
})();
