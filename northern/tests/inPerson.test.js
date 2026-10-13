'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadInPerson, mountInPerson, mountWelcome, fakeHub, fakeWebRTC, fakeTimers, fakeMedia, plain, read, source,
    settle, PWA_DIR } from './helpers/inPersonPage.js';
import { agreementKey, fakeIndexedDB } from './helpers/palsPage.js';
import { generateKeys } from '../src/h2t/PushApi.js';
import sjclClass from '../src/h2t/sjclClass.js';

const { Model, Views, Call, Seal } = loadInPerson();
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
const vapid = generateKeys();

const urlKeyOf = pub => Buffer.from(pub, 'base64').toString('base64url');
const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const ID2 = 'BBBBBBBBBBBBBBBBBBBBBB';

/** A device as a directory search hands its row back: under /pals/ or /inperson/. */
function listed(who, { prefix = '/inperson/', name = who.name, ts = 1, author = who.pub } = {}) {
    return {
        path: `${prefix}${name}/${urlKeyOf(who.pub)}`, type: 'txt', counter: 0, author, public: 'public',
        value: JSON.stringify({
            pub: who.pub, username: name, provider: 'google', ts,
            subscription: { endpoint: `https://fcm.googleapis.com/fcm/send/${name}-${ts}`, keys: { p256dh: 'BP-' + name, auth: 'auth-' + name } }
        })
    };
}

/** What Northern answers a page: the two directories, the push key and the push relay. */
function northern({ pals = [alice, bob, carol], inperson = [alice, bob], pushed = [], extra = {} } = {}) {
    const routes = {
        'GET /pals/?searchPlus=%25': pals.map(w => listed(w, { prefix: '/pals/' })),
        'GET /inperson/?searchPlus=%25': inperson.map(w => listed(w)),
        'GET /push/api/config/pub': { publicKey: vapid.publicKey },
        'POST /push/api/send': call => { pushed.push(JSON.parse(call.body)); return [200, { status: 'OK' }]; },
        ...extra
    };
    for (const who of inperson) {
        routes[`GET /inperson/?searchPlus=%25%2F${urlKeyOf(who.pub)}`] = [listed(who)];
    }
    return routes;
}

/** What the relay pushes, as the receiving worker gets it: `from` set by the server. */
const relayed = (from, sent) => ({ v: 2, from: from.pub, to: sent.to, id: sent.id, part: sent.part, parts: sent.parts, sealed: sent.sealed });

/** The service worker filed a push in the page's inbox, and tells the page. */
function deliver(page, outer) {
    const inbox = page.indexedDB.stores.inbox;
    inbox.set(inbox.size + 1000 + Math.floor(Math.random() * 1000), { payload: outer, at: Date.now() });
    page.push();
}

const many = async (n = 4) => { for (let i = 0; i < n; i++) await settle(); };

// ---------------------------------------------------------------------------
// model.js
// ---------------------------------------------------------------------------

