'use strict';

// Calls of three and four in Pals (UPDATE_10): a mesh, one connection to each
// of the others (conference.js). tests/palsCalls.test.js covers a call of two,
// which goes the same way; these cover what more people add - the ring that
// names everybody, who offers, the grid, somebody introduced, sizes, mic and
// camera, one more added in the middle, and how such a call ends.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadPals, mountPals, fakeIndexedDB, agreementKey, plain, read } from './helpers/palsPage.js';
import { fakeHub, fakeWebRTC, fakeTimers } from './helpers/inPersonPage.js';
import { REPO_ROOT } from './helpers/db.js';
import { generateKeys, readKeys } from '../src/h2t/PushApi.js';
import sjclClass from '../src/h2t/sjclClass.js';

const { Model, Seal, Calls, Conference } = loadPals();
const sjcl = new sjclClass().get();

function identity(name) {
    const keys = sjcl.ecc.ecdsa.generateKeys(256, 0);
    const pub = sjcl.codec.base64.fromBits(keys.pub.get().x.concat(keys.pub.get().y));
    const priv = sjcl.codec.base64.fromBits(keys.sec.get());
    return { name, pub, priv };
}

const [alice, bob, carol, dave, erin] = ['alice', 'bob', 'carol', 'dave', 'erin'].map(identity);
const everybody = [alice, bob, carol, dave, erin];
const keys = Object.fromEntries(await Promise.all(everybody.map(async who => [who.name, await agreementKey(who)])));
const kept = who => ({ [who.pub]: { key: keys[who.name], at: 1 } });
const urlKeyOf = pub => Buffer.from(pub, 'base64').toString('base64url');
const ID = 'Abcdefghijklmnopqrstuv';

