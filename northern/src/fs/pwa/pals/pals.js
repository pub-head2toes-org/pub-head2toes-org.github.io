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

    // A video call (calls.js, call.js): the one there is, if any -
    // {id, peer, name, role, device, controller, source, media} - and the
    // calls already rung, answered, declined or missed, never shown again.
    let current = null;
    const handled = [];
    // Whether this device makes and takes calls: switched on in Settings.
    let callsOn = false;

    function needCard(missing) {
        $('need_card').hidden = !missing;
        $('need_card_link').href = PalsModel.regUrl(window.location.pathname, window.location.search, '');
    }

    // The cookie lasts a day, so it can expire with the page open. A notice
    // to sign in again was easy to miss, and writing on regardless ended in
    // "Not delivered" (UPDATE_4): so the page goes to Reg.html, and back here
    // after. This runs whenever the page comes back into view, and before a
    // message is written or sent again - never in the middle of a call, which
    // needs Northern no more once it is set up. False when the page is leaving.
    function checkSession() {
        if (session.signedIn() || current) {
            return true;
        }
        window.location.replace(PalsModel.regUrl(window.location.pathname, window.location.search, ''));
        return false;
    }

    // What is selected in each list, and what the Messages layer is showing.
    const ui = { pal: null, group: null, member: null, filter: { kind: 'all' } };

    // On the page, and in the Messages layer, which covers it while it is open.
    function say(text) {
        $('status').textContent = text || '';
        $('messages_status').textContent = text || '';
    }

    function save() {
        return PalsStore.put('state', me.pub, state).catch(function (e) {
            say('This could not be saved in the browser: ' + e.message);
        });
    }

    // ---- Northern ------------------------------------------------------

    /** What an API answered, as JSON. Throws what the server said, with its status. */
    function answered(response) {
        return response.json().catch(() => null).then(function (data) {
            if (response.status < 200 || response.status > 299) {
                const error = new Error(data && data.message || 'the server answered ' + response.status);
                error.status = response.status;
                throw error;
            }
            if (!data) {
                throw new Error('the server gave no answer');
            }
            return data;
        });
    }

    /** A POST to the push API. */
    function post(url, body) {
        return fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(answered);
    }

    /**
     * Hands a locked file to Northern's temp API, which keeps it until it is
     * fetched, and answers the random id it is kept under.
     */
    function upload(locked) {
        return fetch('/temp/api/upload', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: locked
        }).then(answered).then(function (data) {
            if (!/^[A-Za-z0-9_-]{43}$/.test(data.id || '')) {
                throw new Error('Northern did not say where it keeps the file');
            }
            return data.id;
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
        $('pals').innerHTML = PalsViews.pals(state, ui.pal, me);
        $('groups').innerHTML = PalsViews.groups(state, ui.group);
        $('members').innerHTML = PalsViews.members(state, ui.group, ui.member);
        $('members_context').textContent = ui.group || '';

        const messages = $('messages');
        messages.innerHTML = PalsViews.log(PalsModel.log(state, ui.filter), state, me);
        messages.scrollTop = messages.scrollHeight;

        $('messages_context').textContent = PalsViews.context(state, ui.filter, me);
        $('pal_remove').disabled = !ui.pal;
        $('pal_verify').disabled = !PalsModel.pal(state, ui.pal);
        $('group_remove').disabled = !ui.group;
        $('member_add').disabled = !ui.group;
        $('member_remove').disabled = !ui.member;

        // A call is made from a pal's messages, to the key pinned for them.
        $('call_start').hidden = !callsOn || !(ui.filter.kind === 'pal' && PalsModel.pal(state, ui.filter.pub));
        $('call_start').disabled = !!current || !ownKey;
        if (callPeer) {
            $('call_with').innerHTML = callWith(callPeer);
        }
    }

    /**
     * Opens a layer above the page (UPDATE_6): a pal's or a group's messages,
     * a group's members, or the settings. It stays open as the page renders
     * under it; showModal on an open dialog would throw.
     */
    function layer(name) {
        const dialog = $('dlg_' + name);
        if (!dialog.open) {
            dialog.showModal();
        }
        if (name === 'messages') {
            toEnd();
            draft();
        }
    }

    /**
     * The messages layer opens on the newest message. iOS Safari drops a
     * scroll set in the frame the dialog opens in - the list cannot scroll
     * until it has been painted - so it is set again once it has.
     */
    function toEnd() {
        const messages = $('messages');
        const end = function () {
            messages.scrollTop = messages.scrollHeight;
        };
        end();
        requestAnimationFrame(() => requestAnimationFrame(end));
        setTimeout(end, 300);
    }

    // Whom the text in the New message panel was written to.
    let draftFor = '';

    /**
     * The New message panel under the messages (UPDATE_7) keeps what was
     * written while the layer shows the same pal or group, and starts empty
     * for another - so nothing meant for one goes to the next.
     */
    function draft() {
        const now = JSON.stringify(ui.filter);
        if (now !== draftFor) {
            draftFor = now;
            $('compose_body').value = '';
            $('compose_file').value = '';
        }
        $('compose_error').textContent = '';
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

    /** A pal - or somebody who wrote - opens what was said with them, and the dot by their name goes. */
    function selectPal(pub) {
        ui.pal = PalsModel.pal(state, pub) || PalsModel.others(state).indexOf(pub) !== -1 ? pub : null;
        ui.group = null;
        ui.member = null;
        if (PalsModel.isUnread(state, pub)) {
            PalsModel.markUnread(state, pub, false);
            save();
        }
        show({ kind: 'pal', pub: pub });
        layer('messages');
    }

    /** A group opens its members. */
    function selectGroup(name) {
        const group = PalsModel.group(state, name);
        ui.pal = null;
        ui.group = group ? group.name : null;
        ui.member = null;
        show({ kind: 'group', id: ui.group });
        if (ui.group) {
            layer('members');
        }
    }

    /** A member is picked to be removed, or for only what they said in the group. */
    function selectMember(pub) {
        ui.member = pub;
        show({ kind: 'member', id: ui.group, pub: pub });
    }

    /** The group's messages - only the picked member's, when one is picked. */
    function groupMessages() {
        if (!ui.group) {
            return;
        }
        show(ui.member ? { kind: 'member', id: ui.group, pub: ui.member } : { kind: 'group', id: ui.group });
        layer('messages');
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
        shown = m.id;
        showAttachment(m);
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
        fit($('message_body'), 12);
    }

    /**
     * A text area only as tall as what it holds, up to `most` rows - so a
     * message of a line or two leaves no empty box under it (UPDATE_7). It
     * measures the layout, so it runs once the overlay is open; without one
     * the text area keeps `most` rows.
     */
    function fit(textarea, most) {
        textarea.style.height = '';
        textarea.rows = most;
        const tallest = textarea.offsetHeight;
        if (!tallest) {
            return;
        }
        // Measured one row high, with no scroll bar to narrow the lines.
        textarea.style.overflowY = 'hidden';
        textarea.rows = 1;
        const needed = textarea.scrollHeight + textarea.offsetHeight - textarea.clientHeight;
        textarea.rows = most;
        textarea.style.overflowY = '';
        textarea.style.height = Math.min(needed, tallest) + 'px';
    }

    // The message the overlay shows, and the object URL of its photo or video.
    let shown = null;
    let shownUrl = null;

    function forgetUrl() {
        if (shownUrl) {
            URL.revokeObjectURL(shownUrl);
            shownUrl = null;
        }
    }

    /** The photo or video under a message in the overlay, from where this device keeps it. */
    function showAttachment(m) {
        const box = $('message_attachment');
        forgetUrl();
        box.hidden = !m.attachment;
        box.innerHTML = PalsViews.attachment(m, null);
        if (!m.attachment) {
            return Promise.resolve();
        }
        return PalsStore.get('files', PalsModel.fileKey(me, m)).then(function (file) {
            if (!file || shown !== m.id) {
                return;
            }
            forgetUrl();
            shownUrl = URL.createObjectURL(new Blob([file.bytes], { type: m.attachment.type }));
            box.innerHTML = PalsViews.attachment(m, shownUrl);
        }).catch(() => {});
    }

    $('dlg_message').addEventListener('close', function () {
        shown = null;
        forgetUrl();
    });

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
        button.textContent = m.out ? 'Edit' : 'Reply';
        button.className = '';
        $('message_answer_box').hidden = true;
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
                fit($('message_body'), 6);
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

    /** Keeps the file the user picked on this device, until it is sent and after. */
    function keepFile(message, picked) {
        return picked.arrayBuffer().then(bytes => PalsStore.put('files', PalsModel.fileKey(me, message),
            { name: message.attachment.name, type: message.attachment.type, bytes: bytes }));
    }

    /**
     * Uploads a message's photo or video, once: locked here under a key of
     * its own, so Northern holds only what it cannot open. The id it is held
     * under and the key go in the seal of every part. A group message uploads
     * it once for every member.
     */
    function uploaded(message) {
        const att = message.attachment;
        if (!att || att.id) {
            return Promise.resolve();
        }
        return PalsStore.get('files', PalsModel.fileKey(me, message))
            .then(function (file) {
                if (!file) {
                    throw new Error('it is no longer on this device');
                }
                return PalsSeal.lock(file.bytes);
            })
            .then(sealed => upload(sealed.locked).then(function (id) {
                att.id = id;
                att.key = sealed.key;
                return save();
            }));
    }

    /**
     * Sends a message to everybody it has not reached yet: each receiver's
     * device is looked up in /pals/ afresh, and each part is sealed here, to
     * the key stored with the pal, and pushed on its own, in order. A group
     * message is one of these per member. The directory only says where to
     * push; what is sealed to whom never comes from it. A photo or a video
     * is uploaded first; without it nothing goes.
     */
    function deliver(message) {
        const pubs = Object.keys(message.delivery).filter(pub => message.delivery[pub] === 'sending');
        return uploaded(message).then(() => pushAll(message, pubs), function (err) {
            const why = 'the ' + PalsViews.kind(message.attachment).toLowerCase() + ' could not be sent: ' + (err.message || 'Northern is out of reach');
            pubs.forEach(pub => PalsModel.delivered(state, message.id, pub, why));
        }).then(function () {
            save();
            render();
            const result = PalsModel.deliveryOf(message);
            say(result === 'sent' ? 'Sent.' : 'Not delivered to everybody - open the message to see why.');
        });
    }

    function pushAll(message, pubs) {
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
                        return PalsSeal.seal(ownKey, me.pub, push.to, wire, { ts: message.ts, body: push.message, att: push.att })
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
        }));
    }

    /**
     * Sends what is in the New message panel (UPDATE_7) to whoever the
     * Messages layer is showing. What is wrong with it is said under it, and
     * it stays there to be put right.
     */
    function addMessage() {
        if (!checkSession()) {
            return;
        }
        if (!ownKey) {
            say('Load your ID Card on this device first - messages are sealed with its key.');
            return;
        }
        const error = $('compose_error');
        let message;
        let picked;
        try {
            const target = PalsModel.writeTo(state, ui.filter, me);
            const files = $('compose_file').files;
            picked = files && files.length ? files[0] : null;
            const attachment = picked ? PalsModel.attachment(picked.name, picked.type, picked.size) : null;
            message = PalsModel.compose(state, me, target, $('compose_body').value, Date.now(), wireId(), attachment);
        } catch (e) {
            error.textContent = e.message;
            return;
        }
        error.textContent = '';
        $('compose_body').value = '';
        $('compose_file').value = '';
        save();
        render();
        say('Sending…');
        // A file that cannot be read is not kept; uploading it then says so.
        return (picked ? keepFile(message, picked).catch(() => {}) : Promise.resolve()).then(() => deliver(message));
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
     * then filed - or, for a video call, handed to `signals`. 1 filed, 0 left
     * or dropped, -1 waiting for the ID Card.
     */
    function take(item, signals) {
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
            if (typeof envelope.signal === 'string') {
                // A video call's ring or cancel: for the call, not the log.
                const signal = PalsCalls.readSignal(envelope.signal);
                if (signal) {
                    signals.push({ from: envelope.from, signal: signal });
                }
                return PalsStore.remove('inbox', item.key).then(() => 0);
            }
            return nameFor(envelope.from).then(function (name) {
                PalsModel.receive(state, me, envelope, name);
                return save().then(() => PalsStore.remove('inbox', item.key)).then(() => 1);
            });
        }, function () {
            // It does not open with this key: forged, damaged, or not ours.
            return Date.now() - (value.at || 0) > KEEP ? drop() : 0;
        });
    }

    let fetching = null;

    /**
     * Fetches the photos and videos that came with messages, opens each with
     * the key its message carried, and keeps it on this device. The first
     * fetch marks it for deletion on Northern, so it is fetched as soon as it
     * is filed. One that failed is tried again next time; one Northern no
     * longer has, or that will not open, is given up.
     */
    function fetchAttachments() {
        if (fetching) {
            return fetching;
        }
        const waiting = PalsModel.unfetched(state);
        if (!waiting.length) {
            return Promise.resolve();
        }
        fetching = waiting.reduce((done, m) => done.then(() => fetchOne(m)), Promise.resolve())
            .then(function () {
                fetching = null;
                save();
                render();
                const open = shown && PalsModel.message(state, shown);
                if (open && open.attachment) {
                    showAttachment(open);
                }
            });
        return fetching;
    }

    function fetchOne(m) {
        const att = m.attachment;
        const lost = text => Object.assign(new Error(text), { lost: true });
        return fetch('/temp/api/download/' + att.id, { credentials: 'same-origin' })
            .then(function (response) {
                if (response.status === 404) {
                    throw lost('Northern no longer has it');
                }
                if (!response.ok) {
                    throw new Error('Northern answered ' + response.status);
                }
                return response.arrayBuffer();
            })
            .then(locked => PalsSeal.unlock(locked, att.key).catch(() => { throw lost('it does not open with the key it came with'); }))
            .then(bytes => PalsStore.put('files', PalsModel.fileKey(me, m), { name: att.name, type: att.type, bytes: bytes.buffer }))
            .then(function () {
                att.saved = true;
                att.error = '';
            }, function (err) {
                att.lost = !!err.lost;
                att.error = err.message || 'Northern is out of reach';
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
        const signals = [];
        draining = PalsStore.all('inbox')
            .then(items => items.reduce((done, item) => done.then(counts => take(item, signals).then(n => counts.concat(n))), Promise.resolve([])))
            .then(function (counts) {
                // What comes in while somebody's messages are open is read as it comes.
                if ($('dlg_messages').open && ui.filter.kind === 'pal' && PalsModel.isUnread(state, ui.filter.pub)) {
                    PalsModel.markUnread(state, ui.filter.pub, false);
                    save();
                }
                render();
                const waiting = counts.filter(n => n === -1).length;
                if (waiting) {
                    say(waiting + (waiting === 1 ? ' message is' : ' messages are') +
                        ' waiting. Load your ID Card on this device to read them.');
                }
                return rang(signals);
            })
            .catch(e => say('The inbox could not be read: ' + e.message))
            .then(function () {
                draining = null;
                if (again) {
                    again = false;
                    return drain();
                }
                return fetchAttachments();
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
        const question = pal ? 'Remove ' + PalsModel.label(pal.name, pal.pub) + ' from your pals?'
            : 'Remove ' + PalsModel.label(PalsModel.nameOf(state, ui.pal, me), ui.pal) + ' from the list? What they wrote stays.';
        if (!ui.pal || !window.confirm(question)) {
            return;
        }
        PalsModel.removePal(state, ui.pal);
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
            // Next, who is in it.
            return () => layer('members');
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


    // ---- video calls ---------------------------------------------------
    //
    // As InPerson tried them live (../inPerson/PLAN.md), with what Pals adds:
    // only a pal can call and be called, and everything is sealed to the key
    // pinned when they were added - the directory only says where to ring.

    // Where Settings keeps whether calls are on: the setup store, beside the setup.
    const CALL_SETTING = 'calls ' + me.pub;
    // Whom the call layer is about: the call there is, or the one just over.
    let callPeer = null;

    function showCall(text) {
        $('call_state').textContent = text || '';
    }

    /** Who the call is with, as the call layer's title says it: ✓ once their key is compared. */
    function callWith(pub) {
        const pal = PalsModel.pal(state, pub);
        return PalsViews.pill(PalsModel.nameOf(state, pub, me), pub) +
            (pal && pal.verified ? ' <span class="verified" title="Key compared in person">&#10003;</span>' : '');
    }

    /** STUN, and fresh TURN credentials from Northern for the call. */
    function rtcConfig() {
        return fetch('/turn/api/ice', { credentials: 'same-origin' }).then(answered)
            .then(data => PalsCalls.rtcConfig(data))
            .catch(function (e) {
                // A call may still get through without TURN.
                say('No TURN credentials from Northern (' + e.message + '); trying without.');
                return PalsCalls.rtcConfig(null);
            });
    }

    /**
     * Rings - or stops ringing - the pal's device: the signal is sealed here
     * to their pinned key, and pushed as a message is. The text is what a
     * Pals too old to know calls files instead.
     */
    function pushSignal(to, device, id, signalText, text) {
        const wire = { id: id, part: 1, parts: 1 };
        return PalsSeal.seal(ownKey, me.pub, to, wire, { ts: Date.now(), body: text, signal: signalText })
            .then(sealed => send({
                to: to,
                subscription: device.subscription,
                provider: device.provider,
                sealed: sealed,
                id: id,
                part: 1,
                parts: 1
            }));
    }

    // The call's channel is Northern's /sub/ of the call's random id, which
    // only the two ends and Northern know. Anybody signed in can write to it,
    // so every signal on it is sealed: Northern relays them, and can neither
    // read nor change them, nor forge one.

    /** Sends one signal on the call's channel, sealed to the other side; one at a time, in order. */
    function signal(call, t, extra) {
        call.sending = call.sending.then(function () {
            call.seq += 1;
            const wire = { id: call.id + '-' + call.seq, part: 1, parts: 1 };
            const text = PalsCalls.signal(t, call.id, Date.now(), extra);
            return PalsSeal.seal(ownKey, me.pub, call.peer, wire, { ts: Date.now(), body: '', signal: text })
                .then(sealed => fetch(PalsCalls.channel(call.id), {
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
            const source = new EventSource(PalsCalls.channel(call.id));
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
                        const s = PalsCalls.readSignal(envelope.signal, call.id);
                        return s && call.controller ? call.controller.receive(s) : null;
                    })
                    .catch(() => {});
            };
        });
    }

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

    /** What a call is, before WebRTC is in it. */
    function newCall(id, peer, role, device) {
        return { id: id, peer: peer, name: PalsModel.nameOf(state, peer, me), role: role, device: device,
                 seq: 0, sending: Promise.resolve(), source: null, controller: null, media: null };
    }

    /** A new call's id: 16 random bytes, base64url - the name of its channel. */
    function callId() {
        const raw = crypto.getRandomValues(new Uint8Array(16));
        return btoa(String.fromCharCode.apply(null, raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    /** The call layer, over everything: the two videos, how the call stands, Hang up. */
    function openCall(call) {
        callPeer = call.peer;
        $('call_with').innerHTML = callWith(call.peer);
        $('contact_caption').textContent = call.name;
        $('hang_up').hidden = false;
        $('call_close').hidden = true;
        layer('call');
    }

    /** WebRTC takes over: the controller, its state in the call layer, the other side's video. */
    function connect(call, rtc) {
        call.controller = PalsCall.create({
            role: call.role,
            call: call.id,
            config: rtc,
            local: call.media,
            RTCPeerConnection: RTCPeerConnection,
            send: (t, extra) => signal(call, t, extra),
            on: {
                state: s => showCall(PalsCalls.stateText(s, call.name)),
                remote: stream => play($('contact_video'), stream),
                ended: reason => ended(call, reason)
            }
        });
        showCall(PalsCalls.stateText(call.role === 'caller' ? 'calling' : 'connecting', call.name));
        return call.controller.start();
    }

    /** It is over: the camera off, the channel closed, the layer says why. A caller who gave up stops the ringing. */
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
        showCall('Call with ' + call.name + ': ' + reason + '.');
        $('hang_up').hidden = true;
        $('call_close').hidden = false;
        render();
        if (call.role === 'caller' && (reason === 'cancelled' || reason === 'no answer') && call.device) {
            pushSignal(call.peer, call.device, call.id + '-x', PalsCalls.signal('cancel', call.id, Date.now()), PalsCalls.MISSED_TEXT)
                .catch(() => {});
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
     * Call, from a pal's messages: the camera on, the call's channel open,
     * then the pal rung by push. WebRTC starts when they answer (call.js).
     */
    function startCall() {
        if (!checkSession() || current) {
            return Promise.resolve();
        }
        const pal = ui.filter.kind === 'pal' ? PalsModel.pal(state, ui.filter.pub) : null;
        if (!ownKey) {
            say('Load your ID Card on this device first - calls are set up sealed with its key.');
            return Promise.resolve();
        }
        if (!pal) {
            say('Only a pal can be called: add them with + first.');
            return Promise.resolve();
        }
        if (!callsOn) {
            say('Switch video calls on in Settings first.');
            return Promise.resolve();
        }
        const call = current = newCall(callId(), pal.pub, 'caller', null);
        openCall(call);
        showCall('Getting the camera ready…');
        render();
        return cameraFor(call)
            .then(() => Promise.all([lookUp(pal.pub), listen(call), rtcConfig()]))
            .then(function (found) {
                if (current !== call) {
                    throw GONE;
                }
                if (!found[0]) {
                    throw new Error('they have not set Pals up');
                }
                return connect(call, found[2])
                    .then(() => pushSignal(call.peer, found[0], call.id, PalsCalls.signal('ring', call.id, Date.now()), PalsCalls.RING_TEXT))
                    // Rung: from here on, giving up stops the ringing.
                    .then(function () {
                        call.device = found[0];
                        if (current !== call) {
                            // Hung up while the ring was on its way: stop it.
                            pushSignal(call.peer, call.device, call.id + '-x', PalsCalls.signal('cancel', call.id, Date.now()), PalsCalls.MISSED_TEXT)
                                .catch(() => {});
                        } else if (call.controller && call.controller.state() === 'calling') {
                            showCall(PalsCalls.stateText('ringing', call.name));
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

    // ---- ringing --------------------------------------------------------

    let ringing = null;
    let ringTimer = null;

    function closeIncoming() {
        clearTimeout(ringTimer);
        ringing = null;
        if ($('dlg_incoming').open) {
            $('dlg_incoming').close();
        }
    }

    /** Files calls not taken in the log, by the caller's name. */
    function missed(list) {
        if (!list.length) {
            return Promise.resolve();
        }
        list.forEach(m => handled.push(m.call));
        return Promise.all(list.map(m => nameFor(m.from).then(name => PalsModel.missedCall(state, me, m.from, m.ts, m.call, name))))
            .then(function () {
                save();
                render();
            });
    }

    function ring(r) {
        if (ringing && ringing.call === r.call) {
            return;
        }
        ringing = r;
        $('incoming_from').innerHTML = callWith(r.from);
        if (!$('dlg_incoming').open) {
            $('dlg_incoming').showModal();
        }
        clearTimeout(ringTimer);
        ringTimer = setTimeout(function () {
            closeIncoming();
            missed([r]);
        }, Math.max(0, PalsCalls.RING_MS - (Date.now() - r.ts)));
    }

    function answerCall() {
        const r = ringing;
        if (!r) {
            return Promise.resolve();
        }
        handled.push(r.call);
        closeIncoming();
        const call = current = newCall(r.call, r.from, 'callee', null);
        openCall(call);
        showCall('Getting the camera ready…');
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

    function declineCall() {
        const r = ringing;
        if (!r) {
            return Promise.resolve();
        }
        handled.push(r.call);
        closeIncoming();
        return signal(newCall(r.call, r.from, 'callee', null), 'decline');
    }

    /**
     * What the inbox held for calls: the call ringing now - from a pal, with
     * calls switched on here, and only while there is no other call - and
     * the ones missed, which go in the log. Somebody who is not a pal never
     * rings, nor does anybody while calls are off: they are a missed call.
     */
    function rang(signals) {
        if (!signals.length) {
            return Promise.resolve();
        }
        const found = PalsCalls.incoming(signals, Date.now(), handled);
        const lost = found.missed;
        if (ringing && signals.some(s => s.signal.t === 'cancel' && s.signal.call === ringing.call)) {
            lost.push(ringing);
            closeIncoming();
        }
        let r = found.ringing;
        if (r && (!callsOn || !PalsModel.pal(state, r.from))) {
            lost.push(r);
            r = null;
        }
        if (r && current) {
            // On a call already: the other caller hears so.
            signal(newCall(r.call, r.from, 'callee', null), 'decline', { busy: true });
            lost.push(r);
            r = null;
        }
        if (r) {
            ring(r);
        }
        return missed(lost);
    }

    // ---- calls on or off, in Settings -------------------------------------

    function report(text) {
        $('calls_report').textContent = text || '';
    }

    function keepCalls(on) {
        return PalsStore.put('setup', CALL_SETTING, { enabled: on }).then(function () {
            callsOn = on;
            render();
        });
    }

    /**
     * The switch: on asks for the camera and microphone at once - so the
     * first call is not held up by the question - and lets go of them again.
     * Refused, it stays off. Off, a pal's call is a missed call.
     */
    function switchCalls() {
        if (!$('calls_on').checked) {
            return keepCalls(false).then(() => report('Off: a pal who calls finds no answer, and you see a missed call.'),
                e => report('This could not be saved in the browser: ' + e.message));
        }
        report('Asking for the camera and microphone…');
        return camera()
            .then(function (media) {
                media.getTracks().forEach(t => t.stop());
                return keepCalls(true);
            })
            .then(() => report('On: call a pal from their messages; your pals can call you.'), function (e) {
                $('calls_on').checked = false;
                report('Still off: ' + e.message + '.');
            });
    }

    // ---- start ---------------------------------------------------------

    $('user').innerHTML = PalsViews.pill(me.name, me.pub);
    $('version').textContent = 'v' + PALS_VERSION;
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
            checkSession();
            // A ring that came while the page was away.
            drain();
        }
    });

    onRow('pals', 'data-pub', selectPal);
    onRow('groups', 'data-group', selectGroup);
    onRow('members', 'data-pub', selectMember);
    onRow('messages', 'data-message', openMessage);

    $('settings_open').addEventListener('click', function () {
        $('calls_on').checked = callsOn;
        report('');
        layer('settings');
    });
    // Logout (Northern UPDATE_8): this browser forgets who is signed in - the
    // cookie, and the keys kept for sealing and for signing in again - and
    // Reg.html offers to sign in, coming back here after. Messages wait on
    // this device until the ID Card is loaded again.
    $('logout').href = PalsModel.regUrl(window.location.pathname, window.location.search, '');
    $('logout').addEventListener('click', function (event) {
        event.preventDefault();
        if (!window.confirm('Logout ' + me.name + '? Load your ID Card to sign in again.')) {
            return;
        }
        session.forget().then(() => window.location.replace($('logout').href));
    });
    $('group_messages').addEventListener('click', groupMessages);
    $('pal_add').addEventListener('click', addPal);
    $('pal_remove').addEventListener('click', removePal);
    $('pal_verify').addEventListener('click', verifyPal);
    $('message_add').addEventListener('click', addMessage);
    $('group_add').addEventListener('click', addGroup);
    $('group_remove').addEventListener('click', removeGroup);
    $('member_add').addEventListener('click', addMember);
    $('member_remove').addEventListener('click', removeMember);
    $('call_start').addEventListener('click', startCall);
    $('hang_up').addEventListener('click', hangUp);
    $('call_answer').addEventListener('click', answerCall);
    $('call_decline').addEventListener('click', declineCall);
    // Keys compared while the two can hear each other: the call's pal, in the Key overlay.
    $('call_key').addEventListener('click', function () {
        if (callPeer && PalsModel.pal(state, callPeer)) {
            ui.pal = callPeer;
            verifyPal();
        }
    });
    // The call layer stays while there is a call: Escape does not close it.
    $('dlg_call').addEventListener('cancel', function (event) {
        if (current) {
            event.preventDefault();
        }
    });
    $('calls_on').addEventListener('change', switchCalls);

    /** The device stopped getting pushes since it was set up: the browser dropped or replaced the subscription. */
    function checkSubscription(setup) {
        if (!('serviceWorker' in navigator)) {
            return;
        }
        navigator.serviceWorker.ready
            .then(registration => registration.pushManager.getSubscription())
            .then(function (subscription) {
                if (!subscription || subscription.endpoint !== setup.endpoint) {
                    say('This device no longer gets messages. Set it up again under Settings (the gear, top right).');
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
            NorthernKeys.available() ? NorthernKeys.get(me.pub).catch(() => null) : null,
            PalsStore.get('setup', CALL_SETTING).catch(() => null)
        ]).then(function (found) {
            state = PalsModel.load(found[0]);
            ownKey = found[1];
            callsOn = PalsCalls.enabled(found[2]);
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