describe('InPerson model - the directories and the contacts', () => {
    it('reads devices from /inperson/ and /pals/ rows the key in the path wrote, newest per key', () => {
        const rows = [
            listed(alice, { ts: 1 }), listed(alice, { ts: 5, name: 'alicia' }),
            listed(bob, { author: carol.pub }),
            listed(carol, { prefix: '/pals/' }),
            { ...listed(carol), path: `/inperson/carol/${urlKeyOf(carol.pub)}/1` },
            { ...listed(carol), value: '{not json' }
        ];
        const found = plain(Model.directory(rows, '/inperson/'));
        assert.deepStrictEqual(found.map(e => [e.name, e.ts]), [['alicia', 5]]);
        assert.deepStrictEqual(plain(Model.directory(rows, '/pals/')).map(e => e.name), ['carol']);
    });

    it('lists everybody either directory has, less the user, and says who can be rung', () => {
        const pals = Model.directory([listed(alice, { prefix: '/pals/' }), listed(bob, { prefix: '/pals/', name: 'bobby', ts: 9 }), listed(carol, { prefix: '/pals/' })], '/pals/');
        const calls = Model.directory([listed(alice), listed(bob, { ts: 2 })], '/inperson/');
        const contacts = plain(Model.contacts(pals, calls, { pub: alice.pub }));
        assert.deepStrictEqual(contacts.map(c => [c.name, !!c.device]), [['bobby', true], ['carol', false]]);
        assert.strictEqual(contacts[0].device.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/bob-2', 'rung where InPerson is, not Pals');
        assert.strictEqual(Model.nameOf(contacts, carol.pub), 'carol');
        assert.strictEqual(Model.nameOf(contacts, alice.pub), '');
    });

    it('files a device the way Pals does, the name in one segment, the key base64url', () => {
        assert.strictEqual(Model.devicePath('a.b c/d', alice.pub), `/inperson/a%2Eb%20c%2Fd/${urlKeyOf(alice.pub)}`);
        const record = plain(Model.deviceRecord({ pub: alice.pub, name: ' alice ' },
            { endpoint: 'https://web.push.apple.com/QG', keys: { p256dh: 'p', auth: 'a' } }, 7));
        assert.deepStrictEqual(record, { pub: alice.pub, username: 'alice', provider: 'apple',
            subscription: { endpoint: 'https://web.push.apple.com/QG', keys: { p256dh: 'p', auth: 'a' } }, ts: 7 });
        assert.strictEqual(Model.providerOf('https://evil.example/fcm.googleapis.com/'), '');
    });
});

describe('InPerson model - STUN and TURN', () => {
    it('starts with Cloudflare\'s STUN server only', () => {
        assert.deepStrictEqual(plain(Model.rtcConfig(Model.defaultConfig())),
            { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], iceTransportPolicy: 'all' });
    });

    it('takes a TURN server of the user\'s own, with its user name and password', () => {
        const config = Model.cleanConfig({ mode: 'turn', stun: 'stun:a.example:3478 stun:b.example:3478',
            turnUrls: 'turn:t.example:3478?transport=udp, turns:t.example:5349', username: 'u', credential: 'p', relayOnly: true });
        assert.deepStrictEqual(plain(Model.rtcConfig(config)), { iceServers: [
            { urls: ['stun:a.example:3478', 'stun:b.example:3478'] },
            { urls: ['turn:t.example:3478?transport=udp', 'turns:t.example:5349'], username: 'u', credential: 'p' }
        ], iceTransportPolicy: 'relay' });
    });

    it('says what is wrong with the form, in words', () => {
        assert.throws(() => Model.cleanConfig({ mode: 'stun', stun: 'http://x' }), /stun:host:port/);
        assert.throws(() => Model.cleanConfig({ mode: 'turn', turnUrls: 'stun:x:1', username: 'u', credential: 'p' }), /turn:host/);
        assert.throws(() => Model.cleanConfig({ mode: 'turn', turnUrls: 'turn:x:1' }), /user name and password/);
        assert.throws(() => Model.cleanConfig({ mode: 'stun', relayOnly: true }), /needs a TURN server/);
        const odd = plain(Model.cleanConfig({ mode: 'what', stun: '', username: 'kept?', credential: 'no' }));
        assert.deepStrictEqual(odd, { mode: 'stun', stun: '', turnUrls: '', username: '', credential: '', relayOnly: false },
            'a password is not kept for a way that does not use it');
        assert.deepStrictEqual(plain(Model.loadConfig({ mode: 'turn' })), plain(Model.defaultConfig()), 'a damaged record reads as the default');
    });

    it('uses the credentials Northern hands out, and nothing that is not an ICE address', () => {
        const config = Model.cleanConfig({ mode: 'northern', stun: '' });
        const rtc = plain(Model.rtcConfig(config, { iceServers: [
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'javascript:alert(1)'], username: 'x', credential: 'y' },
            { urls: ['https://nope'] }
        ] }));
        assert.deepStrictEqual(rtc.iceServers, [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'x', credential: 'y' }
        ]);
    });

    it('reads what a check gathered, and says it in words', () => {
        const found = Model.candidateTypes([
            'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host generation 0',
            'candidate:2 1 udp 1686052607 203.0.113.9 50000 typ srflx raddr 192.168.1.5 rport 50000',
            'candidate:3 1 udp 41885439 198.51.100.7 49170 typ relay raddr 203.0.113.9 rport 50000'
        ]);
        assert.deepStrictEqual(plain(found), { host: 1, srflx: 1, prflx: 0, relay: 1 });
        const turn = Model.cleanConfig({ mode: 'northern', stun: Model.DEFAULT_STUN });
        assert.match(Model.checkReport(turn, found), /TURN works.*STUN works/);
        assert.match(Model.checkReport(turn, { host: 1, srflx: 1, relay: 0 }), /TURN did not answer/);
        assert.match(Model.checkReport(Model.defaultConfig(), { host: 2, srflx: 0, relay: 0 }), /STUN did not answer.*same network/);
    });
});

