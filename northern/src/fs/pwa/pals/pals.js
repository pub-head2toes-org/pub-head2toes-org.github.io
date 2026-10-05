/* Pals PWA - the wiring: storage, the page, the clicks, sending and receiving. */
'use strict';

(function () {

    // Pals is for whoever is signed in to Northern. Anybody else - and anybody
    // whose day-long session cookie has expired - signs in first, and Reg.html
    // sends them back here (UPDATE_4).
    if (!session.signedIn()) {
        window.location.replace(PalsModel.regUrl(
            window.location.pathname, window.location.search, window.location.hash));
        return;
    }

    const me = { pub: session.pub(), name: session.userName() || PalsModel.UNKNOWN };
    const $ = id => document.getElementById(id);

    // ---- state ---------------------------------------------------------

    // Read from IndexedDB once the page knows this device is set up (start).
    let state = PalsModel.empty();

    // The ID Card's key, as reg/keystore.js kept it when the card was loaded
    // on this device: not extractable, for key agreement only. Messages are
    // sealed and opened with it, here - never on the server (UPDATE_2).
    let ownKey = null;

    function needCard(missing) {
        $('need_card').hidden = !missing;
        $('need_card_link').href = PalsModel.regUrl(window.location.pathname, window.location.search, '');
    }

    // The cookie lasts a day, so it can expire with the page open. A notice
    // to sign in again was easy to miss, and writing on regardless ended in
    // "Not delivered" (UPDATE_4): so the page goes to Reg.html, and back here
    // after. This runs whenever the page comes back into view, and before a
    // message is written or sent again. False when the page is leaving.
    function checkSession() {
        if (session.signedIn()) {
            return true;
        }
        window.location.replace(PalsModel.regUrl(window.location.pathname, window.location.search, ''));
        return false;
    }

    // What is selected in each list, and what the log is showing.
    const ui = { pal: null, group: null, member: null, filter: { kind: 'all' } };

    function say(text) {
        $('status').textContent = text || '';
    }

    function save() {
        return PalsStore.put('state', me.pub, state).catch(function (e) {
            say('This could not be saved in the browser: ' + e.message);
        });
    }

    // ---- Northern ------------------------------------------------------

    /** A POST to the push API. Throws what the server said, with its status. */
    function post(url, body) {
        return fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (response) {
            return response.json().then(function (data) {
                if (response.status < 200 || response.status > 299) {
                    const error = new Error(data && data.message || 'the server answered ' + response.status);
                    error.status = response.status;
                    throw error;
                }
                return data;
            });
        });
    }

    let serverKey = null;

    /** The server's VAPID key, which send proofs are made against; asked for once. */
    function pushKey() {
        if (!serverKey) {
            serverKey = fetch('/push/api/config/pub', { credentials: 'same-origin' })
                .then(response => response.json())
                .then(function (config) {
                    if (!config || !config.publicKey) {
                        throw new Error('Northern has no push key to give: ' + (config && config.message || 'no answer'));
                    }
                    return config.publicKey;
                });
            serverKey.catch(() => { serverKey = null; });
        }
        return serverKey;
    }

    /**
     * Pushes one sealed part, with a proof made with the kept key that this is
     * the user sending - so it goes whether the session cookie is live or not.
     */
    function send(request) {
        return pushKey()
            .then(server => PalsSeal.prove(ownKey, me.pub, server, request, Date.now()))
            .then(proof => post('/push/api/send', Object.assign({}, request, proof)));
    }

    const PAGE = 100;

    /** Everybody listed under /pals/ whose path matches `pattern`, newest row per key. */
    function directory(pattern) {
        const rows = [];
        const page = function (offset) {
            const url = PalsModel.DIRECTORY + '?searchPlus=' + encodeURIComponent(pattern) + (offset ? '&offset=' + offset : '');
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
        return page(0).then(PalsModel.directory);
    }

    /** One pal's device, as they last filed it - or null when they never set Pals up. */
    function lookUp(pub) {
        return directory('%/' + PalsModel.urlKey(pub)).then(found => found.find(e => e.pub === pub) || null);
    }

    // ---- the page ------------------------------------------------------

    function render() {
        $('pals').innerHTML = PalsViews.pals(state, ui.pal);
        $('groups').innerHTML = PalsViews.groups(state, ui.group);
        $('members').innerHTML = PalsViews.members(state, ui.group, ui.member);
        $('incoming').innerHTML = PalsViews.incoming(state, me);

        const log = $('log');
        log.innerHTML = PalsViews.log(PalsModel.log(state, ui.filter), state, me);
        log.scrollTop = log.scrollHeight;

        $('log_context').textContent = PalsViews.context(state, ui.filter, me);
        $('log_all').hidden = ui.filter.kind === 'all';
        $('pal_remove').disabled = !ui.pal;
        $('pal_verify').disabled = !ui.pal;
        $('group_remove').disabled = !ui.group;
        $('member_add').disabled = !ui.group;
        $('member_remove').disabled = !ui.member;
    }

    function show(filter) {
        ui.filter = filter;
        render();
    }

    function showAll() {
        ui.pal = null;
        ui.group = null;
        ui.member = null;
        show({ kind: 'all' });
    }

    function selectPal(pub) {
        ui.pal = PalsModel.pal(state, pub) ? pub : null;
        ui.group = null;
        ui.member = null;
        show({ kind: 'pal', pub: pub });
    }

    function selectGroup(name) {
        const group = PalsModel.group(state, name);
        ui.pal = null;
        ui.group = group ? group.name : null;
        ui.member = null;
        show({ kind: 'group', id: ui.group });
    }

    function selectMember(pub) {
        ui.member = pub;
        show({ kind: 'member', id: ui.group, pub: pub });
    }

    // A click anywhere in a list lands on the row that holds it.
    function onRow(boxId, attribute, handler) {
        $(boxId).addEventListener('click', function (event) {
            const row = event.target.closest('[' + attribute + ']');
            if (row) {
                handler(row.getAttribute(attribute));
            }
        });
    }

    // ---- overlays ------------------------------------------------------

    /**
     * Opens one of the forms. `action` does the work and throws what is wrong
     * with the input; the overlay stays open, saying so, until it goes through.
     */
    function ask(name, action) {
        const dialog = $('dlg_' + name);
        const error = $(name + '_error');
        error.textContent = '';
        dialog.querySelector('form').onsubmit = function (event) {
            event.preventDefault();
            let then;
            try {
                then = action();
            } catch (e) {
                error.textContent = e.message;
                return;
            }
            dialog.close();
            save();
            render();
            if (typeof then === 'function') {
                then();
            }
        };
        dialog.showModal();
    }

    document.querySelectorAll('dialog [data-close]').forEach(function (button) {
        button.addEventListener('click', () => button.closest('dialog').close());
    });

    function openMessage(id) {
        const m = PalsModel.message(state, id);
        if (!m) {
            return;
        }
        $('message_from').innerHTML = PalsViews.pill(PalsModel.nameOf(state, m.from, me), m.from);
        $('message_where').textContent = m.to.kind === 'group' ? 'in ' + m.to.name
            : m.out ? 'to ' + PalsModel.label(m.to.name, m.to.id) : '';
        $('message_time').textContent = PalsViews.time(m.ts);
        $('message_body').value = m.body;
        const failures = m.out ? PalsViews.failures(m, state, me) : '';
        $('message_status').textContent = failures ? 'Not delivered to ' + failures : '';
        $('message_retry').hidden = !failures;
        $('message_retry').onclick = function () {
            $('dlg_message').close();
            if (!checkSession()) {
                return;
            }
            Object.keys(m.delivery).forEach(function (pub) {
                if (m.delivery[pub] !== 'sent') {
                    m.delivery[pub] = 'sending';
                }
            });
            save();
            render();
            deliver(m);
        };
        answer(m);
        $('dlg_message').showModal();
    }

    /**
     * Reply to an incoming message, or send a correction of an outgoing one
     * (UPDATE_5). The first click opens a text area under the message - empty
     * for a reply, a copy of the message for a correction - and the button
     * turns into Send, or Correct, which sends the original, a separator line
     * and the new text as a new message.
     */
    function answer(m) {
        const kind = m.out ? 'correction' : 'reply';
        const button = $('message_answer');
        const body = $('message_answer_body');
        let writing = false;
        button.textContent = m.out ? 'Correction' : 'Reply';
        button.className = '';
        $('message_answer_box').hidden = true;
        $('message_body').rows = 12;
        button.onclick = function () {
            if (!checkSession()) {
                $('dlg_message').close();
                return;
            }
            if (!ownKey) {
                $('message_status').textContent = 'Load your ID Card on this device first - messages are sealed with its key.';
                return;
            }
            if (!writing) {
                try {
                    PalsModel.answerTo(state, m);
                } catch (e) {
                    $('message_status').textContent = e.message;
                    return;
                }
                writing = true;
                $('message_answer_label').textContent = m.out ? 'The message, corrected' : 'Your reply';
                body.value = m.out ? m.body : '';
                $('message_answer_box').hidden = false;
                $('message_body').rows = 6;
                $('message_retry').hidden = true;
                $('message_status').textContent = '';
                button.textContent = m.out ? 'Correct' : 'Send';
                button.className = 'primary';
                body.focus();
                return;
            }
            let message;
            try {
                message = PalsModel.answer(state, me, m, kind, body.value, Date.now(), wireId());
            } catch (e) {
                $('message_status').textContent = e.message;
                return;
            }
            $('dlg_message').close();
            save();
            render();
            say('Sending…');
            deliver(message);
        };
    }

    // ---- sending -------------------------------------------------------

    /** A random id for a message on the wire; it only has to be unlikely to repeat. */
    function wireId() {
        const bytes = new Uint8Array(12);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, b => ('0' + b.toString(16)).slice(-2)).join('');
    }

    /**
     * Sends a message to everybody it has not reached yet: each receiver's
     * device is looked up in /pals/ afresh, and each part is sealed here, to
     * the key stored with the pal, and pushed on its own, in order. A group
     * message is one of these per member. The directory only says where to
     * push; what is sealed to whom never comes from it.
     */
    function deliver(message) {
        const pubs = Object.keys(message.delivery).filter(pub => message.delivery[pub] === 'sending');
        return Promise.all(pubs.map(function (pub) {
            return lookUp(pub)
                .then(function (device) {
                    if (!ownKey) {
                        throw new Error('load your ID Card on this device first');
                    }
                    if (!device) {
                        throw new Error('they have not set Pals up');
                    }
                    return PalsModel.pushes(message, [pub]).reduce((sent, push) => sent.then(function () {
                        const wire = { id: push.id, part: push.part, parts: push.parts };
                        return PalsSeal.seal(ownKey, me.pub, push.to, wire, { ts: message.ts, body: push.message })
                            .then(sealed => send({
                                to: push.to,
                                subscription: device.subscription,
                                provider: device.provider,
                                sealed: sealed,
                                id: push.id,
                                part: push.part,
                                parts: push.parts
                            }));
                    }), Promise.resolve());
                })
                .then(() => PalsModel.delivered(state, message.id, pub, 'sent'),
                      err => PalsModel.delivered(state, message.id, pub, err.message || 'it could not be sent'));
        })).then(function () {
            save();
            render();
            const result = PalsModel.deliveryOf(message);
            say(result === 'sent' ? 'Sent.' : 'Not delivered to everybody - open the message to see why.');
        });
    }

    function addMessage() {
        if (!checkSession()) {
            return;
        }
        if (!ownKey) {
            say('Load your ID Card on this device first - messages are sealed with its key.');
            return;
        }
        if (!state.pals.length) {
            say('Add a pal first - there is nobody to write to yet.');
            return;
        }
        $('compose_to').innerHTML = PalsViews.targets(state, ui.filter);
        $('compose_body').value = '';
        ask('compose', function () {
            const target = PalsViews.target($('compose_to').value);
            const message = PalsModel.compose(state, me, target, $('compose_body').value, Date.now(), wireId());
            say('Sending…');
            return () => deliver(message);
        });
        $('compose_body').focus();
    }

    // ---- receiving -----------------------------------------------------

    // Names of senders who are not pals, as the directory has them.
    const names = {};

    function nameFor(pub) {
        if (PalsModel.nameOf(state, pub, me) !== '?') {
            return Promise.resolve('');
        }
        if (names[pub] === undefined) {
            names[pub] = lookUp(pub).then(found => found ? found.name : '', () => '');
        }
        return names[pub];
    }

    // A message that will not open stays a week, then goes.
    const KEEP = 7 * 24 * 3600 * 1000;

    /**
     * One thing from the inbox: opened here if the service worker could not,
     * then filed. 1 filed, 0 left or dropped, -1 waiting for the ID Card.
     */
    function take(item) {
        const value = item.value || {};
        const outer = value.payload;
        const drop = () => PalsStore.remove('inbox', item.key).then(() => 0);
        if (!outer || outer.v !== PalsSeal.VERSION) {
            // Sealed the Update 1 way, by the server: nothing here can open it.
            return drop();
        }
        if (outer.to !== me.pub) {
            // For somebody else signed in on this browser.
            return Promise.resolve(0);
        }
        if (!value.envelope && !ownKey) {
            return Promise.resolve(-1);
        }
        const opened = value.envelope ? Promise.resolve(value.envelope) : PalsSeal.open(ownKey, outer);
        return opened.then(function (envelope) {
            return nameFor(envelope.from).then(function (name) {
                PalsModel.receive(state, me, envelope, name);
                return save().then(() => PalsStore.remove('inbox', item.key)).then(() => 1);
            });
        }, function () {
            // It does not open with this key: forged, damaged, or not ours.
            return Date.now() - (value.at || 0) > KEEP ? drop() : 0;
        });
    }

    let draining = null;
    let again = false;

    /** Files whatever the service worker took in. Runs one at a time. */
    function drain() {
        if (draining) {
            again = true;
            return draining;
        }
        draining = PalsStore.all('inbox')
            .then(items => items.reduce((done, item) => done.then(counts => take(item).then(n => counts.concat(n))), Promise.resolve([])))
            .then(function (counts) {
                render();
                const waiting = counts.filter(n => n === -1).length;
                if (waiting) {
                    say(waiting + (waiting === 1 ? ' message is' : ' messages are') +
                        ' waiting. Load your ID Card on this device to read them.');
                }
            })
            .catch(e => say('The inbox could not be read: ' + e.message))
            .then(function () {
                draining = null;
                if (again) {
                    again = false;
                    return drain();
                }
            });
        return draining;
    }

    // ---- pals and groups -----------------------------------------------

    function addPal() {
        const pick = $('pal_pick');
        const error = $('pal_error');
        let found = [];
        pick.innerHTML = '';
        pick.disabled = true;
        ask('pal', function () {
            const entry = found.find(e => e.pub === pick.value);
            if (!entry) {
                throw new Error('pick a pal from the list');
            }
            const pal = PalsModel.addPal(state, entry.pub, entry.name, me);
            ui.pal = pal.pub;
            ui.group = null;
            ui.member = null;
            ui.filter = { kind: 'pal', pub: pal.pub };
        });
        error.textContent = 'Looking for pals…';
        directory('%').then(function (entries) {
            found = PalsModel.strangers(state, entries, me);
            pick.innerHTML = PalsViews.strangers(found);
            pick.disabled = !found.length;
            error.textContent = found.length ? '' : 'There is nobody new to add. A pal shows up here once they have opened Pals.';
            pick.focus();
        }).catch(function () {
            error.textContent = 'The list of pals could not be read - Northern is out of reach.';
        });
    }

    function removePal() {
        const pal = PalsModel.pal(state, ui.pal);
        if (!pal || !window.confirm('Remove ' + PalsModel.label(pal.name, pal.pub) + ' from your pals?')) {
            return;
        }
        PalsModel.removePal(state, pal.pub);
        save();
        showAll();
    }

    function addGroup() {
        $('group_name').value = '';
        ask('group', function () {
            const group = PalsModel.addGroup(state, $('group_name').value);
            ui.pal = null;
            ui.group = group.name;
            ui.member = null;
            ui.filter = { kind: 'group', id: group.name };
        });
        $('group_name').focus();
    }

    function removeGroup() {
        const group = PalsModel.group(state, ui.group);
        if (!group || !window.confirm('Remove the group ' + group.name + '?')) {
            return;
        }
        PalsModel.removeGroup(state, group.name);
        save();
        showAll();
    }

    function addMember() {
        const options = PalsViews.candidates(state, ui.group);
        if (!options) {
            say(state.pals.length ? 'Every pal is in this group already.' : 'Add a pal first.');
            return;
        }
        $('member_pal').innerHTML = options;
        ask('member', function () {
            PalsModel.addMember(state, ui.group, $('member_pal').value);
        });
    }

    function removeMember() {
        if (!ui.member) {
            return;
        }
        PalsModel.removeMember(state, ui.group, ui.member);
        save();
        selectGroup(ui.group);
    }

    /**
     * Compare keys with the selected pal: their fingerprint and the user's,
     * read to each other in person or on a call, then marked verified.
     */
    function verifyPal() {
        const pal = PalsModel.pal(state, ui.pal);
        if (!pal) {
            return;
        }
        $('verify_pal').innerHTML = PalsViews.pill(pal.name, pal.pub);
        $('verify_theirs').textContent = '…';
        $('verify_mine').textContent = '…';
        Promise.all([PalsSeal.fingerprint(pal.pub), PalsSeal.fingerprint(me.pub)]).then(function (prints) {
            $('verify_theirs').textContent = prints[0];
            $('verify_mine').textContent = prints[1];
        });
        $('verify_reset').onclick = function () {
            PalsModel.verify(state, pal.pub, false);
            $('dlg_verify').close();
            save();
            render();
        };
        ask('verify', function () {
            PalsModel.verify(state, pal.pub, true);
        });
    }

    // ---- start ---------------------------------------------------------

    $('user').innerHTML = PalsViews.pill(me.name, me.pub);
    $('version').textContent = 'v' + PALS_VERSION;
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            checkSession();
        }
    });

    onRow('pals', 'data-pub', selectPal);
    onRow('groups', 'data-group', selectGroup);
    onRow('members', 'data-pub', selectMember);
    onRow('incoming', 'data-pub', selectPal);
    onRow('log', 'data-message', openMessage);

    $('log_all').addEventListener('click', showAll);
    $('pal_add').addEventListener('click', addPal);
    $('pal_remove').addEventListener('click', removePal);
    $('pal_verify').addEventListener('click', verifyPal);
    $('message_add').addEventListener('click', addMessage);
    $('group_add').addEventListener('click', addGroup);
    $('group_remove').addEventListener('click', removeGroup);
    $('member_add').addEventListener('click', addMember);
    $('member_remove').addEventListener('click', removeMember);

    /** The device stopped getting pushes since it was set up: the browser dropped or replaced the subscription. */
    function checkSubscription(setup) {
        if (!('serviceWorker' in navigator)) {
            return;
        }
        navigator.serviceWorker.ready
            .then(registration => registration.pushManager.getSubscription())
            .then(function (subscription) {
                if (!subscription || subscription.endpoint !== setup.endpoint) {
                    say('This device no longer gets messages. Set it up again with the link at the top.');
                }
            })
            .catch(() => {});
    }

    // welcome.html sets the device up once; until it has, there is nothing
    // to receive with, so that is where the page goes.
    PalsStore.get('setup', me.pub).then(function (setup) {
        if (!setup) {
            window.location.replace('./welcome.html');
            return;
        }
        return Promise.all([
            PalsStore.get('state', me.pub),
            NorthernKeys.available() ? NorthernKeys.get(me.pub).catch(() => null) : null
        ]).then(function (found) {
            state = PalsModel.load(found[0]);
            ownKey = found[1];
            needCard(!ownKey);
            render();
            if ('serviceWorker' in navigator) {
                // updateViaCache 'none': the worker's own imports (version.js,
                // model.js...) are checked past the HTTP cache too, so a new
                // version is seen at once.
                navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
                    .catch(err => console.warn('Service Worker registration failed', err));
                // The service worker took something in: file it.
                navigator.serviceWorker.addEventListener('message', function (event) {
                    if (event.data && event.data.type === 'pals:push') {
                        drain();
                    }
                });
            }
            checkSubscription(setup);
            return drain();
        });
    }).catch(function (e) {
        render();
        say('This browser would not open its storage, so Pals cannot keep anything: ' + e.message);
    });
})();
