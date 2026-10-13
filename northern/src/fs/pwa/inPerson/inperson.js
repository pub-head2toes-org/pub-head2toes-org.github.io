/* InPerson PWA - the wiring: contacts, ringing, the call and its two videos. */
'use strict';

(function () {

    // InPerson is for whoever is signed in to Northern; anybody else signs in
    // first, and Reg.html sends them back here - as Pals does.
    if (!session.signedIn()) {
        window.location.replace(InPersonModel.regUrl(
            window.location.pathname, window.location.search, window.location.hash));
        return;
    }

    const me = { pub: session.pub(), name: session.userName() || InPersonModel.UNKNOWN };
    const $ = id => document.getElementById(id);

    // ---- state ---------------------------------------------------------

    let contacts = [];
    let selected = null;
    // The ID Card's key, as reg/keystore.js kept it on this device: every
    // signal of a call is sealed and opened with it, here.
    let ownKey = null;
    let config = InPersonModel.defaultConfig();
    // The call there is, if any: {id, peer, name, role, device, controller, source, media}.
    let current = null;
    // Calls already rung, answered, declined or missed: never shown again.
    const handled = [];

    function say(text) {
        $('status').textContent = text || '';
    }

    function needCard(missing) {
        $('need_card').hidden = !missing;
        $('need_card_link').href = InPersonModel.regUrl(window.location.pathname, window.location.search, '');
    }

    /** The day-long cookie ran out: sign in again, and come back. Never in the middle of a call. */
    function checkSession() {
        if (session.signedIn() || current) {
            return true;
        }
        window.location.replace(InPersonModel.regUrl(window.location.pathname, window.location.search, ''));
        return false;
    }

    // ---- Northern ------------------------------------------------------

    function answered(response) {
        return response.json().catch(() => null).then(function (data) {
            if (response.status < 200 || response.status > 299) {
                throw new Error(data && data.message || 'the server answered ' + response.status);
            }
            if (!data) {
                throw new Error('the server gave no answer');
            }
            return data;
        });
    }

    const PAGE = 100;

    /** Everybody listed under `prefix` whose path matches `pattern`, newest row per key. */
    function directory(prefix, pattern) {
        const rows = [];
        const page = function (offset) {
            const url = prefix + '?searchPlus=' + encodeURIComponent(pattern) + (offset ? '&offset=' + offset : '');
            return fetch(url, { credentials: 'same-origin' })
                .then(response => response.json())
                .then(function (batch) {
                    if (!Array.isArray(batch)) {
                        return rows;
                    }
                    rows.push.apply(rows, batch);
                    return batch.length === PAGE && offset < 10 * PAGE ? page(offset + PAGE) : rows;
                });
        };
        return page(0).then(found => InPersonModel.directory(found, prefix));
    }

    /** Where to ring somebody, as they last filed it - looked up afresh for every call. */
    function lookUp(pub) {
        return directory(InPersonModel.DIRECTORY, '%/' + InPersonModel.urlKey(pub))
            .then(found => found.find(e => e.pub === pub) || null);
    }

    let serverKey = null;

    function pushKey() {
        if (!serverKey) {
            serverKey = fetch('/push/api/config/pub', { credentials: 'same-origin' })
                .then(response => response.json())
                .then(function (data) {
                    if (!data || !data.publicKey) {
                        throw new Error('Northern has no push key to give');
                    }
                    return data.publicKey;
                });
            serverKey.catch(() => { serverKey = null; });
        }
        return serverKey;
    }

    /**
     * Rings - or stops ringing - the device behind `device`: the signal is
     * sealed here to the other side's key, and pushed through Northern with
     * a send proof, as Pals sends a message.
     */
    function push(device, id, body) {
        const wire = { id: id, part: 1, parts: 1 };
        return PalsSeal.seal(ownKey, me.pub, device.pub, wire, { ts: Date.now(), body: body })
            .then(sealed => ({ to: device.pub, subscription: device.subscription, provider: device.provider, sealed: sealed, id: id, part: 1, parts: 1 }))
            .then(request => pushKey()
                .then(server => PalsSeal.prove(ownKey, me.pub, server, request, Date.now()))
                .then(proof => fetch('/push/api/send', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.assign({}, request, proof))
                })))
            .then(answered);
    }

    /** STUN and TURN for a call, with fresh TURN credentials from Northern when that is the way. */
    function rtcConfig() {
        if (config.mode !== 'northern') {
            return Promise.resolve(InPersonModel.rtcConfig(config));
        }
        return fetch('/turn/api/ice', { credentials: 'same-origin' }).then(answered)
            .then(data => InPersonModel.rtcConfig(config, data))
            .catch(function (e) {
                // A call may still get through without TURN.
                say('No TURN credentials from Northern (' + e.message + '); trying without.');
                return InPersonModel.rtcConfig(config);
            });
    }

    // ---- the call's channel: Northern's /sub/ ------------------------------
    //
    // Whoever knows a channel's name can listen to it, and anybody signed in
    // can write to it. So its name is the call's random id, which only the
    // two ends and Northern know, and every signal on it is sealed: Northern
    // relays them, and can neither read nor change them, nor forge one.

    /** Sends one signal on the call's channel, sealed to the other side; one at a time, in order. */
    function signal(call, t, extra) {
        call.sending = call.sending.then(function () {
            call.seq += 1;
            const wire = { id: call.id + '-' + call.seq, part: 1, parts: 1 };
            const body = InPersonModel.signal(t, call.id, Date.now(), extra);
            return PalsSeal.seal(ownKey, me.pub, call.peer, wire, { ts: Date.now(), body: body })
                .then(sealed => fetch(InPersonModel.channel(call.id), {
                    method: 'PUT',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(Object.assign({ v: PalsSeal.VERSION, from: me.pub, to: call.peer, sealed: sealed }, wire))
                }));
        }).catch(() => {});
        return call.sending;
    }

    /**
     * Listens on the call's channel. Resolves once Northern says it is
     * listening - a signal sent before then is not heard. Every message is
     * opened in turn, in the order it came; one not from the other side, not
     * for this call, seen before or that will not open is dropped.
     */
    function listen(call) {
        return new Promise(function (resolve, reject) {
            const source = new EventSource(InPersonModel.channel(call.id));
            const seen = {};
            let opened = false;
            let order = Promise.resolve();
            call.source = source;
            const late = setTimeout(() => reject(new Error('Northern\'s channel did not answer')), 10000);
            source.onmessage = function (event) {
                let outer;
                try {
                    outer = JSON.parse(event.data);
                } catch (e) {
                    return;
                }
                if (outer && outer.status === 'OK' && !opened) {
                    opened = true;
                    clearTimeout(late);
                    resolve();
                    return;
                }
                if (!outer || outer.from !== call.peer || outer.to !== me.pub || typeof outer.id !== 'string' || seen[outer.id]) {
                    return;
                }
                seen[outer.id] = true;
                order = order.then(() => PalsSeal.open(ownKey, outer))
                    .then(function (envelope) {
                        const s = InPersonModel.readSignal(envelope.body, call.id);
                        return s && call.controller ? call.controller.receive(s) : null;
                    })
                    .catch(() => {});
            };
        });
    }

    // ---- the page ------------------------------------------------------

    function render() {
        $('contacts').innerHTML = InPersonViews.contacts(contacts, selected);
        const contact = contacts.find(c => c.pub === selected);
        $('call').disabled = !!current || !contact || !contact.device || !ownKey;
        $('hang_up').hidden = !current;
    }

    function showState(text) {
        $('call_state').textContent = text || '';
    }

    function loadContacts() {
        return Promise.all([directory(InPersonModel.PALS_DIRECTORY, '%'), directory(InPersonModel.DIRECTORY, '%')])
            .then(function (found) {
                contacts = InPersonModel.contacts(found[0], found[1], me);
                render();
                // The service worker names a caller from this; it asks the server nothing.
                return InPersonStore.put('contacts', me.pub, contacts.map(c => ({ pub: c.pub, name: c.name }))).catch(() => {});
            })
            .catch(() => say('The contacts could not be read - Northern is out of reach.'));
    }

    function nameOf(pub) {
        return InPersonModel.nameOf(contacts, pub) || InPersonModel.label('Somebody', pub);
    }

    // ---- the camera and the videos ------------------------------------------

    function camera() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return Promise.reject(new Error('this browser cannot use the camera here'));
        }
        return navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } })
            .catch(function (e) {
                throw new Error('the camera and microphone are not allowed (' + (e.name || e.message) + ')');
            });
    }

    function play(video, stream) {
        video.srcObject = stream;
        if (stream && video.play) {
            const playing = video.play();
            if (playing && playing.catch) {
                playing.catch(() => {});
            }
        }
    }

    // ---- a call -----------------------------------------------------------

    /** What a call is, before WebRTC is in it. */
    function newCall(id, peer, role, device) {
        return { id: id, peer: peer, name: nameOf(peer), role: role, device: device,
                 seq: 0, sending: Promise.resolve(), source: null, controller: null, media: null };
    }

    /** A new call's id: 16 random bytes, base64url - the name of its channel. */
    function callId() {
        const raw = crypto.getRandomValues(new Uint8Array(16));
        return btoa(String.fromCharCode.apply(null, raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    /** WebRTC takes over: the controller, its state on the call bar, the other side's video. */
    function connect(call, rtc) {
        call.controller = InPersonCall.create({
            role: call.role,
            call: call.id,
            config: rtc,
            local: call.media,
            RTCPeerConnection: RTCPeerConnection,
            send: (t, extra) => signal(call, t, extra),
            on: {
                state: state => showState(InPersonViews.callState(state, call.name)),
                remote: stream => play($('contact_video'), stream),
                ended: reason => ended(call, reason)
            }
        });
        showState(InPersonViews.callState(call.role === 'caller' ? 'calling' : 'connecting', call.name));
        return call.controller.start();
    }

    /** It is over: the camera off, the channel closed, the bar says why. A caller who gave up stops the ringing. */
    function ended(call, reason) {
        if (call.media) {
            call.media.getTracks().forEach(t => t.stop());
        }
        if (call.source) {
            call.source.close();
        }
        if (current === call) {
            current = null;
        }
        play($('self_video'), null);
        play($('contact_video'), null);
        $('contact_name').textContent = '';
        showState('Call with ' + call.name + ': ' + reason + '.');
        render();
        if (call.role === 'caller' && (reason === 'cancelled' || reason === 'no answer') && call.device) {
            push(call.device, call.id + '-x', InPersonModel.signal('cancel', call.id, Date.now())).catch(() => {});
        }
    }

    /**
     * Setting up went wrong: undo what was done. Whatever WebRTC started is
     * hung up first, without stopping a ringing that never started.
     */
    function abandon(call, why) {
        const controller = call.controller;
        call.controller = null;
        call.device = null;
        if (controller) {
            controller.hangUp();
        }
        ended(call, why);
    }

    // The user hung up while the camera was still being asked for.
    const GONE = new Error('gone');

    /** The camera, once allowed, on the Self video - or off at once when the call is gone by then. */
    function cameraFor(call) {
        return camera().then(function (media) {
            call.media = media;
            if (current !== call) {
                media.getTracks().forEach(t => t.stop());
                throw GONE;
            }
            play($('self_video'), media);
            return media;
        });
    }

    /**
     * Call: the camera on, the call's channel open, then the other side is
     * rung by push. WebRTC starts when they answer (call.js).
     */
    function startCall() {
        if (!checkSession() || current) {
            return Promise.resolve();
        }
        const contact = contacts.find(c => c.pub === selected);
        if (!ownKey) {
            say('Load your ID Card on this device first - calls are set up sealed with its key.');
            return Promise.resolve();
        }
        if (!contact || !contact.device) {
            say(contact ? contact.name + ' has not set InPerson up yet.' : 'Pick somebody to call.');
            return Promise.resolve();
        }
        say('');
        const call = current = newCall(callId(), contact.pub, 'caller', null);
        $('contact_name').textContent = call.name;
        showState('Getting the camera ready…');
        render();
        return cameraFor(call)
            .then(() => Promise.all([lookUp(contact.pub), listen(call), rtcConfig()]))
            .then(function (found) {
                if (current !== call) {
                    throw GONE;
                }
                if (!found[0]) {
                    throw new Error('they are no longer set up for calls');
                }
                return connect(call, found[2])
                    .then(() => push(found[0], call.id, InPersonModel.signal('ring', call.id, Date.now())))
                    // Rung: from here on, giving up stops the ringing.
                    .then(function () {
                        call.device = found[0];
                        // Hung up while the ring was on its way: stop it.
                        if (current !== call) {
                            push(call.device, call.id + '-x', InPersonModel.signal('cancel', call.id, Date.now())).catch(() => {});
                        }
                    });
            })
            .catch(function (e) {
                if (e !== GONE) {
                    abandon(call, 'could not ring them: ' + e.message);
                }
            });
    }

    function hangUp() {
        const call = current;
        if (!call) {
            return;
        }
        if (call.controller) {
            call.controller.hangUp();
        } else {
            abandon(call, 'cancelled');
        }
    }

    // ---- ringing ------------------------------------------------------------

    let ringing = null;
    let ringTimer = null;

    function closeIncoming() {
        clearTimeout(ringTimer);
        ringing = null;
        if ($('dlg_incoming').open) {
            $('dlg_incoming').close();
        }
    }

    function ring(r) {
        if (ringing && ringing.call === r.call) {
            return;
        }
        ringing = r;
        $('incoming_from').innerHTML = InPersonViews.pill(nameOf(r.from), r.from);
        if (!$('dlg_incoming').open) {
            $('dlg_incoming').showModal();
        }
        clearTimeout(ringTimer);
        ringTimer = setTimeout(function () {
            handled.push(r.call);
            closeIncoming();
            say('Missed call from ' + nameOf(r.from) + ' at ' + InPersonModel.clock(r.ts) + '.');
        }, Math.max(0, InPersonModel.RING_MS - (Date.now() - r.ts)));
    }

    function answer() {
        const r = ringing;
        if (!r) {
            return Promise.resolve();
        }
        handled.push(r.call);
        closeIncoming();
        const call = current = newCall(r.call, r.from, 'callee', null);
        $('contact_name').textContent = call.name;
        showState('Getting the camera ready…');
        render();
        return cameraFor(call)
            .then(() => Promise.all([listen(call), rtcConfig()]))
            .then(function (found) {
                if (current !== call) {
                    throw GONE;
                }
                return connect(call, found[1]);
            })
            .catch(function (e) {
                if (e !== GONE) {
                    signal(call, 'decline');
                    abandon(call, 'could not answer: ' + e.message);
                }
            });
    }

    function decline() {
        const r = ringing;
        if (!r) {
            return Promise.resolve();
        }
        handled.push(r.call);
        closeIncoming();
        return signal(newCall(r.call, r.from, 'callee', null), 'decline');
    }

    // ---- what the service worker took in ------------------------------------

    // One that will not open stays a day, then goes.
    const KEEP = 24 * 3600 * 1000;

    /** One item from the inbox: `{from, signal}`, or null - taken out unless it waits for the ID Card or another identity. */
    function take(item) {
        const value = item.value || {};
        const outer = value.payload;
        const drop = () => InPersonStore.remove('inbox', item.key).then(() => null);
        if (!outer || outer.v !== PalsSeal.VERSION) {
            return drop();
        }
        if (outer.to !== me.pub || (!value.envelope && !ownKey)) {
            return Promise.resolve(null);
        }
        const opened = value.envelope ? Promise.resolve(value.envelope) : PalsSeal.open(ownKey, outer);
        return opened.then(function (envelope) {
            const s = InPersonModel.readSignal(envelope.body);
            return drop().then(() => s ? { from: envelope.from, signal: s } : null);
        }, () => Date.now() - (value.at || 0) > KEEP ? drop() : null);
    }

    let draining = null;
    let again = false;

    /** Rings for a call that is still ringing, and tells of the ones missed. */
    function drain() {
        if (draining) {
            again = true;
            return draining;
        }
        draining = InPersonStore.all('inbox')
            .then(items => items.reduce((done, item) => done.then(list => take(item).then(s => s ? list.concat([s]) : list)), Promise.resolve([])))
            .then(function (signals) {
                const now = Date.now();
                const found = InPersonModel.incoming(signals, now, handled);
                found.missed.forEach(m => handled.push(m.call));
                if (ringing && signals.some(s => s.signal.t === 'cancel' && s.signal.call === ringing.call)) {
                    found.missed.push(ringing);
                    handled.push(ringing.call);
                    closeIncoming();
                }
                if (found.missed.length) {
                    const last = found.missed[found.missed.length - 1];
                    say('Missed call from ' + nameOf(last.from) + ' at ' + InPersonModel.clock(last.ts) + '.');
                }
                if (found.ringing) {
                    if (current) {
                        // On a call already: the other caller hears so.
                        handled.push(found.ringing.call);
                        signal(newCall(found.ringing.call, found.ringing.from, 'callee', null), 'decline', { busy: true });
                        say('Missed call from ' + nameOf(found.ringing.from) + ' - you were on a call.');
                    } else {
                        ring(found.ringing);
                    }
                }
            })
            .catch(e => say('What came in could not be read: ' + e.message))
            .then(function () {
                draining = null;
                if (again) {
                    again = false;
                    return drain();
                }
            });
        return draining;
    }

    // ---- start ---------------------------------------------------------

    $('user').innerHTML = InPersonViews.pill(me.name, me.pub);
    $('version').textContent = 'v' + INPERSON_VERSION;
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            checkSession();
            drain();
        }
    });

    $('contacts').addEventListener('click', function (event) {
        const row = event.target.closest('[data-pub]');
        if (row) {
            selected = row.getAttribute('data-pub');
            render();
        }
    });
    $('call').addEventListener('click', startCall);
    $('refresh').addEventListener('click', loadContacts);
    $('hang_up').addEventListener('click', hangUp);
    $('answer').addEventListener('click', answer);
    $('decline').addEventListener('click', decline);
    $('settings_open').addEventListener('click', () => $('dlg_settings').showModal());

    function checkSubscription(setup) {
        if (!('serviceWorker' in navigator)) {
            return;
        }
        navigator.serviceWorker.ready
            .then(registration => registration.pushManager.getSubscription())
            .then(function (subscription) {
                if (!subscription || subscription.endpoint !== setup.endpoint) {
                    say('This device can no longer be rung. Set it up again under Settings (the gear).');
                }
            })
            .catch(() => {});
    }

    const MODE_WORDS = { stun: 'a STUN server', turn: 'your TURN server', northern: 'TURN from Northern' };

    // welcome.html sets the device up once; until it has, nobody can ring it.
    InPersonStore.get('setup', me.pub).then(function (setup) {
        if (!setup) {
            window.location.replace('./welcome.html');
            return;
        }
        return Promise.all([
            InPersonStore.get('config', me.pub),
            NorthernKeys.available() ? NorthernKeys.get(me.pub).catch(() => null) : null
        ]).then(function (found) {
            config = InPersonModel.loadConfig(found[0]);
            ownKey = found[1];
            $('ice_mode').textContent = MODE_WORDS[config.mode] + (config.relayOnly ? ', only through TURN' : '');
            needCard(!ownKey);
            render();
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
                    .catch(err => console.warn('Service Worker registration failed', err));
                navigator.serviceWorker.addEventListener('message', function (event) {
                    if (event.data && event.data.type === 'inperson:push') {
                        drain();
                    }
                });
            }
            checkSubscription(setup);
            return loadContacts().then(drain);
        });
    }).catch(function (e) {
        render();
        say('This browser would not open its storage, so InPerson cannot work here: ' + e.message);
    });
})();
