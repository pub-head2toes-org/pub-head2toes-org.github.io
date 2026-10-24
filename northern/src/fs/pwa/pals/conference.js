'use strict';

/**
 * A call of two, three or four (UPDATE_10): a mesh, one PalsCall (call.js)
 * to each of the others. No DOM and no network, as call.js: what it sends
 * goes through `send`, what arrives comes in through `receive`, and the page
 * shows whatever `on.person` says - so it is tested with a fake
 * RTCPeerConnection.
 *
 * Of any two, the smaller key offers. One who joins says `ready` to
 * everybody in the call. Whoever hears it offers when theirs is the smaller
 * key, and says `ready` back when it is not - so the one who joined offers.
 * Two who join at once come to the same. One side of each pair offers, as in
 * a call of two, and there is no glare.
 *
 *   in the call                             one who joins
 *                                           listens, `ready` to each
 *   smaller key:  offer  ----------------->  answer
 *   larger key:   `ready` back  ---------->  offer, as the smaller key
 *
 * Once two are connected, the rest goes over their data channel, as JSON:
 * who else is in the call (`with`: somebody added is introduced this way),
 * mic and camera off or on, and what size to send (`size`).
 *
 * `options`:
 *   me         this device's key
 *   call       the call's id
 *   role       'caller' when this device rang them, 'callee' when it answered
 *   people     everybody else in the call: [{pub, name, by}], where `by` is
 *              who introduced them, when they are not this device's pal
 *   known(pub) this device's own name for a pal, or '' for somebody else
 *   config, local, RTCPeerConnection, timers - as for PalsCall
 *   send(to, t, extra)  a signal to one of them; returns a promise
 *   on.person(person)   somebody changed: {pub, name, by, status, reason, stream, mic, camera}
 *   on.state()          how the call stands changed (`summary`)
 *   on.gaveUp(pubs)     rung from here and never answered: their ringing is to stop
 *   on.ended(reason)    once, when it is over, with why in words
 */
