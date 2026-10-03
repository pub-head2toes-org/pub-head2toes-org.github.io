'use strict';

/**
 * The signed-in identity's private key, kept for key agreement only.
 *
 * Apps that seal messages between users (Pals) need the private key long
 * after the ID Card was loaded - in a service worker, with no page open. It
 * is kept here, in IndexedDB, as a WebCrypto key that is:
 *
 *   - not extractable: no script, this one included, can read it back out;
 *   - ECDH only (`deriveBits`): it cannot sign, so it cannot mint a Northern
 *     session cookie or register anything.
 *
 * session.js files it whenever an ID Card is loaded or created on a page that
 * loads this script, and deletes it on forget(). IndexedDB belongs to one
 * origin, so the key is kept per host name (FEATURES J6).
 *
 * Works in a page and in a service worker; does nothing where there is no
 * IndexedDB or WebCrypto.
 */
const NorthernKeys = (function () {

    const NAME = 'northern';
    const VERSION = 1;
    const STORE = 'keys';

    let opening = null;

    const done = request => new Promise(function (resolve, reject) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    function db() {
        if (!opening) {
            opening = new Promise(function (resolve, reject) {
                const request = indexedDB.open(NAME, VERSION);
                request.onupgradeneeded = function () {
                    if (!request.result.objectStoreNames.contains(STORE)) {
                        request.result.createObjectStore(STORE);
                    }
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            opening.catch(() => { opening = null; });
        }
        return opening;
    }

    function run(mode, call) {
        return db().then(function (handle) {
            const tx = handle.transaction(STORE, mode);
            const result = done(call(tx.objectStore(STORE)));
            result.catch(() => {});
            return new Promise(function (resolve, reject) {
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('the key was not kept'));
            });
        });
    }

    const bytes = b64 => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const b64u = list => btoa(String.fromCharCode.apply(null, list)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const api = {};

    api.available = function () {
        return typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && !!crypto.subtle;
    };

    /**
     * The JWK for a Northern key pair: `pub` is x then y (64 bytes, base64),
     * `priv` the secret exponent (base64), which SJCL writes without leading
     * zero bytes - so it is padded back to 32.
     */
    api.jwk = function (pub, priv) {
        const point = bytes(pub);
        const secret = bytes(priv);
        if (point.length !== 64 || secret.length > 32) {
            throw new Error('not a P-256 key pair');
        }
        const d = new Uint8Array(32);
        d.set(secret, 32 - secret.length);
        return { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(0, 32)), y: b64u(point.subarray(32)), d: b64u(d) };
    };

    /** Imports the key for ECDH only, not extractable, and files it under its public key. */
    api.keep = function (pub, priv) {
        return crypto.subtle.importKey('jwk', api.jwk(pub, priv), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
            .then(key => run('readwrite', s => s.put({ key: key, at: Date.now() }, pub)));
    };

    /** The kept key for a public key, or null. */
    api.get = function (pub) {
        return run('readonly', s => s.get(pub)).then(record => record && record.key || null);
    };

    api.forget = function (pub) {
        return run('readwrite', s => s.delete(pub));
    };

    return api;
})();
