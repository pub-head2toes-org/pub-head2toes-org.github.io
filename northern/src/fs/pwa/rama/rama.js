/* Rama PWA - the wiring: the recorder, the two pages, the lists, the overlay and the reminders. */
'use strict';

(function () {

    // Rama is for whoever is signed in to Northern. Anybody else - and anybody
    // whose day-long session cookie has expired - signs in first, and Reg.html
    // sends them back here.
    if (!session.signedIn()) {
        window.location.replace(RamaModel.regUrl(
            window.location.pathname, window.location.search, window.location.hash));
        return;
    }

    const me = { pub: session.pub(), name: session.userName() || RamaModel.UNKNOWN };
    const $ = id => document.getElementById(id);

    // The cookie lasts a day, so it can expire with the page open: this runs
    // whenever the page comes back into view, and before anything is saved.
    // False when the page is leaving.
    function checkSession() {
        if (session.signedIn()) {
            return true;
        }
        window.location.replace(RamaModel.regUrl(window.location.pathname, window.location.search, ''));
        return false;
    }

    // ---- state ---------------------------------------------------------

    // This user's notes, as RamaModel.clean left them; read from IndexedDB on load.
    let notes = [];
    // The types this user added to the three.
    let known = [];
    // The note in the overlay, and the next reminder's timer.
    let shown = null;
    let timer = null;
    // Which page is on top: the recorder, or the lists.
    const ui = { front: 'record', peeling: false };

    function say(text) {
        $('status').textContent = text || '';
    }

    const mine = id => notes.find(note => note.id === id) || null;
    const types = () => RamaModel.types(known, notes);

    // ---- the lists -----------------------------------------------------

    function render() {
        const query = $('search').value;
        const now = Date.now();
        $('reminders').innerHTML = RamaViews.reminders(RamaModel.reminders(notes, query, now), query, now);
        $('recordings').innerHTML = RamaViews.recordings(RamaModel.recordings(notes, query), query);
    }

    $('search').addEventListener('input', render);

    // A click anywhere on a row of either list opens its recording.
    ['reminders', 'recordings'].forEach(function (id) {
        $(id).addEventListener('click', function (event) {
            const row = event.target && event.target.closest && event.target.closest('[data-id]');
            if (row) {
                openNote(row.getAttribute('data-id'));
            }
        });
    });

    // ---- peeling: the top page comes off, and shows the one under it -----

    // As long as the animation in styles.css (--peel).
    const PEEL_MS = 650;
    const page = name => $(name === 'record' ? 'page_record' : 'page_browse');
    const other = name => name === 'record' ? 'browse' : 'record';

    function reduced() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /** Puts `name` on top: by peeling the other off, or at once when `animate` is false. */
    function bring(name, animate) {
        if (ui.front === name || ui.peeling) {
            return;
        }
        const from = page(ui.front);
        const to = page(name);
        const swap = function () {
            from.classList.remove('front', 'peeling');
            from.inert = true;
            to.classList.add('front');
            ui.front = name;
            ui.peeling = false;
            if (name === 'browse') {
                render();
                $('search').focus();
            } else {
                $('record').focus();
            }
        };
        // The page underneath is live from the start: it shows as the top one lifts.
        to.inert = false;
        if (animate === false || reduced()) {
            swap();
            return;
        }
        ui.peeling = true;
        from.classList.add('peeling');
        setTimeout(swap, PEEL_MS);
    }

    $('peel_top').addEventListener('click', () => bring('browse'));
    $('peel_back').addEventListener('click', () => bring('record'));

    // ---- recording -----------------------------------------------------

    const rec = { state: 'idle', recorder: null, stream: null, chunks: [], mime: '', started: 0, ended: 0, tick: null };

    function canRecord() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof MediaRecorder !== 'undefined';
    }

    function showRecording(on) {
        const button = $('record');
        button.classList.toggle('recording', on);
        button.setAttribute('aria-pressed', on ? 'true' : 'false');
        $('record_label').textContent = on ? 'Stop' : 'Record';
        $('elapsed').textContent = on ? RamaModel.clock(0) : '';
    }

    function release() {
        if (rec.stream) {
            rec.stream.getTracks().forEach(track => track.stop());
        }
        rec.stream = null;
        rec.recorder = null;
    }

    function start() {
        rec.state = 'starting';
        say('');
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
            rec.stream = stream;
            const mime = RamaModel.mimeFor(type => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type));
            const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
            rec.recorder = recorder;
            rec.chunks = [];
            rec.mime = recorder.mimeType || mime || 'audio/webm';
            recorder.ondataavailable = function (event) {
                if (event.data && event.data.size) {
                    rec.chunks.push(event.data);
                }
            };
            recorder.onstop = finish;
            recorder.start();
            rec.started = Date.now();
            rec.state = 'recording';
            showRecording(true);
            rec.tick = setInterval(function () {
                $('elapsed').textContent = RamaModel.clock((Date.now() - rec.started) / 1000);
            }, 250);
        }).catch(function (e) {
            release();
            rec.state = 'idle';
            say(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
                ? 'Rama needs the microphone to record. Allow it for this site, then press Record again.'
                : 'The microphone would not start: ' + (e && e.message || e));
        });
    }

    function stop() {
        rec.state = 'saving';
        clearInterval(rec.tick);
        rec.ended = Date.now();
        rec.recorder.stop();
    }

    /** What the recorder made, kept: the sound under `audio`, the note under `notes`. */
    function finish() {
        const at = rec.started;
        const duration = (rec.ended - rec.started) / 1000;
        const type = rec.mime;
        const blob = new Blob(rec.chunks, { type: type });
        rec.chunks = [];
        release();
        showRecording(false);
        if (!blob.size) {
            rec.state = 'idle';
            say('Nothing was recorded.');
            return;
        }
        const id = RamaModel.newId(at);
        const note = RamaModel.note(me.pub, id, at, duration, type);
        blob.arrayBuffer()
            .then(bytes => RamaStore.put('audio', id, { type: type, bytes: bytes }))
            .then(() => RamaStore.put('notes', id, note))
            .then(function () {
                notes.push(note);
                render();
                say('Saved. Peel the corner to see it.');
            })
            .catch(e => say('The recording could not be saved in the browser: ' + e.message))
            .then(() => { rec.state = 'idle'; });
    }

    $('record').addEventListener('click', function () {
        if (rec.state === 'recording') {
            stop();
            return;
        }
        if (rec.state !== 'idle' || !checkSession()) {
            return;
        }
        if (!canRecord()) {
            say('This browser cannot record here. Rama needs a browser with a microphone, on https.');
            return;
        }
        start();
    });

    // ---- the overlay: one recording, to play and to write about ----------

    const audio = $('note_audio');
    const player = { url: null, length: 0 };

    function showTime(at) {
        $('note_time').textContent = RamaModel.clock(at) + ' / ' + RamaModel.clock(player.length);
    }

    function setLength(seconds) {
        player.length = seconds || 0;
        $('note_seek').max = String(player.length);
        showTime(audio.currentTime || 0);
    }

    function openNote(id) {
        const note = mine(id);
        if (!note) {
            return;
        }
        shown = id;
        $('note_stamp').textContent = RamaModel.stamp(note.at);
        $('note_stamp').setAttribute('datetime', new Date(note.at).toISOString());
        $('note_buzz').value = note.buzz;
        $('note_type').value = note.type;
        $('note_remind').value = note.remind ? RamaModel.localInput(note.remind) : '';
        $('note_essay').value = note.essay;
        $('note_error').textContent = '';
        hideTypes();
        $('note_play').disabled = true;
        $('note_play').textContent = 'Play';
        $('note_seek').value = '0';
        // MediaRecorder's WebM says nothing of its length until it is played
        // through, so the length measured while recording stands in for it.
        setLength(note.duration);
        $('dlg_note').showModal();

        RamaStore.get('audio', id).then(function (sound) {
            if (shown !== id) {
                return;
            }
            if (!sound || !sound.bytes) {
                $('note_error').textContent = 'The sound of this recording is not in this browser.';
                return;
            }
            player.url = URL.createObjectURL(new Blob([sound.bytes], { type: sound.type || note.mime }));
            audio.src = player.url;
            $('note_play').disabled = false;
        }).catch(function (e) {
            $('note_error').textContent = 'The recording could not be read from the browser: ' + e.message;
        });
    }

    $('note_play').addEventListener('click', function () {
        if (!audio.paused) {
            audio.pause();
            return;
        }
        const playing = audio.play();
        if (playing && playing.catch) {
            playing.catch(e => { $('note_error').textContent = 'It would not play: ' + e.message; });
        }
    });
    audio.addEventListener('play', () => { $('note_play').textContent = 'Pause'; });
    audio.addEventListener('pause', () => { $('note_play').textContent = 'Play'; });
    audio.addEventListener('loadedmetadata', function () {
        if (isFinite(audio.duration) && audio.duration > 0) {
            setLength(audio.duration);
        }
    });
    audio.addEventListener('timeupdate', function () {
        $('note_seek').value = String(audio.currentTime);
        showTime(audio.currentTime);
    });
    $('note_seek').addEventListener('input', function () {
        audio.currentTime = Number($('note_seek').value) || 0;
        showTime(audio.currentTime);
    });

    $('dlg_note').addEventListener('close', function () {
        audio.pause();
        audio.removeAttribute('src');
        if (player.url) {
            URL.revokeObjectURL(player.url);
        }
        player.url = null;
        shown = null;
    });

    $('note_close').addEventListener('click', () => $('dlg_note').close());

    // ---- Type: search as you type, from the types there are ---------------

    const combo = { offered: [], active: -1 };

    function hideTypes() {
        combo.offered = [];
        combo.active = -1;
        $('note_types').hidden = true;
        $('note_types').innerHTML = '';
        $('note_type').setAttribute('aria-expanded', 'false');
        $('note_type').removeAttribute('aria-activedescendant');
    }

    function showTypes() {
        const typed = $('note_type').value;
        const offered = RamaModel.suggest(types(), typed);
        // Nothing to offer once what is typed is the one type that fits.
        if (!offered.length || (offered.length === 1 && offered[0].toLowerCase() === typed.trim().toLowerCase())) {
            hideTypes();
            return;
        }
        combo.offered = offered;
        $('note_types').innerHTML = RamaViews.suggestions(offered, combo.active);
        $('note_types').hidden = false;
        $('note_type').setAttribute('aria-expanded', 'true');
        if (combo.active >= 0) {
            $('note_type').setAttribute('aria-activedescendant', 'type_option_' + combo.active);
        } else {
            $('note_type').removeAttribute('aria-activedescendant');
        }
    }

    function pickType(type) {
        $('note_type').value = type;
        hideTypes();
    }

    $('note_type').addEventListener('input', function () {
        combo.active = -1;
        showTypes();
    });
    $('note_type').addEventListener('focus', showTypes);
    $('note_type').addEventListener('blur', hideTypes);
    $('note_type').addEventListener('keydown', function (event) {
        const open = !$('note_types').hidden;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
                showTypes();
                return;
            }
            const step = event.key === 'ArrowDown' ? 1 : -1;
            combo.active = (combo.active + step + combo.offered.length + 1) % (combo.offered.length + 1);
            if (combo.active === combo.offered.length) {
                combo.active = -1;
            }
            showTypes();
        } else if (event.key === 'Enter' && open && combo.active >= 0) {
            event.preventDefault();
            pickType(combo.offered[combo.active]);
        } else if (event.key === 'Escape' && open) {
            // Closes the list, not the overlay.
            event.preventDefault();
            hideTypes();
        }
    });
    // A press on a suggestion must not blur the field first: the list would go before the click lands.
    $('note_types').addEventListener('pointerdown', event => event.preventDefault());
    $('note_types').addEventListener('click', function (event) {
        const option = event.target && event.target.closest && event.target.closest('[data-type]');
        if (option) {
            pickType(option.getAttribute('data-type'));
        }
    });

    // ---- Update --------------------------------------------------------

    /** Asks once to notify; true when it may. Called from the click, as browsers require. */
    function mayNotify() {
        if (typeof Notification === 'undefined') {
            return Promise.resolve(false);
        }
        if (Notification.permission !== 'default') {
            return Promise.resolve(Notification.permission === 'granted');
        }
        return Promise.resolve(Notification.requestPermission()).then(answer => answer === 'granted', () => false);
    }

    $('note_form').addEventListener('submit', function (event) {
        event.preventDefault();
        const note = mine(shown);
        if (!note || !checkSession()) {
            return;
        }
        const offered = types();
        let edited;
        try {
            edited = RamaModel.edit(note, {
                buzz: $('note_buzz').value, type: $('note_type').value,
                remind: $('note_remind').value, essay: $('note_essay').value
            }, offered, Date.now());
        } catch (e) {
            $('note_error').textContent = e.message;
            return;
        }
        const asking = edited.remind && edited.remind !== note.remind ? mayNotify() : Promise.resolve(true);
        const added = RamaModel.isNewType(edited.type, offered);

        RamaStore.put('notes', note.id, edited)
            .then(function () {
                notes = notes.map(n => n.id === note.id ? edited : n);
                if (added) {
                    known.push(edited.type);
                    return RamaStore.put('meta', me.pub, { types: known.slice() });
                }
            })
            .then(function () {
                $('dlg_note').close();
                render();
                schedule();
                return asking;
            })
            .then(function (allowed) {
                say(allowed ? 'Updated.' : 'Updated. This site may not notify you, so the reminder shows in the list only.');
                if (allowed && edited.remind) {
                    wakeWorker();
                }
            })
            .catch(e => { $('note_error').textContent = 'This could not be saved in the browser: ' + e.message; });
    });

    // ---- reminders -----------------------------------------------------

    const notifying = () => typeof Notification !== 'undefined' && Notification.permission === 'granted';

    /** One notification: through the service worker, as Android requires, or the page's own. */
    function notify(title, options) {
        if (!notifying()) {
            return Promise.resolve();
        }
        const worker = navigator.serviceWorker && navigator.serviceWorker.getRegistration
            ? navigator.serviceWorker.getRegistration() : Promise.resolve(null);
        return worker.then(function (registration) {
            if (registration) {
                return registration.showNotification(title, options);
            }
            new Notification(title, options);
        });
    }

    /** Shows what is due, says so on the page as well, and waits for the next one. */
    function remind() {
        return RamaRemind.fire(notify, Date.now(), me.pub)
            .then(function (due) {
                if (due.length) {
                    say('Reminder: ' + due.map(note => RamaModel.notice(note).options.body).join(' · '));
                    render();
                }
            })
            .catch(e => console.log('the reminders could not be read', e))
            .then(schedule);
    }

    function schedule() {
        clearTimeout(timer);
        timer = null;
        const now = Date.now();
        const next = RamaModel.next(notes, now);
        if (next !== null) {
            timer = setTimeout(remind, Math.min(next - now, RamaModel.LONGEST_WAIT));
        }
    }

    // ---- Settings: Backup and Restore (UPDATE_1) ------------------------

    // The ID Card's key, as reg/keystore.js kept it when the card was loaded
    // on this device: not extractable, for key agreement only. A backup is
    // sealed with it, and opens only with it.
    let ownKey = null;
    // The backup last made, as an object URL, until the next one is.
    let backupUrl = null;
    let busy = false;

    function loadKey() {
        if (typeof NorthernKeys === 'undefined' || !NorthernKeys.available()) {
            return Promise.resolve(null);
        }
        return NorthernKeys.get(me.pub).catch(() => null).then(key => { ownKey = key; });
    }

    function needCard() {
        $('need_card').hidden = !!ownKey;
        $('need_card_link').href = RamaModel.regUrl(window.location.pathname, window.location.search, '');
    }

    function backupSays(text) {
        $('backup_report').textContent = text || '';
    }

    function working(on) {
        busy = on;
        $('backup').disabled = on;
        $('restore').disabled = on;
    }

    $('settings_open').addEventListener('click', function () {
        $('settings_user').textContent = me.name;
        needCard();
        $('dlg_settings').showModal();
        // An ID Card loaded in another tab since counts too.
        loadKey().then(needCard);
    });

    /**
     * Backup: this user's recordings - the sound and what was written about
     * each - and the types they added, sealed with the ID Card's key into one
     * file (backup.js). It is offered as a link the user taps to save it:
     * iPhone asks before it saves a file, and drops a download the page
     * starts on its own.
     */
    function backup() {
        if (busy) {
            return Promise.resolve();
        }
        if (!ownKey) {
            backupSays('Load your ID Card on this device first - the backup is sealed with its key.');
            return Promise.resolve();
        }
        working(true);
        $('backup_save').hidden = true;
        backupSays('Making the backup…');
        const at = Date.now();
        const kept = notes.slice();
        return RamaBackup.make(ownKey, me, kept, known.slice(), note => RamaStore.get('audio', note.id).catch(() => null), at)
            .then(function (made) {
                if (backupUrl) {
                    URL.revokeObjectURL(backupUrl);
                }
                backupUrl = URL.createObjectURL(made.blob);
                const name = RamaBackup.fileName(me.name, at);
                const link = $('backup_save');
                link.href = backupUrl;
                link.download = name;
                link.textContent = 'Save ' + name + ', ' + RamaViews.size(made.blob.size);
                link.hidden = false;
                const silent = kept.length - made.files;
                backupSays('The backup holds ' + RamaViews.counted(kept.length) +
                    (silent ? ' (' + silent + ' without its sound, which is not in this browser)' : '') +
                    '. It opens only with your ID Card: keep it somewhere safe.');
            }, e => backupSays('The backup could not be made: ' + e.message))
            .then(() => working(false));
    }

    /** Restore: picks the file first. */
    function restore() {
        if (busy) {
            return;
        }
        if (!ownKey) {
            backupSays('Load your ID Card on this device first - a backup opens only with its key.');
            return;
        }
        $('restore_file').value = '';
        $('restore_file').click();
    }

    /**
     * Adds what a backup holds to what is here (RamaModel.restore): one
     * recording at a time, its sound before its note, so no note is ever kept
     * without the sound it has. Nothing here is removed or changed.
     */
    function restoreFrom() {
        const files = $('restore_file').files;
        const picked = files && files.length ? files[0] : null;
        if (!picked || busy || !checkSession()) {
            return Promise.resolve();
        }
        if (!window.confirm('Restore from ' + picked.name + '? Its recordings are added to those here; none here is removed or changed.')) {
            $('restore_file').value = '';
            return Promise.resolve();
        }
        working(true);
        backupSays('Opening the backup…');
        let added = 0;
        let silent = 0;
        return RamaBackup.read(ownKey, me, picked)
            .then(function (opened) {
                const found = RamaModel.restore(notes, known, opened, me.pub);
                const where = {};
                opened.files.forEach((f, i) => { where[f.id] = i; });
                return found.notes.reduce((done, note, n) => done.then(function () {
                    backupSays('Restoring recordings: ' + (n + 1) + ' of ' + found.notes.length + '…');
                    const i = where[note.id];
                    // A reminder shown before the backup was made is not shown again: marked first.
                    return (found.fired[note.id] ? RamaStore.put('fired', note.id, found.fired[note.id]) : Promise.resolve())
                        .then(() => i === undefined ? false : opened.sound(i)
                            .then(bytes => RamaStore.put('audio', note.id, { type: opened.files[i].type || note.mime, bytes: bytes.buffer }))
                            .then(() => true, () => false))
                        .then(function (heard) {
                            silent += heard ? 0 : 1;
                            return RamaStore.put('notes', note.id, note);
                        })
                        .then(function () {
                            notes.push(note);
                            added += 1;
                        });
                }), Promise.resolve()).then(function () {
                    if (found.types.length !== known.length) {
                        known = found.types;
                        return RamaStore.put('meta', me.pub, { types: known.slice() });
                    }
                });
            })
            .then(function () {
                backupSays('Restored: ' + RamaViews.counted(added) + ' added' +
                    (silent ? ' (' + silent + ' without its sound: it was not in the backup, or would not open)' : '') + '.');
            }, e => backupSays((added ? 'The restore stopped after ' + RamaViews.counted(added) + ': ' : 'The backup could not be restored: ') + e.message))
            .then(function () {
                $('restore_file').value = '';
                working(false);
                render();
                // A reminder that came due since the backup was made is shown now.
                return remind();
            });
    }

    $('backup').addEventListener('click', backup);
    $('restore').addEventListener('click', restore);
    $('restore_file').addEventListener('change', restoreFrom);

    // ---- the service worker --------------------------------------------

    /**
     * Where the browser offers it (Chrome, for an installed app), the worker
     * is woken now and then to show what came due while no page was open.
     */
    function wakeWorker() {
        if (!navigator.serviceWorker || !navigator.serviceWorker.ready) {
            return;
        }
        navigator.serviceWorker.ready.then(function (registration) {
            if (registration && registration.periodicSync) {
                return registration.periodicSync.register(RamaModel.SYNC_TAG, { minInterval: 15 * 60 * 1000 });
            }
        }).catch(() => {});
    }

    if (navigator.serviceWorker) {
        // Its imports are checked past the HTTP cache too.
        navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
            .catch(e => console.log('the service worker could not be registered', e));
        // A notification was clicked while this page was open.
        navigator.serviceWorker.addEventListener('message', function (event) {
            if (event.data && event.data.type === 'rama:open' && mine(event.data.id)) {
                bring('browse', false);
                openNote(event.data.id);
            }
        });
    }

    // ---- start ---------------------------------------------------------

    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && checkSession()) {
            render();
            remind();
        }
    });

    $('user').textContent = me.name;
    $('version').textContent = 'v' + RAMA_VERSION;
    loadKey();

    Promise.all([RamaStore.all('notes'), RamaStore.get('meta', me.pub)])
        .then(function ([rows, meta]) {
            notes = rows.map(row => RamaModel.clean(row.value)).filter(note => note && note.owner === me.pub);
            known = meta && Array.isArray(meta.types) ? meta.types.filter(type => typeof type === 'string') : [];
            render();
            // Opened from a reminder's notification: straight to its recording.
            const wanted = RamaModel.noteFromHash(window.location.hash);
            if (wanted && mine(wanted)) {
                bring('browse', false);
                openNote(wanted);
            }
            if (notifying()) {
                wakeWorker();
            }
            return remind();
        })
        .catch(e => say('Rama could not read what it keeps in this browser: ' + e.message));
})();
