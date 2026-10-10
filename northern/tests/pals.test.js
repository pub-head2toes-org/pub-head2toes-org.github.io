'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import nodeCrypto from 'node:crypto';
import { loadPals, mountPals, mountWelcome, fakeIndexedDB, agreementKey, plain, read, settle, PWA_DIR, PAGE } from './helpers/palsPage.js';
import { REPO_ROOT, tmpDbPaths, seedSchema } from './helpers/db.js';
import sjclClass from '../src/h2t/sjclClass.js';
import Crypto from '../src/h2t/Crypto.js';
import { generateKeys, readKeys, sendProof, MAX_PAYLOAD } from '../src/h2t/PushApi.js';

const { Model, Views, Seal, Keys } = loadPals();
const sjcl = new sjclClass().get();

/** A Northern identity exactly as reg/session.js drafts one, with a live cookie. */
function identity(name) {
    const keys = sjcl.ecc.ecdsa.generateKeys(256, 0);
    const pub = sjcl.codec.base64.fromBits(keys.pub.get().x.concat(keys.pub.get().y));
    const priv = sjcl.codec.base64.fromBits(keys.sec.get());
    const signed = `${pub}.${Date.now()}`;
    const ssid = `${signed}.${sjcl.codec.base64.fromBits(keys.sec.sign(sjcl.hash.sha256.hash(signed), 0))}`;
    return { name, pub, priv, ssid };
}

const alice = identity('alice');
const bob = identity('bob');
const carol = identity('carol');
const dave = identity('dave');
const me = { pub: alice.pub, name: 'alice' };

const urlKeyOf = pub => Buffer.from(pub, 'base64').toString('base64url');
const tag = pub => pub.slice(0, 5);

/** A device as welcome.html lists it under /pals/, and as a search hands the row back. */
function listed(who, { name = who.name, ts = 1, author = who.pub, endpoint } = {}) {
    return {
        path: `/pals/${name}/${urlKeyOf(who.pub)}`, type: 'txt', counter: 0, author, public: 'public',
        value: JSON.stringify({
            pub: who.pub, username: name, provider: 'google', ts,
            subscription: { endpoint: endpoint || `https://fcm.googleapis.com/fcm/send/${name}-${ts}`, keys: { p256dh: 'BP-' + name, auth: 'auth-' + name } }
        })
    };
}

/** What PalsSeal.open hands back. */
const envelope = (from, body, extra = {}) => ({ v: 2, from: from.pub, to: alice.pub, ts: 1000, id: 'w1', part: 1, parts: 1, body, ...extra });

// Each identity's private key as reg/keystore.js keeps it: non-extractable, ECDH only.
const keys = Object.fromEntries(await Promise.all([alice, bob, carol, dave].map(async who => [who.name, await agreementKey(who)])));
const kept = (...who) => Object.fromEntries(who.map(w => [w.pub, { key: keys[w.name], at: 1 }]));

/** A push payload as the server relays it: sealed in the sender's browser. */
async function sealedFrom(from, to, body, { id = 'w1', part = 1, parts = 1, ts = 1000 } = {}) {
    const wire = { id, part, parts };
    return { v: 2, from: from.pub, to: to.pub, ...wire, sealed: await Seal.seal(keys[from.name], from.pub, to.pub, wire, { ts, body }) };
}

// ---------------------------------------------------------------------------
// model.js
// ---------------------------------------------------------------------------

describe('Pals model - keys and the directory', () => {
    it('recognises a Northern public key and nothing else', () => {
        assert.strictEqual(Model.isPub(alice.pub), true);
        for (const not of [urlKeyOf(alice.pub), alice.pub.slice(1), '', null, 42, alice.pub + 'A']) {
            assert.strictEqual(Model.isPub(not), false, String(not));
        }
    });

    it('labels a pal with the first five letters of the key', () => {
        assert.strictEqual(Model.tag(alice.pub), tag(alice.pub));
        assert.strictEqual(Model.label('alice', alice.pub), `alice (${tag(alice.pub)})`);
        assert.strictEqual(Model.label('', alice.pub), `UNKNOWN (${tag(alice.pub)})`);
    });

    it('puts a key in a path in the alphabet a path can carry, and reads it back', () => {
        for (const who of [alice, bob, carol, dave]) {
            const key = Model.urlKey(who.pub);
            assert.match(key, /^[A-Za-z0-9_-]{86}$/);
            assert.strictEqual(Model.pubFromUrlKey(key), who.pub);
        }
        assert.strictEqual(Model.pubFromUrlKey('nope'), '');
    });

    it('lists a device at /pals/<username>/<key>, the name made safe for one path segment', () => {
        assert.strictEqual(Model.palPath('alice', alice.pub), `/pals/alice/${urlKeyOf(alice.pub)}`);
        assert.strictEqual(Model.palPath(' ann  marie/x.y ', alice.pub), `/pals/ann%20marie%2Fx%2Ey/${urlKeyOf(alice.pub)}`,
            'a "." would make Northern read the rest as a file type');
        assert.strictEqual(Model.palPath('', alice.pub), `/pals/UNKNOWN/${urlKeyOf(alice.pub)}`);
    });

    it('files what a pal needs to push to the device, with the provider read off the endpoint', () => {
        const subscription = { endpoint: 'https://web.push.apple.com/QGx', expirationTime: null, keys: { p256dh: 'BPx', auth: 'au' } };
        assert.deepStrictEqual(plain(Model.palRecord(me, subscription, 7)), {
            pub: alice.pub, username: 'alice', provider: 'apple', ts: 7,
            subscription: { endpoint: 'https://web.push.apple.com/QGx', keys: { p256dh: 'BPx', auth: 'au' } }
        });
    });

    it('reads the directory: newest row per key, and only rows the key wrote itself', () => {
        const rows = [
            listed(bob, { ts: 1 }),
            listed(bob, { name: 'robert', ts: 5 }),
            listed(carol),
            listed(dave, { author: carol.pub, name: 'dave-by-carol' }),
            { ...listed(carol), path: listed(carol).path + '/1' },
            { ...listed(carol), value: 'not json' },
            { ...listed(dave), value: JSON.stringify({ pub: carol.pub, username: 'x', subscription: { endpoint: 'e', keys: {} } }) },
            { path: '/pals/premise/box/1.json', author: alice.pub, value: '{}' }
        ];
        const found = plain(Model.directory(rows));

        assert.deepStrictEqual(found.map(e => [e.name, e.pub]), [['carol', carol.pub], ['robert', bob.pub]]);
        assert.strictEqual(found[1].subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/robert-5');
        assert.strictEqual(found[1].provider, 'google');
        assert.deepStrictEqual(plain(Model.directory({ unavailable: '/pals/%' })), []);
    });

    it('leaves out the user and the pals they have already when offering whom to add', () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        const entries = Model.directory([listed(alice), listed(bob), listed(carol)]);
        assert.deepStrictEqual(plain(Model.strangers(state, entries, me)).map(e => e.name), ['carol']);
    });

    it('sends a visitor with no session to registration, carrying the way back', () => {
        assert.strictEqual(Model.regUrl(PAGE, '?a=1', '#x'), `/fs/get/reg/Reg.html#${PAGE}?a=1#x`);
    });
});

describe('Pals model - pals and groups', () => {
    it('adds a pal, and renames one who is already there', () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, '  bob  ', me);
        Model.addPal(state, bob.pub, 'robert', me);
        assert.deepStrictEqual(plain(state.pals), [{ pub: bob.pub, name: 'robert', verified: false }]);
        Model.verify(state, bob.pub, true);
        Model.addPal(state, bob.pub, 'bob', me);
        assert.strictEqual(state.pals[0].verified, true, 'renaming keeps the mark - the key is the same');
        assert.throws(() => Model.verify(state, carol.pub, true), /pick a pal/);
    });

    it('refuses what is not a key, and the user', () => {
        const state = Model.empty();
        assert.throws(() => Model.addPal(state, 'nope', 'x', me), /pick a pal/);
        assert.throws(() => Model.addPal(state, alice.pub, 'x', me), /that is you/);
    });

    it('keeps groups by name - case aside - with no brackets, and members unique', () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        const family = Model.addGroup(state, ' Family ');
        assert.strictEqual(family.name, 'Family');
        assert.strictEqual(Model.group(state, 'family'), family);
        assert.throws(() => Model.addGroup(state, 'FAMILY'), /already a group called FAMILY/);
        assert.throws(() => Model.addGroup(state, 'a [b]'), /\[ or \]/);
        assert.throws(() => Model.addGroup(state, '   '), /needs a name/);

        Model.addMember(state, 'family', bob.pub);
        Model.addMember(state, 'Family', bob.pub);
        assert.deepStrictEqual(plain(family.members), [bob.pub]);
        assert.throws(() => Model.addMember(state, 'Family', carol.pub), /only a pal/);
        assert.throws(() => Model.addMember(state, 'Work', bob.pub), /pick a group/);
        assert.deepStrictEqual(plain(Model.candidates(state, 'Family')), []);
    });

    it('takes a removed pal out of every group and out of the incoming list', () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        Model.addGroup(state, 'Family');
        Model.addMember(state, 'Family', bob.pub);
        Model.noteIncoming(state, bob.pub);
        Model.removePal(state, bob.pub);
        assert.deepStrictEqual(plain(state.groups[0].members), []);
        assert.deepStrictEqual(plain(state.incoming), []);
        Model.removeGroup(state, 'FAMILY');
        assert.deepStrictEqual(plain(state.groups), []);
    });

    // UPDATE_6: a dot by whoever wrote something not opened yet.
    it('marks a sender unread until their messages are opened, and lists who wrote without being a pal', () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        Model.receive(state, me, envelope(bob, 'hi'));
        Model.receive(state, me, envelope(dave, 'who is this', { id: 'd1' }));

        assert.strictEqual(Model.isUnread(state, bob.pub), true);
        assert.strictEqual(Model.isUnread(state, dave.pub), true);
        assert.strictEqual(Model.isUnread(state, carol.pub), false);
        assert.deepStrictEqual(plain(Model.others(state)), [dave.pub], 'bob is a pal; dave only wrote');

        Model.markUnread(state, bob.pub, false);
        assert.strictEqual(Model.isUnread(state, bob.pub), false);
        assert.deepStrictEqual(plain(Model.load(plain(state)).unread), [dave.pub], 'and it is kept');

        Model.addPal(state, dave.pub, 'dave', me);
        assert.deepStrictEqual(plain(Model.others(state)), [], 'once added, dave is a pal like any other');
        Model.removePal(state, dave.pub);
        assert.deepStrictEqual(plain(state.unread), [], 'removed, nothing is left marked');
        assert.deepStrictEqual(plain(Model.load({ unread: ['nope', bob.pub] }).unread), [bob.pub]);
    });

    it('writes a group into a message as a prefix, and reads it back out', () => {
        assert.strictEqual(Model.prefix('Family'), '[Family] ');
        assert.deepStrictEqual(plain(Model.unprefix('[Family] dinner at 8')), { group: 'Family', text: 'dinner at 8' });
        assert.deepStrictEqual(plain(Model.unprefix('[Family]dinner')), { group: 'Family', text: 'dinner' });
        assert.deepStrictEqual(plain(Model.unprefix('dinner [Family]')), { group: '', text: 'dinner [Family]' });
        assert.deepStrictEqual(plain(Model.unprefix('[] x')), { group: '', text: '[] x' });
        assert.deepStrictEqual(plain(Model.unprefix('[   ] x')), { group: '', text: '[   ] x' });
    });
});