describe('InPerson model - signals', () => {
    it('reads back what it wrote, and only what a signal may carry', () => {
        const offer = Model.readSignal(Model.signal('offer', ID, 5, { sdp: 'v=0', extra: 'dropped' }), ID);
        assert.deepStrictEqual(plain(offer), { t: 'offer', call: ID, ts: 5, sdp: 'v=0' });
        const ice = Model.readSignal(Model.signal('ice', ID, 5, { candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'x' } }));
        assert.deepStrictEqual(plain(ice.candidate), { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
        assert.strictEqual(Model.readSignal(Model.signal('decline', ID, 5, { busy: true })).busy, true);
    });

    it('drops what is not a signal for this call', () => {
        const junk = ['', 'null', '{"t":"ring"}', Model.signal('ring', ID2, 1), JSON.stringify({ t: 'hello', call: ID, ts: 1 }),
            Model.signal('offer', ID, 1), Model.signal('answer', ID, 1, { sdp: 'x'.repeat(70000) }),
            Model.signal('ice', ID, 1, { candidate: 'candidate:1' }), JSON.stringify({ t: 'bye', call: ID })];
        for (const text of junk) {
            assert.strictEqual(Model.readSignal(text, ID), null, text.slice(0, 60));
        }
        assert.throws(() => Model.signal('ring', 'short', 1), /not a signal/);
    });

    it('rings for the newest fresh call, and counts the rest as missed', () => {
        const now = 1_000_000;
        const from = (pub, t, call, ts) => ({ from: pub, signal: { t, call, ts } });
        const seen = Model.incoming([
            from(bob.pub, 'ring', ID, now - 70_000),
            from(carol.pub, 'ring', ID2, now - 5_000),
            from(bob.pub, 'ring', 'CCCCCCCCCCCCCCCCCCCCCC', now - 2_000),
            from(bob.pub, 'cancel', 'CCCCCCCCCCCCCCCCCCCCCC', now - 1_000)
        ], now, []);
        assert.strictEqual(seen.ringing.call, ID2, 'the newest one was cancelled; the oldest is stale');
        assert.deepStrictEqual(plain(seen.missed).map(m => m.call), [ID, 'CCCCCCCCCCCCCCCCCCCCCC']);
        assert.strictEqual(Model.incoming([from(carol.pub, 'ring', ID2, now)], now, [ID2]).ringing, null, 'one already dealt with');
    });

    it('finds the call a notification opens on, and its channel', () => {
        assert.strictEqual(Model.callFromHash('#call=' + ID), ID);
        assert.strictEqual(Model.callFromHash('#call=x'), '');
        assert.strictEqual(Model.channel(ID), '/sub/inperson-' + ID);
    });
});

describe('InPerson views', () => {
    it('escapes names, and greys out who cannot be called yet', () => {
        const html = Views.contacts([
            { pub: bob.pub, name: '<b>bob</b>', device: { pub: bob.pub } },
            { pub: carol.pub, name: 'carol', device: null }
        ], bob.pub);
        assert.ok(html.includes('&lt;b&gt;bob&lt;/b&gt;') && !html.includes('<b>'));
        assert.match(html, /class="row" aria-selected="true" data-pub="[^"]+">/);
        assert.match(html, /class="row unreachable" aria-selected="false"[^>]*>.*not set up for calls/);
        assert.match(Views.contacts([], null), /Nobody yet/);
        assert.strictEqual(Views.callState('connected', '<x>'), 'In a call with &lt;x&gt;');
    });
});

// ---------------------------------------------------------------------------
// call.js
// ---------------------------------------------------------------------------

describe('InPerson call - WebRTC, two ends wired to each other', () => {
    /** Two controllers whose signals reach each other as they would: written, read back, checked. */
    function pair({ calleeAnswers = true } = {}) {
        const net = fakeWebRTC();
        const timers = fakeTimers();
        const log = { caller: [], callee: [], states: { caller: [], callee: [] }, remote: {}, ended: {} };
        const ends = {};
        const make = (role, other) => Call.create({
            role, call: ID, config: { iceServers: [] }, local: fakeMedia(role), RTCPeerConnection: net.RTCPeerConnection, timers,
            send: (t, extra) => {
                log[role].push(t);
                const s = Model.readSignal(Model.signal(t, ID, Date.now(), extra), ID);
                setImmediate(() => ends[other] && ends[other].receive(s));
                return Promise.resolve();
            },
            on: {
                state: s => log.states[role].push(s),
                remote: stream => { log.remote[role] = stream; },
                ended: reason => { log.ended[role] = reason; }
            }
        });
        ends.caller = make('caller', 'callee');
        if (calleeAnswers) {
            ends.callee = make('callee', 'caller');
        }
        return { ...ends, ends, net, timers, log };
    }

    it('rings, is answered, offers, is answered again, and connects: each end sees the other', async () => {
        const { caller, callee, net, log } = pair();
        await caller.start();
        assert.strictEqual(caller.state(), 'calling');
        await callee.start();
        await many(2);

        assert.deepStrictEqual(log.callee.filter(t => t !== 'ice'), ['ready', 'answer']);
        assert.deepStrictEqual(log.caller.filter(t => t !== 'ice'), ['offer']);
        assert.ok(log.caller.includes('ice') && log.callee.includes('ice'), 'candidates go both ways');
        assert.strictEqual(caller.state(), 'connected');
        assert.strictEqual(callee.state(), 'connected');
        assert.strictEqual(log.remote.caller.name, 'callee');
        assert.strictEqual(log.remote.callee.name, 'caller');
        const [a, b] = net.all;
        assert.strictEqual(a.tracks.length, 2, 'camera and microphone both');
        assert.deepStrictEqual(a.added.map(c => c.candidate), ['candidate:2 1 udp 2122260223 192.0.2.2 50002 typ host']);
        assert.strictEqual(b.added.length, 1, 'the caller\'s candidate was kept until the offer was in');
    });

    it('uses the page\'s own timers as a browser allows: never called as a method of another object', async () => {
        // Chrome throws "Illegal invocation" when setTimeout's `this` is not the window.
        const strict = (fn) => function (...args) {
            if (this !== undefined && !('InPersonCall' in this)) {
                throw new TypeError('Illegal invocation');
            }
            return fn(...args);
        };
        const { Call: BrowserCall } = loadInPerson({ setTimeout: strict(setTimeout), clearTimeout: strict(clearTimeout) });
        const ended = [];
        const caller = BrowserCall.create({
            role: 'caller', call: ID, config: { iceServers: [] }, local: fakeMedia('caller'), RTCPeerConnection: fakeWebRTC().RTCPeerConnection,
            send: () => Promise.resolve(), on: { ended: reason => ended.push(reason) }
        });
        await caller.start();
        assert.strictEqual(caller.state(), 'calling');
        await caller.hangUp();
        assert.deepStrictEqual(ended, ['cancelled']);
    });

    it('hangs up over the data channel: the other end is told without Northern', async () => {
        const { caller, callee, log } = pair();
        await caller.start();
        await callee.start();
        await many(2);
        callee.hangUp();
        assert.strictEqual(log.ended.callee, 'hung up');
        assert.strictEqual(log.ended.caller, 'they hung up');
        assert.ok(caller.peer().closed && callee.peer().closed);
    });

    it('gives up when nobody answers, or the one called is gone', async () => {
        const { caller, timers, log } = pair({ calleeAnswers: false });
        await caller.start();
        timers.pass(Model.ANSWER_MS - 1);
        assert.strictEqual(caller.ended(), '');
        timers.pass(1);
        assert.strictEqual(log.ended.caller, 'no answer');

        const lone = pair();
        await lone.callee.start();
        lone.ends.caller = null;
        lone.timers.pass(Model.OFFER_MS);
        assert.match(lone.log.ended.callee, /they hung up/);
    });

    it('ends when declined, when the line fails, and when hung up before an answer', async () => {
        const declined = pair({ calleeAnswers: false });
        await declined.caller.start();
        await declined.caller.receive({ t: 'decline', call: ID, ts: 1, busy: true });
        assert.strictEqual(declined.log.ended.caller, 'they are on another call');

        const failing = pair();
        await failing.caller.start();
        await failing.callee.start();
        await many(2);
        failing.net.fail(failing.caller.peer());
        assert.match(failing.log.ended.caller, /failed - a TURN server/);

        const early = pair({ calleeAnswers: false });
        await early.caller.start();
        early.caller.hangUp();
        assert.strictEqual(early.log.ended.caller, 'cancelled');
        assert.deepStrictEqual(early.log.caller, ['bye']);
    });

    it('takes no offer twice, and no answer it did not ask for', async () => {
        const { callee, net } = pair({ calleeAnswers: true });
        await callee.receive({ t: 'answer', call: ID, ts: 1, sdp: 'v=0 answer from pc9' });
        assert.strictEqual(net.all.length, 0);
        await callee.receive({ t: 'offer', call: ID, ts: 1, sdp: 'v=0 offer from pc9' });
        await callee.receive({ t: 'offer', call: ID, ts: 1, sdp: 'v=0 offer from pc9' });
        assert.strictEqual(net.all.length, 1);
    });
});

// ---------------------------------------------------------------------------
// The pages
// ---------------------------------------------------------------------------

describe('InPerson page - before a call', () => {
    it('sends a visitor with no session to Reg, and an unset device to the welcome page', async () => {
        const nobody = mountInPerson({});
        assert.strictEqual(nobody.location.replaced, '/fs/get/reg/Reg.html#/fs/get/pwa/inPerson/index.html');

        const fresh = mountInPerson({ who: alice, setup: false, routes: northern(), idb: { keys: kept(alice) } });
        await settle();
        assert.strictEqual(fresh.location.replaced, './welcome.html');
    });

    it('lists the contacts from both directories, and keeps their names for the service worker', async () => {
        const page = mountInPerson({ who: alice, routes: northern(), idb: { keys: kept(alice) } });
        await settle();
        const html = page.element('contacts').innerHTML;
        assert.ok(html.indexOf('bob') < html.indexOf('carol'));
        assert.match(html, /unreachable[^>]*data-pub="[^"]*">.*carol/s);
        assert.ok(!html.includes('alice ('), 'not the user');
        assert.deepStrictEqual(page.stored('contacts', alice.pub).map(c => c.name), ['bob', 'carol']);
        assert.strictEqual(page.element('need_card').hidden, true);

        assert.strictEqual(page.element('call').disabled, true, 'nobody picked');
        page.pick(carol.pub);
        assert.strictEqual(page.element('call').disabled, true, 'carol has not set InPerson up');
        page.pick(bob.pub);
        assert.strictEqual(page.element('call').disabled, false);
        assert.strictEqual(page.element('version').textContent, 'v' + vm.runInNewContext(read('version.js') + ';INPERSON_VERSION'));
    });

    it('says to load the ID Card when its key is not on this device, and does not call', async () => {
        const page = mountInPerson({ who: alice, routes: northern() });
        await settle();
        assert.strictEqual(page.element('need_card').hidden, false);
        page.pick(bob.pub);
        assert.strictEqual(page.element('call').disabled, true);
    });
});

describe('InPerson page - a call between two devices', () => {
    async function twoDevices() {
        const hub = fakeHub();
        const net = fakeWebRTC();
        const pushed = [];
        const a = mountInPerson({ who: alice, routes: northern({ pushed }), hub, net, idb: { keys: kept(alice) } });
        const b = mountInPerson({ who: bob, routes: northern({ pushed: [] }), hub, net, idb: { keys: kept(bob) } });
        await settle();
        return { a, b, hub, net, pushed };
    }

    /** Alice calls bob, and the ring reaches bob's page. */
    async function ring(d) {
        d.a.pick(bob.pub);
        await d.a.click('call');
        await many(2);
        const ringing = d.pushed.find(p => p.id.length === 22);
        deliver(d.b, relayed(alice, ringing));
        await many(2);
        return ringing;
    }

    it('rings bob by push, sealed to his key, with the call\'s channel already open', async () => {
        const d = await twoDevices();
        const sent = await ring(d);

        assert.strictEqual(d.a.media.length, 1, 'the camera first');
        assert.strictEqual(d.a.element('self_video').srcObject, d.a.media[0].stream);
        assert.deepStrictEqual(d.hub.opened, ['/sub/inperson-' + sent.id], 'listening before it rings');
        assert.strictEqual(sent.to, bob.pub);
        assert.strictEqual(sent.subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/bob-1', 'bob\'s InPerson device');
        assert.ok(sent.proof && sent.from === alice.pub, 'with a send proof, as Pals sends');
        const opened = await Seal.open(keys.bob, relayed(alice, sent));
        assert.deepStrictEqual(plain(Model.readSignal(opened.body)), { t: 'ring', call: sent.id, ts: JSON.parse(opened.body).ts });
        await assert.rejects(Seal.open(keys.carol, { ...relayed(alice, sent), to: carol.pub }), 'nobody else opens it');
        assert.match(d.a.element('call_state').textContent, /Calling bob/);
        assert.strictEqual(d.a.element('hang_up').hidden, false);

        assert.strictEqual(d.b.element('dlg_incoming').open, true);
        assert.match(d.b.element('incoming_from').innerHTML, />alice \(/);
    });

    it('connects when bob answers: each sees the other, and nothing on the channel is in clear', async () => {
        const d = await twoDevices();
        await ring(d);
        await d.b.click('answer');
        await many(4);

        assert.strictEqual(d.b.element('dlg_incoming').open, false);
        assert.match(d.a.element('call_state').textContent, /In a call with bob/);
        assert.match(d.b.element('call_state').textContent, /In a call with alice/);
        assert.strictEqual(d.a.element('contact_video').srcObject, d.b.media[0].stream, 'alice sees bob');
        assert.strictEqual(d.b.element('contact_video').srcObject, d.a.media[0].stream, 'bob sees alice');
        assert.strictEqual(d.a.element('contact_name').textContent, 'bob');

        const kinds = await Promise.all(d.hub.puts.map(async p => {
            const reader = p.body.to === bob.pub ? keys.bob : keys.alice;
            return Model.readSignal((await Seal.open(reader, p.body)).body).t;
        }));
        assert.deepStrictEqual(kinds.filter(t => t !== 'ice'), ['ready', 'offer', 'answer']);
        assert.ok(d.hub.puts.every(p => !JSON.stringify(p.body).includes('v=0')), 'no SDP in clear');
        assert.ok(d.net.all.every(pc => pc.config.iceServers[0].urls[0] === Model.DEFAULT_STUN));
    });

    it('ignores what anybody else writes on the channel', async () => {
        const d = await twoDevices();
        const sent = await ring(d);
        const channel = '/sub/inperson-' + sent.id;
        // Mallory - carol - knows the channel, and is signed in: she can write to it.
        const forged = { v: 2, from: bob.pub, to: alice.pub, id: 'x-1', part: 1, parts: 1,
            sealed: await Seal.seal(keys.carol, carol.pub, alice.pub, { id: 'x-1', part: 1, parts: 1 }, { ts: 1, body: Model.signal('decline', sent.id, 1) }) };
        await d.hub.put(channel, JSON.stringify(forged));
        await d.hub.put(channel, JSON.stringify({ ...forged, from: carol.pub }));
        await d.hub.put(channel, '{"t":"decline"}');
        await many(2);
        assert.match(d.a.element('call_state').textContent, /Calling bob/, 'still ringing');
    });

    it('hangs up on both sides, the cameras off and the channel closed', async () => {
        const d = await twoDevices();
        await ring(d);
        await d.b.click('answer');
        await many(4);
        d.a.click('hang_up');
        await many(2);

        assert.match(d.a.element('call_state').textContent, /Call with bob: hung up\./);
        assert.match(d.b.element('call_state').textContent, /Call with alice: they hung up\./);
        for (const page of [d.a, d.b]) {
            assert.ok(page.media[0].stream.tracks.every(t => t.stopped), 'camera off');
            assert.strictEqual(page.element('self_video').srcObject, null);
            assert.strictEqual(page.element('hang_up').hidden, true);
            assert.deepStrictEqual(Object.values(d.hub.listeners).flat(), [], 'nobody listening any more');
        }
        assert.strictEqual(d.a.element('call').disabled, false, 'free to call again');
    });

    it('tells alice when bob declines', async () => {
        const d = await twoDevices();
        await ring(d);
        await d.b.click('decline');
        await many(2);
        assert.match(d.a.element('call_state').textContent, /they declined/);
        assert.strictEqual(d.b.media.length, 0, 'bob\'s camera never came on');
    });

    it('gives up after no answer, and bob\'s ringing turns into a missed call', async () => {
        const d = await twoDevices();
        await ring(d);
        d.a.timers.pass(Model.ANSWER_MS);
        await many(2);
        assert.match(d.a.element('call_state').textContent, /no answer/);
        const cancel = d.pushed.find(p => p.id.endsWith('-x'));
        assert.ok(cancel, 'the ringing is stopped by push');
        deliver(d.b, relayed(alice, cancel));
        await many(2);
        assert.strictEqual(d.b.element('dlg_incoming').open, false);
        assert.match(d.b.element('status').textContent, /Missed call from alice at \d\d:\d\d/);
        assert.deepStrictEqual(d.b.inbox(), [], 'the inbox is emptied');
    });

    it('says bob is busy when he is on another call', async () => {
        const d = await twoDevices();
        await ring(d);
        await d.b.click('answer');
        await many(4);
        // Carol rings bob now.
        const outer = { v: 2, from: carol.pub, to: bob.pub, id: ID2, part: 1, parts: 1,
            sealed: await Seal.seal(keys.carol, carol.pub, bob.pub, { id: ID2, part: 1, parts: 1 }, { ts: Date.now(), body: Model.signal('ring', ID2, Date.now()) }) };
        deliver(d.b, outer);
        await many(2);
        const busy = d.hub.puts.find(p => p.url === '/sub/inperson-' + ID2);
        const said = Model.readSignal((await Seal.open(keys.carol, busy.body)).body);
        assert.deepStrictEqual([said.t, said.busy], ['decline', true]);
        assert.match(d.b.element('call_state').textContent, /In a call with alice/, 'the call goes on');
    });

    it('does not ring for a call older than a minute: it was missed', async () => {
        const d = await twoDevices();
        const old = Date.now() - Model.RING_MS - 1000;
        const outer = { v: 2, from: alice.pub, to: bob.pub, id: ID, part: 1, parts: 1,
            sealed: await Seal.seal(keys.alice, alice.pub, bob.pub, { id: ID, part: 1, parts: 1 }, { ts: old, body: Model.signal('ring', ID, old) }) };
        deliver(d.b, outer);
        await many(2);
        assert.strictEqual(d.b.element('dlg_incoming').open, false);
        assert.match(d.b.element('status').textContent, /Missed call from alice/);
    });

    it('says why when the camera is not allowed, and rings nobody', async () => {
        const blocked = mountInPerson({ who: alice, routes: northern(), camera: false, idb: { keys: kept(alice) } });
        await settle();
        blocked.pick(bob.pub);
        await blocked.click('call');
        await many(2);
        assert.match(blocked.element('call_state').textContent, /could not ring them: the camera and microphone are not allowed \(NotAllowedError\)/);
        assert.deepStrictEqual(blocked.fetch.calls.filter(c => c.url === '/push/api/send'), []);
    });

    it('asks Northern for TURN credentials when the device is set up that way', async () => {
        const hub = fakeHub();
        const net = fakeWebRTC();
        const turn = { iceServers: [{ urls: ['turn:turn.example.org:3478'], username: '1:x', credential: 'c' }], ttl: 60 };
        const a = mountInPerson({ who: alice, hub, net, routes: northern({ extra: { 'GET /turn/api/ice': turn } }),
            idb: { keys: kept(alice), config: { [alice.pub]: { mode: 'northern', stun: '', relayOnly: true } } } });
        await settle();
        a.pick(bob.pub);
        await a.click('call');
        await many(2);
        const b = mountInPerson({ who: bob, hub, net, routes: northern(), idb: { keys: kept(bob) } });
        await settle();
        deliver(b, relayed(alice, a.fetch.calls.filter(c => c.url === '/push/api/send').map(c => JSON.parse(c.body))[0]));
        await many(2);
        await b.click('answer');
        await many(4);
        assert.deepStrictEqual(plain(net.all[0].config), { iceServers: turn.iceServers, iceTransportPolicy: 'relay' });
        assert.strictEqual(a.element('ice_mode').textContent, 'TURN from Northern, only through TURN');
    });
});

describe('InPerson welcome page', () => {
    const welcomeRoutes = (extra = {}) => ({
        'GET /push/api/config/pub': { publicKey: vapid.publicKey },
        [`PUT /inperson/alice/${urlKeyOf(alice.pub)}?isPublic=true`]: { unavailable: true },
        [`POST /inperson/alice/${urlKeyOf(alice.pub)}?isPublic=true`]: { status: 'OK' },
        ...extra
    });

    it('fills the form with what was saved, or Cloudflare\'s STUN server', async () => {
        const page = mountWelcome({ who: alice, idb: { keys: kept(alice) } });
        await settle();
        assert.strictEqual(page.element('stun').value, Model.DEFAULT_STUN);
        assert.strictEqual(page.element('mode_stun').checked, true);
        assert.strictEqual(page.element('turn_fields').hidden, true);

        const saved = mountWelcome({ who: alice, idb: { keys: kept(alice),
            config: { [alice.pub]: { mode: 'turn', stun: '', turnUrls: 'turn:t.example:3478', username: 'u', credential: 'p' } } } });
        await settle();
        assert.strictEqual(saved.element('mode_turn').checked, true);
        assert.strictEqual(saved.element('turn_fields').hidden, false);
        assert.strictEqual(saved.element('turn_password').value, 'p');
    });

    it('saves only a configuration that holds together', async () => {
        const page = mountWelcome({ who: alice, idb: { keys: kept(alice) } });
        await settle();
        page.element('mode_stun').checked = false;
        page.element('mode_turn').checked = true;
        page.element('mode_turn').listeners.change();
        page.element('turn_urls').value = 'turn:t.example:3478';
        page.click('save');
        assert.match(page.element('check_report').textContent, /user name and password/);
        page.element('turn_user').value = 'u';
        page.element('turn_password').value = 'p';
        page.click('save');
        await settle();
        assert.strictEqual(page.element('check_report').textContent, 'Saved.');
        assert.deepStrictEqual(page.stored('config', alice.pub), { mode: 'turn', stun: Model.DEFAULT_STUN, turnUrls: 'turn:t.example:3478', username: 'u', credential: 'p', relayOnly: false });
    });

    it('checks the configuration by gathering candidates, and says what it found', async () => {
        const net = fakeWebRTC();
        const page = mountWelcome({ who: alice, net, idb: { keys: kept(alice) } });
        await settle();
        page.click('check');
        await settle();
        assert.match(page.element('check_report').textContent, /STUN did not answer.*same network/);
        assert.ok(net.all[0].closed);
        assert.deepStrictEqual(plain(net.all[0].config.iceServers), [{ urls: [Model.DEFAULT_STUN] }]);

        const noRtc = mountWelcome({ who: alice, rtc: false, idb: { keys: kept(alice) } });
        await settle();
        noRtc.click('check');
        assert.match(noRtc.element('check_report').textContent, /no WebRTC/);
    });

    it('says when Northern has no TURN credentials to give', async () => {
        const page = mountWelcome({ who: alice, idb: { keys: kept(alice) },
            routes: { 'GET /turn/api/ice': () => [503, { error: 'NotConfigured', message: 'this node gives no TURN credentials' }] } });
        await settle();
        page.element('mode_stun').checked = false;
        page.element('mode_northern').checked = true;
        page.click('check');
        await settle();
        assert.match(page.element('check_report').textContent, /Northern gave no TURN credentials: this node gives no TURN/);
    });

    it('subscribes, lists the device under /inperson/, keeps the setup and opens the app', async () => {
        const page = mountWelcome({ who: alice, routes: welcomeRoutes(), idb: { keys: kept(alice) } });
        await settle();
        page.click('go');
        await settle();
        assert.strictEqual(page.location.replaced, './index.html', page.element('status').textContent);
        assert.deepStrictEqual(page.worker.registered, ['./sw.js']);
        const written = page.fetch.calls.find(c => c.method === 'POST');
        assert.deepStrictEqual(JSON.parse(written.body).subscription.endpoint, 'https://fcm.googleapis.com/fcm/send/new-device');
        assert.strictEqual(page.stored('setup', alice.pub).path, `/inperson/alice/${urlKeyOf(alice.pub)}`);
        assert.strictEqual(page.stored('config', alice.pub).mode, 'stun');
    });

    it('will not set up without the ID Card\'s key, notifications, or a Push API', async () => {
        const noKey = mountWelcome({ who: alice, routes: welcomeRoutes() });
        await settle();
        assert.strictEqual(noKey.element('go').disabled, true);
        assert.strictEqual(noKey.element('load_card').hidden, false);

        const denied = mountWelcome({ who: alice, permission: 'denied', routes: welcomeRoutes(), idb: { keys: kept(alice) } });
        await settle();
        denied.click('go');
        await settle();
        assert.match(denied.element('status').textContent, /may notify you/);

        const noPush = mountWelcome({ who: alice, push: false, idb: { keys: kept(alice) } });
        assert.match(noPush.element('status').textContent, /Home Screen/);

        const nobody = mountWelcome({});
        assert.strictEqual(nobody.location.replaced, '/fs/get/reg/Reg.html#/fs/get/pwa/inPerson/welcome.html');
    });
});

// ---------------------------------------------------------------------------
// The service worker, and the files
// ---------------------------------------------------------------------------

describe('InPerson service worker', () => {
    function worker(idb = {}) {
        const listeners = {};
        const did = { notified: [], posted: [], opened: [], focused: 0, windows: [] };
        const indexedDB = fakeIndexedDB(idb);
        const here = 'https://inperson.example/fs/get/pwa/inPerson/';
        const context = {
            URL, Promise, JSON, Date, atob, btoa, Uint8Array, String, TextEncoder, TextDecoder, indexedDB,
            crypto: globalThis.crypto,
            Request: function Request(url, options) { this.url = url; Object.assign(this, options); },
            caches: { open: () => Promise.resolve({ addAll: urls => { did.precached = urls; return Promise.resolve(); } }), keys: () => Promise.resolve([]) },
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
        context.importScripts = (...files) => files.forEach(file => vm.runInContext(source(file), context, { filename: file }));
        vm.createContext(context);
        vm.runInContext(read('sw.js'), context, { filename: 'sw.js' });
        const fire = async (name, event = {}) => {
            const waits = [];
            listeners[name]({ ...event, waitUntil: p => waits.push(p) });
            await Promise.all(waits);
        };
        did.inbox = () => [...(indexedDB.stores.inbox || new Map()).values()];
        did.global = name => vm.runInContext(name, context);
        return { did, fire, here };
    }
    const pushOf = payload => ({ data: { text: () => JSON.stringify(payload) } });
    const sealed = async (from, to, body, id = ID) => ({ v: 2, from: from.pub, to: to.pub, id, part: 1, parts: 1,
        sealed: await Seal.seal(keys[from.name], from.pub, to.pub, { id, part: 1, parts: 1 }, { ts: 1, body }) });

    it('rings: opens the push with the kept key, names the caller, keeps it, and tells open pages', async () => {
        const { did, fire, here } = worker({ keys: kept(bob), contacts: { [bob.pub]: [{ pub: alice.pub, name: 'alice' }] } });
        did.windows.push({ url: here + 'index.html', postMessage: data => did.posted.push(data) });
        await fire('push', pushOf(await sealed(alice, bob, Model.signal('ring', ID, Date.now()))));

        assert.deepStrictEqual(did.notified.map(n => [n.body, n.tag, n.requireInteraction, n.data.call]),
            [['alice is calling', 'inperson-' + ID, true, ID]]);
        assert.strictEqual(did.inbox()[0].envelope.from, alice.pub);
        assert.deepStrictEqual(plain(did.posted), [{ type: 'inperson:push' }]);
    });

    it('turns a cancelled ring into a missed call, and still notifies for what it cannot open', async () => {
        const { did, fire } = worker({ keys: kept(bob) });
        await fire('push', pushOf(await sealed(alice, bob, Model.signal('cancel', ID, 1), ID + '-x')));
        assert.deepStrictEqual(did.notified.map(n => [n.body, n.tag]), [[`Missed call from Somebody (${alice.pub.slice(0, 5)})`, 'inperson-' + ID]],
            'a caller the page never listed is somebody');

        const keyless = worker({});
        await keyless.fire('push', pushOf(await sealed(alice, bob, Model.signal('ring', ID, 1))));
        assert.match(keyless.did.notified[0].body, /A call came in/);
        assert.strictEqual(keyless.did.inbox().length, 1, 'kept sealed for the page');
    });

    it('opens the call the notification is about', async () => {
        const { did, fire, here } = worker();
        await fire('notificationclick', { notification: { close() {}, data: { call: ID } } });
        assert.deepStrictEqual(did.opened, [here + 'index.html#call=' + ID]);
    });

    it('caches every file the pages load, under the app\'s version', async () => {
        const { did, fire } = worker();
        await fire('install');
        const version = did.global('INPERSON_VERSION');
        assert.strictEqual(did.global('CACHE_NAME'), 'inperson-v' + version);
        const cached = did.precached.map(r => r.url);
        for (const page of ['index.html', 'welcome.html']) {
            const html = read(page);
            for (const [, src] of html.matchAll(/(?:src|href)="(\.{1,2}\/[^"?]+)(\?v=(\d+))?"/g)) {
                assert.ok(cached.includes(src), `${page}: ${src} is not cached`);
            }
            for (const [, , v] of html.matchAll(/(src|href)="[^"]+\?v=(\d+)"/g)) {
                assert.strictEqual(Number(v), version, `${page} asks for ?v=${v}, not ${version}`);
            }
        }
        for (const file of fs.readdirSync(PWA_DIR).filter(f => f.endsWith('.js') && f !== 'sw.js')) {
            assert.ok(cached.includes('./' + file), `${file} is not cached`);
        }
        for (const url of cached) {
            assert.ok(fs.existsSync(path.join(PWA_DIR, url)), `sw.js caches a file that does not exist: ${url}`);
        }
    });
});