const PalsConference = (function () {

    const api = {};

    // Somebody is no longer in the call, and why.
    const GONE = ['declined', 'busy', 'no answer', 'left', 'away', 'failed'];
    api.isGone = status => GONE.indexOf(status) !== -1;
    const PUB = /^[A-Za-z0-9+/]{86}==$/;

    api.create = function (options) {
        const o = options;
        const timers = o.timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id) };
        const on = o.on || {};
        const known = o.known || (() => '');
        // Everybody else, in the order they came into the call - the order of the tiles.
        const order = [];
        const people = {};
        // The connection to each of them that is up or being set up.
        const pairs = {};
        let ended = '';
        let ending = false;
        let everConnected = false;
        let large = null;
        let counted = 0;
        const own = { mic: true, camera: true };

        const conf = {};

        const person = pub => people[pub] || null;
        const active = () => order.map(person).filter(p => !api.isGone(p.status));
        const count = () => 1 + active().length;

        function emit(p) {
            if (on.person) {
                on.person({ pub: p.pub, name: p.name, by: p.by, status: p.status, reason: p.reason,
                            stream: p.stream, mic: p.mic, camera: p.camera });
            }
            if (on.state) {
                on.state();
            }
        }

        function wait(p, ms, then) {
            timers.clearTimeout(p.timer);
            p.timer = ms ? timers.setTimeout(then, ms) : null;
        }

        function join(pub, name, by, status) {
            let p = person(pub);
            if (!p) {
                p = people[pub] = { pub: pub, name: name, by: by || '', status: status, reason: '', stream: null,
                                    mic: true, camera: true, size: 'grid', rung: false, timer: null };
                order.push(pub);
            } else {
                p.status = status;
                p.reason = '';
            }
            return p;
        }

        // Rung from here, they are being called; rung by somebody else, they are in the call already, or deciding.
        (o.people || []).forEach(function (w) {
            join(w.pub, w.name, w.by, o.role === 'caller' ? 'calling' : 'waiting').rung = o.role === 'caller';
        });
        counted = count();

        // ---- how much video each connection sends ----------------------

        function shortSide() {
            const track = o.local && o.local.getTracks().find(t => t.kind === 'video');
            const s = track && track.getSettings ? track.getSettings() : null;
            return s && s.width && s.height ? Math.min(s.width, s.height) : 720;
        }

        function sizeEach() {
            const n = count();
            counted = n;
            Object.keys(pairs).forEach(pub => pairs[pub].video(PalsCalls.videoFor(n, people[pub].size, shortSide())));
        }

        function say(pair, message) {
            pair.say(JSON.stringify(message));
        }

        // ---- somebody's status -----------------------------------------

        function setStatus(p, status, reason) {
            if (ended || (p.status === status && !reason)) {
                return;
            }
            p.status = status;
            p.reason = reason || '';
            if (api.isGone(status)) {
                wait(p, 0);
                p.stream = null;
                if (large === p.pub) {
                    conf.makeLarge(null);
                }
            }
            emit(p);
            if (count() !== counted) {
                sizeEach();
            }
            check();
        }

        /** Nobody else is left - or coming: it is over. */
        function check() {
            if (ended || ending || active().length) {
                return;
            }
            const all = order.map(person);
            if (all.length === 1) {
                end(all[0].reason || 'the call ended');
            } else {
                end(everConnected ? 'everybody left' : 'nobody answered');
            }
        }

        function end(reason) {
            if (ended) {
                return;
            }
            ended = reason;
            order.forEach(pub => wait(people[pub], 0));
            if (on.ended) {
                on.ended(reason);
            }
        }

        // ---- the connection to one of them -----------------------------

        function pairWith(p, role) {
            let connected = false;
            const pair = PalsCall.create({
                role: role,
                call: o.call,
                config: o.config,
                local: o.local,
                RTCPeerConnection: o.RTCPeerConnection,
                timers: o.timers,
                send: (t, extra) => o.send(p.pub, t, extra),
                on: {
                    state: function (s) {
                        if (pairs[p.pub] !== pair) {
                            return;
                        }
                        if (s === 'connected' && !connected) {
                            connected = true;
                            everConnected = true;
                            introduce(p, pair);
                        }
                        setStatus(p, s === 'calling' ? 'connecting' : s);
                    },
                    remote: function (stream) {
                        p.stream = stream;
                        emit(p);
                    },
                    message: text => heard(p, text),
                    ended: function (reason) {
                        if (pairs[p.pub] !== pair) {
                            return;
                        }
                        delete pairs[p.pub];
                        if (!ending) {
                            setStatus(p, reason === 'they hung up' ? 'left' : 'failed', reason);
                        }
                    }
                }
            });
            pairs[p.pub] = pair;
            wait(p, 0);
            pair.video(PalsCalls.videoFor(count(), p.size, shortSide()));
            return pair;
        }

        /** A pal just connected hears who else is in the call, and whether this device's mic or camera is off. */
        function introduce(p, pair) {
            active().filter(q => q !== p).forEach(q => say(pair, { t: 'with', pub: q.pub, name: q.name }));
            if (!own.mic) {
                say(pair, { t: 'mic', on: false });
            }
            if (!own.camera) {
                say(pair, { t: 'camera', on: false });
            }
            if (large) {
                say(pair, { t: 'size', size: large === p.pub ? 'large' : 'small' });
            }
        }

        /** What one of them said over the data channel. */
        function heard(p, text) {
            let m;
            try {
                m = JSON.parse(text);
            } catch (e) {
                return;
            }
            if (!m || typeof m !== 'object' || ended) {
                return;
            }
            if (m.t === 'with' && typeof m.pub === 'string' && PUB.test(m.pub) && m.pub !== o.me &&
                typeof m.name === 'string' && (!person(m.pub) || api.isGone(person(m.pub).status)) && count() < PalsCalls.MAX) {
                // Somebody they rang, or who was in the call before them: they will say `ready`.
                const name = known(m.pub);
                const q = join(m.pub, name || m.name.slice(0, 64), name ? '' : p.pub, 'waiting');
                wait(q, PalsCalls.ANSWER_MS, () => setStatus(q, 'away', 'they did not come'));
                emit(q);
                sizeEach();
            } else if ((m.t === 'mic' || m.t === 'camera') && typeof m.on === 'boolean') {
                p[m.t] = m.on;
                emit(p);
            } else if (m.t === 'size' && ['grid', 'large', 'small'].indexOf(m.size) !== -1) {
                p.size = m.size;
                if (pairs[p.pub]) {
                    pairs[p.pub].video(PalsCalls.videoFor(count(), p.size, shortSide()));
                }
            }
        }

        // ---- the call --------------------------------------------------

        /**
         * Starts it. This device rang them: each has ANSWER_MS to answer.
         * It answered: it says `ready` to each, and waits for them - the one
         * who rang must answer within OFFER_MS, the others may still be
         * deciding.
         */
        conf.start = function () {
            if (o.role === 'caller') {
                active().forEach(p => wait(p, PalsCalls.ANSWER_MS, () => unanswered([p])));
                return Promise.resolve();
            }
            // The one who rang comes first, and is in the call already.
            return Promise.all(active().map(function (p) {
                wait(p, p.pub === order[0] ? PalsCalls.OFFER_MS : PalsCalls.ANSWER_MS,
                    () => setStatus(p, 'away', 'the call is gone - they hung up'));
                return o.send(p.pub, 'ready');
            }));
        };

        function unanswered(list) {
            const still = list.filter(p => p.status === 'calling' || p.status === 'ringing');
            if (!still.length) {
                return;
            }
            if (on.gaveUp) {
                on.gaveUp(still.map(p => p.pub));
            }
            still.forEach(p => setStatus(p, 'no answer', 'no answer'));
        }

        /** The ring went out to them: they are ringing now, not just being called. */
        conf.rung = function (pub) {
            const p = person(pub);
            if (p && p.status === 'calling') {
                setStatus(p, 'ringing');
            }
        };

        /** One of them cannot be rung after all - not set up, or the push refused: out of the call, and why. */
        conf.drop = function (pub, reason) {
            const p = person(pub);
            if (p && !api.isGone(p.status) && !pairs[pub]) {
                setStatus(p, 'failed', reason);
            }
        };

        /** A signal from one of them, opened and checked by PalsCalls.readSignal already. */
        conf.receive = function (from, s) {
            const p = person(from);
            if (ended || ending || !p) {
                return Promise.resolve();
            }
            const pair = pairs[from];
            if (s.t === 'ready') {
                if (pair) {
                    return pair.receive(s);
                }
                setStatus(p, 'connecting');
                if (o.me < from) {
                    return pairWith(p, 'caller').receive(s);
                }
                // Theirs is the smaller key: they offer once they hear this.
                wait(p, PalsCalls.OFFER_MS, () => setStatus(p, 'away', 'the call is gone - they hung up'));
                return Promise.resolve(o.send(from, 'ready'));
            }
            if (s.t === 'offer') {
                if (pair && pair.peer()) {
                    return pair.receive(s);
                }
                setStatus(p, 'connecting');
                return pairWith(p, 'callee').receive(s);
            }
            if (s.t === 'decline') {
                if (p.status === 'calling' || p.status === 'ringing') {
                    setStatus(p, s.busy ? 'busy' : 'declined', s.busy ? 'they are on another call' : 'they declined');
                }
                return Promise.resolve();
            }
            if (s.t === 'bye' && !pair) {
                if (!api.isGone(p.status)) {
                    setStatus(p, 'left', 'they hung up');
                }
                return Promise.resolve();
            }
            return pair ? pair.receive(s) : Promise.resolve();
        };

        /**
         * Rings one more, from the call: they get ANSWER_MS, and everybody
         * already connected is told - so they take the newcomer's `ready`,
         * as introduced by this device when they are not their pal.
         */
        conf.add = function (pub, name) {
            if (ended || pub === o.me || count() >= PalsCalls.MAX || (person(pub) && !api.isGone(person(pub).status))) {
                return false;
            }
            const p = join(pub, name, '', 'calling');
            p.rung = true;
            wait(p, PalsCalls.ANSWER_MS, () => unanswered([p]));
            Object.keys(pairs).forEach(k => say(pairs[k], { t: 'with', pub: pub, name: name }));
            emit(p);
            sizeEach();
            return true;
        };

        /** Shows one of them large - or nobody, with null. Each is told what size to send. */
        conf.makeLarge = function (pub) {
            large = pub && person(pub) && !api.isGone(person(pub).status) ? pub : null;
            Object.keys(pairs).forEach(k => say(pairs[k], { t: 'size', size: !large ? 'grid' : k === large ? 'large' : 'small' }));
            if (on.state) {
                on.state();
            }
        };

        /** Mic or camera off - or on again: the tracks, and everybody told. */
        conf.mute = function (what, isOn) {
            own[what] = isOn;
            const kind = what === 'mic' ? 'audio' : 'video';
            if (o.local) {
                o.local.getTracks().filter(t => t.kind === kind).forEach(t => { t.enabled = isOn; });
            }
            Object.keys(pairs).forEach(k => say(pairs[k], { t: what, on: isOn }));
        };

        /** This device leaves: bye to each, and the ringing stopped for whoever it rang. */
        conf.hangUp = function () {
            if (ended) {
                return Promise.resolve();
            }
            ending = true;
            const ringing = active().filter(p => p.rung && (p.status === 'calling' || p.status === 'ringing'));
            const told = active().map(function (p) {
                const pair = pairs[p.pub];
                return pair ? pair.hangUp() : (p.status === 'connecting' || p.status === 'waiting') ? o.send(p.pub, 'bye') : null;
            });
            if (ringing.length && on.gaveUp) {
                on.gaveUp(ringing.map(p => p.pub));
            }
            end(everConnected || Object.keys(pairs).length || o.role === 'callee' ? 'hung up' : 'cancelled');
            return Promise.all(told);
        };

        conf.knows = pub => !!person(pub);
        conf.people = () => order.map(person).map(p => ({ pub: p.pub, name: p.name, by: p.by, status: p.status,
            reason: p.reason, stream: p.stream, mic: p.mic, camera: p.camera }));
        conf.count = count;
        conf.large = () => large;
        conf.own = () => ({ mic: own.mic, camera: own.camera });
        conf.ended = () => ended;
        /** The connections up now, for who is speaking: [{pub, pc}]. */
        conf.connections = () => Object.keys(pairs).map(pub => ({ pub: pub, pc: pairs[pub].peer() })).filter(c => c.pc);

        /**
         * How the call stands, for the line under the videos: the state of
         * those furthest on, and who they are - in a call with whoever is
         * connected; else reconnecting, connecting, ringing or calling.
         */
        conf.summary = function () {
            const now = active();
            for (const [state, statuses] of [['connected', ['connected']], ['reconnecting', ['reconnecting']],
                ['connecting', ['connecting', 'waiting']], ['ringing', ['ringing']], ['calling', ['calling']]]) {
                const these = now.filter(p => statuses.indexOf(p.status) !== -1);
                if (these.length) {
                    return { state: state, names: these.map(p => p.name) };
                }
            }
            return { state: '', names: [] };
        };

        return conf;
    };

    return api;
})();