describe('Pals model - messages', () => {
    const withPals = () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        Model.addPal(state, carol.pub, 'carol', me);
        Model.addGroup(state, 'Family');
        Model.addMember(state, 'Family', bob.pub);
        Model.addMember(state, 'Family', carol.pub);
        return state;
    };

    it('splits a message into pushes of at most 1000 characters', () => {
        const parts = Model.split('x'.repeat(2500));
        assert.deepStrictEqual(plain(parts.map(p => p.length)), [1000, 1000, 500]);
        assert.deepStrictEqual(plain(Model.split('short')), ['short']);
        assert.deepStrictEqual(plain(Model.split('')), []);
    });

    it('splits by bytes as well, so a part full of emoji or escapes still fits one push', () => {
        const emoji = Model.split('🍉'.repeat(1000));
        assert.deepStrictEqual(plain(emoji.map(p => Array.from(p).length)), [650, 350], '650 emoji are 2600 bytes');
        assert.ok(emoji.every(p => !/[\uD800-\uDBFF]$/.test(p)), 'never cut inside one');

        const controls = Model.split('\u0001'.repeat(1000));
        assert.ok(controls.every(p => Buffer.byteLength(JSON.stringify(p)) - 2 <= Model.MAX_BYTES));
        assert.strictEqual(controls.join(''), '\u0001'.repeat(1000));
    });

    it('leaves room in every part for the group prefix', () => {
        const parts = Model.split('x'.repeat(1990), '[Family] ');
        assert.deepStrictEqual(plain(parts.map(p => p.length)), [991, 991, 8]);
    });

    it('files what the user wrote, waiting to be sent to each receiver', () => {
        const state = withPals();
        const m = Model.compose(state, me, { kind: 'group', id: 'family' }, 'dinner at 8', 5, 'w9');

        assert.deepStrictEqual(plain(m), {
            ts: 5, out: true, wire: 'w9', from: alice.pub, fromName: 'alice',
            to: { kind: 'group', id: 'Family', name: 'Family' }, body: 'dinner at 8',
            delivery: { [bob.pub]: 'sending', [carol.pub]: 'sending' }, id: 'm1'
        });
        assert.strictEqual(Model.deliveryOf(m), 'sending');
    });

    it('refuses a message to nobody, to an empty group, an empty one, and one too long to send', () => {
        const state = withPals();
        Model.addGroup(state, 'Empty');
        assert.throws(() => Model.compose(state, me, null, 'x', 1, 'w'), /pick a pal or a group/);
        assert.throws(() => Model.compose(state, me, { kind: 'pal', id: dave.pub }, 'x', 1, 'w'), /pick a pal or a group/);
        assert.throws(() => Model.compose(state, me, { kind: 'group', id: 'Empty' }, 'x', 1, 'w'), /nobody is in Empty/);
        assert.throws(() => Model.compose(state, me, { kind: 'pal', id: bob.pub }, '  \n ', 1, 'w'), /nothing to send/);
        assert.throws(() => Model.compose(state, me, { kind: 'pal', id: bob.pub }, 'x'.repeat(100001), 1, 'w'), /too long/);
        assert.deepStrictEqual(plain(state.messages), []);
    });

    it('makes one push per part per receiver - a group message to each member, every part with the prefix', () => {
        const state = withPals();
        const m = Model.compose(state, me, { kind: 'group', id: 'Family' }, 'y'.repeat(1500), 5, 'w9');
        const pushes = plain(Model.pushes(m));

        assert.deepStrictEqual(pushes.map(p => [p.to, p.id, p.part, p.parts, p.message.length]), [
            [bob.pub, 'w9', 1, 2, 1000], [bob.pub, 'w9', 2, 2, 518],
            [carol.pub, 'w9', 1, 2, 1000], [carol.pub, 'w9', 2, 2, 518]
        ]);
        assert.ok(pushes.every(p => p.message.startsWith('[Family] ')));
        assert.deepStrictEqual(plain(Model.pushes(m, [carol.pub])).map(p => p.to), [carol.pub, carol.pub], 'or to whom it is told');

        const direct = Model.compose(state, me, { kind: 'pal', id: bob.pub }, 'hi', 6, 'w10');
        assert.deepStrictEqual(plain(Model.pushes(direct)), [{ to: bob.pub, id: 'w10', part: 1, parts: 1, message: 'hi' }]);
    });

    it('tracks delivery per receiver', () => {
        const state = withPals();
        const m = Model.compose(state, me, { kind: 'group', id: 'Family' }, 'hi', 5, 'w');
        Model.delivered(state, m.id, bob.pub, 'sent');
        assert.strictEqual(Model.deliveryOf(m), 'sending');
        Model.delivered(state, m.id, carol.pub, 'gone');
        assert.strictEqual(Model.deliveryOf(m), 'failed');
        Model.delivered(state, m.id, carol.pub, 'sent');
        assert.strictEqual(Model.deliveryOf(m), 'sent');
        Model.delivered(state, m.id, dave.pub, 'sent');
        assert.strictEqual(Object.keys(m.delivery).length, 2, 'and nobody it was not for');
    });

    it('files a direct message, and puts its sender on top of the incoming list', () => {
        const state = withPals();
        Model.noteIncoming(state, carol.pub);
        const m = Model.receive(state, me, envelope(bob, 'hello'));

        assert.strictEqual(m.body, 'hello');
        assert.strictEqual(m.fromName, 'bob');
        assert.deepStrictEqual(plain(m.to), { kind: 'pal', id: alice.pub, name: 'alice' });
        assert.strictEqual(m.complete, true);
        assert.deepStrictEqual(plain(state.incoming), [bob.pub, carol.pub]);
    });

    it('files a message with a group prefix under that group, without the prefix', () => {
        const state = withPals();
        const m = Model.receive(state, me, envelope(bob, '[family] dinner'));

        assert.strictEqual(m.body, 'dinner');
        assert.deepStrictEqual(plain(m.to), { kind: 'group', id: 'Family', name: 'Family' });
        assert.deepStrictEqual(plain(Model.log(state, { kind: 'group', id: 'Family' })).map(x => x.body), ['dinner']);
    });

    it('makes the group when the user has none of that name, starting with its sender', () => {
        const state = withPals();
        Model.receive(state, me, envelope(carol, '[Climbing] Saturday?'));
        Model.receive(state, me, envelope(dave, '[Chess] e4', { id: 'w2' }), 'dave');

        assert.deepStrictEqual(plain(Model.group(state, 'climbing')), { name: 'Climbing', members: [carol.pub] });
        assert.deepStrictEqual(plain(Model.group(state, 'chess')), { name: 'Chess', members: [] }, 'nobody who is not a pal joins a group');
    });

    it('puts a message in parts back together, in whatever order they come, once each', () => {
        const state = withPals();
        const part = (n, body) => envelope(bob, body, { id: 'long', part: n, parts: 3 });

        const m = Model.receive(state, me, part(3, 'three'));
        assert.strictEqual(m.body, '[…][…]three');
        assert.strictEqual(m.complete, false);
        assert.strictEqual(Model.receive(state, me, part(1, 'one ')), m);
        assert.strictEqual(Model.receive(state, me, part(1, 'one ')), null, 'a part seen before is dropped');
        Model.receive(state, me, part(2, 'two '));

        assert.strictEqual(m.body, 'one two three');
        assert.strictEqual(m.complete, true);
        assert.strictEqual(state.messages.length, 1);

        const other = Model.receive(state, me, envelope(carol, 'not bob\'s', { id: 'long', part: 1, parts: 3 }));
        assert.notStrictEqual(other, m, 'the same id from somebody else is another message');
    });

    it('names a sender who is not a pal as the directory does, and refuses what is not a message', () => {
        const state = withPals();
        const m = Model.receive(state, me, envelope(dave, 'hi'), 'dave');
        assert.strictEqual(m.fromName, 'dave');
        assert.strictEqual(Model.nameOf(state, dave.pub, me), 'dave');
        assert.strictEqual(Model.nameOf(state, identity('x').pub, me), '?');
        assert.throws(() => Model.receive(state, me, { from: 'nobody', body: 'x' }), /not a message/);
    });

    it('shows everything, one pal, one group, or one member of it - oldest first', () => {
        const state = withPals();
        Model.receive(state, me, envelope(bob, '[Family] b-group', { ts: 3, id: 'a' }));
        Model.compose(state, me, { kind: 'pal', id: bob.pub }, 'to-bob', 2, 'w');
        Model.receive(state, me, envelope(carol, '[Family] c-group', { ts: 4, id: 'b' }));
        Model.receive(state, me, envelope(bob, 'b-direct', { ts: 1, id: 'c' }));
        const bodies = filter => plain(Model.log(state, filter)).map(m => m.body);

        assert.deepStrictEqual(bodies(), ['b-direct', 'to-bob', 'b-group', 'c-group']);
        assert.deepStrictEqual(bodies({ kind: 'pal', pub: bob.pub }), ['b-direct', 'to-bob', 'b-group']);
        assert.deepStrictEqual(bodies({ kind: 'group', id: 'family' }), ['b-group', 'c-group']);
        assert.deepStrictEqual(bodies({ kind: 'member', id: 'Family', pub: carol.pub }), ['c-group']);
        assert.deepStrictEqual(bodies({ kind: 'nonsense' }), []);
    });

    // UPDATE_5: a reply and a correction are new messages carrying the
    // original, then who sent it and when.
    it('replies where a message came from: its group, or its sender', () => {
        const state = withPals();
        const direct = Model.receive(state, me, envelope(bob, 'are you in?', { id: 'a' }));
        const group = Model.receive(state, me, envelope(carol, '[Family] dinner at 8', { id: 'b' }));

        const reply = Model.answer(state, me, direct, 'reply', 'yes', 5, 'w1');
        assert.deepStrictEqual(plain(reply.to), { kind: 'pal', id: bob.pub, name: 'bob' });
        assert.strictEqual(reply.body, `are you in?\nSent by: bob (${tag(bob.pub)}) on ${Model.time(1000)}\n--- Reply ---\nyes`);
        assert.strictEqual(reply.out, true);
        assert.deepStrictEqual(plain(reply.delivery), { [bob.pub]: 'sending' });

        const toGroup = Model.answer(state, me, group, 'reply', 'see you', 6, 'w2');
        assert.deepStrictEqual(plain(toGroup.to), { kind: 'group', id: 'Family', name: 'Family' });
        assert.strictEqual(toGroup.body, `dinner at 8\nSent by: carol (${tag(carol.pub)}) on ${Model.time(1000)}\n--- Reply ---\nsee you`);
        assert.deepStrictEqual(Object.keys(toGroup.delivery), [bob.pub, carol.pub]);
    });

    it('sends a correction where the message went, after the original', () => {
        const state = withPals();
        const m = Model.compose(state, me, { kind: 'pal', id: carol.pub }, 'dinner at 8', 1, 'w1');
        const fixed = Model.answer(state, me, m, 'correction', 'dinner at 9', 2, 'w2');

        assert.deepStrictEqual(plain(fixed.to), { kind: 'pal', id: carol.pub, name: 'carol' });
        assert.strictEqual(fixed.body, `dinner at 8\nSent by: alice (${tag(alice.pub)}) on ${Model.time(1)}\n--- Correction ---\ndinner at 9`);
        assert.notStrictEqual(fixed.id, m.id, 'a new message');
        assert.strictEqual(m.body, 'dinner at 8', 'the original stays as it was');
    });

    it('refuses an empty reply, a correction that changes nothing, and an answer to nobody', () => {
        const state = withPals();
        const fromBob = Model.receive(state, me, envelope(bob, 'hi', { id: 'a' }));
        const fromDave = Model.receive(state, me, envelope(dave, 'hi', { id: 'b' }), 'dave');
        const mine = Model.compose(state, me, { kind: 'group', id: 'Family' }, 'hi all', 1, 'w');
        const count = state.messages.length;

        assert.throws(() => Model.answer(state, me, fromBob, 'reply', ' \n', 2, 'w'), /write the reply first/);
        assert.throws(() => Model.answer(state, me, mine, 'correction', 'hi all ', 2, 'w'), /nothing is corrected/);
        assert.throws(() => Model.answer(state, me, mine, 'correction', '', 2, 'w'), /nothing to send/);
        assert.throws(() => Model.answer(state, me, fromDave, 'reply', 'who?', 2, 'w'), new RegExp(`dave \\(${tag(dave.pub)}\\) is not a pal`));
        Model.removeGroup(state, 'Family');
        assert.throws(() => Model.answer(state, me, mine, 'correction', 'hi everyone', 2, 'w'), /no group Family any more/);
        assert.strictEqual(state.messages.length, count, 'nothing was filed');
    });
});

describe('Pals model - keeping it', () => {
    it('round trips through what IndexedDB stores', () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        Model.addGroup(state, 'Family');
        Model.addMember(state, 'Family', bob.pub);
        Model.compose(state, me, { kind: 'group', id: 'Family' }, 'hi', 1, 'w');
        Model.receive(state, me, envelope(bob, 'yo'));

        assert.deepStrictEqual(plain(Model.load(structuredClone(plain(state)))), plain(state));
        assert.deepStrictEqual(plain(Model.load(JSON.stringify(state))), plain(state), 'or as text');
    });

    it('starts empty rather than fail on what it cannot read, and drops what does not fit', () => {
        for (const bad of [undefined, null, '', 'not json', 42, []]) {
            assert.deepStrictEqual(plain(Model.load(bad)), plain(Model.empty()), String(bad));
        }
        const repaired = Model.load({
            pals: [{ pub: bob.pub, name: '' }, { pub: 'nope' }],
            groups: [{ name: 'Family', members: [bob.pub, 'nope'] }, { name: 'family' }, { name: '[x]' }, { id: 'g1' }],
            messages: [{ id: 'm1', to: {}, body: 'x', from: bob.pub }, { id: 'm2' }],
            seq: 'x'
        });
        assert.deepStrictEqual(plain(repaired.pals), [{ pub: bob.pub, name: 'UNKNOWN', verified: false }]);
        assert.deepStrictEqual(plain(repaired.groups), [{ name: 'Family', members: [bob.pub] }]);
        assert.strictEqual(repaired.messages.length, 1);
        assert.strictEqual(repaired.seq, 1, 'so the next message does not reuse an id');
    });
});

// ---------------------------------------------------------------------------
// seal.js and reg/keystore.js
// ---------------------------------------------------------------------------

describe('Pals seal', () => {
    it('seals in one browser and opens in the other, with nothing but the two key pairs', async () => {
        const outer = await sealedFrom(alice, bob, 'zdravo 🍉', { id: 'm1', part: 2, parts: 3, ts: 7 });
        assert.deepStrictEqual(plain(await Seal.open(keys.bob, outer)),
            { v: 2, from: alice.pub, to: bob.pub, id: 'm1', part: 2, parts: 3, ts: 7, body: 'zdravo 🍉' });
        assert.notStrictEqual((await sealedFrom(alice, bob, 'zdravo 🍉')).sealed, (await sealedFrom(alice, bob, 'zdravo 🍉')).sealed,
            'a fresh salt and IV every time');
    });

    it('opens only for the receiver, from the sender it names, in the direction it was sent, unchanged', async () => {
        const outer = await sealedFrom(alice, bob, 'only bob');
        await assert.rejects(Seal.open(keys.carol, { ...outer, to: carol.pub }), 'not for carol');
        await assert.rejects(Seal.open(keys.bob, { ...outer, from: carol.pub }), 'not from anybody else');
        await assert.rejects(Seal.open(keys.alice, { ...outer, from: bob.pub, to: alice.pub }), 'not bounced back to alice as bob\'s');
        for (const change of [{ id: 'w2' }, { part: 2 }, { parts: 2 }, { v: 1 }]) {
            await assert.rejects(Seal.open(keys.bob, { ...outer, ...change }), JSON.stringify(change));
        }
        const bytes = Buffer.from(outer.sealed, 'base64url');
        bytes[40] ^= 1;
        await assert.rejects(Seal.open(keys.bob, { ...outer, sealed: bytes.toString('base64url') }), 'not once a byte has changed');
        await assert.rejects(Seal.open(keys.bob, { ...outer, sealed: 'short' }));
    });

    it('works with a key whose secret SJCL wrote short, padding it back to 32 bytes', () => {
        const jwk = plain(Keys.jwk(alice.pub, Buffer.alloc(31, 7).toString('base64')));
        assert.deepStrictEqual([...Buffer.from(jwk.d, 'base64url')], [0, ...Array(31).fill(7)]);
        assert.throws(() => Keys.jwk(alice.pub.slice(4), alice.priv), /not a P-256 key pair/);
    });

    it('keeps the key so that no script can read it back, and it cannot sign', async () => {
        assert.strictEqual(keys.alice.extractable, false);
        assert.deepStrictEqual([...keys.alice.usages], ['deriveBits']);
        await assert.rejects(globalThis.crypto.subtle.exportKey('jwk', keys.alice));
        assert.match(fs.readFileSync(path.join(REPO_ROOT, 'src/fs/reg/keystore.js'), 'utf8'),
            /importKey\('jwk', api\.jwk\(pub, priv\), \{ name: 'ECDH', namedCurve: 'P-256' \}, false, \['deriveBits'\]\)/);
    });

    it('gives every key a fingerprint of 30 digits, the same each time and different for each key', async () => {
        const print = await Seal.fingerprint(alice.pub);
        assert.match(print, /^\d{5}( \d{5}){5}$/);
        assert.strictEqual(await Seal.fingerprint(alice.pub), print);
        assert.notStrictEqual(await Seal.fingerprint(bob.pub), print);
    });
});

// ---------------------------------------------------------------------------
// views.js
// ---------------------------------------------------------------------------