const listed = who => ({
    path: `/pals/${who.name}/${urlKeyOf(who.pub)}`, type: 'txt', counter: 0, author: who.pub, public: 'public',
    value: JSON.stringify({ pub: who.pub, username: who.name, provider: 'google', ts: 1,
        subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${who.name}`, keys: { p256dh: 'BP-' + who.name, auth: 'auth-' + who.name } } })
});
const palsOf = (...who) => who.map(w => ({ pub: w.pub, name: w.name, verified: false }));
const setUp = who => ({
    [who.pub]: { path: '/pals/x/y', endpoint: 'https://fcm.googleapis.com/fcm/send/device' },
    ['calls ' + who.pub]: { enabled: true }
});

// ---------------------------------------------------------------------------
// The signals and the sizes, as data
// ---------------------------------------------------------------------------

describe('Pals conference - the ring and the sizes', () => {
    it('carries who else is in the call, and the group, in the ring - and refuses a list that is not one', () => {
        const ring = Calls.signal('ring', ID, 1, { with: [{ pub: carol.pub, name: ' carol\n ' }], group: 'Family' });
        assert.deepStrictEqual(plain(Calls.readSignal(ring)),
            { t: 'ring', call: ID, ts: 1, with: [{ pub: carol.pub, name: 'carol' }], group: 'Family' });
        assert.deepStrictEqual(plain(Calls.readSignal(Calls.signal('ring', ID, 1))), { t: 'ring', call: ID, ts: 1 }, 'a call of two, as before');

        const bad = [
            'nobody',
            [{ pub: carol.pub, name: 'c' }, { pub: dave.pub, name: 'd' }, { pub: erin.pub, name: 'e' }],
            [{ pub: 'not a key', name: 'x' }],
            [{ pub: carol.pub, name: 'c' }, { pub: carol.pub, name: 'again' }],
            [{ pub: carol.pub }]
        ];
        for (const list of bad) {
            assert.strictEqual(Calls.readSignal(JSON.stringify({ t: 'ring', call: ID, ts: 1, with: list })), null, JSON.stringify(list));
        }
    });

    it('says several names as people do', () => {
        assert.strictEqual(Calls.names(['bob']), 'bob');
        assert.strictEqual(Calls.names(['bob', 'carol']), 'bob and carol');
        assert.strictEqual(Calls.names(['bob', 'carol', 'dave']), 'bob, carol and dave');
        assert.strictEqual(Calls.stateText('connected', Calls.names(['bob', 'carol'])), 'In a call with bob and carol');
    });

    it('sends less the more are in the call: 720p for two, 360p in the grid, more to the one made large', () => {
        assert.deepStrictEqual(plain(Calls.videoFor(2, 'grid', 720)), { maxBitrate: 1500000, maxFramerate: 30, scaleResolutionDownBy: 1 });
        assert.deepStrictEqual(plain(Calls.videoFor(3, 'grid', 720)), { maxBitrate: 500000, maxFramerate: 24, scaleResolutionDownBy: 2 });
        assert.deepStrictEqual(plain(Calls.videoFor(4, 'large', 720)), { maxBitrate: 1200000, maxFramerate: 30, scaleResolutionDownBy: 1 });
        assert.deepStrictEqual(plain(Calls.videoFor(4, 'small', 720)), { maxBitrate: 150000, maxFramerate: 15, scaleResolutionDownBy: 4 });
        assert.strictEqual(Calls.videoFor(2, 'large', 720).maxBitrate, 1500000, 'with two, nobody is made large');
        assert.strictEqual(Calls.videoFor(3, 'grid', 240).scaleResolutionDownBy, 1, 'never scaled up');
        assert.strictEqual(Calls.videoFor(3, 'grid', undefined).scaleResolutionDownBy, 2, 'a camera that does not say is taken as 720p');
    });

    it('knows who is no longer in the call', () => {
        for (const gone of ['declined', 'busy', 'no answer', 'left', 'away', 'failed']) {
            assert.strictEqual(Conference.isGone(gone), true, gone);
        }
        for (const here of ['calling', 'ringing', 'waiting', 'connecting', 'connected', 'reconnecting']) {
            assert.strictEqual(Conference.isGone(here), false, here);
        }
    });
});

// ---------------------------------------------------------------------------
// The service worker
// ---------------------------------------------------------------------------

describe('Pals conference - the service worker', () => {
    it('says who else is in the call when it rings', async () => {
        const listeners = {};
        const notified = [];
        const indexedDB = fakeIndexedDB({ keys: kept(bob), state: { [bob.pub]: { pals: palsOf(alice, carol).map(p => p.pub === carol.pub ? { ...p, name: 'Carol B.' } : p) } }, setup: setUp(bob) });
        const context = {
            URL, Promise, JSON, Date, atob, btoa, Uint8Array, String, TextEncoder, TextDecoder, indexedDB, crypto: globalThis.crypto,
            Request: function Request(url) { this.url = url; },
            caches: { open: () => Promise.resolve({ addAll: () => Promise.resolve() }), keys: () => Promise.resolve([]) },
            fetch: () => Promise.reject(new Error('no')),
            self: {
                location: { href: 'https://pals.example/fs/get/pwa/pals/sw.js' },
                addEventListener: (name, fn) => { listeners[name] = fn; },
                skipWaiting() {},
                clients: { claim() {}, matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve() },
                registration: { showNotification: (title, options) => { notified.push(options.body); return Promise.resolve(); } }
            }
        };
        const source = file => file.startsWith('../../reg/')
            ? fs.readFileSync(path.join(REPO_ROOT, 'src/fs/reg', file.slice('../../reg/'.length)), 'utf8')
            : read(file.replace('./', ''));
        context.importScripts = (...files) => files.forEach(file => vm.runInContext(source(file), context, { filename: file }));
        vm.createContext(context);
        vm.runInContext(read('sw.js'), context, { filename: 'sw.js' });

        const wire = { id: ID, part: 1, parts: 1 };
        const signal = Calls.signal('ring', ID, Date.now(), { with: [{ pub: carol.pub, name: 'carol' }, { pub: dave.pub, name: 'dave' }] });
        const sealed = await Seal.seal(keys.alice, alice.pub, bob.pub, wire, { ts: Date.now(), body: Calls.RING_TEXT, signal });
        const waits = [];
        listeners.push({ data: { text: () => JSON.stringify({ v: 2, from: alice.pub, to: bob.pub, ...wire, sealed }) }, waitUntil: p => waits.push(p) });
        await Promise.all(waits);
        assert.deepStrictEqual(notified, ['alice is calling - with Carol B. and dave'], 'a pal by the name given here; anybody else as the caller says');
    });
});

// ---------------------------------------------------------------------------
// The page: three and four pals in a call
// ---------------------------------------------------------------------------

describe('Pals conference - the page', () => {
    const vapid = readKeys(JSON.stringify(generateKeys()));
    const search = pattern => `GET /pals/?searchPlus=${encodeURIComponent(pattern)}`;
    const routes = () => ({
        [search('%')]: everybody.map(listed),
        ...Object.fromEntries(everybody.map(w => [search('%/' + urlKeyOf(w.pub)), [listed(w)]])),
        'GET /push/api/config/pub': { publicKey: vapid.publicKey },
        'POST /push/api/send': () => [200, { status: 'OK' }],
        'GET /turn/api/ice': { iceServers: [], ttl: 60, provider: 'cloudflare' }
    });
    /** Devices on one Northern: the same /sub/ hub, the same network, the same clock. `states` by name. */
    function devices(states) {
        const shared = { hub: fakeHub(), net: fakeWebRTC(), timers: fakeTimers() };
        const pages = {};
        for (const [name, state] of Object.entries(states)) {
            const who = everybody.find(w => w.name === name);
            pages[name] = mountPals({
                localStorage: { pub: who.pub, pub_name: who.name }, cookie: `ssid=${who.pub}.${Date.now()}.sig`,
                routes: routes(), idb: { keys: kept(who), state: { [who.pub]: state }, setup: setUp(who) }, ...shared
            });
        }
        return { ...pages, ...shared, pages: Object.values(pages) };
    }
    /** Lets every page run until signals stop going back and forth. */
    const settleAll = async (d, rounds = 8) => {
        for (let i = 0; i < rounds; i++) {
            for (const page of d.pages) {
                await page.settle();
            }
        }
    };
    const sent = page => page.fetch.calls.filter(c => c.url === '/push/api/send').map(c => JSON.parse(c.body));
    let inboxAt = 1;
    const deliver = async (to, push) => {
        const payload = { v: 2, from: push.from, to: push.to, id: push.id, part: push.part, parts: push.parts, sealed: push.sealed };
        to.indexedDB.stores.inbox.set(inboxAt++, { payload, at: Date.now() });
        to.push();
        await to.settle();
    };
    const opened = (who, push) => Seal.open(keys[who.name], { v: 2, ...push }).then(plain);
    const ringTo = (page, who) => sent(page).find(p => p.to === who.pub && p.id === sent(page)[0].id);
    const family = (...members) => ({ name: 'Family', members: members.map(m => m.pub) });
    /** Everybody a pal of everybody, and alice's group of them. */
    const friends = (...who) => Object.fromEntries(who.map(w => [w.name, {
        pals: palsOf(...who.filter(o => o !== w)),
        groups: w === alice ? [family(...who.filter(o => o !== alice))] : []
    }]));
    /** alice calls her group from its messages. */
    const callGroup = async (d) => {
        await settleAll(d, 1);
        d.alice.pick('groups', 'data-group', 'Family');
        d.alice.click('group_messages');
        assert.strictEqual(d.alice.element('call_start').hidden, false, 'Call is there for a group');
        d.alice.click('call_start');
        await settleAll(d, 2);
    };
    /** Those rung answer. */
    const answer = async (d, ...who) => {
        for (const w of who) {
            await deliver(d[w.name], ringTo(d.alice, w));
            assert.strictEqual(d[w.name].element('dlg_incoming').open, true, w.name + ' is rung');
            d[w.name].click('call_answer');
        }
        await settleAll(d);
    };
    /** The connection on `from`'s device to `to`'s, as the fake network has it. */
    const pcOf = (d, from, to) => d.net.all.find(pc => !pc.closed && pc.stream && pc.stream.name === from.name && pc.other && pc.other.stream.name === to.name);
    const sentAt = (d, from, to) => { const pc = pcOf(d, from, to); const s = pc && pc.senders.find(x => x.track.kind === 'video'); return s ? s.params.encodings[0] : null; };

    it('rings everybody in the group, each told who else is in the call, and all three see each other', async () => {
        const d = devices(friends(alice, bob, carol));
        await callGroup(d);

        assert.strictEqual(d.alice.element('dlg_call').open, true);
        assert.strictEqual(d.alice.element('call_state').textContent, 'Ringing bob and carol…');
        assert.strictEqual(d.alice.element('call_videos').className, 'videos grid', 'three: the grid');
        assert.strictEqual(d.alice.element('note_1').textContent, 'Ringing…');
        const toBob = await opened(bob, ringTo(d.alice, bob));
        assert.deepStrictEqual(plain(Calls.readSignal(toBob.signal).with), [{ pub: carol.pub, name: 'carol' }]);
        assert.strictEqual(Calls.readSignal(toBob.signal).group, 'Family');
        assert.deepStrictEqual(plain(Calls.readSignal((await opened(carol, ringTo(d.alice, carol))).signal).with), [{ pub: bob.pub, name: 'bob' }]);

        await deliver(d.bob, ringTo(d.alice, bob));
        assert.match(d.bob.element('incoming_with').innerHTML, /With .*carol.* - in Family/);
        assert.doesNotMatch(d.bob.element('incoming_with').innerHTML, /introduced/, 'carol is bob\'s pal');
        d.bob.click('call_answer');
        await answer(d, carol);

        for (const [page, others] of [[d.alice, 'bob and carol'], [d.bob, 'alice and carol'], [d.carol, 'alice and bob']]) {
            assert.strictEqual(page.element('call_state').textContent, 'In a call with ' + others);
            assert.strictEqual(page.element('call_videos').className, 'videos grid');
            assert.ok(page.element('contact_video').srcObject && page.element('contact_video_2').srcObject, 'two pals on screen');
            assert.strictEqual(page.element('tile_3').hidden, true);
            assert.strictEqual(page.element('add_tile').hidden, false, 'the free tile rings one more');
            assert.strictEqual(page.element('call_key').hidden, true, 'Key on each tile instead');
            assert.strictEqual(page.element('key_1').hidden, false);
        }
        assert.strictEqual(d.net.all.length, 6, 'three pairs, a connection at each end');
        assert.ok(d.net.all.every(pc => pc.connectionState === 'connected'));
        for (const [x, y] of [[alice, bob], [alice, carol], [bob, carol]]) {
            const offerer = x.pub < y.pub ? x : y;
            assert.ok(pcOf(d, offerer, offerer === x ? y : x).channel.label, 'the smaller key offered, with the data channel');
        }
        assert.strictEqual(sentAt(d, alice, bob).maxBitrate, 500000, '360p each way in the grid');
        assert.strictEqual(sentAt(d, bob, carol).scaleResolutionDownBy, 2);
    });

    it('makes a tile large on a tap: that pal sends more, the others less - and back on a second tap', async () => {
        const d = devices(friends(alice, bob, carol));
        await callGroup(d);
        await answer(d, bob, carol);
        const bobTile = d.alice.element('contact_caption').textContent === 'bob' ? 1 : 2;

        d.alice.click('tile_' + bobTile);
        await settleAll(d, 2);
        assert.strictEqual(d.alice.element('call_videos').className, 'videos grid spotlight');
        assert.match(d.alice.element('tile_' + bobTile).className, /\blarge\b/);
        assert.strictEqual(sentAt(d, bob, alice).maxBitrate, 1200000, 'bob sends alice more');
        assert.strictEqual(sentAt(d, carol, alice).maxBitrate, 150000, 'carol, in the strip, less');
        assert.strictEqual(sentAt(d, bob, carol).maxBitrate, 500000, 'what carol sees is not changed');

        d.alice.click('tile_' + bobTile);
        await settleAll(d, 2);
        assert.strictEqual(d.alice.element('call_videos').className, 'videos grid');
        assert.strictEqual(sentAt(d, bob, alice).maxBitrate, 500000);
    });

    it('turns the mic and camera off and on, and the others see so on the tile', async () => {
        const d = devices(friends(alice, bob, carol));
        await callGroup(d);
        await answer(d, bob, carol);

        d.alice.click('call_mic');
        d.alice.click('call_camera');
        await settleAll(d, 2);
        const tracks = d.alice.media[0].stream.tracks;
        assert.deepStrictEqual(tracks.map(t => t.enabled), [false, false]);
        assert.strictEqual(d.alice.element('call_mic').textContent, 'Mic on');
        assert.strictEqual(d.alice.element('self_caption').textContent, 'Self · mic off');
        const aliceTile = d.bob.element('contact_caption').textContent === 'alice' ? 1 : 2;
        assert.strictEqual(d.bob.element('note_' + aliceTile).textContent, 'Mic off · Camera off');
        assert.match(d.bob.element('tile_' + aliceTile).className, /no-camera/);

        d.alice.click('call_mic');
        await settleAll(d, 2);
        assert.strictEqual(tracks[0].enabled, true);
        assert.strictEqual(d.bob.element('note_' + aliceTile).textContent, 'Camera off');
    });

    it('goes on when one leaves, back to two on screen once their tile has said so - and ends when the last does', async () => {
        const d = devices(friends(alice, bob, carol));
        await callGroup(d);
        await answer(d, bob, carol);

        d.bob.click('hang_up');
        await settleAll(d, 2);
        assert.strictEqual(d.bob.element('call_state').textContent, 'Call with alice and carol: hung up.');
        assert.strictEqual(d.alice.element('call_state').textContent, 'In a call with carol');
        const bobTile = d.alice.element('contact_caption').textContent === 'bob' ? 1 : 2;
        assert.strictEqual(d.alice.element('note_' + bobTile).textContent, 'Left');
        assert.strictEqual(sentAt(d, alice, carol).maxBitrate, 1500000, 'two again: 720p');

        d.timers.pass(4000);
        await settleAll(d, 1);
        assert.strictEqual(d.alice.element('call_videos').className, 'videos n2', 'the pal large, this device small');

        d.carol.click('hang_up');
        await settleAll(d, 2);
        assert.strictEqual(d.alice.element('call_state').textContent, 'Call with bob and carol: everybody left.');
        assert.ok(d.alice.media[0].stream.tracks.every(t => t.stopped), 'the camera is off');
        assert.strictEqual(d.alice.element('hang_up').hidden, true);
    });

    it('takes somebody who is not a pal as introduced by the caller, and says so', async () => {
        const d = devices({
            alice: { pals: palsOf(bob, carol), groups: [family(bob, carol)] },
            bob: { pals: palsOf(alice) },
            carol: { pals: palsOf(alice) }
        });
        await callGroup(d);
        await deliver(d.bob, ringTo(d.alice, bob));
        assert.match(d.bob.element('incoming_with').innerHTML, /carol.*introduced by alice/);
        d.bob.click('call_answer');
        await answer(d, carol);

        assert.strictEqual(d.bob.element('call_state').textContent, 'In a call with alice and carol');
        const carolTile = d.bob.element('contact_caption').textContent.startsWith('carol') ? 1 : 2;
        const carolCaption = carolTile === 1 ? 'contact_caption' : 'contact_caption_2';
        assert.strictEqual(d.bob.element(carolCaption).textContent, 'carol · introduced by alice');
        assert.strictEqual(d.bob.element('key_' + carolTile).hidden, true, 'no keys to compare with somebody who is not a pal');
        assert.deepStrictEqual(plain(Model.load(d.bob.stored()).pals.map(p => p.name)), ['alice'], 'carol is not made a pal');
    });

    it('picks up to three from a larger group, and refuses a fourth', async () => {
        const d = devices({ ...friends(alice, bob, carol, dave, erin) });
        await settleAll(d, 1);
        d.alice.pick('groups', 'data-group', 'Family');
        d.alice.click('group_messages');
        d.alice.click('call_start');
        await d.alice.settle();
        assert.strictEqual(d.alice.element('dlg_pick').open, true);
        assert.match(d.alice.element('pick_hint').textContent, /Up to three of Family/);
        assert.deepStrictEqual(sent(d.alice), [], 'nobody rung yet');

        for (const w of [bob, carol, dave, erin]) {
            d.alice.pick('pick_list', 'data-pub', w.pub);
        }
        assert.match(d.alice.element('pick_error').textContent, /3 at most/);
        d.alice.submit('pick');
        await settleAll(d, 2);
        assert.deepStrictEqual(sent(d.alice).map(p => p.to).sort(), [bob.pub, carol.pub, dave.pub].sort());
        assert.strictEqual(d.alice.element('call_state').textContent, 'Ringing bob, carol and dave…');
        assert.strictEqual(d.alice.element('tile_3').hidden, false, 'four: every tile');
        assert.strictEqual(d.alice.element('add_tile').hidden, true);
        assert.strictEqual(d.alice.element('call_add').disabled, true, 'four is the most');
    });

    it('connects four, each to the other three', async () => {
        const d = devices(friends(alice, bob, carol, dave));
        await callGroup(d);
        await answer(d, bob, carol, dave);
        assert.strictEqual(d.net.all.length, 12, 'six pairs');
        assert.ok(d.net.all.every(pc => pc.connectionState === 'connected'));
        assert.strictEqual(d.dave.element('call_state').textContent, 'In a call with alice, bob and carol');
        assert.ok(['contact_video', 'contact_video_2', 'contact_video_3'].every(id => d.dave.element(id).srcObject));
    });

    it('adds one more in the middle of a call of two: rung with who is in it, and the other told', async () => {
        const d = devices({
            alice: { pals: palsOf(bob, carol) },
            bob: { pals: palsOf(alice) },
            carol: { pals: palsOf(alice) }
        });
        await settleAll(d, 1);
        d.alice.pick('pals', 'data-pub', bob.pub);
        d.alice.click('call_start');
        await settleAll(d, 2);
        await answer(d, bob);
        assert.strictEqual(d.alice.element('call_videos').className, 'videos n2');
        assert.strictEqual(d.alice.element('call_add').hidden, false);

        d.alice.click('call_add');
        assert.strictEqual(d.alice.element('dlg_pick').open, true);
        assert.strictEqual(d.alice.element('pick_list').innerHTML.includes(bob.pub), false, 'bob is in the call already');
        d.alice.pick('pick_list', 'data-pub', carol.pub);
        d.alice.submit('pick');
        await settleAll(d, 2);

        const toCarol = sent(d.alice).find(p => p.to === carol.pub);
        assert.deepStrictEqual(plain(Calls.readSignal((await opened(carol, toCarol)).signal).with), [{ pub: bob.pub, name: 'bob' }]);
        assert.strictEqual(d.bob.element('call_videos').className, 'videos grid', 'bob was told: carol is coming');
        await deliver(d.carol, toCarol);
        d.carol.click('call_answer');
        await settleAll(d);
        assert.strictEqual(d.bob.element('call_state').textContent, 'In a call with alice and carol');
        assert.strictEqual(d.carol.element('call_state').textContent, 'In a call with alice and bob');
    });

    it('goes on without one who declines, stops the ringing of one who never answers, and ends when nobody answers', async () => {
        const d = devices(friends(alice, bob, carol));
        await callGroup(d);
        await deliver(d.bob, ringTo(d.alice, bob));
        d.bob.click('call_decline');
        await settleAll(d, 2);
        const bobTile = d.alice.element('contact_caption').textContent === 'bob' ? 1 : 2;
        assert.strictEqual(d.alice.element('note_' + bobTile).textContent, 'Declined');
        assert.strictEqual(d.alice.element('call_state').textContent, 'Ringing carol…', 'carol is still rung');

        d.timers.pass(Calls.ANSWER_MS);
        await settleAll(d, 2);
        assert.strictEqual(d.alice.element('call_state').textContent, 'Call with bob and carol: nobody answered.');
        const cancels = sent(d.alice).filter(p => p.id.endsWith('-x'));
        assert.deepStrictEqual(cancels.map(p => p.to), [carol.pub], 'carol\'s ringing stops; bob already said no');
        assert.strictEqual(Calls.readSignal((await opened(carol, cancels[0])).signal).t, 'cancel');
    });

    it('offers Call in a group\'s messages only when it has members', async () => {
        const d = devices({ alice: { pals: palsOf(bob), groups: [{ name: 'Empty', members: [] }] } });
        await d.alice.settle();
        d.alice.pick('groups', 'data-group', 'Empty');
        d.alice.click('group_messages');
        assert.strictEqual(d.alice.element('call_start').hidden, true);
    });
});
