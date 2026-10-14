'use strict';

// Video calls in Pals: brought over from InPerson (src/fs/pwa/inPerson/PLAN.md,
// "Porting calls to Pals"). InPerson's tests cover the controller and the
// signals in depth (tests/inPerson.test.js); these cover what Pals adds - the
// signal in the seal, the ring to the /pals/ device and the pinned key, the
// worker's notifications, missed calls in the log, the call layer, the
// switch in Settings and TURN from Northern.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadPals, mountPals, fakeIndexedDB, agreementKey, plain, read, settle } from './helpers/palsPage.js';
import { fakeHub, fakeWebRTC, fakeTimers } from './helpers/inPersonPage.js';
import { REPO_ROOT } from './helpers/db.js';
import { generateKeys, readKeys } from '../src/h2t/PushApi.js';
import sjclClass from '../src/h2t/sjclClass.js';

const { Model, Views, Seal, Calls } = loadPals();
const sjcl = new sjclClass().get();

/** A Northern identity as reg/session.js drafts one. */
function identity(name) {
    const keys = sjcl.ecc.ecdsa.generateKeys(256, 0);
    const pub = sjcl.codec.base64.fromBits(keys.pub.get().x.concat(keys.pub.get().y));
    const priv = sjcl.codec.base64.fromBits(keys.sec.get());
    return { name, pub, priv };
}

const alice = identity('alice');
const bob = identity('bob');
const carol = identity('carol');
const keys = Object.fromEntries(await Promise.all([alice, bob, carol].map(async who => [who.name, await agreementKey(who)])));
const kept = (...who) => Object.fromEntries(who.map(w => [w.pub, { key: keys[w.name], at: 1 }]));
const urlKeyOf = pub => Buffer.from(pub, 'base64').toString('base64url');
const ID = 'Abcdefghijklmnopqrstuv';