describe('Pals views', () => {
    const state = Model.empty();
    Model.addPal(state, bob.pub, 'bob', me);
    Model.addPal(state, carol.pub, '<img src=x onerror=alert(1)>', me);
    Model.addGroup(state, 'Family');
    Model.addMember(state, 'Family', bob.pub);

    it('lists pals as name and the head of the key, and never lets a name become markup', () => {
        const html = Views.pals(state, bob.pub);
        assert.ok(html.includes(`data-pub="${bob.pub}"`));
        assert.ok(html.includes(`aria-selected="true" data-pub="${bob.pub}">bob (${tag(bob.pub)})</button>`));
        assert.ok(!html.includes('<img'));
        assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(!html.includes('class="verified"'));
        const verified = Model.load(plain(state));
        Model.verify(verified, bob.pub, true);
        assert.ok(Views.pals(verified).includes(`bob (${tag(bob.pub)}) <span class="verified"`), 'a verified pal carries a tick');
    });

    it('puts a dot by a pal with new messages, and lists who wrote without being a pal, set apart', () => {
        const s = Model.load(plain(state));
        assert.ok(!Views.pals(s, null, me).includes('class="dot"'));
        Model.receive(s, me, envelope(bob, 'hi'));
        Model.receive(s, me, envelope(dave, 'hello', { id: 'd1' }), 'dave');
        const html = Views.pals(s, null, me);

        assert.ok(html.includes(`>bob (${tag(bob.pub)})<span class="dot"`));
        assert.ok(html.includes(`data-pub="${dave.pub}" title="Not a pal: add them with + to answer"><span class="other">dave (${tag(dave.pub)})</span><span class="dot"`));
        assert.ok(html.indexOf(dave.pub) > html.indexOf(carol.pub), 'after the pals');
        Model.markUnread(s, bob.pub, false);
        assert.ok(!Views.pals(s, null, me).includes(`>bob (${tag(bob.pub)})<span class="dot"`));
    });

    it('lists groups by name, the selected one marked whatever its case', () => {
        const html = Views.groups(state, 'FAMILY');
        assert.ok(html.includes('aria-selected="true" data-group="Family">Family</button>'));
        assert.ok(Views.members(state, 'family', null).includes(`bob (${tag(bob.pub)})`));
        assert.ok(Views.members(state, 'Nope', null).includes('Pick a group'));
    });

    // UPDATE_8: the whole message, not its first 128 characters on one line.
    it('gives a message two rows: all of it, then who sent it on an oval', () => {
        const s = Model.load(plain(state));
        const long = 'x'.repeat(200) + '\n\n  <second> line';
        Model.receive(s, me, envelope(bob, '\n' + long + '\n'));
        const html = Views.log(Model.log(s), s, me);
        const [first, second] = html.split('</span>');

        assert.ok(first.endsWith('<span class="text">' + 'x'.repeat(200) + '\n\n  &lt;second&gt; line'), 'line breaks kept, the ends trimmed');
        assert.ok(!html.includes('&hellip;'));
        assert.ok(second.includes(`class="pill" style="--hue:${Views.hue(bob.pub)}">bob (${tag(bob.pub)})`));
        assert.match(read('styles.css'), /\.text\s*{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/);
    });

    it('puts a bubble of three dots by the sender, as a message opens to more', () => {
        const s = Model.load(plain(state));
        Model.receive(s, me, envelope(bob, 'hi'));
        Model.compose(s, me, { kind: 'pal', id: bob.pub }, 'hi', 1, 'w');
        const html = Views.log(Model.log(s), s, me);

        assert.ok(html.includes(`bob (${tag(bob.pub)})</span><span class="more" title="Open to reply">...</span>`));
        assert.ok(html.includes(`alice (${tag(alice.pub)})</span><span class="more" title="Open to send a correction">...</span>`));
        assert.match(read('styles.css'), /\.more\s*{[^}]*background:\s*var\(--more-bg\)/);
    });

    it('says when a message is on its way, did not get there, or is missing parts', () => {
        const s = Model.load(plain(state));
        const m = Model.compose(s, me, { kind: 'pal', id: bob.pub }, 'hi', 1, 'w');
        assert.ok(Views.log([m], s, me).includes('<span class="state sending">sending…</span>'));
        Model.delivered(s, m.id, bob.pub, 'the pal\'s device is no longer subscribed');
        assert.ok(Views.log([m], s, me).includes('<span class="state failed">not delivered</span>'));
        assert.strictEqual(Views.failures(m, s, me), `bob (${tag(bob.pub)}): the pal's device is no longer subscribed`);
        Model.delivered(s, m.id, bob.pub, 'sent');
        assert.ok(!Views.log([m], s, me).includes('class="state'));

        const partial = Model.receive(s, me, envelope(bob, 'a', { id: 'p', part: 1, parts: 3 }));
        assert.ok(Views.log([partial], s, me).includes('1 of 3 parts'));
    });

    // UPDATE_7: no "To" list - a message goes to whoever the Messages layer shows.
    it('writes to the pal the messages are with, or to the whole group, a member picked or not', () => {
        assert.deepStrictEqual(plain(Model.writeTo(state, { kind: 'pal', pub: bob.pub }, me)), { kind: 'pal', id: bob.pub });
        assert.deepStrictEqual(plain(Model.writeTo(state, { kind: 'group', id: 'family' }, me)), { kind: 'group', id: 'Family' });
        assert.deepStrictEqual(plain(Model.writeTo(state, { kind: 'member', id: 'Family', pub: bob.pub }, me)), { kind: 'group', id: 'Family' });
        assert.throws(() => Model.writeTo(state, { kind: 'pal', pub: dave.pub }, me), new RegExp(`\\(${tag(dave.pub)}\\) is not a pal - add them first`));
        assert.throws(() => Model.writeTo(state, { kind: 'group', id: 'Nope' }, me), /no group Nope any more/);
        assert.throws(() => Model.writeTo(state, { kind: 'all' }, me), /pick a pal or a group/);
    });

    it('starts a reply\'s row with Re:, and only a reply\'s', () => {
        const s = Model.load(plain(state));
        const asked = Model.receive(s, me, envelope(bob, 'are you in?'));
        const reply = Model.answer(s, me, asked, 'reply', 'yes', 2, 'w1');
        const fixed = Model.answer(s, me, Model.compose(s, me, { kind: 'pal', id: bob.pub }, 'at 8', 3, 'w2'), 'correction', 'at 9', 4, 'w3');

        assert.ok(Views.log([reply], s, me).startsWith('<button type="button" role="option" class="row" aria-selected="false" data-message="' +
            reply.id + '"><span class="text"><span class="re">Re:</span> are you in?'));
        assert.ok(!Views.log([asked, fixed], s, me).includes('Re:'), 'not the message replied to, nor a correction');
        assert.strictEqual(Model.isReply('a line\n--- Reply --- and more'), false, 'only the line itself');
        assert.match(read('styles.css'), /\.re\s*{/);
    });

    it('offers whom to add from the directory', () => {
        const html = Views.strangers(Model.directory([listed(dave)]));
        assert.strictEqual(html, `<option value="${dave.pub}">dave (${tag(dave.pub)})</option>`);
    });

    it('names what the log is showing, and says so when a list is empty', () => {
        assert.strictEqual(Views.context(state, { kind: 'member', id: 'Family', pub: bob.pub }, me), `Family, from bob (${tag(bob.pub)})`);
        assert.strictEqual(Views.context(state, { kind: 'all' }, me), '');
        const none = Model.empty();
        assert.ok(Views.pals(none).includes('Add a pal with +'));
        assert.strictEqual(Views.groups(none), '<p class="empty">No groups</p>');
    });
});

// ---------------------------------------------------------------------------
// The files, and sw.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// attachments: a photo or a video that goes with a message
// ---------------------------------------------------------------------------

describe('Pals attachments - model, seal and views', () => {
    const withPals = () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        Model.addPal(state, carol.pub, 'carol', me);
        Model.addGroup(state, 'Family');
        Model.addMember(state, 'Family', bob.pub);
        Model.addMember(state, 'Family', carol.pub);
        return state;
    };
    const fileId = 'F'.repeat(43);
    const fileKey = 'K'.repeat(43);

    it('takes a photo or a video of at most 50 MB, sealed, and names it without a path', () => {
        assert.deepStrictEqual(plain(Model.attachment('IMG_0001.JPG', 'image/jpeg', 2048)),
            { name: 'IMG_0001.JPG', type: 'image/jpeg', size: 2048, id: '', key: '' });
        assert.strictEqual(Model.attachment('clip.mov', 'Video/QuickTime', 1).type, 'video/quicktime');
        assert.strictEqual(Model.attachment('C:\\Users\\a\\b/c\u0007.png', 'image/png', 1).name, 'c.png');
        assert.strictEqual(Array.from(Model.attachment('🍉'.repeat(100), 'image/png', 1).name).length, 60);
        assert.strictEqual(Model.attachment('', 'image/png', 1).name, 'attachment');
        assert.strictEqual(Model.MAX_FILE + 29, 50 * 1024 * 1024, 'what the temp API takes, less what sealing adds');
        assert.ok(Model.attachment('big.mp4', 'video/mp4', Model.MAX_FILE));

        assert.throws(() => Model.attachment('a.pdf', 'application/pdf', 10), /only a photo or a video/);
        assert.throws(() => Model.attachment('a', '', 10), /only a photo or a video/);
        assert.throws(() => Model.attachment('a.png', 'image/png', 0), /empty/);
        assert.throws(() => Model.attachment('big.mp4', 'video/mp4', Model.MAX_FILE + 1), /50 MB at most/);
    });

    it('sends a photo with no words, and a long text with one in shorter parts, the photo with every part', () => {
        const state = withPals();
        assert.throws(() => Model.compose(state, me, { kind: 'pal', id: bob.pub }, ' ', 1, 'w'), /nothing to send/);

        const photo = Model.compose(state, me, { kind: 'pal', id: bob.pub }, '', 1, 'w1', Model.attachment('a.jpg', 'image/jpeg', 10));
        Object.assign(photo.attachment, { id: fileId, key: fileKey });
        assert.deepStrictEqual(plain(Model.pushes(photo)), [{ to: bob.pub, id: 'w1', part: 1, parts: 1, message: '',
            att: { id: fileId, key: fileKey, type: 'image/jpeg', name: 'a.jpg', size: 10 } }]);

        const long = Model.compose(state, me, { kind: 'group', id: 'Family' }, '🍉'.repeat(1300), 2, 'w2', Model.attachment('a.jpg', 'image/jpeg', 10));
        Object.assign(long.attachment, { id: fileId, key: fileKey });
        const pushes = plain(Model.pushes(long));
        assert.deepStrictEqual(pushes.map(p => [p.part, p.parts]), [[1, 3], [2, 3], [3, 3], [1, 3], [2, 3], [3, 3]],
            'without the photo it is two parts; the photo takes room in each');
        assert.ok(pushes.every(p => p.att.id === fileId && p.message.startsWith('[Family] ')));
    });

    it('still fits every part in one push, at the worst: emoji, the longest names, 100 parts', async () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bob', me);
        // A name is cut to 40 UTF-16 units: 20 emoji.
        const group = Model.addGroup(state, '🍉'.repeat(40)).name;
        Model.addMember(state, group, bob.pub);
        const att = Model.attachment('"🍉'.repeat(30), 'image/' + 'x'.repeat(34), Model.MAX_FILE);
        for (const text of ['🍉'.repeat(30000), '\u0001'.repeat(30000), '"'.repeat(30000)]) {
            const m = Model.compose(state, me, { kind: 'group', id: group }, text, Date.now(), 'x'.repeat(40), att);
            Object.assign(m.attachment, { id: fileId, key: fileKey });
            const [push] = plain(Model.pushes(m));
            const wire = { id: push.id, part: 100, parts: 100 };
            const sealed = await Seal.seal(keys.alice, alice.pub, bob.pub, wire, { ts: Date.now(), body: push.message, att: push.att });
            const payload = JSON.stringify({ v: 2, from: alice.pub, to: bob.pub, ...wire, sealed });
            assert.ok(sealed.length <= 3800, `the seal is ${sealed.length} characters`);
            assert.ok(payload.length <= MAX_PAYLOAD, `the push is ${payload.length} characters`);
        }
    });

    it('seals the photo\'s id and key in with the text, and opens them only for the receiver', async () => {
        const wire = { id: 'w1', part: 1, parts: 1 };
        const att = { id: fileId, key: fileKey, type: 'image/jpeg', name: 'a.jpg', size: 10 };
        const outer = { v: 2, from: alice.pub, to: bob.pub, ...wire, sealed: await Seal.seal(keys.alice, alice.pub, bob.pub, wire, { ts: 1, body: 'look', att }) };

        assert.deepStrictEqual(plain(await Seal.open(keys.bob, outer)), { v: 2, from: alice.pub, to: bob.pub, ...wire, ts: 1, body: 'look', att });
        assert.ok(!Buffer.from(outer.sealed, 'base64url').toString('latin1').includes(fileKey));
        await assert.rejects(Seal.open(keys.carol, { ...outer, to: carol.pub }));
        assert.ok(!('att' in plain(await Seal.open(keys.bob, await sealedFrom(alice, bob, 'no photo')))), 'and a message without one has none');
    });

    it('locks a file under a key of its own, which opens it and nothing else does', async () => {
        const photo = nodeCrypto.randomBytes(70000);
        const { locked, key } = await Seal.lock(photo);
        const bytes = Buffer.from(locked);

        assert.match(key, /^[A-Za-z0-9_-]{43}$/);
        assert.strictEqual(bytes.length, photo.length + 29);
        assert.strictEqual(bytes.indexOf(photo.subarray(0, 32)), -1, 'Northern holds nothing it can read');
        assert.deepStrictEqual(Buffer.from(await Seal.unlock(bytes, key)), photo);
        assert.notStrictEqual((await Seal.lock(photo)).key, key, 'a fresh key every time');

        await assert.rejects(Seal.unlock(bytes, (await Seal.lock(photo)).key), 'not with another key');
        const changed = Buffer.from(bytes);
        changed[100] ^= 1;
        await assert.rejects(Seal.unlock(changed, key), 'not once a byte has changed');
        await assert.rejects(Seal.unlock(bytes.subarray(0, 20), key));
        await assert.rejects(Seal.unlock(bytes, 'short'));
    });

    it('files a received photo once, from whichever part comes first, and only one worth fetching', () => {
        const state = withPals();
        const att = { id: fileId, key: fileKey, type: 'image/jpeg', name: '../../a.jpg', size: 10 };
        const m = Model.receive(state, me, envelope(bob, 'part two', { part: 2, parts: 2, att }));
        Model.receive(state, me, envelope(bob, 'part one', { part: 1, parts: 2, att: { ...att, id: 'G'.repeat(43) } }));

        assert.deepStrictEqual(plain(m.attachment), { name: 'a.jpg', type: 'image/jpeg', size: 10, id: fileId, key: fileKey,
            saved: false, lost: false, error: '' });
        assert.deepStrictEqual(plain(Model.unfetched(state)).map(x => x.id), [m.id]);
        m.attachment.lost = true;
        assert.deepStrictEqual(plain(Model.unfetched(state)), [], 'one Northern no longer has is not asked for again');

        for (const bad of [{ ...att, id: 'short' }, { ...att, key: '../x' }, { ...att, type: 'text/html' }, 'x', null]) {
            assert.strictEqual(Model.receive(state, me, envelope(carol, 'hi', { id: JSON.stringify(bad), att: bad })).attachment, undefined, JSON.stringify(bad));
        }
    });

    it('shows a paperclip in the log, and the photo or video in the overlay - names never markup', () => {
        const state = withPals();
        const m = Model.compose(state, me, { kind: 'pal', id: bob.pub }, '', 1, 'w', Model.attachment('<b>"x\'.png', 'image/png', 2500000));
        assert.match(Views.log([m], state, me), /<span class="text"><span class="clip" title="Photo: &lt;b&gt;&quot;x&#39;\.png">&#128206;<\/span>&lt;b&gt;&quot;x&#39;\.png<\/span>/);

        assert.strictEqual(Views.attachment(m, 'blob:1'),
            '<img src="blob:1" alt="&lt;b&gt;&quot;x&#39;.png"><a class="link" href="blob:1" download="&lt;b&gt;&quot;x&#39;.png">Save Photo: &lt;b&gt;&quot;x&#39;.png, 2.4 MB</a>');
        const video = { attachment: { name: 'v.mp4', type: 'video/mp4', size: 3000 } };
        assert.match(Views.attachment(video, 'blob:2'), /^<video controls playsinline preload="metadata" src="blob:2"><\/video>/);
        assert.match(Views.attachment({ out: true, ...video }, null), /Video: v\.mp4, 3 KB\. Not sent yet\./);
        assert.match(Views.attachment(video, null), /Fetching it…/);
        assert.match(Views.attachment({ attachment: { ...video.attachment, error: 'Northern no longer has it' } }, null), /It could not be fetched: Northern no longer has it/);
        assert.strictEqual(Views.attachment({ attachment: undefined }, null), '');
        assert.deepStrictEqual([Views.size(900), Views.size(34 * 1024), Views.size(2.5 * 1024 * 1024)], ['900 bytes', '34 KB', '2.5 MB']);
    });
});

describe('Pals shell', () => {
    const index = read('index.html');
    const welcome = read('welcome.html');
    const sw = read('sw.js');
    const scriptsOf = html => [...html.matchAll(/<script[^>]*src=["']([^"'?]+)(\?[^"']*)?["']/g)].map(m => m[1]);
    const cached = [...sw.matchAll(/'(\.{1,2}\/[^']+)'/g)].map(m => m[1]);

    // UPDATE_6: the main screen has the gear, Pals and Groups; the rest is a layer above it.
    it('has the gear, then Pals and Groups side by side; messages, members and settings are layers', () => {
        const main = index.slice(index.indexOf('<main>'), index.indexOf('</main>'));
        const order = ['id="settings_open"', 'class="panels"', 'id="panel_pals"', 'id="panel_groups"'].map(mark => main.indexOf(mark));

        assert.ok(order.every(at => at !== -1), 'every section is on the page');
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
        assert.ok(!/<h1|id="user"|setup_again|id="version"|Incoming|id="messages"|id="members"|show all/.test(main),
            'no app name, nobody signed in, no version, no incoming list, no messages and no members on the page');
        assert.ok(!/invite/i.test(index), 'UPDATE_1 takes the invite link out');

        const layer = name => {
            const at = index.indexOf(`<dialog class="layer" id="dlg_${name}"`);
            assert.ok(at > index.indexOf('</main>'), name);
            return index.slice(at, index.indexOf('</dialog>', at));
        };
        assert.match(layer('messages'), /<h2 id="messages_title">Messages /);
        // UPDATE_7: the New message panel is under the messages, and Send (UPDATE_8) sends it.
        const messages = layer('messages');
        const panel = ['id="messages"', 'id="compose_body" rows="2"', '<label for="compose_file">Photo or video (50 MB at most)</label>',
            '<input type="file" id="compose_file"', 'id="message_add">Send</button>'].map(mark => messages.indexOf(mark));
        assert.ok(panel.every(at => at !== -1), 'the list, two rows to write in, the label, the file, Send');
        assert.deepStrictEqual(panel, [...panel].sort((a, b) => a - b));
        assert.ok(!/dlg_compose|compose_to|New message<\/h2>/.test(index), 'no New message overlay, and no To list');
        assert.ok(!messages.includes('>+</button>'));
        for (const id of ['members', 'member_add', 'member_remove', 'group_messages']) assert.ok(layer('members').includes(`id="${id}"`), id);
        for (const id of ['user', 'setup_again', 'version']) assert.ok(layer('settings').includes(`id="${id}"`), id);
        for (const id of ['pal_add', 'pal_remove', 'group_add', 'group_remove', 'pal_pick', 'message_retry', 'message_answer', 'message_answer_body']) {
            assert.ok(index.includes(`id="${id}"`), id);
        }
        assert.match(read('styles.css'), /\.panels\s*{[^}]*grid-template-columns:(\s*minmax\([^)]*fr\)){2};/);

        // UPDATE_8: on a phone, Messages is the whole screen, and its list never scrolls sideways.
        const css = read('styles.css');
        const phone = css.slice(css.indexOf('@media (max-width: 760px)'));
        assert.match(phone, /#dlg_messages\s*{[^}]*width:\s*100%;\s*max-width:\s*none;[^}]*height:\s*100dvh;\s*max-height:\s*none;\s*margin:\s*0;/);
        assert.match(css, /#messages\s*{[^}]*overflow-x:\s*hidden;/);
        assert.match(css, /\.meta\s*{[^}]*flex-wrap:\s*wrap;/);
        // Nothing in an overlay - a long name in the title - makes it wider than the screen.
        assert.match(css, /dialog form\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
        assert.match(css, /\.context\s*{[^}]*min-width:\s*0;/);
        assert.match(css, /\.compose\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
        assert.match(css, /\ntextarea\s*{[^}]*min-width:\s*0;\s*max-width:\s*100%;/);
    });

    it('has a welcome screen: one centred panel with a title, a line and Go', () => {
        const order = ['class="welcome"', '<h1>Welcome Pal</h1>', "<p>Let's get it started!</p>", 'id="go"'].map(mark => welcome.indexOf(mark));
        assert.ok(order.every(at => at !== -1));
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b));
        assert.match(read('styles.css'), /\.welcome\s*{[^}]*place-items:\s*center/);
    });

    it('loads every script it ships, and caches every script either page loads', () => {
        const shipped = fs.readdirSync(PWA_DIR).filter(f => f.endsWith('.js') && f !== 'sw.js');
        const loaded = new Set([...scriptsOf(index), ...scriptsOf(welcome)]);

        for (const file of shipped) {
            assert.ok(loaded.has('./' + file), `${file} is loaded by neither page`);
        }
        for (const src of loaded) {
            assert.ok(fs.existsSync(path.join(PWA_DIR, src)), `${src} does not exist`);
            assert.ok(cached.includes(src), `${src} is not cached by sw.js`);
        }
        for (const url of cached) {
            assert.ok(fs.existsSync(path.join(PWA_DIR, url)), `sw.js caches a file that does not exist: ${url}`);
        }
        assert.ok(cached.includes('./welcome.html') && cached.includes('./index.html'));
    });

    it('loads the identity first, then the model and the store, then the wiring', () => {
        for (const [html, last] of [[index, './pals.js'], [welcome, './welcome.js']]) {
            const scripts = scriptsOf(html);
            const at = name => scripts.indexOf(name);
            assert.ok(at('../../reg/session.js') < at('./model.js'));
            assert.ok(at('./model.js') < at('./store.js') && at('./store.js') < at(last));
            assert.strictEqual(scripts[scripts.length - 1], last);
        }
    });

    it('has a manifest whose icons exist', () => {
        const manifest = JSON.parse(read('manifest.json'));

        assert.strictEqual(manifest.name, 'Pals');
        assert.strictEqual(manifest.display, 'standalone');
        for (const icon of manifest.icons) {
            const png = fs.readFileSync(path.join(PWA_DIR, icon.src));
            assert.strictEqual(png.subarray(1, 4).toString(), 'PNG');
            assert.strictEqual(png.readUInt32BE(16), Number(icon.sizes.split('x')[0]), `${icon.src} is the size it claims`);
        }
    });

    /** sw.js run with a worker's globals stubbed; returns its listeners and what it did. */
    function worker({ online = true, idb = {} } = {}) {
        const listeners = {};
        const did = { fetched: [], called: [], put: [], posted: [], notified: [], windowsOpened: [], focused: 0 };
        const here = 'https://pals.example/fs/get/pwa/pals/';
        const cache = {
            addAll: urls => { did.precached = urls; return Promise.resolve(); },
            put: request => { did.put.push(request.url); return Promise.resolve(); }
        };
        const indexedDB = fakeIndexedDB(idb);
        const context = {
            URL, Promise, JSON, Date, atob, btoa, Uint8Array, String, TextEncoder, TextDecoder, indexedDB,
            Request: function Request(url, options) { this.url = url; Object.assign(this, options); },
            crypto: globalThis.crypto,
            caches: {
                open: () => Promise.resolve(cache),
                keys: () => Promise.resolve([]),
                match: request => Promise.resolve({ fromCache: request.url })
            },
            fetch: (request, options) => {
                if (typeof request === 'string') {
                    did.called.push(request);
                    return Promise.reject(new Error('the worker asks the server nothing'));
                }
                did.fetched.push(request.url);
                return online ? Promise.resolve({ status: 200, type: 'basic', clone: () => ({}) }) : Promise.reject(new Error('offline'));
            },
            self: {
                location: { href: here + 'sw.js' },
                addEventListener: (name, fn) => { listeners[name] = fn; },
                skipWaiting() {},
                clients: {
                    claim() {},
                    matchAll: () => Promise.resolve(did.windows || []),
                    openWindow: url => { did.windowsOpened.push(url); return Promise.resolve(); }
                },
                registration: { showNotification: (title, options) => { did.notified.push({ title, ...options }); return Promise.resolve(); } }
            }
        };
        const source = file => file.startsWith('../../reg/')
            ? fs.readFileSync(path.join(REPO_ROOT, 'src/fs/reg', file.slice('../../reg/'.length)), 'utf8')
            : read(file.replace('./', ''));
        context.importScripts = (...files) => files.forEach(file => vm.runInContext(source(file), context, { filename: file }));
        vm.createContext(context);
        vm.runInContext(sw, context, { filename: 'sw.js' });
        did.global = name => vm.runInContext(name, context);
        const fire = async (name, event = {}) => {
            let answered;
            const waits = [];
            listeners[name]({ ...event, waitUntil: p => waits.push(p), respondWith: p => { answered = p; } });
            await Promise.all(waits);
            return answered;
        };
        did.window = url => ({ url, postMessage: data => did.posted.push(data), focus: () => { did.focused += 1; return Promise.resolve(); } });
        did.inbox = () => [...(indexedDB.stores.inbox || new Map()).values()];
        return { did, fire, here };
    }
    // What Chrome hands the worker: the payload as text. The server sends JSON
    // because Chrome nulls a payload that is not UTF-8.
    const pushOf = payload => ({ data: { text: () => typeof payload === 'string' ? payload : JSON.stringify(payload) } });

    it('keeps the cache off everything that is not the pages\' own files', async () => {
        const { did, fire, here } = worker();
        const get = url => fire('fetch', { request: { method: 'GET', url } });

        for (const url of ['https://pals.example/pals/?searchPlus=%25', 'https://pals.example/push/api/config/pub',
            here + 'example/OpenChannel/index.html']) {
            assert.strictEqual(await get(url), undefined, url);
        }
        assert.strictEqual(await fire('fetch', { request: { method: 'POST', url: here + 'index.html' } }), undefined);
        assert.deepStrictEqual(did.fetched, [], 'none of those went through the worker');

        assert.ok(await get(here + 'welcome.html'));
        assert.ok(await get('https://pals.example/fs/get/reg/session.js'));
        assert.strictEqual(did.fetched.length, 2, 'the pages\' own files do, network first');
    });

    // UPDATE_4: the page shows the version the service worker's cache is named after.
    it('shows the app version in the settings, the one the cache is named after', async () => {
        const { did } = worker();
        const version = did.global('PALS_VERSION');
        assert.ok(Number.isInteger(version) && version >= 6);
        assert.strictEqual(did.global('CACHE_NAME'), `pals-v${version}`);
        assert.ok(index.indexOf('id="version"') > index.indexOf('id="dlg_settings"'), 'in the settings');

        const page = mountPals({ localStorage: { pub: alice.pub, pub_name: 'alice' }, cookie: `ssid=${alice.pub}.${Date.now()}.sig`,
            idb: { keys: kept(alice) } });
        await page.settle();
        assert.strictEqual(page.location.replaced, null);
        assert.strictEqual(page.element('version').textContent, `v${version}`);
    });

    // Cloudflare turns the server's no-cache on .js into max-age=14400, while
    // the HTML stays no-cache: a new index.html then ran an old pals.js, which
    // threw on the element Update 4 took out.
    it('asks for every script and the stylesheet by its version, so no cache can mix two versions', () => {
        const { did } = worker();
        const version = did.global('PALS_VERSION');
        for (const [name, html] of [['index.html', index], ['welcome.html', welcome]]) {
            const assets = [...html.matchAll(/<(?:script[^>]*src|link rel="stylesheet"[^>]*href)="(\.{1,2}\/[^"]+)"/g)].map(m => m[1]);
            assert.ok(assets.length > 5, name);
            for (const url of assets) {
                assert.ok(url.endsWith(`?v=${version}`), `${name}: ${url} is not asked for as v${version}`);
            }
        }
    });

    it('fills its cache past the browser\'s, and is checked for updates past it too', async () => {
        const { did, fire } = worker();
        await fire('install');
        assert.ok(did.precached.length > 10);
        assert.ok(did.precached.every(request => request.cache === 'reload'), 'not from the HTTP cache');
        assert.match(read('pals.js'), /register\('\.\/sw\.js', \{ updateViaCache: 'none' \}\)/);
        assert.match(read('welcome.js'), /register\('\.\/sw\.js', \{ updateViaCache: 'none' \}\)/);
    });

    it('answers from the cache when there is no network', async () => {
        const { fire, here } = worker({ online: false });
        assert.deepStrictEqual(await (await fire('fetch', { request: { method: 'GET', url: here + 'pals.js' } })), { fromCache: here + 'pals.js' });
    });

    it('opens a push on the device with the key the ID Card left, asking the server nothing, and names the sender', async () => {
        const state = Model.empty();
        Model.addPal(state, bob.pub, 'bobby', me);
        const { did, fire, here } = worker({ idb: { state: { [alice.pub]: plain(state) }, keys: kept(alice) } });
        did.windows = [did.window(here + 'index.html'), did.window(here + 'index.html')];
        const outer = await sealedFrom(bob, alice, 'hi');

        await fire('push', pushOf(outer));

        assert.deepStrictEqual(did.called, [], 'nothing went to the server');
        const [item] = did.inbox();
        assert.deepStrictEqual(plain(item.payload), outer);
        assert.deepStrictEqual(plain(item.envelope), envelope(bob, 'hi'));
        assert.deepStrictEqual(plain(did.posted), [{ type: 'pals:push' }, { type: 'pals:push' }]);
        assert.deepStrictEqual(did.notified.map(n => [n.title, n.body]), [['Pals', 'New message from bobby']],
            'the sender, and never the text');
    });

    it('keeps a push sealed when there is no key for it here, or it does not open, and notifies all the same', async () => {
        const { did, fire } = worker({ idb: { keys: kept(bob) } });
        const forAlice = await sealedFrom(bob, alice, 'no key for alice here');
        const relabelled = { ...(await sealedFrom(alice, bob, 'hi')), from: carol.pub };

        await fire('push', pushOf(forAlice));
        await fire('push', pushOf(relabelled));
        await fire('push', { data: null });
        await fire('push', pushOf('not json'));

        assert.deepStrictEqual(did.inbox().map(i => [i.payload.to, i.envelope]), [[alice.pub, undefined], [bob.pub, undefined]]);
        assert.deepStrictEqual(did.notified.map(n => n.body), ['New message', 'New message', 'New message', 'New message'],
            'a push always shows a notification, as Chrome requires');
    });

    it('calls a sender who is not a pal by the head of their key', async () => {
        const { did, fire } = worker({ idb: { keys: kept(alice) } });
        await fire('push', pushOf(await sealedFrom(dave, alice, 'hi')));
        assert.strictEqual(did.notified[0].body, `New message from A new pal (${tag(dave.pub)})`);
    });

    it('brings the open page forward on a notification click, or opens one', async () => {
        const { did, fire, here } = worker();
        const notification = { close() {} };

        await fire('notificationclick', { notification });
        assert.deepStrictEqual(did.windowsOpened, [here + 'index.html']);

        did.windows = [did.window(here + 'index.html#x')];
        await fire('notificationclick', { notification });
        assert.strictEqual(did.focused, 1);
        assert.strictEqual(did.windowsOpened.length, 1);
    });
});

// ---------------------------------------------------------------------------
// pals.js, through the real scripts in a DOM stub
// ---------------------------------------------------------------------------

describe('Pals page', () => {
    // The server's VAPID keys, which a send proof is made against.
    const vapid = readKeys(JSON.stringify(generateKeys()));
    const signedIn = (who = alice) => ({
        localStorage: { pub: who.pub, pub_name: who.name },
        cookie: `ssid=${who.pub}.${Date.now()}.sig`
    });
    const search = pattern => `GET /pals/?searchPlus=${encodeURIComponent(pattern)}`;
    const one = who => search('%/' + urlKeyOf(who.pub));
    // Northern with alice, bob and carol set up, a row filed by carol under
    // dave's key, and a push API that takes everything.
    const northern = (extra = {}) => ({
        [search('%')]: [listed(alice), listed(bob), listed(carol), listed(dave, { author: carol.pub })],
        [one(bob)]: [listed(bob)],
        [one(carol)]: [listed(carol)],
        [one(dave)]: [listed(dave)],
        'GET /push/api/config/pub': { publicKey: vapid.publicKey },
        'POST /push/api/send': () => [200, { status: 'OK' }],
        ...extra
    });
    // Alice's ID Card was loaded on this device, so her key is kept here.
    const open = async (options = {}) => {
        const { routes, idb, ...rest } = options;
        const page = mountPals({ ...signedIn(), routes: northern(routes), idb: { keys: kept(alice), ...idb }, ...rest });
        await page.settle();
        return page;
    };
    const type = (page, id, value) => { page.element(id).value = value; };
    const sent = page => page.fetch.calls.filter(c => c.url === '/push/api/send').map(c => JSON.parse(c.body));
    const addPal = async (page, who) => {
        page.click('pal_add');
        await page.settle();
        type(page, 'pal_pick', who.pub);
        page.submit('pal');
    };
    // Adds bob and carol, a group with both in it, and leaves the group selected.
    const populated = async (options) => {
        const page = await open(options);
        await addPal(page, bob);
        await addPal(page, carol);
        page.click('group_add');
        type(page, 'group_name', 'Family');
        page.submit('group');
        for (const who of [bob, carol]) {
            page.click('member_add');
            type(page, 'member_pal', who.pub);
            page.submit('member');
        }
        await page.settle();
        return page;
    };
    // The New message panel under the messages: written to, then Add.
    const write = async (page, body) => {
        type(page, 'compose_body', body);
        page.click('message_add');
        await page.settle();
    };
    const inbox = page => [...(page.indexedDB.stores.inbox || new Map()).values()];
    /** What the page sent, opened as its receiver would. */
    const opened = page => Promise.all(sent(page).map(push =>
        Seal.open(keys[[bob, carol, dave].find(w => w.pub === push.to).name], { v: 2, from: alice.pub, ...push }).then(plain)));
    // An inbox item the service worker opened, and one it could not.
    const openedItem = (from, body, extra = {}) => ({ payload: { v: 2, from: from.pub, to: alice.pub, id: 'w1', part: 1, parts: 1, sealed: 'x', ...extra },
        at: 1, envelope: envelope(from, body, extra) });
    const sealedItem = async (from, body, extra = {}) => ({ payload: await sealedFrom(from, alice, body, extra), at: Date.now() });

    it('sends a visitor who is not signed in to Reg.html, with the way back', async () => {
        const page = mountPals({});
        await page.settle();

        assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`);
        assert.strictEqual(page.html('pals'), '', 'and draws nothing');
        assert.strictEqual(page.fetch.calls.length, 0);
    });

    it('does the same for a browser that signed out', () => {
        const page = mountPals({ localStorage: { pub: 'notloggedin' }, cookie: `ssid=${alice.pub}.1.sig` });
        assert.ok(page.location.replaced.startsWith('/fs/get/reg/Reg.html#'));
    });

    // UPDATE_4: a notice to sign in again was missed, and the next message
    // went undelivered - so an expired session goes to Reg.html instead.
    it('sends a visitor whose session cookie has expired to Reg.html, with the way back', async () => {
        for (const cookie of ['', `ssid=${bob.pub}.1.sig`]) {
            const page = mountPals({ localStorage: { pub: alice.pub, pub_name: 'alice' }, cookie, idb: { keys: kept(alice) } });
            await page.settle();

            assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`, 'expired, or somebody else\'s: ' + cookie);
            assert.strictEqual(page.html('pals'), '', 'and draws nothing');
            assert.strictEqual(page.fetch.calls.length, 0);
        }
    });

    it('goes to Reg.html when the cookie expires while the page is open, once it is looked at again', async () => {
        const page = await open();
        page.show();
        assert.strictEqual(page.location.replaced, null, 'not while the cookie is live');

        page.document.cookie = '';
        page.show();
        assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`);
    });

    it('goes to Reg.html instead of writing a message, once the cookie has expired', async () => {
        const page = await open();
        await addPal(page, bob);
        page.document.cookie = '';

        type(page, 'compose_body', 'hi');
        page.click('message_add');
        await page.settle();
        assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`);
        assert.deepStrictEqual(page.stored().messages, [], 'nothing is filed that could not be sent');
        assert.deepStrictEqual(sent(page), []);
    });

    it('sends every part with a proof made with the kept key, which the server checks', async () => {
        const page = await open();
        await addPal(page, bob);
        const before = Date.now();
        await write(page, 'still here');

        const [push] = sent(page);
        assert.strictEqual(page.stored().messages[0].delivery[bob.pub], 'sent');
        assert.strictEqual(page.element('status').textContent, 'Sent.');
        assert.strictEqual(push.from, alice.pub);
        assert.ok(push.at >= before && push.at <= Date.now());
        assert.strictEqual(push.proof, sendProof(vapid, push).toString('base64url'), 'made against the server\'s key, as the server makes it');
        assert.notStrictEqual(push.proof, sendProof(vapid, { ...push, to: carol.pub }).toString('base64url'), 'and good for this push only');
        assert.strictEqual((await opened(page))[0].body, 'still here');
        assert.strictEqual(page.fetch.calls.filter(c => c.url === '/push/api/config/pub').length, 1, 'the server\'s key is asked for once');
    });

    it('sends a user who has not set this device up to welcome.html', async () => {
        const page = mountPals({ ...signedIn(), idb: { setup: {} } });
        await page.settle();

        assert.strictEqual(page.location.replaced, './welcome.html');
        assert.strictEqual(page.html('messages'), '');
        assert.deepStrictEqual(page.worker.registered, []);
    });

    it('shows who is signed in under the gear, and starts empty', async () => {
        const page = await open();

        assert.strictEqual(page.location.replaced, null);
        assert.strictEqual(page.element('dlg_settings').open, false);
        page.click('settings_open');
        assert.strictEqual(page.element('dlg_settings').open, true);
        assert.ok(page.html('user').includes(`>alice (${tag(alice.pub)})<`));
        assert.ok(page.html('groups').includes('No groups'));
        assert.deepStrictEqual(page.rows('pals'), []);
        assert.ok(page.html('pals').includes('Nobody yet'));
        assert.deepStrictEqual(page.worker.registered, ['./sw.js']);
    });

    it('offers to add everybody in /pals/ but the user, and only rows the key wrote itself', async () => {
        const page = await open();
        page.click('pal_add');
        assert.strictEqual(page.element('pal_error').textContent, 'Looking for pals…');
        await page.settle();

        const offered = [...page.html('pal_pick').matchAll(/value="([^"]+)">([^<]+)</g)].map(m => m[2]);
        assert.deepStrictEqual(offered, [`bob (${tag(bob.pub)})`, `carol (${tag(carol.pub)})`]);
        assert.strictEqual(page.element('pal_error').textContent, '');

        type(page, 'pal_pick', bob.pub);
        page.submit('pal');
        await page.settle();
        assert.deepStrictEqual(page.rows('pals'), [`bob (${tag(bob.pub)})`]);
        assert.deepStrictEqual(page.stored().pals, [{ pub: bob.pub, name: 'bob', verified: false }], 'kept in IndexedDB');
        assert.strictEqual(page.element('dlg_pal').open, false);

        page.click('pal_add');
        await page.settle();
        assert.ok(!page.html('pal_pick').includes(bob.pub), 'a pal is not offered twice');
    });

    it('keeps the overlay open, saying why, when nothing was picked or there is nobody to pick', async () => {
        const page = await open({ routes: { [search('%')]: [listed(alice)] } });
        page.click('pal_add');
        await page.settle();

        assert.match(page.element('pal_error').textContent, /nobody new to add/);
        assert.strictEqual(page.element('pal_pick').disabled, true);
        page.submit('pal');
        assert.strictEqual(page.element('pal_error').textContent, 'pick a pal from the list');
        assert.strictEqual(page.element('dlg_pal').open, true);
    });

    it('says so when the directory is out of reach', async () => {
        const page = await open({ routes: { [search('%')]: () => { throw new Error('offline'); } } });
        page.click('pal_add');
        await page.settle();
        assert.match(page.element('pal_error').textContent, /out of reach/);
    });

    it('opens a group\'s members in a layer; Messages there opens what was said in it, a member narrows it', async () => {
        const page = await populated();

        assert.deepStrictEqual(page.rows('groups'), ['Family']);
        assert.strictEqual(page.element('dlg_members').open, true, 'a new group opens its members, to add some');
        assert.deepStrictEqual(page.rows('members'), [`bob (${tag(bob.pub)})`, `carol (${tag(carol.pub)})`]);
        assert.strictEqual(page.element('members_context').textContent, 'Family');
        assert.deepStrictEqual(page.stored().groups, [{ name: 'Family', members: [bob.pub, carol.pub] }]);

        page.element('dlg_members').close();
        page.pick('groups', 'data-group', 'Family');
        assert.strictEqual(page.element('dlg_members').open, true, 'and so does a click on its name');
        assert.strictEqual(page.element('dlg_messages').open, false);
        page.click('group_messages');
        assert.strictEqual(page.element('dlg_messages').open, true);
        assert.strictEqual(page.element('messages_context').textContent, 'Family');
        page.pick('members', 'data-pub', bob.pub);
        assert.strictEqual(page.element('messages_context').textContent, `Family, from bob (${tag(bob.pub)})`);

        page.click('group_add');
        type(page, 'group_name', 'family');
        page.submit('group');
        assert.strictEqual(page.element('group_error').textContent, 'there is already a group called family');
    });

    it('seals in the browser to the pal\'s pinned key, and pushes to the device the directory lists for them now', async () => {
        const page = await open({ routes: { [one(bob)]: [listed(bob, { ts: 1 }), listed(bob, { ts: 9 })] } });
        await addPal(page, bob);
        await write(page, 'hello bob');

        const [push] = sent(page);
        assert.deepStrictEqual({ ...push, id: 'x', sealed: '', at: 0, proof: '' }, {
            to: bob.pub, provider: 'google', sealed: '', id: 'x', part: 1, parts: 1,
            subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/bob-9', keys: { p256dh: 'BP-bob', auth: 'auth-bob' } },
            from: alice.pub, at: 0, proof: ''
        });
        assert.match(push.id, /^[0-9a-f]{24}$/);
        assert.ok(!JSON.stringify(page.fetch.calls).includes('hello bob'), 'the text never leaves the browser unsealed');
        const [mine] = await opened(page);
        assert.strictEqual(mine.body, 'hello bob', 'and bob opens it with his key');
        const call = page.fetch.calls.find(c => c.url === '/push/api/send');
        assert.strictEqual(call.headers['Content-Type'], 'application/json');

        assert.deepStrictEqual(page.rows('messages'), [`hello bob\nalice (${tag(alice.pub)})\nto bob (${tag(bob.pub)})`]);
        assert.strictEqual(page.stored().messages[0].delivery[bob.pub], 'sent');
        assert.strictEqual(page.element('status').textContent, 'Sent.');
    });

    it('seals to the key it pinned when the pal was added, whatever the directory says later', async () => {
        const page = await open();
        await addPal(page, bob);
        // The directory now also has a row for bob's path written by dave: a
        // server, or a user, handing out another key. It changes nothing.
        const forged = { ...listed(dave), path: listed(bob).path };
        const again = await open({ indexedDB: page.indexedDB, routes: { [one(bob)]: [listed(bob), forged] } });
        again.pick('pals', 'data-pub', bob.pub);
        await write(again, 'for bob only');

        const [push] = sent(again);
        assert.strictEqual(push.to, bob.pub);
        assert.strictEqual((await opened(again))[0].body, 'for bob only');
    });

    it('sends a group message to each member on their own, prefixed, a long one in parts', async () => {
        const page = await populated();
        await write(page, 'z'.repeat(1500));

        const pushes = sent(page);
        const bodies = await opened(page);
        for (const who of [bob, carol]) {
            assert.deepStrictEqual(pushes.map((p, i) => [p.to, p.part, p.parts, bodies[i].body.length]).filter(p => p[0] === who.pub).map(p => p.slice(1)),
                [[1, 2, 1000], [2, 2, 518]], who.name + ' gets both parts, in order');
        }
        assert.strictEqual(pushes.length, 4);
        assert.ok(bodies.every(b => b.body.startsWith('[Family] ')), 'the group\'s name is inside the seal');
        assert.strictEqual(new Set(pushes.map(p => p.id)).size, 1, 'one message, one id');
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n').slice(1)), [[`alice (${tag(alice.pub)})`, 'in Family']]);
    });

    it('marks who a message did not reach and why, and sends it again to them alone', async () => {
        let carolGone = true;
        const page = await populated({ routes: {
            'POST /push/api/send': call => JSON.parse(call.body).to === carol.pub && carolGone
                ? [410, { error: 'Gone', message: 'the pal\'s device is no longer subscribed; they need to open Pals again' }]
                : [200, { status: 'OK' }]
        } });
        await write(page, 'hi all');

        assert.ok(page.html('messages').includes('not delivered'));
        assert.match(page.element('status').textContent, /Not delivered to everybody/);
        const id = page.stored().messages[0].id;
        page.pick('messages', 'data-message', id);
        assert.strictEqual(page.element('message_status').textContent,
            `Not delivered to carol (${tag(carol.pub)}): the pal's device is no longer subscribed; they need to open Pals again`);
        assert.strictEqual(page.element('message_retry').hidden, false);

        carolGone = false;
        const before = sent(page).length;
        page.element('message_retry').onclick();
        await page.settle();
        assert.deepStrictEqual(sent(page).slice(before).map(p => p.to), [carol.pub]);
        assert.ok(!page.html('messages').includes('not delivered'));
    });

    it('goes to Reg.html instead of sending again, once the cookie has expired', async () => {
        const page = await open({ routes: { 'POST /push/api/send': () => [410, { error: 'Gone', message: 'gone' }] } });
        await addPal(page, bob);
        await write(page, 'hi');
        const before = sent(page).length;
        page.pick('messages', 'data-message', page.stored().messages[0].id);
        page.document.cookie = '';

        page.element('message_retry').onclick();
        await page.settle();
        assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`);
        assert.strictEqual(sent(page).length, before);
        assert.notStrictEqual(page.stored().messages[0].delivery[bob.pub], 'sending', 'left as it was, to send again after');
    });

    it('does not send to a pal who is not in the directory, and says so', async () => {
        const page = await open({ routes: { [one(bob)]: [] } });
        await addPal(page, bob);
        await write(page, 'hi');

        assert.deepStrictEqual(sent(page), []);
        assert.strictEqual(page.stored().messages[0].delivery[bob.pub], 'they have not set Pals up');
    });

    it('says to load the ID Card when its key is not on this device, and sends nothing until it is', async () => {
        const page = await open({ idb: { keys: {} } });
        assert.strictEqual(page.element('need_card').hidden, false);
        assert.strictEqual(page.element('need_card_link').href, `/fs/get/reg/Reg.html#${PAGE}`);

        await addPal(page, bob);
        type(page, 'compose_body', 'hi');
        page.click('message_add');
        assert.match(page.element('messages_status').textContent, /Load your ID Card on this device first/);
        assert.strictEqual(page.element('compose_body').value, 'hi', 'what was written stays');
        await page.settle();
        assert.deepStrictEqual(page.stored().messages, []);
        assert.deepStrictEqual(sent(page), []);

        const ready = await open();
        assert.strictEqual(ready.element('need_card').hidden, true);
    });

    it('compares keys with a pal: both fingerprints, then a verified mark', async () => {
        const page = await open();
        await addPal(page, bob);
        assert.strictEqual(page.element('pal_verify').disabled, false);
        page.click('pal_verify');
        await page.settle();

        assert.strictEqual(page.element('verify_theirs').textContent, await Seal.fingerprint(bob.pub));
        assert.strictEqual(page.element('verify_mine').textContent, await Seal.fingerprint(alice.pub));
        page.submit('verify');
        await page.settle();
        assert.ok(page.html('pals').includes('class="verified"'));
        assert.strictEqual(page.stored().pals[0].verified, true);

        page.click('pal_verify');
        page.element('verify_reset').onclick();
        await page.settle();
        assert.strictEqual(page.stored().pals[0].verified, false);
    });

    // UPDATE_5: Reply on an incoming message, Correction (Edit since UPDATE_8) on an outgoing one.
    it('replies to an incoming message: Reply opens a text area and turns into Send', async () => {
        const page = await open({ idb: { inbox: { 1: openedItem(bob, 'are you in?') } } });
        await addPal(page, bob);
        await page.settle();
        const id = page.stored().messages[0].id;
        page.pick('messages', 'data-message', id);

        const button = page.element('message_answer');
        assert.strictEqual(button.textContent, 'Reply');
        assert.strictEqual(page.element('message_answer_box').hidden, true);
        button.onclick();
        assert.strictEqual(page.element('message_answer_box').hidden, false);
        assert.strictEqual(page.element('message_answer_body').value, '');
        assert.strictEqual(button.textContent, 'Send');

        button.onclick();
        assert.strictEqual(page.element('message_status').textContent, 'write the reply first');
        assert.strictEqual(page.element('dlg_message').open, true);

        type(page, 'message_answer_body', 'yes, at 8');
        button.onclick();
        await page.settle();
        assert.strictEqual(page.element('dlg_message').open, false);
        const [push] = sent(page);
        assert.strictEqual(push.to, bob.pub);
        const replied = `are you in?\nSent by: bob (${tag(bob.pub)}) on ${Model.time(1000)}\n--- Reply ---\nyes, at 8`;
        assert.strictEqual((await opened(page))[0].body, replied);
        assert.deepStrictEqual(page.stored().messages.map(m => [m.out, m.body]), [[false, 'are you in?'], [true, replied]]);
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n')[0]), ['are you in?', 'Re:']);
        assert.ok(page.html('messages').includes('<span class="re">Re:</span> are you in?'), 'the reply\'s row starts with Re:');
        assert.strictEqual(page.element('status').textContent, 'Sent.');

        // Opened again, the overlay starts closed up, as Reply.
        page.pick('messages', 'data-message', id);
        assert.strictEqual(button.textContent, 'Reply');
        assert.strictEqual(page.element('message_answer_box').hidden, true);
    });

    it('corrects an outgoing message: Edit opens a copy to edit and turns into Correct', async () => {
        const page = await populated();
        await write(page, 'dinner at 8');
        page.pick('messages', 'data-message', page.stored().messages[0].id);

        const button = page.element('message_answer');
        assert.strictEqual(button.textContent, 'Edit');
        button.onclick();
        assert.strictEqual(page.element('message_answer_body').value, 'dinner at 8');
        assert.strictEqual(button.textContent, 'Correct');

        type(page, 'message_answer_body', 'dinner at 9');
        const before = sent(page).length;
        button.onclick();
        await page.settle();
        const pushes = sent(page).slice(before);
        assert.deepStrictEqual(pushes.map(p => p.to).sort(), [bob.pub, carol.pub].sort(), 'to the group, as the original');
        const bodies = (await opened(page)).slice(before).map(b => b.body);
        const at = Model.time(page.stored().messages[0].ts);
        assert.deepStrictEqual(bodies, Array(2).fill(`[Family] dinner at 8\nSent by: alice (${tag(alice.pub)}) on ${at}\n--- Correction ---\ndinner at 9`));
    });

    it('says why a message from somebody who is not a pal cannot be answered, and opens nothing', async () => {
        const page = await open({ idb: { inbox: { 1: await sealedItem(dave, 'hi') } } });
        page.pick('messages', 'data-message', page.stored().messages[0].id);
        page.element('message_answer').onclick();

        assert.strictEqual(page.element('message_status').textContent, `dave (${tag(dave.pub)}) is not a pal - add them first`);
        assert.strictEqual(page.element('message_answer_box').hidden, true);
        assert.strictEqual(page.element('message_answer').textContent, 'Reply');
    });

    it('goes to Reg.html instead of replying, once the cookie has expired', async () => {
        const page = await open({ idb: { inbox: { 1: openedItem(bob, 'hi') } } });
        await addPal(page, bob);
        await page.settle();
        page.pick('messages', 'data-message', page.stored().messages[0].id);
        page.element('message_answer').onclick();
        type(page, 'message_answer_body', 'hello');
        page.document.cookie = '';

        page.element('message_answer').onclick();
        await page.settle();
        assert.strictEqual(page.location.replaced, `/fs/get/reg/Reg.html#${PAGE}`);
        assert.deepStrictEqual(sent(page), []);
        assert.strictEqual(page.stored().messages.length, 1);
    });

    it('refuses an empty message, and one to somebody who is not a pal, saying why under it', async () => {
        const page = await open({ idb: { inbox: { 1: openedItem(dave, 'hi') } } });
        await addPal(page, bob);
        type(page, 'compose_body', '   ');
        page.click('message_add');
        assert.strictEqual(page.element('compose_error').textContent, 'there is nothing to send');
        assert.strictEqual(page.element('compose_body').value, '   ', 'left to be put right');

        page.pick('pals', 'data-pub', dave.pub);
        type(page, 'compose_body', 'who are you?');
        page.click('message_add');
        assert.strictEqual(page.element('compose_error').textContent, `dave (${tag(dave.pub)}) is not a pal - add them first`);
        await page.settle();
        assert.strictEqual(page.stored().messages.length, 1, 'nothing was filed');
        assert.deepStrictEqual(sent(page), []);
    });

    it('keeps what was written while the same pal\'s messages are open, and starts empty for another', async () => {
        const page = await open();
        await addPal(page, bob);
        await addPal(page, carol);
        page.pick('pals', 'data-pub', bob.pub);
        assert.strictEqual(page.element('dlg_messages').open, true);
        type(page, 'compose_body', 'half a thought');
        page.element('compose_error').textContent = 'an old error';
        page.element('dlg_messages').close();

        page.pick('pals', 'data-pub', bob.pub);
        assert.strictEqual(page.element('compose_body').value, 'half a thought');
        assert.strictEqual(page.element('compose_error').textContent, '');
        page.element('dlg_messages').close();

        page.pick('pals', 'data-pub', carol.pub);
        assert.strictEqual(page.element('compose_body').value, '', 'not meant for carol');
        await write(page, 'hi carol');
        assert.deepStrictEqual(sent(page).map(p => p.to), [carol.pub]);
        assert.strictEqual(page.element('compose_body').value, '', 'emptied once it is on its way');
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n')[0]), ['hi carol']);
    });

    it('files what the service worker took in, opens here what it could not, and names somebody who is not a pal', async () => {
        const page = await open({
            idb: { inbox: {
                1: openedItem(bob, 'opened by the worker', { ts: 10, id: 'a' }),
                2: await sealedItem(dave, 'opened by the page', { ts: 20, id: 'b' })
            } }
        });

        assert.deepStrictEqual(inbox(page), [], 'the inbox is emptied');
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n')), [
            ['opened by the worker', `bob (${tag(bob.pub)})`],
            ['opened by the page', `dave (${tag(dave.pub)})`]
        ]);
        // UPDATE_6: no incoming list - a dot by whoever wrote; who is not a pal comes after the pals.
        assert.deepStrictEqual(page.rows('pals'), [`dave (${tag(dave.pub)})`, `bob (${tag(bob.pub)})`]);
        assert.strictEqual((page.html('pals').match(/class="dot"/g) || []).length, 2);
        assert.ok(page.fetch.calls.some(c => `GET ${c.url}` === search('%/' + urlKeyOf(dave.pub))), 'dave was looked up by key');
        assert.ok(!page.fetch.calls.some(c => c.url.startsWith('/push/api/')), 'and nothing was sent to the server to open');

        page.pick('pals', 'data-pub', dave.pub);
        assert.strictEqual(page.element('dlg_messages').open, true);
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n')[0]), ['opened by the page']);
        assert.strictEqual((page.html('pals').match(/class="dot"/g) || []).length, 1, 'opened, dave\'s dot goes');
        await page.settle();
        assert.deepStrictEqual(page.stored().unread, [bob.pub]);
    });

    it('puts a dot by a pal who wrote, but not while their messages are open; Key is for pals only', async () => {
        const page = await open();
        await addPal(page, bob);
        await page.settle();
        page.indexedDB.stores.inbox.set(1, openedItem(bob, 'first', { id: 'm1' }));
        page.push();
        await page.settle();
        assert.ok(page.html('pals').includes('class="dot"'));

        page.pick('pals', 'data-pub', bob.pub);
        assert.strictEqual(page.element('dlg_messages').open, true);
        assert.strictEqual(page.element('pal_verify').disabled, false);
        page.indexedDB.stores.inbox.set(2, openedItem(bob, 'second', { id: 'm2' }));
        page.push();
        await page.settle();
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n')[0]), ['first', 'second']);
        assert.ok(!page.html('pals').includes('class="dot"'), 'read as it comes');
        assert.deepStrictEqual(page.stored().unread, []);

        page.element('dlg_messages').close();
        page.indexedDB.stores.inbox.set(3, openedItem(dave, 'hello', { id: 'm3' }));
        page.push();
        await page.settle();
        page.pick('pals', 'data-pub', dave.pub);
        assert.strictEqual(page.element('pal_verify').disabled, true, 'dave is not a pal');
        page.element('dlg_messages').close();
        page.click('pal_remove');
        await page.settle();
        assert.match(page.confirms[0], /^Remove dave .* from the list\? What they wrote stays\./);
        assert.deepStrictEqual(page.rows('pals'), [`bob (${tag(bob.pub)})`]);
        assert.strictEqual(page.stored().messages.length, 3);
    });

    it('files a group message under its group, making it when there is none', async () => {
        const page = await populated({ routes: {} });
        page.indexedDB.stores.inbox.set(1, await sealedItem(bob, '[Family] dinner', { id: 'g1' }));
        page.indexedDB.stores.inbox.set(2, openedItem(carol, '[Climbing] Saturday?', { id: 'g2' }));
        page.push();
        await page.settle();

        assert.deepStrictEqual(page.rows('groups'), ['Family', 'Climbing']);
        page.pick('groups', 'data-group', 'Family');
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n')[0]), ['dinner']);
        page.pick('groups', 'data-group', 'Climbing');
        assert.deepStrictEqual(page.rows('members'), [`carol (${tag(carol.pub)})`]);
    });

    it('puts parts back together as they come, and shows a message still missing some', async () => {
        const part = (n, text) => sealedItem(bob, text, { id: 'long', part: n, parts: 2 });
        const page = await open({ idb: { inbox: { 1: await part(2, 'world') } } });
        assert.ok(page.html('messages').includes('1 of 2 parts'));

        page.indexedDB.stores.inbox.set(5, await part(1, 'hello '));
        page.push();
        await page.settle();
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n')[0]), ['hello world']);
        assert.strictEqual(page.stored().messages.length, 1);
    });

    it('keeps sealed messages in the inbox until the ID Card is loaded here, and says so', async () => {
        const page = await open({ idb: { keys: {}, inbox: { 1: await sealedItem(bob, 'later') } } });

        assert.strictEqual(inbox(page).length, 1);
        assert.match(page.element('status').textContent, /1 message is waiting\. Load your ID Card/);
    });

    it('leaves what is for another identity on this browser, and drops what will not open after a week, and the old kind', async () => {
        const forgery = { ...(await sealedFrom(bob, alice, 'x')), from: carol.pub };
        const page = await open({ idb: { inbox: {
            1: { payload: await sealedFrom(bob, carol, 'for carol'), at: 1 },
            2: { payload: forgery, at: Date.now() - 8 * 24 * 3600 * 1000 },
            3: { payload: forgery, at: Date.now() },
            4: { sealed: 'sealed by the server, the Update 1 way', at: Date.now() }
        } } });

        assert.deepStrictEqual(inbox(page).map(i => [i.payload.to, i.at > 1]), [[carol.pub, false], [alice.pub, true]]);
        assert.deepStrictEqual(page.rows('messages'), []);
    });

    it('removes a pal and a group only when the user says so', async () => {
        const page = await populated();
        page.pick('pals', 'data-pub', bob.pub);

        const refusing = await populated({ confirm: false });
        refusing.pick('pals', 'data-pub', bob.pub);
        refusing.click('pal_remove');
        assert.strictEqual(refusing.rows('pals').length, 2);

        page.click('pal_remove');
        await page.settle();
        assert.match(page.confirms[0], /^Remove bob/);
        assert.deepStrictEqual(page.rows('pals'), [`carol (${tag(carol.pub)})`]);
        page.pick('groups', 'data-group', 'Family');
        page.click('group_remove');
        await page.settle();
        assert.deepStrictEqual(page.stored().groups, []);
    });

    it('is still there after a reload, and is not shown to another identity', async () => {
        const page = await populated();
        await write(page, 'remember me');

        const again = mountPals({ ...signedIn(), routes: northern(), indexedDB: page.indexedDB });
        await again.settle();
        assert.deepStrictEqual(again.rows('groups'), ['Family']);
        assert.strictEqual(again.rows('messages').length, 1);

        page.indexedDB.stores.setup.set(bob.pub, { endpoint: 'https://fcm.googleapis.com/fcm/send/device' });
        const other = mountPals({ ...signedIn(bob), routes: northern(), indexedDB: page.indexedDB });
        await other.settle();
        assert.deepStrictEqual(other.rows('groups'), []);
        assert.deepStrictEqual(other.rows('messages'), []);
    });

    it('says so when this device no longer gets pushes', async () => {
        const page = await open({ subscription: null });
        assert.match(page.element('status').textContent, /no longer gets messages/);
        const replaced = await open({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/other' } });
        assert.match(replaced.element('status').textContent, /no longer gets messages/);
    });

    // A photo the user picks, as an <input type="file"> holds it.
    const picked = (bytes, name = 'beach.jpg', type = 'image/jpeg') =>
        ({ name, type, size: bytes.length, arrayBuffer: () => Promise.resolve(Uint8Array.from(bytes).buffer) });
    const writeWith = async (page, body, file) => {
        type(page, 'compose_body', body);
        page.element('compose_file').files = file ? [file] : [];
        page.click('message_add');
        await page.settle();
        await page.settle();
    };
    const FILE_ID = 'f'.repeat(43);
    const uploads = page => page.fetch.calls.filter(c => c.url === '/temp/api/upload');

    it('uploads a photo locked in the browser first, then seals its id and key into every part, once for a whole group', async () => {
        const photo = nodeCrypto.randomBytes(5000);
        const page = await populated({ routes: { 'POST /temp/api/upload': () => [200, { status: 'OK', id: FILE_ID, size: 5029 }] } });
        await writeWith(page, 'z'.repeat(1500), picked(photo));

        const [up] = uploads(page);
        assert.strictEqual(uploads(page).length, 1, 'one upload for both members');
        assert.strictEqual(up.method, 'POST');
        assert.strictEqual(up.headers['Content-Type'], 'application/octet-stream');
        assert.strictEqual(Buffer.from(up.body).indexOf(photo.subarray(0, 32)), -1, 'Northern gets only what it cannot open');
        assert.ok(page.fetch.calls.indexOf(up) < page.fetch.calls.findIndex(c => c.url === '/push/api/send'), 'before anything is pushed');

        const bodies = await opened(page);
        assert.strictEqual(bodies.length, 4, 'two parts to each of bob and carol');
        const { att } = bodies[0];
        assert.deepStrictEqual({ ...att, key: '' }, { id: FILE_ID, key: '', type: 'image/jpeg', name: 'beach.jpg', size: 5000 });
        assert.ok(bodies.every(b => JSON.stringify(b.att) === JSON.stringify(att)), 'every part carries it');
        assert.deepStrictEqual(Buffer.from(await Seal.unlock(Uint8Array.from(up.body), att.key)), photo, 'and the key in the seal opens it');
        assert.ok(!JSON.stringify(sent(page)).includes(att.key), 'the key never travels outside the seal');

        const [m] = page.stored().messages;
        assert.deepStrictEqual([m.attachment.id, m.attachment.key], [FILE_ID, att.key]);
        assert.deepStrictEqual(Buffer.from(page.file(m.id).bytes), photo, 'the photo stays on this device');
        assert.strictEqual(page.element('status').textContent, 'Sent.');
        assert.match(page.html('messages'), /class="clip"/);

        page.pick('messages', 'data-message', m.id);
        await page.settle();
        assert.strictEqual(page.element('message_attachment').hidden, false);
        assert.match(page.html('message_attachment'), /^<img src="blob:1" alt="beach\.jpg">/);
        assert.deepStrictEqual(Buffer.from(await page.urls.made.get('blob:1').arrayBuffer()), photo);
        page.element('dlg_message').listeners.close();
        assert.deepStrictEqual(page.urls.revoked, ['blob:1'], 'its URL is let go when the overlay closes');
    });

    it('sends nothing when the photo cannot be uploaded, says why, and uploads it on Send again', async () => {
        let full = true;
        const page = await open({ routes: { 'POST /temp/api/upload': () => full
            ? [507, { error: 'InsufficientStorage', message: 'the temp space is full; try again later' }]
            : [200, { status: 'OK', id: FILE_ID, size: 39 }] } });
        await addPal(page, bob);
        await writeWith(page, 'look', picked(Buffer.from('0123456789')));

        assert.deepStrictEqual(sent(page), [], 'no message without its photo');
        const [m] = page.stored().messages;
        assert.strictEqual(m.delivery[bob.pub], 'the photo could not be sent: the temp space is full; try again later');
        page.pick('messages', 'data-message', m.id);
        await page.settle();
        assert.match(page.html('message_attachment'), /^<img src="blob:1"/, 'the sender still sees it');

        full = false;
        page.element('message_retry').onclick();
        await page.settle();
        await page.settle();
        assert.strictEqual(uploads(page).length, 2);
        assert.strictEqual(sent(page).length, 1);
        assert.strictEqual((await opened(page))[0].att.id, FILE_ID);
        assert.strictEqual(page.stored().messages[0].delivery[bob.pub], 'sent');
    });

    it('keeps the message, saying why, for a file that is not a photo or a video, or too large', async () => {
        const page = await open();
        await addPal(page, bob);
        for (const [file, why] of [
            [picked(Buffer.from('%PDF'), 'a.pdf', 'application/pdf'), 'only a photo or a video can go with a message'],
            [{ ...picked(Buffer.from('x'), 'big.mp4', 'video/mp4'), size: 60 * 1024 * 1024 }, 'that file is too large to send: 50 MB at most']
        ]) {
            await writeWith(page, 'x', file);
            assert.strictEqual(page.element('compose_error').textContent, why);
            assert.strictEqual(page.element('compose_body').value, 'x');
        }
        assert.deepStrictEqual(page.stored().messages, [], 'nothing was filed');
        assert.deepStrictEqual(uploads(page), []);
    });

    it('fetches a received photo by its id at once, opens it with the key from the seal, and keeps it here', async () => {
        const photo = nodeCrypto.randomBytes(3000);
        const { locked, key } = await Seal.lock(photo);
        const att = { id: FILE_ID, key, type: 'image/png', name: 'cat.png', size: photo.length };
        const page = await open({
            routes: { [`GET /temp/api/download/${FILE_ID}`]: Uint8Array.from(locked) },
            idb: { inbox: { 1: await (async () => {
                const wire = { id: 'p1', part: 1, parts: 1 };
                const sealed = await Seal.seal(keys.bob, bob.pub, alice.pub, wire, { ts: 5, body: '', att });
                return { payload: { v: 2, from: bob.pub, to: alice.pub, ...wire, sealed }, at: Date.now() };
            })() } }
        });
        await page.settle();

        const [m] = page.stored().messages;
        assert.deepStrictEqual(page.fetch.calls.filter(c => c.url.startsWith('/temp/api/')).map(c => `${c.method} ${c.url}`),
            [`GET /temp/api/download/${FILE_ID}`]);
        assert.strictEqual(m.attachment.saved, true);
        assert.deepStrictEqual(Buffer.from(page.file(m.id).bytes), photo);
        assert.deepStrictEqual(page.rows('messages').map(r => r.split('\n').slice(0, 2)), [['&#128206;', 'cat.png']],
            'a paperclip, and for a photo with no words, its name');

        page.pick('messages', 'data-message', m.id);
        await page.settle();
        assert.match(page.html('message_attachment'), /^<img src="blob:1" alt="cat\.png"><a class="link" href="blob:1" download="cat\.png">/);

        page.push();
        await page.settle();
        assert.strictEqual(page.fetch.calls.filter(c => c.url.startsWith('/temp/api/')).length, 1, 'and it is fetched once');
    });

    it('tries a photo again when Northern is out of reach, and gives up on one it no longer has, or that will not open', async () => {
        const photo = nodeCrypto.randomBytes(100);
        const { locked, key } = await Seal.lock(photo);
        const ids = ['a', 'b', 'c'].map(c => c.repeat(43));
        let reachable = false;
        const page = await open({
            routes: {
                [`GET /temp/api/download/${ids[0]}`]: () => reachable ? [200, Uint8Array.from(locked)] : [502, 'Bad Gateway'],
                [`GET /temp/api/download/${ids[1]}`]: () => [404, { error: 'NotFound', message: 'no such file; it may have been purged' }],
                [`GET /temp/api/download/${ids[2]}`]: Uint8Array.from(locked)
            },
            idb: { inbox: Object.fromEntries(ids.map((id, i) => [i + 1, openedItem(bob, 'p' + i, { id: 'w' + i,
                att: { id, key: i === 2 ? (Buffer.alloc(32, 1)).toString('base64url') : key, type: 'image/png', name: i + '.png', size: 100 } })])) }
        });
        await page.settle();

        const errors = () => page.stored().messages.map(m => [m.attachment.saved, m.attachment.lost, m.attachment.error]);
        assert.deepStrictEqual(errors(), [
            [false, false, 'Northern answered 502'],
            [false, true, 'Northern no longer has it'],
            [false, true, 'it does not open with the key it came with']
        ]);
        page.pick('messages', 'data-message', page.stored().messages[1].id);
        await page.settle();
        assert.match(page.html('message_attachment'), /It could not be fetched: Northern no longer has it/);

        reachable = true;
        page.push();
        await page.settle();
        assert.deepStrictEqual(errors()[0], [true, false, '']);
        const asked = page.fetch.calls.filter(c => c.url.startsWith('/temp/api/')).map(c => c.url.slice(-1));
        assert.deepStrictEqual(asked, ['a', 'b', 'c', 'a'], 'only the one that could still come was asked for again');
    });

    it('asks Northern for nothing but the directory and the push API, and writes nothing to the database', async () => {
        const page = await populated();
        await write(page, 'hi');

        for (const call of page.fetch.calls) {
            assert.ok(call.url.startsWith('/pals/?searchPlus=') || call.url.startsWith('/push/api/'), call.url);
            assert.ok(call.method === 'GET' || call.url.startsWith('/push/api/'), `${call.method} ${call.url}`);
        }
    });
});

// ---------------------------------------------------------------------------
// welcome.js
// ---------------------------------------------------------------------------

describe('Pals welcome', () => {
    const SERVER_KEY = Buffer.from(nodeCrypto.createECDH('prime256v1').generateKeys()).toString('base64url');
    const where = `/pals/alice/${urlKeyOf(alice.pub)}?isPublic=true`;
    const signedIn = (name = 'alice') => ({
        localStorage: { pub: alice.pub, pub_name: name },
        cookie: `ssid=${alice.pub}.${Date.now()}.sig`
    });
    const northern = (extra = {}) => ({
        'GET /push/api/config/pub': { publicKey: SERVER_KEY },
        [`PUT ${where}`]: { unavailable: where.split('?')[0], author: alice.pub },
        [`POST ${where}`]: { status: 'OK', path: where.split('?')[0] },
        ...extra
    });
    // Alice's ID Card was loaded on this device, so her key is kept here.
    const welcome = async (options = {}) => {
        const { routes, ...rest } = options;
        const page = mountWelcome({ ...signedIn(), routes: northern(routes), idb: { keys: kept(alice) }, ...rest });
        await page.settle();
        return page;
    };

    it('sends a visitor who is not signed in to Reg.html, and back here after', () => {
        const page = mountWelcome({});
        assert.strictEqual(page.location.replaced, '/fs/get/reg/Reg.html#/fs/get/pwa/pals/welcome.html');
    });

    it('needs a user name to list the user under', async () => {
        for (const name of ['', 'UNKNOWN']) {
            const page = await welcome({ ...signedIn(name) });
            assert.strictEqual(page.element('go').disabled, true);
            assert.match(page.element('status').textContent, /no user name|none yet/);
        }
    });

    it('needs the ID Card loaded on this device first, and links to where that is done', async () => {
        const page = await welcome({ idb: {} });

        assert.strictEqual(page.element('go').disabled, true);
        assert.match(page.element('status').textContent, /load the card on this device first/);
        assert.strictEqual(page.element('load_card').hidden, false);
        assert.strictEqual(page.element('load_card').href, '/fs/get/reg/Reg.html#/fs/get/pwa/pals/welcome.html');
        page.go();
        await page.settle();
        assert.deepStrictEqual(page.asked, [], 'and Go does nothing without it');
        assert.deepStrictEqual(page.worker.subscribed, []);
    });

    it('says what to do where the browser has no Push API', async () => {
        const page = await welcome({ push: false });
        assert.strictEqual(page.element('go').disabled, true);
        assert.match(page.element('status').textContent, /Home Screen/);
    });

    it('on Go: asks to notify, subscribes with the server\'s key, lists the device, remembers it, and opens Pals', async () => {
        const page = await welcome();
        page.go();
        await page.settle();

        assert.strictEqual(page.asked.length, 1);
        assert.deepStrictEqual(page.worker.registered, ['./sw.js']);
        const [options] = page.worker.subscribed;
        assert.strictEqual(options.userVisibleOnly, true);
        assert.strictEqual(Buffer.from(options.applicationServerKey).toString('base64url'), SERVER_KEY);

        const writes = page.fetch.calls.filter(c => c.method !== 'GET');
        assert.deepStrictEqual(writes.map(c => `${c.method} ${c.url}`), [`PUT ${where}`, `POST ${where}`],
            'in place if listed before, new if not');
        const record = JSON.parse(writes[1].body);
        assert.deepStrictEqual({ ...record, ts: 0 }, {
            pub: alice.pub, username: 'alice', provider: 'google', ts: 0,
            subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/new-device', keys: { p256dh: 'BPdevice', auth: 'secret' } }
        });
        assert.deepStrictEqual(plain(page.setup(alice.pub)), {
            path: where.split('?')[0], endpoint: 'https://fcm.googleapis.com/fcm/send/new-device', provider: 'google', ts: record.ts
        });
        assert.strictEqual(page.location.replaced, './index.html');
    });

    it('updates the row in place when the device was listed before', async () => {
        const page = await welcome({ routes: { [`PUT ${where}`]: { status: 'OK', path: where, counter: 1 } } });
        page.go();
        await page.settle();
        assert.deepStrictEqual(page.fetch.calls.filter(c => c.method !== 'GET').map(c => c.method), ['PUT']);
        assert.strictEqual(page.location.replaced, './index.html');
    });

    it('keeps a subscription made with this server\'s key, and replaces one made with another', async () => {
        const mine = await welcome();
        mine.worker.current = mine.worker.subscriptionWith('https://fcm.googleapis.com/fcm/send/kept', Buffer.from(SERVER_KEY, 'base64url'));
        mine.go();
        await mine.settle();
        assert.deepStrictEqual(mine.worker.subscribed, []);
        assert.match(mine.fetch.calls.find(c => c.method === 'POST').body, /send\/kept/);

        const theirs = await welcome();
        theirs.worker.current = theirs.worker.subscriptionWith('https://fcm.googleapis.com/fcm/send/old', [4, 1, 2]);
        theirs.go();
        await theirs.settle();
        assert.strictEqual(theirs.worker.unsubscribed, 1);
        assert.strictEqual(theirs.worker.subscribed.length, 1);
    });

    it('stops, saying why, when notifications are refused, Northern will not list it, or the push service is unknown', async () => {
        const refused = await welcome({ permission: 'denied' });
        refused.go();
        await refused.settle();
        assert.match(refused.element('status').textContent, /Allow notifications/);
        assert.strictEqual(refused.element('go').disabled, false, 'and Go can be pressed again');
        assert.deepStrictEqual(refused.worker.subscribed, []);

        const unlisted = await welcome({ routes: { [`POST ${where}`]: { code: 'SQLITE_CONSTRAINT' } } });
        unlisted.go();
        await unlisted.settle();
        assert.match(unlisted.element('status').textContent, /would not list this device/);
        assert.strictEqual(unlisted.setup(alice.pub), undefined);
        assert.strictEqual(unlisted.location.replaced, null);

        const unknown = await welcome();
        unknown.worker.current = unknown.worker.subscriptionWith('https://push.example.net/x', Buffer.from(SERVER_KEY, 'base64url'));
        unknown.go();
        await unknown.settle();
        assert.match(unknown.element('status').textContent, /not one Pals knows: push\.example\.net/);
    });
});

// What PLAN.md rests on. Each of these is a fact about Northern or about the
// browser's crypto that the evaluation of the two architectures leans on; when
// one stops being true, the plan is what needs another look.
// ---------------------------------------------------------------------------

const subtle = globalThis.crypto.subtle;
const b64u = bytes => Buffer.from(bytes).toString('base64url');

/** A Northern key pair as WebCrypto takes it: the public half is x then y. */
function asJwk(who) {
    const raw = Buffer.from(who.pub, 'base64');
    return { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(0, 32)), y: b64u(raw.subarray(32)), d: b64u(Buffer.from(who.priv, 'base64')) };
}
const asPoint = who => Buffer.concat([Buffer.from([4]), Buffer.from(who.pub, 'base64')]);

