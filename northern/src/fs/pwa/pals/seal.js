'use strict';

/**
 * End-to-end sealing between two pals, in the browser (UPDATE_2).
 *
 * The key for a message is HKDF-SHA256 over ECDH(own private key, other's
 * public key), with a fresh salt and the direction in the info string:
 * "Pals v2\0" ‖ from point ‖ to point. Only the two key holders can make it,
 * so the server can neither read a message nor forge one. A message opens
 * only from the sender it names, and only in the direction it was sent, so it
 * cannot be bounced back to its sender as the other pal's.
 *
 *   sealed = 2 | salt(16) | iv(12) | AES-256-GCM({ts, body}) | tag(16), base64url
 *
 * `v, from, to, id, part, parts` are AES-GCM additional data. They travel
 * beside the seal, in clear inside the push encryption, and none of them can
 * be changed without the seal failing to open.
 *
 * Works in a page and in a service worker. The private key is the one
 * reg/keystore.js keeps: not extractable, ECDH only.
 */
const PalsSeal = (function () {

    const VERSION = 2;
    const INFO = 'Pals v2\0';
    const subtle = () => crypto.subtle;
    const utf8 = text => new TextEncoder().encode(text);

    const bytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const b64u = list => {
        let text = '';
        for (let i = 0; i < list.length; i += 0x8000) {
            text += String.fromCharCode.apply(null, list.subarray(i, i + 0x8000));
        }
        return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    const join = function () {
        const parts = Array.prototype.slice.call(arguments);
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        parts.forEach(p => { out.set(p, at); at += p.length; });
        return out;
    };

    /** A Northern public key (x ‖ y, base64) as the 65-byte point WebCrypto takes. */
    const point = pub => join(Uint8Array.of(4), bytes(pub));

    const additional = (from, to, id, part, parts) =>
        utf8(['Pals', VERSION, from, to, id, part, parts].join('\0'));

    /** The AES key for one message from `from` to `to`; `own` is whichever end's private key this is. */
    function messageKey(own, other, from, to, salt) {
        return subtle().importKey('raw', point(other), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
            .then(publicKey => subtle().deriveBits({ name: 'ECDH', public: publicKey }, own, 256))
            .then(secret => subtle().importKey('raw', secret, 'HKDF', false, ['deriveKey']))
            .then(ikm => subtle().deriveKey(
                { name: 'HKDF', hash: 'SHA-256', salt: salt, info: join(utf8(INFO), point(from), point(to)) },
                ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    }

    const api = {};
    api.VERSION = VERSION;

    /**
     * Seals `{ts, body}` from `from` (whose private key is `own`) to `to`.
     * `wire` is `{id, part, parts}`. Resolves to the base64url seal.
     */
    api.seal = function (own, from, to, wire, inner) {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        return messageKey(own, to, from, to, salt)
            .then(key => subtle().encrypt({ name: 'AES-GCM', iv: iv, additionalData: additional(from, to, wire.id, wire.part, wire.parts) },
                key, utf8(JSON.stringify({ ts: inner.ts, body: inner.body }))))
            .then(sealed => b64u(join(Uint8Array.of(VERSION), salt, iv, new Uint8Array(sealed))));
    };

    /**
     * Opens what arrived for `to` (whose private key is `own`):
     * `{v, from, to, id, part, parts, sealed}`. Resolves to the envelope the
     * model files - `{v, from, to, id, part, parts, ts, body}` - or rejects.
     */
    api.open = function (own, outer) {
        const o = outer || {};
        let raw;
        try {
            raw = bytes(String(o.sealed || ''));
        } catch (e) {
            return Promise.reject(new Error('not a sealed message'));
        }
        if (o.v !== VERSION || raw.length < 46 || raw[0] !== VERSION) {
            return Promise.reject(new Error('not a sealed Pals v2 message'));
        }
        return messageKey(own, o.from, o.from, o.to, raw.subarray(1, 17))
            .then(key => subtle().decrypt({ name: 'AES-GCM', iv: raw.subarray(17, 29), additionalData: additional(o.from, o.to, o.id, o.part, o.parts) },
                key, raw.subarray(29)))
            .then(function (plain) {
                const inner = JSON.parse(new TextDecoder().decode(plain));
                return { v: VERSION, from: o.from, to: o.to, id: o.id, part: o.part, parts: o.parts, ts: inner.ts, body: inner.body };
            });
    };

    /**
     * A key's fingerprint: 30 digits in six groups, from SHA-256 of the key.
     * Two people read them to each other - each sees their own under "Your
     * key" - and a pal whose number matches is marked verified. About 100
     * bits, against the 30 of the five letters shown beside a name.
     */
    api.fingerprint = function (pub) {
        return subtle().digest('SHA-256', join(utf8('Pals fingerprint v1\0'), bytes(pub))).then(function (hash) {
            const h = new Uint8Array(hash);
            const groups = [];
            for (let i = 0; i < 6; i++) {
                let n = 0;
                for (let j = 0; j < 5; j++) {
                    n = n * 256 + h[i * 5 + j];
                }
                groups.push(String(n % 100000).padStart(5, '0'));
            }
            return groups.join(' ');
        });
    };

    return api;
})();
