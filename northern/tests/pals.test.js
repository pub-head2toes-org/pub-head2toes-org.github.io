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
import { generateKeys, readKeys, sendProof } from '../src/h2t/PushApi.js';

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

    it('cuts a message to its first 128 characters on one line', () => {
        assert.strictEqual(Model.excerpt('a\n b\t c'), 'a b c');
        assert.strictEqual(Array.from(Model.excerpt('🍉'.repeat(200))).length, 128, 'whole characters, not halves of one');
    });

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

    it('lists groups by name, the selected one marked whatever its case', () => {
        const html = Views.groups(state, 'FAMILY');
        assert.ok(html.includes('aria-selected="true" data-group="Family">Family</button>'));
        assert.ok(Views.members(state, 'family', null).includes(`bob (${tag(bob.pub)})`));
        assert.ok(Views.members(state, 'Nope', null).includes('Pick a group'));
    });

    it('gives a message two rows: how it starts, then who sent it on an oval', () => {
        const s = Model.load(plain(state));
        Model.receive(s, me, envelope(bob, 'x'.repeat(200)));
        const html = Views.log(Model.log(s), s, me);
        const [first, second] = html.split('</span>');

        assert.ok(first.endsWith('x'.repeat(128) + '&hellip;'));
        assert.ok(second.includes(`class="pill" style="--hue:${Views.hue(bob.pub)}">bob (${tag(bob.pub)})`));
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

    it('offers every group and pal as a target, preselecting what the log shows', () => {
        assert.ok(Views.targets(state, { kind: 'member', id: 'family', pub: bob.pub }).includes('value="group:Family" selected'));
        assert.ok(Views.targets(state, { kind: 'pal', pub: bob.pub }).includes(`value="pal:${bob.pub}" selected`));
        assert.deepStrictEqual(plain(Views.target('group:Me: and you')), { kind: 'group', id: 'Me: and you' });
        assert.strictEqual(Views.target(''), null);
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
        assert.ok(Views.incoming(none, me).includes('Nothing new'));
    });
});

// ---------------------------------------------------------------------------
// The files, and sw.js
// ---------------------------------------------------------------------------