/** A device as welcome.html lists it under /pals/. */
const listed = who => ({
    path: `/pals/${who.name}/${urlKeyOf(who.pub)}`, type: 'txt', counter: 0, author: who.pub, public: 'public',
    value: JSON.stringify({ pub: who.pub, username: who.name, provider: 'google', ts: 1,
        subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${who.name}`, keys: { p256dh: 'BP-' + who.name, auth: 'auth-' + who.name } } })
});

/** A push as the server relays it: sealed in the sender's browser. */
async function sealedFrom(from, to, inner, { id = 'w1' } = {}) {
    const wire = { id, part: 1, parts: 1 };
    return { v: 2, from: from.pub, to: to.pub, ...wire, sealed: await Seal.seal(keys[from.name], from.pub, to.pub, wire, inner) };
}

/** Pals' state with these pals in it. */
const withPals = (...who) => ({ pals: who.map(w => ({ pub: w.pub, name: w.name, verified: false })) });
/** A device set up by welcome.html, with video calls switched on in Settings - or not. */
const setUp = (who, calls = true) => ({
    [who.pub]: { path: '/pals/x/y', endpoint: 'https://fcm.googleapis.com/fcm/send/device' },
    ...(calls ? { ['calls ' + who.pub]: { enabled: true } } : {})
});

// ---------------------------------------------------------------------------
// The seal, the model, the views
// ---------------------------------------------------------------------------

describe('Pals calls - the seal, the model and the log', () => {
    it('seals a call\'s signal beside the text, and a message without one opens without one', async () => {
        const signal = Calls.signal('ring', ID, 1000);
        const ring = await sealedFrom(alice, bob, { ts: 1000, body: Calls.RING_TEXT, signal });
        const opened = plain(await Seal.open(keys.bob, ring));
        assert.strictEqual(opened.signal, signal);
        assert.strictEqual(opened.body, Calls.RING_TEXT, 'what a Pals too old to know calls files instead');
        assert.deepStrictEqual(plain(Calls.readSignal(opened.signal)), { t: 'ring', call: ID, ts: 1000 });

        const message = plain(await Seal.open(keys.bob, await sealedFrom(alice, bob, { ts: 1, body: 'hello' })));
        assert.ok(!('signal' in message));
    });

    it('files a missed call once, in the caller\'s messages, with the dot by their name', () => {
        const me = { pub: bob.pub, name: 'bob' };
        const state = Model.load(withPals(alice));
        const m = Model.missedCall(state, me, alice.pub, 5000, ID);
        assert.strictEqual(m.body, Model.MISSED_CALL);
        assert.strictEqual(m.call, 'missed');
        assert.strictEqual(Model.missedCall(state, me, alice.pub, 5000, ID), null, 'once per call');
        assert.ok(Model.isUnread(state, alice.pub));
        assert.deepStrictEqual(plain(Model.log(state, { kind: 'pal', pub: alice.pub }).map(x => x.body)), [Model.MISSED_CALL]);
        assert.match(Views.log(Model.log(state, { kind: 'all' }), state, me), /title="Video call"/);

        // Somebody who is not a pal: listed under the pals, by the name the directory gave.
        Model.missedCall(state, me, carol.pub, 6000, ID, 'carol');
        assert.deepStrictEqual(plain(Model.others(state)), [carol.pub]);
        assert.strictEqual(Model.nameOf(state, carol.pub, me), 'carol');
        assert.throws(() => Model.missedCall(state, me, 'not a key', 1, ID), /not a caller/);
    });

    it('takes STUN, and TURN from Northern - and tries without TURN when Northern has none', () => {
        const turn = { urls: ['turn:turn.example.org:3478?transport=udp', 'nonsense'], username: 'u', credential: 'c' };
        assert.deepStrictEqual(plain(Calls.rtcConfig({ iceServers: [turn] })), {
            iceServers: [{ urls: [Calls.DEFAULT_STUN] }, { urls: ['turn:turn.example.org:3478?transport=udp'], username: 'u', credential: 'c' }],
            iceTransportPolicy: 'all'
        });
        assert.deepStrictEqual(plain(Calls.rtcConfig(null).iceServers), [{ urls: [Calls.DEFAULT_STUN] }]);
        assert.strictEqual(Calls.enabled({ enabled: true }), true);
        for (const off of [undefined, null, {}, { enabled: 'yes' }, { mode: 'northern' }]) {
            assert.strictEqual(Calls.enabled(off), false, JSON.stringify(off));
        }
    });

    it('says how a call stands in plain words', () => {
        assert.strictEqual(Calls.stateText('ringing', 'bob <b>'), 'Ringing bob <b>…', 'text, never markup');
        assert.strictEqual(Calls.stateText('connected', 'bob'), 'In a call with bob');
        assert.strictEqual(Calls.stateText('nonsense', 'bob'), '');
    });
});

// ---------------------------------------------------------------------------
// The service worker
// ---------------------------------------------------------------------------

describe('Pals calls - the service worker', () => {
    /** sw.js with a worker's globals stubbed, on bob's device. */
    function worker(idb) {
        const listeners = {};
        const did = { notified: [], posted: [], opened: [], focused: 0, windows: [] };
        const indexedDB = fakeIndexedDB(idb);
        const here = 'https://pals.example/fs/get/pwa/pals/';
        const context = {
            URL, Promise, JSON, Date, atob, btoa, Uint8Array, String, TextEncoder, TextDecoder, indexedDB,
            crypto: globalThis.crypto,
            Request: function Request(url, options) { this.url = url; Object.assign(this, options); },
            caches: { open: () => Promise.resolve({ addAll: () => Promise.resolve() }), keys: () => Promise.resolve([]) },
            fetch: () => Promise.reject(new Error('the worker asks the server nothing')),
            self: {
                location: { href: here + 'sw.js' },
                addEventListener: (name, fn) => { listeners[name] = fn; },
                skipWaiting() {},
                clients: {
                    claim() {},
                    matchAll: () => Promise.resolve(did.windows),
                    openWindow: url => { did.opened.push(url); return Promise.resolve(); }
                },
                registration: { showNotification: (title, options) => { did.notified.push({ title, ...options }); return Promise.resolve(); } }
            }
        };
        const source = file => file.startsWith('../../reg/')
            ? fs.readFileSync(path.join(REPO_ROOT, 'src/fs/reg', file.slice('../../reg/'.length)), 'utf8')
            : read(file.replace('./', ''));
        context.importScripts = (...files) => files.forEach(file => vm.runInContext(source(file), context, { filename: file }));
        vm.createContext(context);
        vm.runInContext(read('sw.js'), context, { filename: 'sw.js' });
        const fire = async (name, event = {}) => {
            const waits = [];
            listeners[name]({ ...event, waitUntil: p => waits.push(p) });
            await Promise.all(waits);
        };
        did.inbox = () => [...(indexedDB.stores.inbox || new Map()).values()];
        return { did, fire, here };
    }
    const pushOf = payload => ({ data: { text: () => JSON.stringify(payload) } });
    const bobs = (calls = true) => worker({ keys: kept(bob), state: { [bob.pub]: withPals(alice) }, setup: setUp(bob, calls) });
    const ring = (from, ts = Date.now()) => sealedFrom(from, bob, { ts, body: Calls.RING_TEXT, signal: Calls.signal('ring', ID, ts) }, { id: ID });

    it('rings for a pal: who is calling, until it is dealt with - and the ring waits in the inbox', async () => {
        const { did, fire, here } = bobs();
        did.windows.push({ url: here + 'index.html', postMessage: data => did.posted.push(data) });
        await fire('push', pushOf(await ring(alice)));

        assert.deepStrictEqual(did.notified.map(n => [n.body, n.tag, n.requireInteraction, n.data && n.data.call]),
            [['alice is calling', 'pals-call-' + ID, true, ID]]);
        assert.strictEqual(did.inbox().length, 1);
        assert.deepStrictEqual(plain(did.posted), [{ type: 'pals:push' }]);
    });

    it('never rings for somebody who is not a pal, with calls off, nor for a ring too old or cancelled: those are missed calls', async () => {
        const stranger = bobs();
        await stranger.fire('push', pushOf(await ring(carol)));
        assert.deepStrictEqual(stranger.did.notified.map(n => [n.body, !!n.requireInteraction]),
            [[`Missed call from A new pal (${carol.pub.slice(0, 5)})`, false]]);

        const late = bobs();
        await late.fire('push', pushOf(await ring(alice, Date.now() - Calls.RING_MS - 1)));
        assert.deepStrictEqual(late.did.notified.map(n => n.body), ['Missed call from alice']);

        const off = bobs(false);
        await off.fire('push', pushOf(await ring(alice)));
        assert.deepStrictEqual(off.did.notified.map(n => n.body), ['Missed call from alice'], 'calls switched off here');

        const cancelled = bobs();
        await cancelled.fire('push', pushOf(await sealedFrom(alice, bob,
            { ts: 1, body: Calls.MISSED_TEXT, signal: Calls.signal('cancel', ID, 1) }, { id: ID + '-x' })));
        assert.deepStrictEqual(cancelled.did.notified.map(n => [n.body, n.tag]), [['Missed call from alice', 'pals-call-' + ID]],
            'it takes the place of the ring\'s notification');
    });

    it('still says New message for a message', async () => {
        const { did, fire } = bobs();
        await fire('push', pushOf(await sealedFrom(alice, bob, { ts: 1, body: 'hello' })));
        assert.deepStrictEqual(did.notified.map(n => [n.body, n.tag]), [['New message from alice', 'pals']]);
    });

    it('brings an open page forward on a click, and tells it to look in the inbox', async () => {
        const { did, fire, here } = bobs();
        did.windows.push({ url: here + 'index.html', postMessage: data => did.posted.push(data), focus: () => { did.focused += 1; return Promise.resolve(); } });
        await fire('notificationclick', { notification: { close() {}, data: { call: ID } } });
        assert.strictEqual(did.focused, 1);
        assert.deepStrictEqual(plain(did.posted), [{ type: 'pals:push' }]);
    });
});

// ---------------------------------------------------------------------------
// The page: two pals call each other
// ---------------------------------------------------------------------------

describe('Pals calls - the page', () => {
    const vapid = readKeys(JSON.stringify(generateKeys()));
    const search = pattern => `GET /pals/?searchPlus=${encodeURIComponent(pattern)}`;
    const routes = (extra = {}) => ({
        [search('%')]: [listed(alice), listed(bob), listed(carol)],
        ...Object.fromEntries([alice, bob, carol].map(w => [search('%/' + urlKeyOf(w.pub)), [listed(w)]])),
        'GET /push/api/config/pub': { publicKey: vapid.publicKey },
        'POST /push/api/send': () => [200, { status: 'OK' }],
        'GET /turn/api/ice': { iceServers: [{ urls: ['turn:turn.example.org:3478?transport=udp'], username: 'u', credential: 'c' }], ttl: 60, provider: 'cloudflare' },
        ...extra
    });
    /** Two devices on one Northern: the same /sub/ hub, the same network, the same clock. */
    function devices({ extra, aliceState = withPals(bob), bobState = withPals(alice), bobCalls = true } = {}) {
        const shared = { hub: fakeHub(), net: fakeWebRTC(), timers: fakeTimers() };
        const mount = (who, state, calls) => mountPals({
            localStorage: { pub: who.pub, pub_name: who.name }, cookie: `ssid=${who.pub}.${Date.now()}.sig`,
            routes: routes(extra), idb: { keys: kept(who), state: { [who.pub]: state }, setup: setUp(who, calls) }, ...shared
        });
        return { a: mount(alice, aliceState, true), b: mount(bob, bobState, bobCalls), ...shared };
    }
    const sent = page => page.fetch.calls.filter(c => c.url === '/push/api/send').map(c => JSON.parse(c.body));
    /** What a page keeps, read as the page reads it. */
    const stateOf = page => plain(Model.load(page.stored()));
    /** What alice pushed, into bob's inbox as his service worker keeps it - and his page told. */
    const deliver = async (to, push, at = 1) => {
        const payload = { v: 2, from: push.from, to: push.to, id: push.id, part: push.part, parts: push.parts, sealed: push.sealed };
        to.indexedDB.stores.inbox.set(at, { payload, at: Date.now() });
        to.push();
        await to.settle();
    };
    const opened = (who, push) => Seal.open(keys[who.name], { v: 2, ...push }).then(plain);
    const calling = async (d) => {
        await d.a.settle();
        await d.b.settle();
        d.a.pick('pals', 'data-pub', bob.pub);
        assert.strictEqual(d.a.element('call_start').hidden, false, 'Call is there for a pal');
        d.a.click('call_start');
        await d.a.settle();
    };

    it('rings the pal\'s Pals device, sealed to the key pinned for them, and shows the call layer', async () => {
        const d = devices();
        await calling(d);

        assert.strictEqual(d.a.element('dlg_call').open, true);
        assert.strictEqual(d.a.media.length, 1, 'the camera is on');
        assert.strictEqual(d.a.element('self_video').srcObject, d.a.media[0].stream);
        const [push] = sent(d.a);
        assert.strictEqual(push.to, bob.pub);
        assert.strictEqual(push.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/bob', 'to bob\'s /pals/ device');
        const ring = await opened(bob, push);
        assert.strictEqual(Calls.readSignal(ring.signal).t, 'ring');
        assert.strictEqual(ring.body, Calls.RING_TEXT);
        assert.ok(d.hub.opened.includes(Calls.channel(push.id)), 'listening on the call\'s channel before ringing');
        assert.strictEqual(d.a.element('call_state').textContent, 'Ringing bob…', 'says so once the ring is out');
        assert.strictEqual(stateOf(d.a).messages.length, 0, 'a call is not a message');
    });

    it('is answered, connects both ends, and hangs up', async () => {
        const d = devices();
        await calling(d);
        await deliver(d.b, sent(d.a)[0]);

        assert.strictEqual(d.b.element('dlg_incoming').open, true);
        assert.match(d.b.element('incoming_from').innerHTML, /alice/);
        assert.strictEqual(stateOf(d.b).messages.length, 0, 'the ring is not filed as a message');
        d.b.click('call_answer');
        for (let i = 0; i < 4; i++) {
            await d.b.settle();
            await d.a.settle();
        }
        assert.strictEqual(d.a.element('call_state').textContent, 'In a call with bob');
        assert.strictEqual(d.b.element('call_state').textContent, 'In a call with alice');
        assert.strictEqual(d.b.element('dlg_call').open, true);
        assert.ok(d.a.element('contact_video').srcObject, 'bob\'s camera on alice\'s screen');
        assert.strictEqual(d.a.element('hang_up').hidden, false);
        assert.strictEqual(d.a.element('call_close').hidden, true, 'no closing the layer in the middle of a call');

        d.a.click('hang_up');
        await d.a.settle();
        await d.b.settle();
        assert.strictEqual(d.a.element('call_state').textContent, 'Call with bob: hung up.');
        assert.strictEqual(d.b.element('call_state').textContent, 'Call with alice: they hung up.');
        assert.ok(d.a.media[0].stream.tracks.every(t => t.stopped), 'the camera is off');
        assert.strictEqual(d.a.element('call_close').hidden, false);
    });

    it('gives up after no answer, stops the ringing, and the pal finds a missed call in the log', async () => {
        const d = devices();
        await calling(d);
        await deliver(d.b, sent(d.a)[0]);
        assert.strictEqual(d.b.element('dlg_incoming').open, true);

        d.timers.pass(Calls.ANSWER_MS);
        await d.a.settle();
        assert.strictEqual(d.a.element('call_state').textContent, 'Call with bob: no answer.');
        const cancel = sent(d.a)[1];
        assert.strictEqual(cancel.id, sent(d.a)[0].id + '-x');
        assert.strictEqual(Calls.readSignal((await opened(bob, cancel)).signal).t, 'cancel');

        await deliver(d.b, cancel, 2);
        assert.strictEqual(d.b.element('dlg_incoming').open, false);
        const log = stateOf(d.b).messages;
        assert.deepStrictEqual(log.map(m => [m.from, m.body, m.call]), [[alice.pub, Model.MISSED_CALL, 'missed']]);
        assert.ok(stateOf(d.b).unread.includes(alice.pub), 'the dot by alice');
    });

    it('never rings for somebody who is not a pal: a missed call in the log instead', async () => {
        const d = devices({ aliceState: withPals(bob), bobState: withPals() });
        await calling(d);
        await deliver(d.b, sent(d.a)[0]);

        assert.strictEqual(d.b.element('dlg_incoming').open, false);
        assert.deepStrictEqual(stateOf(d.b).messages.map(m => [m.from, m.body]), [[alice.pub, Model.MISSED_CALL]]);
        assert.deepStrictEqual(stateOf(d.b).incoming, [alice.pub], 'listed under the pals, to be added');
    });

    it('never rings while calls are switched off on the device called: a missed call', async () => {
        const d = devices({ bobCalls: false });
        await calling(d);
        await deliver(d.b, sent(d.a)[0]);
        assert.strictEqual(d.b.element('dlg_incoming').open, false);
        assert.deepStrictEqual(stateOf(d.b).messages.map(m => m.body), [Model.MISSED_CALL]);
    });

    it('declines: the caller hears so', async () => {
        const d = devices();
        await calling(d);
        await deliver(d.b, sent(d.a)[0]);
        d.b.click('call_decline');
        await d.b.settle();
        await d.a.settle();
        assert.strictEqual(d.b.element('dlg_incoming').open, false);
        assert.strictEqual(d.a.element('call_state').textContent, 'Call with bob: they declined.');
    });

    it('offers Call only in a pal\'s messages, and says why when the camera is refused', async () => {
        const d = devices();
        await d.a.settle();
        d.a.pick('pals', 'data-pub', bob.pub);
        assert.strictEqual(d.a.element('call_start').hidden, false);
        d.a.element('dlg_messages').open = false;

        const refused = mountPals({ localStorage: { pub: alice.pub, pub_name: 'alice' }, cookie: `ssid=${alice.pub}.${Date.now()}.sig`,
            routes: routes(), idb: { keys: kept(alice), state: { [alice.pub]: withPals(bob) }, setup: setUp(alice) }, camera: false,
            hub: d.hub, net: d.net, timers: d.timers });
        await refused.settle();
        refused.pick('pals', 'data-pub', bob.pub);
        refused.click('call_start');
        await refused.settle();
        assert.match(refused.element('call_state').textContent, /could not ring them: the camera and microphone are not allowed/);
        assert.deepStrictEqual(sent(refused), [], 'nothing is rung');
    });

    it('is off until switched on in Settings, which asks for the camera once and lets it go', async () => {
        const page = mountPals({ localStorage: { pub: alice.pub, pub_name: 'alice' }, cookie: `ssid=${alice.pub}.${Date.now()}.sig`,
            routes: routes(), idb: { keys: kept(alice), state: { [alice.pub]: withPals(bob) } } });
        await page.settle();
        page.pick('pals', 'data-pub', bob.pub);
        assert.strictEqual(page.element('call_start').hidden, true, 'no Call while calls are off');

        page.click('settings_open');
        assert.strictEqual(page.element('calls_on').checked, false);
        page.element('calls_on').checked = true;
        page.element('calls_on').listeners.change({});
        await page.settle();
        assert.strictEqual(page.media.length, 1, 'the browser asked for the camera and microphone');
        assert.ok(page.media[0].stream.tracks.every(t => t.stopped), 'and let them go again');
        assert.deepStrictEqual(plain(page.indexedDB.stores.setup.get('calls ' + alice.pub)), { enabled: true });
        assert.match(page.element('calls_report').textContent, /^On:/);
        assert.strictEqual(page.element('call_start').hidden, false, 'Call is there now');

        page.element('calls_on').checked = false;
        page.element('calls_on').listeners.change({});
        await page.settle();
        assert.deepStrictEqual(plain(page.indexedDB.stores.setup.get('calls ' + alice.pub)), { enabled: false });
        assert.strictEqual(page.element('call_start').hidden, true);
    });

    it('stays off when the camera is refused, and says why', async () => {
        const page = mountPals({ localStorage: { pub: alice.pub, pub_name: 'alice' }, cookie: `ssid=${alice.pub}.${Date.now()}.sig`,
            routes: routes(), idb: { keys: kept(alice) }, camera: false });
        await page.settle();
        page.click('settings_open');
        page.element('calls_on').checked = true;
        page.element('calls_on').listeners.change({});
        await page.settle();
        assert.strictEqual(page.element('calls_on').checked, false);
        assert.match(page.element('calls_report').textContent, /^Still off: the camera and microphone are not allowed/);
        assert.strictEqual(page.indexedDB.stores.setup.get('calls ' + alice.pub), undefined);
    });

    it('takes TURN from Northern for every call, and tries without when Northern has none', async () => {
        const d = devices();
        await calling(d);
        await deliver(d.b, sent(d.a)[0]);
        d.b.click('call_answer');
        for (let i = 0; i < 4; i++) {
            await d.b.settle();
            await d.a.settle();
        }
        assert.strictEqual(d.a.element('call_state').textContent, 'In a call with bob');
        for (const pc of d.net.all) {
            assert.deepStrictEqual(plain(pc.config.iceServers.map(s => s.urls[0])), [Calls.DEFAULT_STUN, 'turn:turn.example.org:3478?transport=udp']);
            assert.strictEqual(pc.config.iceTransportPolicy, 'all', 'direct when the devices can reach each other');
        }

        const none = devices({ extra: { 'GET /turn/api/ice': () => [503, { error: 'NotConfigured', message: 'TURN is not set up on this server' }] } });
        await calling(none);
        assert.match(none.a.element('status').textContent, /No TURN credentials from Northern \(TURN is not set up on this server\); trying without/);
        assert.strictEqual(none.a.element('call_state').textContent, 'Ringing bob…', 'the call goes on');
    });

    it('lets the user compare keys in the middle of a call', async () => {
        const d = devices();
        await calling(d);
        d.a.click('call_key');
        await settle();
        assert.strictEqual(d.a.element('dlg_verify').open, true);
        assert.match(d.a.element('verify_pal').innerHTML, /bob/);
    });
});