// RFC 8291 (the encryption of a Web Push payload), written against WebCrypto.
const utf8 = text => new TextEncoder().encode(text);
const join = (...parts) => Buffer.concat(parts.map(p => Buffer.from(p)));
async function hkdf(salt, ikm, info, length) {
    const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
async function contentKeys(secret, auth, receiver, sender, salt) {
    const ikm = await hkdf(auth, secret, join(utf8('WebPush: info\0'), receiver, sender), 32);
    return {
        key: await subtle.importKey('raw', await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt', 'decrypt']),
        iv: await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
    };
}
async function seal(plaintext, receiver, auth) {
    const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const sender = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
    const to = await subtle.importKey('raw', receiver, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: to }, ephemeral.privateKey, 256));
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const { key, iv } = await contentKeys(secret, auth, receiver, sender, salt);
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, key, join(plaintext, [2]));
    return join(salt, [0, 0, 16, 0], [sender.length], sender, new Uint8Array(sealed));
}
async function unseal(body, privateKey, receiver, auth) {
    const salt = body.subarray(0, 16);
    const sender = body.subarray(21, 21 + body[20]);
    const from = await subtle.importKey('raw', sender, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: from }, privateKey, 256));
    const { key, iv } = await contentKeys(secret, auth, receiver, sender, salt);
    const padded = Buffer.from(await subtle.decrypt({ name: 'AES-GCM', iv }, key, body.subarray(21 + body[20])));
    return padded.subarray(0, padded.lastIndexOf(2));
}

