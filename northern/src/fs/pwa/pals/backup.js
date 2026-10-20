'use strict';

/**
 * A backup of Pals (UPDATE_9): the pals, the groups, every message, and the
 * photos and videos kept on this device - one file, to keep anywhere and
 * restore later, on this device or another.
 *
 * Messages are kept here opened, so the file is sealed as they were when they
 * came: with the ID Card's key (PalsSeal.backupKey). It opens only where that
 * ID Card is loaded; to anybody else - and to whatever stores the file - it
 * is noise, bar its size.
 *
 *   file    = "Pals backup\n" | 1 | salt(16) | record 0 | record 1 | ...
 *   record  = length(4, big-endian) | iv(12) | AES-256-GCM(bytes) | tag(16)
 *
 * Record 0 is the index, as JSON: `{v, pub, name, at, state, files}`, where
 * `files` lists `{id, name, type, size}` - the message each photo or video
 * goes with - in the order the records after it hold them.
 *
 * Each file is sealed apart, one at a time, and read back apart, one slice of
 * the file at a time - so a restore never reads the whole file in at once.
 *
 * Depends on seal.js.
 */
const PalsBackup = (function () {

    const MAGIC = 'Pals backup\n';
    const VERSION = 1;
    const HEAD = MAGIC.length + 1 + 16;

    const api = {};
    api.VERSION = VERSION;

    const length = function (n) {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, n);
        return out;
    };

    const slice = (blob, from, to) => blob.slice(from, to).arrayBuffer().then(b => new Uint8Array(b));

    /** What the file is called: whose, and when. */
    api.fileName = function (name, at) {
        const d = new Date(at);
        const two = n => String(n).padStart(2, '0');
        const who = String(name || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        return 'pals-backup' + (who ? '-' + who : '') + '-' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '.pals';
    };

    /**
     * Makes a backup of `state` for `me`, sealed with `own` - the ID Card's
     * key. `fileOf(message)` resolves to what this device keeps of a
     * message's photo or video, `{name, type, bytes}`, or nothing. Resolves
     * to `{blob, files}`: the file, and how many photos and videos are in it.
     */
    api.make = function (own, me, state, fileOf, at) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const head = new Uint8Array(HEAD);
        head.set(new TextEncoder().encode(MAGIC));
        head[MAGIC.length] = VERSION;
        head.set(salt, MAGIC.length + 1);
        const records = [];
        const files = [];
        return PalsSeal.backupKey(own, me.pub, salt).then(function (key) {
            const kept = state.messages.filter(m => m.attachment);
            // One at a time: only its sealed copy stays.
            return kept.reduce((done, m) => done.then(() => fileOf(m)).then(function (file) {
                if (!file || !file.bytes) {
                    return;
                }
                const bytes = new Uint8Array(file.bytes);
                files.push({ id: m.id, name: file.name || m.attachment.name, type: file.type || m.attachment.type, size: bytes.length });
                return PalsSeal.sealRecord(key, files.length, bytes).then(sealed => { records.push(length(sealed.length), sealed); });
            }), Promise.resolve()).then(function () {
                const index = { v: VERSION, pub: me.pub, name: me.name, at: at, state: state, files: files };
                return PalsSeal.sealRecord(key, 0, new TextEncoder().encode(JSON.stringify(index)));
            });
        }).then(sealed => ({
            blob: new Blob([head, length(sealed.length), sealed].concat(records), { type: 'application/octet-stream' }),
            files: files.length
        }));
    };

    /**
     * Opens a backup - a Blob, or a File the user picked - for `me`, with
     * `own`. Resolves to `{at, state, files, file}`, where `file(i)` resolves
     * to the bytes of the i-th entry of `files`. Rejects, saying why, a file
     * that is not a backup, is cut short, or does not open with this key.
     */
    api.read = function (own, me, blob) {
        const bad = text => Promise.reject(new Error(text));
        if (!blob || !(blob.size > HEAD + 4)) {
            return bad('that is not a Pals backup');
        }
        let key;
        let index;
        const offsets = [];
        // A record's place and length, read off its length field.
        const at = function (from) {
            return slice(blob, from, from + 4).then(function (field) {
                const size = field.length === 4 ? new DataView(field.buffer).getUint32(0) : -1;
                if (size < 28 || from + 4 + size > blob.size) {
                    throw new Error('the backup is cut short');
                }
                return { from: from + 4, to: from + 4 + size };
            });
        };
        return slice(blob, 0, HEAD).then(function (head) {
            if (new TextDecoder().decode(head.subarray(0, MAGIC.length)) !== MAGIC) {
                throw new Error('that is not a Pals backup');
            }
            if (head[MAGIC.length] !== VERSION) {
                throw new Error('that backup is from a newer Pals - update this one first');
            }
            return PalsSeal.backupKey(own, me.pub, head.subarray(MAGIC.length + 1));
        }).then(function (made) {
            key = made;
            return at(HEAD);
        }).then(function (place) {
            return slice(blob, place.from, place.to)
                .then(sealed => PalsSeal.openRecord(key, 0, sealed))
                .catch(function () {
                    throw new Error('it does not open with your ID Card - it is somebody else\'s backup, or it is damaged');
                })
                .then(function (plain) {
                    index = JSON.parse(new TextDecoder().decode(plain));
                    if (!index || index.pub !== me.pub || !Array.isArray(index.files)) {
                        throw new Error('it is somebody else\'s backup');
                    }
                    return place.to;
                });
        }).then(function (next) {
            // Where every file is, so one cut short is found before anything is restored.
            return index.files.reduce((done, f) => done.then(from => at(from).then(function (place) {
                offsets.push(place);
                return place.to;
            })), Promise.resolve(next));
        }).then(function (end) {
            if (end !== blob.size) {
                throw new Error('the backup has more in it than it says');
            }
            return {
                at: index.at,
                state: index.state,
                files: index.files,
                file: i => slice(blob, offsets[i].from, offsets[i].to).then(sealed => PalsSeal.openRecord(key, i + 1, sealed))
            };
        });
    };

    return api;
})();