describe('Pals shell', () => {
    const index = read('index.html');
    const welcome = read('welcome.html');
    const sw = read('sw.js');
    const scriptsOf = html => [...html.matchAll(/<script[^>]*src=["']([^"']+)["']/g)].map(m => m[1]);
    const cached = [...sw.matchAll(/'(\.{1,2}\/[^']+)'/g)].map(m => m[1]);

    it('has the three panels side by side and the incoming list under them, and no invite link', () => {
        const order = ['id="user"', 'class="panels"', 'id="panel_pals"', 'id="panel_log"',
            'id="panel_groups"', 'id="panel_members"', 'id="panel_incoming"'].map(mark => index.indexOf(mark));

        assert.ok(order.every(at => at !== -1), 'every section is on the page');
        assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), 'in the order the prompt gives');
        assert.ok(!/invite/i.test(index), 'UPDATE_1 takes the invite link out');
        for (const id of ['pal_add', 'pal_remove', 'message_add', 'group_add', 'group_remove', 'member_add', 'member_remove', 'pal_pick', 'message_retry']) {
            assert.ok(index.includes(`id="${id}"`), id);
        }
        assert.match(read('styles.css'), /\.panels\s*{[^}]*grid-template-columns:(\s*minmax\([^)]*fr\)){3};/);
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
    // A <select> shows its selected option, or its first: the stub is told so.
    const choose = (page, id) => {
        const html = page.html(id);
        const option = html.match(/value="([^"]*)" selected/) || html.match(/value="([^"]*)"/);
        type(page, id, option ? option[1].replace(/&amp;/g, '&') : '');
    };
    const write = async (page, body) => {
        page.click('message_add');
        choose(page, 'compose_to');
        type(page, 'compose_body', body);
        page.submit('compose');
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

    it('stays open when the session cookie has expired, and says so with a link to sign in again', async () => {
        for (const cookie of ['', `ssid=${bob.pub}.1.sig`]) {
            const page = await open({ cookie });

            assert.strictEqual(page.location.replaced, null, 'expired, or somebody else\'s: ' + cookie);
            assert.ok(page.html('user').includes(`>alice (${tag(alice.pub)})<`));
            assert.strictEqual(page.element('session_expired').hidden, false);
            assert.strictEqual(page.element('sign_in_again').href, `/fs/get/reg/Reg.html#${PAGE}`);
        }
        const live = await open();
        assert.strictEqual(live.element('session_expired').hidden, true);
    });

    it('notices the cookie expiring while the page is open, and it coming back', async () => {
        const page = await open();
        page.document.cookie = '';
        page.show();
        assert.strictEqual(page.element('session_expired').hidden, false);

        page.document.cookie = signedIn().cookie;
        page.show();
        assert.strictEqual(page.element('session_expired').hidden, true);
    });

    it('sends with the kept key when the session has expired, with a proof the server checks', async () => {
        const page = await open({ cookie: '' });
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
        assert.strictEqual(page.html('log'), '');
        assert.deepStrictEqual(page.worker.registered, []);
    });

    it('shows who is signed in, and starts empty', async () => {
        const page = await open();

        assert.strictEqual(page.location.replaced, null);
        assert.ok(page.html('user').includes(`>alice (${tag(alice.pub)})<`));
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

    it('loads a group\'s members below it and its messages into the log; a member narrows it', async () => {
        const page = await populated();

        assert.deepStrictEqual(page.rows('groups'), ['Family']);
        assert.deepStrictEqual(page.rows('members'), [`bob (${tag(bob.pub)})`, `carol (${tag(carol.pub)})`]);
        assert.strictEqual(page.element('log_context').textContent, 'Family');
        assert.deepStrictEqual(page.stored().groups, [{ name: 'Family', members: [bob.pub, carol.pub] }]);

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

        assert.deepStrictEqual(page.rows('log'), [`hello bob\nalice (${tag(alice.pub)})\nto bob (${tag(bob.pub)})`]);
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
        assert.deepStrictEqual(page.rows('log').map(r => r.split('\n').slice(1)), [[`alice (${tag(alice.pub)})`, 'in Family']]);
    });

    it('marks who a message did not reach and why, and sends it again to them alone', async () => {
        let carolGone = true;
        const page = await populated({ routes: {
            'POST /push/api/send': call => JSON.parse(call.body).to === carol.pub && carolGone
                ? [410, { error: 'Gone', message: 'the pal\'s device is no longer subscribed; they need to open Pals again' }]
                : [200, { status: 'OK' }]
        } });
        await write(page, 'hi all');

        assert.ok(page.html('log').includes('not delivered'));
        assert.match(page.element('status').textContent, /Not delivered to everybody/);
        const id = page.stored().messages[0].id;
        page.pick('log', 'data-message', id);
        assert.strictEqual(page.element('message_status').textContent,
            `Not delivered to carol (${tag(carol.pub)}): the pal's device is no longer subscribed; they need to open Pals again`);
        assert.strictEqual(page.element('message_retry').hidden, false);

        carolGone = false;
        const before = sent(page).length;
        page.element('message_retry').onclick();
        await page.settle();
        assert.deepStrictEqual(sent(page).slice(before).map(p => p.to), [carol.pub]);
        assert.ok(!page.html('log').includes('not delivered'));
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
        page.click('message_add');
        assert.match(page.element('status').textContent, /Load your ID Card on this device first/);
        assert.strictEqual(page.element('dlg_compose').open, false);
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

    it('refuses an empty message and has nobody to write to on a first visit', async () => {
        const page = await open();
        page.click('message_add');
        assert.match(page.element('status').textContent, /Add a pal first/);

        await addPal(page, bob);
        page.click('message_add');
        choose(page, 'compose_to');
        type(page, 'compose_body', '   ');
        page.submit('compose');
        assert.strictEqual(page.element('compose_error').textContent, 'there is nothing to send');
        assert.strictEqual(page.element('dlg_compose').open, true);
    });

    it('files what the service worker took in, opens here what it could not, and names somebody who is not a pal', async () => {
        const page = await open({
            idb: { inbox: {
                1: openedItem(bob, 'opened by the worker', { ts: 10, id: 'a' }),
                2: await sealedItem(dave, 'opened by the page', { ts: 20, id: 'b' })
            } }
        });

        assert.deepStrictEqual(inbox(page), [], 'the inbox is emptied');
        assert.deepStrictEqual(page.rows('log').map(r => r.split('\n')), [
            ['opened by the worker', `bob (${tag(bob.pub)})`],
            ['opened by the page', `dave (${tag(dave.pub)})`]
        ]);
        assert.deepStrictEqual(page.rows('incoming'), [`dave (${tag(dave.pub)})`, `bob (${tag(bob.pub)})`]);
        assert.ok(page.fetch.calls.some(c => `GET ${c.url}` === search('%/' + urlKeyOf(dave.pub))), 'dave was looked up by key');
        assert.ok(!page.fetch.calls.some(c => c.url.startsWith('/push/api/')), 'and nothing was sent to the server to open');

        page.pick('incoming', 'data-pub', dave.pub);
        assert.deepStrictEqual(page.rows('log').map(r => r.split('\n')[0]), ['opened by the page']);
    });

    it('files a group message under its group, making it when there is none', async () => {
        const page = await populated({ routes: {} });
        page.indexedDB.stores.inbox.set(1, await sealedItem(bob, '[Family] dinner', { id: 'g1' }));
        page.indexedDB.stores.inbox.set(2, openedItem(carol, '[Climbing] Saturday?', { id: 'g2' }));
        page.push();
        await page.settle();

        assert.deepStrictEqual(page.rows('groups'), ['Family', 'Climbing']);
        page.pick('groups', 'data-group', 'Family');
        assert.deepStrictEqual(page.rows('log').map(r => r.split('\n')[0]), ['dinner']);
        page.pick('groups', 'data-group', 'Climbing');
        assert.deepStrictEqual(page.rows('members'), [`carol (${tag(carol.pub)})`]);
    });

    it('puts parts back together as they come, and shows a message still missing some', async () => {
        const part = (n, text) => sealedItem(bob, text, { id: 'long', part: n, parts: 2 });
        const page = await open({ idb: { inbox: { 1: await part(2, 'world') } } });
        assert.ok(page.html('log').includes('1 of 2 parts'));

        page.indexedDB.stores.inbox.set(5, await part(1, 'hello '));
        page.push();
        await page.settle();
        assert.deepStrictEqual(page.rows('log').map(r => r.split('\n')[0]), ['hello world']);
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
        assert.deepStrictEqual(page.rows('log'), []);
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
        assert.strictEqual(again.rows('log').length, 1);

        page.indexedDB.stores.setup.set(bob.pub, { endpoint: 'https://fcm.googleapis.com/fcm/send/device' });
        const other = mountPals({ ...signedIn(bob), routes: northern(), indexedDB: page.indexedDB });
        await other.settle();
        assert.deepStrictEqual(other.rows('groups'), []);
        assert.deepStrictEqual(other.rows('log'), []);
    });

    it('says so when this device no longer gets pushes', async () => {
        const page = await open({ subscription: null });
        assert.match(page.element('status').textContent, /no longer gets messages/);
        const replaced = await open({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/other' } });
        assert.match(replaced.element('status').textContent, /no longer gets messages/);
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