describe('PLAN.md premises - the Northern key in WebCrypto', () => {
    it('is a P-256 key WebCrypto imports, whose signatures Northern accepts and the other way round', async () => {
        const sign = await subtle.importKey('jwk', asJwk(alice), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const verify = await subtle.importKey('raw', asPoint(alice), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const text = 'zdravo, pals ✓';

        const made = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sign, utf8(text)));
        assert.strictEqual(new Crypto().verify(alice.pub, text, made.toString('base64'), 'EC'), true);

        const sec = new sjcl.ecc.ecdsa.secretKey(sjcl.ecc.curves.c256, sjcl.ecc.curves.c256.field.fromBits(sjcl.codec.base64.toBits(alice.priv)));
        const bySjcl = Buffer.from(sjcl.codec.base64.fromBits(sec.sign(sjcl.hash.sha256.hash(text), 0)), 'base64');
        assert.strictEqual(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verify, bySjcl, utf8(text)), true);
    });

    it('mints a session cookie the server accepts from a key that cannot be exported', async () => {
        const sign = await subtle.importKey('jwk', asJwk(alice), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const body = `${alice.pub}.${Date.now()}`;
        const ssid = `${body}.${Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sign, utf8(body))).toString('base64')}`;

        assert.strictEqual(new Crypto().verifySsid(ssid).sValid, true);
        await assert.rejects(subtle.exportKey('jwk', sign), 'a non-extractable key stays in the browser\'s key store');
    });

    it('signs a VAPID token a push service would accept, and is the applicationServerKey less one byte', async () => {
        const sign = await subtle.importKey('jwk', asJwk(alice), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
        const claims = b64u(JSON.stringify({ aud: 'https://fcm.googleapis.com', exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:pals@example.org' }));
        const signature = Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sign, utf8(`${head}.${claims}`)));

        // The check a push service runs: ES256 over header.claims, with the key from k=.
        const point = asPoint(alice);
        const k = nodeCrypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) } });
        assert.strictEqual(nodeCrypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: k, dsaEncoding: 'ieee-p1363' }, signature), true);
        assert.strictEqual(point.length, 65);
        assert.strictEqual(b64u(point).length, 87);
    });

    it('opens the RFC 8291 test vector with plain WebCrypto', async () => {
        // RFC 8291, Appendix A.
        const receiver = Buffer.from('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'base64url');
        const privateKey = await subtle.importKey('jwk', {
            kty: 'EC', crv: 'P-256', d: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
            x: b64u(receiver.subarray(1, 33)), y: b64u(receiver.subarray(33))
        }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        const body = Buffer.from('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN', 'base64url');

        const opened = await unseal(body, privateKey, receiver, Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'));
        assert.strictEqual(opened.toString(), 'When I grow up, I want to be a watermelon');
    });

    it('seals a message to a Northern key the same way, at a cost of 103 bytes', async () => {
        const privateKey = await subtle.importKey('jwk', asJwk(bob), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
        const text = 'only bob reads this';

        const sealed = await seal(utf8(text), asPoint(bob), auth);
        assert.strictEqual(sealed.length - utf8(text).length, 103);
        assert.strictEqual((await unseal(sealed, privateKey, asPoint(bob), auth)).toString(), text);

        const wrong = await subtle.importKey('jwk', asJwk(carol), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        await assert.rejects(unseal(sealed, wrong, asPoint(bob), auth), 'and nobody else does');
    });
});

describe('PLAN.md premises - what Northern does today', () => {
    let server;
    let base;
    let dbFile;
    const cookie = who => ({ cookie: `ssid=${who.ssid}` });
    const call = (method, url, body, headers = {}) => fetch(base + url, { method, body, headers, redirect: 'manual' });
    const json = async response => JSON.parse(await response.text());

    async function freePort() {
        const probe = net.createServer();
        await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
        const { port } = probe.address();
        await new Promise(resolve => probe.close(resolve));
        return port;
    }

    before(async () => {
        process.chdir(REPO_ROOT);
        const { default: Server } = await import('../src/h2t/Server.js');
        const paths = tmpDbPaths('pals.test.db');
        dbFile = paths.absolute;
        await seedSchema(dbFile);
        const port = await freePort();
        server = new Server(port, paths.relativeToSrcH2t, await freePort());
        base = `http://127.0.0.1:${port}`;
        await new Promise(resolve => server.httpServer.once('listening', resolve));
    });

    after(async () => {
        server.httpServer.closeAllConnections();
        server.sslServer.closeAllConnections();
        await new Promise(resolve => server.httpServer.close(resolve));
        await new Promise(resolve => server.sslServer.close(resolve));
        fs.rmSync(dbFile, { force: true });
    });

    /** Listens on a /sub/ channel; resolves with a way to read what arrived and to hang up. */
    async function listen(channel) {
        const abort = new AbortController();
        const response = await fetch(`${base}/sub/${channel}`, { signal: abort.signal });
        let text = '';
        (async () => {
            const decoder = new TextDecoder();
            try { for await (const chunk of response.body) text += decoder.decode(chunk); } catch (e) { /* hung up */ }
        })();
        await new Promise(resolve => setTimeout(resolve, 50));
        return { status: response.status, text: () => text, close: () => abort.abort() };
    }

    it('lets anybody listen on a /sub/ channel and anybody with any cookie publish to it', async () => {
        const ear = await listen('pals/premise-1');
        assert.strictEqual(ear.status, 200, 'listening needs no session');

        assert.strictEqual((await call('PUT', '/sub/pals/premise-1', '{"a":1}')).status, 302, 'no cookie at all is turned away');
        await call('PUT', '/sub/pals/premise-1', '{"from":"nobody"}', { cookie: 'ssid=not-a-signature' });
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.ok(ear.text().includes('data: {"from":"nobody"}\n\n'), 'so a message proves nothing unless it is signed');
        ear.close();
    });

    it('does not tell a sender whether anybody heard', async () => {
        const ear = await listen('pals/premise-2');
        const heard = await json(await call('PUT', '/sub/pals/premise-2', '{}', cookie(alice)));
        const unheard = await json(await call('PUT', '/sub/pals/nobody-is-here', '{}', cookie(alice)));
        ear.close();

        assert.deepStrictEqual(heard, unheard, 'the answer counts channels, not listeners');
    });

    it('breaks an event in two at a line break, so a payload has to be one line', async () => {
        const ear = await listen('pals/premise-3');
        await call('PUT', '/sub/pals/premise-3', 'one\ntwo', cookie(alice));
        await new Promise(resolve => setTimeout(resolve, 50));
        ear.close();

        // An EventSource reads "two" as a field name and hands the page "one".
        assert.ok(ear.text().includes('data: one\ntwo\n\n'));
    });

    it('keeps a stored message for good: DELETE is a read, and an overwrite keeps the old value', async () => {
        const key = '/pals/premise/box/1.json';
        await call('POST', `${key}?isGroup=mailbox-token`, '{"ct":"ciphertext"}', cookie(alice));

        const deleted = await call('DELETE', `${key}?isGroup=mailbox-token`, null, cookie(alice));
        assert.strictEqual(await deleted.text(), '{"ct":"ciphertext"}', 'DELETE answers with the row');

        const put = await json(await call('PUT', `${key}?isGroup=mailbox-token`, '{}', cookie(alice)));
        assert.strictEqual(put.counter, 1);
        assert.deepStrictEqual(await json(await call('GET', `${key}/1?isGroup=mailbox-token`)), { ct: 'ciphertext' },
            'the ciphertext is still there, one key along');
        assert.ok((await json(await call('PUT', `${key}?isGroup=mailbox-token`, '{}', cookie(bob)))).unavailable,
            'and the receiver cannot even overwrite it');

        // Hiding the sender by posting without a real session is no way out.
        await call('POST', '/pals/premise/box/2.json?isPublic=true', '{"ct":"y"}', { cookie: 'ssid=not-a-signature' });
        assert.strictEqual((await json(await call('PUT', '/pals/premise/box/2.json?isPublic=true', '{}', cookie(carol)))).status, 'OK',
            'a row filed under the public author can be overwritten by anybody');
    });

    it('guards a group row by its name alone, and lists who wrote each row', async () => {
        const key = '/pals/premise/box2/1.json';
        await call('POST', `${key}?isGroup=mailbox-token-2`, '{"ct":"x"}', cookie(alice));

        assert.ok((await json(await call('GET', key, null, cookie(bob)))).unavailable, 'bob without the name: nothing');
        assert.deepStrictEqual(await json(await call('GET', `${key}?isGroup=mailbox-token-2`)), { ct: 'x' },
            'anybody with the name: the row, no session needed');

        const listed = await json(await call('GET', '/pals/premise/box2/?search=%25&isGroup=mailbox-token-2'));
        assert.strictEqual(listed[0].author, alice.pub, 'a mailbox listing names every sender');
    });

    it('lists a device the way welcome.html does, and gives it back the way pals.js reads it', async () => {
        const where = Model.palPath('bob', bob.pub) + '?isPublic=true';
        const record = n => JSON.stringify(Model.palRecord({ pub: bob.pub, name: 'bob' },
            { endpoint: 'https://fcm.googleapis.com/fcm/send/' + n, keys: { p256dh: 'p', auth: 'a' } }, n));

        assert.ok((await json(await call('PUT', where, record(1), cookie(bob)))).unavailable, 'a PUT finds nothing to update at first');
        assert.strictEqual((await json(await call('POST', where, record(1), cookie(bob)))).status, 'OK');
        assert.notStrictEqual((await json(await call('POST', where, record(2), cookie(bob)))).status, 'OK',
            'posting again files a version and leaves the row as it was - which is why welcome.html PUTs first');
        assert.strictEqual((await json(await call('PUT', where, record(3), cookie(bob)))).status, 'OK');
        await call('POST', Model.palPath('bob', bob.pub).replace('/bob/', '/bobby/') + '?isPublic=true', record(4), cookie(carol));
        await new Promise(resolve => setTimeout(resolve, 50));

        const rows = await json(await call('GET', '/pals/?searchPlus=%25'));
        assert.ok(rows.length >= 4, 'the search has the versions and carol\'s row as well');
        const found = plain(Model.directory(rows)).filter(e => e.pub === bob.pub);
        assert.deepStrictEqual(found.map(e => [e.name, e.subscription.endpoint]), [['bob', 'https://fcm.googleapis.com/fcm/send/3']],
            'and the page keeps the one bob wrote last');
    });

    it('lets anybody file a name under somebody else\'s key, marked with who filed it', async () => {
        await call('POST', `/id/1/${bob.pub}.json?isPublic=true`, JSON.stringify({ pub: bob.pub, pub_name: 'bob' }), cookie(bob));
        await call('POST', `/id/2/${bob.pub}.json?isPublic=true`, JSON.stringify({ pub: bob.pub, pub_name: 'mallory' }), cookie(carol));

        const rows = await json(await call('GET', `/id/?searchPlus=${encodeURIComponent('%' + bob.pub + '.json')}`));
        assert.strictEqual(rows.length, 2);
        assert.deepStrictEqual(rows.filter(r => r.author === bob.pub).map(r => JSON.parse(r.value).pub_name), ['bob'],
            'which is why the page only believes the row the key wrote itself');
    });
});
