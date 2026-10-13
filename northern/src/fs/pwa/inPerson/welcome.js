/* InPerson PWA - the setup: subscribe this device to push, list it under
   /inperson/, and say how calls reach the other device (STUN, TURN). */
'use strict';

(function () {

    if (!session.signedIn()) {
        window.location.replace(InPersonModel.regUrl(
            window.location.pathname, window.location.search, window.location.hash));
        return;
    }

    const me = { pub: session.pub(), name: InPersonModel.cleanName(session.userName()) };
    const $ = id => document.getElementById(id);
    const go = $('go');

    function say(text) {
        $('status').textContent = text || '';
    }

    function report(text) {
        $('check_report').textContent = text || '';
    }

    // ---- STUN and TURN -------------------------------------------------

    const MODE_IDS = { stun: 'mode_stun', turn: 'mode_turn', northern: 'mode_northern' };

    function mode() {
        return Object.keys(MODE_IDS).find(m => $(MODE_IDS[m]).checked) || 'stun';
    }

    /** Shows the fields the chosen way needs. */
    function showFields() {
        const m = mode();
        $('turn_fields').hidden = m !== 'turn';
        $('relay_only_row').hidden = m === 'stun';
        if (m === 'stun') {
            $('relay_only').checked = false;
        }
    }

    function fill(config) {
        $(MODE_IDS[config.mode]).checked = true;
        $('stun').value = config.stun;
        $('turn_urls').value = config.turnUrls;
        $('turn_user').value = config.username;
        $('turn_password').value = config.credential;
        $('relay_only').checked = config.relayOnly;
        showFields();
    }

    /** What the form says, checked; throws what is wrong. */
    function read() {
        return InPersonModel.cleanConfig({
            mode: mode(),
            stun: $('stun').value,
            turnUrls: $('turn_urls').value,
            username: $('turn_user').value,
            credential: $('turn_password').value,
            relayOnly: $('relay_only').checked
        });
    }

    function save() {
        const config = read();
        return InPersonStore.put('config', me.pub, config).then(() => config);
    }

    /** The RTCConfiguration the form makes - asking Northern for TURN credentials when it says so. */
    function rtcConfig(config) {
        if (config.mode !== 'northern') {
            return Promise.resolve(InPersonModel.rtcConfig(config));
        }
        return fetch('/turn/api/ice', { credentials: 'same-origin' }).then(function (response) {
            return response.json().catch(() => null).then(function (data) {
                if (!response.ok || !data) {
                    throw new Error('Northern gave no TURN credentials: ' + (data && data.message || 'it answered ' + response.status));
                }
                return InPersonModel.rtcConfig(config, data);
            });
        });
    }

    /**
     * Gathers this device's ICE candidates with the configuration and says
     * what it found: a public address from STUN, an address on the TURN
     * server. No call is made; nothing leaves the browser but STUN and TURN.
     */
    function check() {
        let config;
        try {
            config = read();
        } catch (e) {
            report(e.message);
            return Promise.resolve();
        }
        if (typeof RTCPeerConnection === 'undefined') {
            report('This browser has no WebRTC: it cannot make calls.');
            return Promise.resolve();
        }
        $('check').disabled = true;
        report('Checking…');
        return rtcConfig(config).then(function (rtc) {
            const pc = new RTCPeerConnection(rtc);
            const found = [];
            return new Promise(function (resolve) {
                const done = setTimeout(resolve, 8000);
                pc.onicecandidate = function (event) {
                    if (event.candidate) {
                        found.push(event.candidate.candidate);
                    } else {
                        clearTimeout(done);
                        resolve();
                    }
                };
                pc.createDataChannel('check');
                pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(function (e) {
                    clearTimeout(done);
                    found.push('');
                    report('The browser would not try: ' + e.message);
                    resolve();
                });
            }).then(function () {
                pc.close();
                report(InPersonModel.checkReport(config, InPersonModel.candidateTypes(found)));
            });
        }).catch(e => report(e.message)).then(function () {
            $('check').disabled = false;
        });
    }

    Object.keys(MODE_IDS).forEach(m => $(MODE_IDS[m]).addEventListener('change', showFields));
    $('check').addEventListener('click', check);
    $('save').addEventListener('click', function () {
        let saved;
        try {
            saved = save();
        } catch (e) {
            report(e.message);
            return;
        }
        saved.then(() => report('Saved.'), e => report('This could not be saved in the browser: ' + e.message));
    });

    InPersonStore.get('config', me.pub).then(stored => fill(InPersonModel.loadConfig(stored)))
        .catch(() => fill(InPersonModel.defaultConfig()));
    InPersonStore.get('setup', me.pub).then(function (setup) {
        $('open_app').hidden = !setup;
    }).catch(() => {});

    // ---- push ----------------------------------------------------------

    /** base64url to the bytes pushManager.subscribe takes. */
    function bytes(text) {
        const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
        return Uint8Array.from(raw, c => c.charCodeAt(0));
    }

    function sameBytes(buffer, wanted) {
        const have = new Uint8Array(buffer || []);
        return have.length === wanted.length && have.every((b, i) => b === wanted[i]);
    }

    function write(method, path, record) {
        return fetch(path + '?isPublic=true', {
            method: method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        }).then(response => response.json());
    }

    /** Files the record at /inperson/<username>/<key>: in place when it is there, new when it is not (as Pals does). */
    function list(path, record) {
        return write('PUT', path, record).then(function (result) {
            return result && result.unavailable ? write('POST', path, record) : result;
        }).then(function (result) {
            if (!result || result.status !== 'OK') {
                throw new Error('Northern would not list this device under ' + path + '.');
            }
        });
    }

    // Contacts are listed by their Northern user name, so they need one.
    if (!me.name || me.name === InPersonModel.UNKNOWN) {
        go.disabled = true;
        say('InPerson lists you under your Northern user name, and you have none yet. ' +
            'Set one on the Northern sign-in page, then come back.');
        return;
    }

    // A call is set up sealed with the ID Card's key, which Reg.html keeps
    // on this device when the card is loaded here.
    const keyHere = typeof NorthernKeys !== 'undefined' && NorthernKeys.available()
        ? NorthernKeys.get(me.pub).catch(() => null) : Promise.resolve(null);

    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        go.disabled = true;
        say('This browser cannot be rung here. On an iPhone or iPad, ' +
            'add InPerson to the Home Screen first and open it from there.');
        return;
    }

    keyHere.then(function (key) {
        if (!key) {
            go.disabled = true;
            say('InPerson sets calls up sealed with your ID Card\'s key, so load the card on this device first: ' +
                'on the sign-in page, choose your ID Card, and you come straight back here.');
            const link = $('load_card');
            link.href = InPersonModel.regUrl(window.location.pathname, window.location.search, '');
            link.hidden = false;
        }
    });

    go.addEventListener('click', function () {
        let saving;
        try {
            saving = save();
        } catch (e) {
            report(e.message);
            return;
        }
        go.disabled = true;
        say('Setting up…');

        let registration;
        saving
            .then(() => keyHere)
            .then(function (key) {
                if (!key) {
                    throw new Error('Load your ID Card on this device first.');
                }
                return Notification.requestPermission();
            })
            .then(function (permission) {
                if (permission !== 'granted') {
                    throw new Error('InPerson can only ring this device if it may notify you. ' +
                        'Allow notifications for this site, then press Go again.');
                }
                return navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
            })
            .then(() => navigator.serviceWorker.ready)
            .then(function (ready) {
                registration = ready;
                return fetch('/push/api/config/pub', { credentials: 'same-origin' }).then(response => response.json());
            })
            .then(function (config) {
                if (!config || !config.publicKey) {
                    throw new Error('Northern has no push key to give: ' + (config && config.message || 'no answer'));
                }
                const key = bytes(config.publicKey);
                return registration.pushManager.getSubscription().then(function (existing) {
                    if (existing && !sameBytes(existing.options && existing.options.applicationServerKey, key)) {
                        return existing.unsubscribe().then(() => null);
                    }
                    return existing;
                }).then(existing => existing || registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
            })
            .then(function (made) {
                const record = InPersonModel.deviceRecord(me, made.toJSON(), Date.now());
                if (!record.provider) {
                    throw new Error('This browser\'s push service is not one Northern knows: ' + record.subscription.endpoint.split('/')[2] + '.');
                }
                const path = InPersonModel.devicePath(me.name, me.pub);
                return list(path, record).then(() => InPersonStore.put('setup', me.pub, {
                    path: path, endpoint: record.subscription.endpoint, provider: record.provider, ts: record.ts
                }));
            })
            .then(function () {
                window.location.replace('./index.html');
            })
            .catch(function (e) {
                say(e.message);
                go.disabled = false;
            });
    });
})();
