'use strict';

/**
 * A backup of Rama (UPDATE_1): the signed-in user's recordings - the sound of
 * each, and what was written about it - and the types they added. One file,
 * to keep anywhere and restore later, on this device or another.
 *
 * It is sealed as Pals seals its backup: with the ID Card's key, as
 * reg/keystore.js keeps it - HKDF-SHA256 over ECDH of the key with its own
 * public key, then AES-256-GCM. It opens only where that ID Card is loaded;
 * to anybody else - and to whatever stores the file - it is noise, bar its size.
 *
 *   file    = "Rama backup\n" | 1 | salt(16) | record 0 | record 1 | ...
 *   record  = length(4, big-endian) | iv(12) | AES-256-GCM(bytes) | tag(16)
 *
 * Record 0 is the index, as JSON: `{v, pub, name, at, notes, types, files}`,
 * where `files` lists `{id, type, size}` - the note each sound goes with - in
 * the order the records after it hold them. Every record is sealed with its
 * place in the file, so none can be moved, swapped or put in another backup.
 *
 * Each sound is sealed apart, one at a time, and read back apart, one slice
 * of the file at a time - so a restore never reads the whole file in at once.
 *
 * Works wherever there is WebCrypto; no DOM, no storage.
 */
const RamaBackup = (function () {

    const MAGIC = 'Rama backup\n';
    const VERSION = 1;
    const HEAD = MAGIC.length + 1 + 16;
    const INFO = 'Rama backup v1\0';
    const RECORD = 'Rama backup record\0';

    const api = {};
    api.VERSION = VERSION;

    const subtle = () => crypto.subtle;
    const utf8 = text => new TextEncoder().encode(text);
    const bytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const join = function () {
        const parts = Array.prototype.slice.call(arguments);
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        parts.forEach(p => { out.set(p, at); at += p.length; });
        return out;
    };

    /** A Northern public key (x ‖ y, base64) as the 65-byte point WebCrypto takes. */
    const point = pub => join(Uint8Array.of(4), bytes(pub));

    const length = function (n) {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, n);
        return out;
    };

    const slice = (blob, from, to) => blob.slice(from, to).arrayBuffer().then(b => new Uint8Array(b));

    // ---- the seal ----------------------------------------------------------

    /** The AES key of one backup: from the ID Card's key `own`, its public key and the backup's salt. */
    api.key = function (own, pub, salt) {
        return subtle().importKey('raw', point(pub), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
            .then(publicKey => subtle().deriveBits({ name: 'ECDH', public: publicKey }, own, 256))
            .then(secret => subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']))
            .then(ikm => subtle().deriveKey(
                { name: 'HKDF', hash: 'SHA-256', salt: salt, info: join(utf8(INFO), point(pub)) },
                ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    };

    /** Seals record `n` of a backup. Resolves to `iv(12) | ciphertext | tag(16)`. */
    api.seal = function (key, n, plain) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        return subtle().encrypt({ name: 'AES-GCM', iv: iv, additionalData: utf8(RECORD + n) }, key, plain)
            .then(sealed => join(iv, new Uint8Array(sealed)));
    };

    /** Opens what `seal` made of record `n`. Resolves to its bytes, or rejects. */
    api.open = function (key, n, sealed) {
        const data = new Uint8Array(sealed);
        if (data.length < 28) {
            return Promise.reject(new Error('not a sealed record'));
        }
        return subtle().decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: utf8(RECORD + n) }, key, data.subarray(12))
            .then(plain => new Uint8Array(plain));
    };

    // ---- the file ----------------------------------------------------------

    /** What the file is called: whose, and when. */
    api.fileName = function (name, at) {
        const d = new Date(at);
        const two = n => String(n).padStart(2, '0');
        const who = String(name || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        return 'rama-backup' + (who ? '-' + who : '') + '-' + d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + '.rama';
    };

    /**
     * Makes a backup of `notes` and `types` for `me`, sealed with `own` - the
     * ID Card's key. `soundOf(note)` resolves to what this device keeps of a
     * note's sound, `{type, bytes}`, or nothing. Resolves to `{blob, files}`:
     * the file, and how many sounds are in it.
     */
    api.make = function (own, me, notes, types, soundOf, at) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const head = new Uint8Array(HEAD);
        head.set(utf8(MAGIC));
        head[MAGIC.length] = VERSION;
        head.set(salt, MAGIC.length + 1);
        const records = [];
        const files = [];
        return api.key(own, me.pub, salt).then(function (key) {
            // One at a time: only its sealed copy stays.
            return notes.reduce((done, note) => done.then(() => soundOf(note)).then(function (sound) {
                if (!sound || !sound.bytes) {
                    return;
                }
                const plain = new Uint8Array(sound.bytes);
                files.push({ id: note.id, type: sound.type || note.mime, size: plain.length });
                return api.seal(key, files.length, plain).then(sealed => { records.push(length(sealed.length), sealed); });
            }), Promise.resolve()).then(function () {
                const index = { v: VERSION, pub: me.pub, name: me.name, at: at, notes: notes, types: types, files: files };
                return api.seal(key, 0, utf8(JSON.stringify(index)));
            });
        }).then(sealed => ({
            blob: new Blob([head, length(sealed.length), sealed].concat(records), { type: 'application/octet-stream' }),
            files: files.length
        }));
    };

    /**
     * Opens a backup - a Blob, or a File the user picked - for `me`, with
     * `own`. Resolves to `{at, notes, types, files, sound}`, where `sound(i)`
     * resolves to the bytes of the i-th entry of `files`. Rejects, saying
     * why, a file that is not a backup, is cut short, or does not open with
     * this key.
     */
    api.read = function (own, me, blob) {
        if (!blob || !(blob.size > HEAD + 4)) {
            return Promise.reject(new Error('that is not a Rama backup'));
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
                throw new Error('that is not a Rama backup');
            }
            if (head[MAGIC.length] !== VERSION) {
                throw new Error('that backup is from a newer Rama - update this one first');
            }
            return api.key(own, me.pub, head.subarray(MAGIC.length + 1));
        }).then(function (made) {
            key = made;
            return at(HEAD);
        }).then(function (place) {
            return slice(blob, place.from, place.to)
                .then(sealed => api.open(key, 0, sealed))
                .catch(function () {
                    throw new Error('it does not open with your ID Card - it is somebody else\'s backup, or it is damaged');
                })
                .then(function (plain) {
                    index = JSON.parse(new TextDecoder().decode(plain));
                    if (!index || index.pub !== me.pub || !Array.isArray(index.notes) || !Array.isArray(index.files)) {
                        throw new Error('it is somebody else\'s backup');
                    }
                    return place.to;
                });
        }).then(function (next) {
            // Where every sound is, so one cut short is found before anything is restored.
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
                notes: index.notes,
                types: Array.isArray(index.types) ? index.types : [],
                files: index.files,
                sound: i => slice(blob, offsets[i].from, offsets[i].to).then(sealed => api.open(key, i + 1, sealed))
            };
        });
    };

    return api;
})();
