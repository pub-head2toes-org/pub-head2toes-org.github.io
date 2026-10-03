/* Pals PWA - the one-time setup: subscribe this device to push, and list it under /pals/. */
'use strict';

(function () {

    if (!session.signedIn()) {
        window.location.replace(PalsModel.regUrl(
            window.location.pathname, window.location.search, window.location.hash));
        return;
    }

    const me = { pub: session.pub(), name: PalsModel.cleanName(session.userName()) };
    const $ = id => document.getElementById(id);
    const go = $('go');

    function say(text) {
        $('status').textContent = text || '';
    }

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

    /** A Northern write that has to go through: the row as the server answered it. */
    function write(method, path, record) {
        return fetch(path + '?isPublic=true', {
            method: method,
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(record)
        }).then(response => response.json());
    }

    /**
     * Files the record at /pals/<username>/<key>: in place when it is there
     * already - a PUT keeps the old one as history - or new when it is not.
     */
    function list(path, record) {
        return write('PUT', path, record).then(function (result) {
            return result && result.unavailable ? write('POST', path, record) : result;
        }).then(function (result) {
            if (!result || result.status !== 'OK') {
                throw new Error('Northern would not list this device under ' + path + '.');
            }
        });
    }

    // Pals lists people by their Northern user name, so they need one.
    if (!me.name || me.name === PalsModel.UNKNOWN) {
        go.disabled = true;
        say('Pals lists you under your Northern user name, and you have none yet. ' +
            'Set one on the Northern sign-in page, then come back.');
        return;
    }

    // Messages are sealed and opened on this device with the ID Card's key,
    // which Reg.html keeps here when the card is loaded (UPDATE_2).
    const keyHere = typeof NorthernKeys !== 'undefined' && NorthernKeys.available()
        ? NorthernKeys.get(me.pub).catch(() => null) : Promise.resolve(null);

    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        go.disabled = true;
        say('This browser cannot get push notifications here. On an iPhone or iPad, ' +
            'add Pals to the Home Screen first and open it from there.');
        return;
    }

    keyHere.then(function (key) {
        if (!key) {
            go.disabled = true;
            say('Pals seals messages with your ID Card\'s key, so load the card on this device first: ' +
                'on the sign-in page, choose your ID Card, and you come straight back here.');
            const link = $('load_card');
            link.href = PalsModel.regUrl(window.location.pathname, window.location.search, '');
            link.hidden = false;
        }
    });

    go.addEventListener('click', function () {
        go.disabled = true;
        say('Setting up…');

        let registration;
        let subscription;
        keyHere
            .then(function (key) {
                if (!key) {
                    throw new Error('Load your ID Card on this device first.');
                }
                return Notification.requestPermission();
            })
            .then(function (permission) {
                if (permission !== 'granted') {
                    throw new Error('Pals can only tell you about a message if it may notify you. ' +
                        'Allow notifications for this site, then press Go again.');
                }
                return navigator.serviceWorker.register('./sw.js');
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
                    // A subscription made with another server key cannot be
                    // pushed to by this one; it has to go first.
                    if (existing && !sameBytes(existing.options && existing.options.applicationServerKey, key)) {
                        return existing.unsubscribe().then(() => null);
                    }
                    return existing;
                }).then(existing => existing || registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
            })
            .then(function (made) {
                subscription = made.toJSON();
                const record = PalsModel.palRecord(me, subscription, Date.now());
                if (!record.provider) {
                    throw new Error('This browser\'s push service is not one Pals knows: ' + subscription.endpoint.split('/')[2] + '.');
                }
                const path = PalsModel.palPath(me.name, me.pub);
                return list(path, record).then(() => PalsStore.put('setup', me.pub, {
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
