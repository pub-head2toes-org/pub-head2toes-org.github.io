'use strict';

/**
 * The signed-in identity.
 *
 * The private key lives in this closure, in memory, for the life of the page
 * and no longer. Local storage only ever holds the public key and the user
 * name. A page that needs to mint a session cookie must be handed an ID Card
 * first - that is what "Load Id Card" is for.
 *
 * The session cookie it mints lasts a day, so the key is only needed when a
 * new one is due, not on every visit.
 *
 * Depends on sjcl.js, cookies.js and idcard.js.
 */
const session = (function () {

    const COOKIE = 'ssid';
    const DAYS = 1;
    const PUB = 'pub';
    const NAME = 'pub_name';
    const LEGACY_PRIV = 'priv';
    const LOGGED_OUT = 'notloggedin';
    // Everybody is called something, even the visitor who would rather not be.
    const UNKNOWN = 'UNKNOWN';

    // The private key, never written to storage.
    let held = null;

    const store = () => window.localStorage;

    const secretKeyFrom = privB64 => new sjcl.ecc.ecdsa.secretKey(
        sjcl.ecc.curves.c256,
        sjcl.ecc.curves.c256.field.fromBits(sjcl.codec.base64.toBits(privB64)));

    const api = {};

    /** The public key this browser is registered as, or '' when there is none. */
    api.pub = function () {
        const pub = store()[PUB];
        return !pub || pub === LOGGED_OUT ? '' : pub;
    };

    api.userName = function () {
        return store()[NAME] || '';
    };

    /** Stores the typed name, or UNKNOWN when nothing was typed. */
    api.rememberUserName = function (username) {
        const clean = idcard.cleanName(username) || UNKNOWN;
        store()[NAME] = clean;
        return clean;
    };

    /** True once an ID Card has been loaded into this page and can sign. */
    api.unlocked = function () {
        return !!held;
    };

    /** True when this browser already knows who it is, key loaded or not. */
    api.known = function () {
        return !!api.pub();
    };

    /** True while the session cookie is live and belongs to the stored key. */
    api.signedIn = function () {
        const value = getCookie(COOKIE);
        return !!value && !!api.pub() && value.split('.')[0] === api.pub();
    };

    /** Takes an ID Card into memory; only its public half is persisted. */
    api.unlock = function (card) {
        if (!card || !card.pub || !card.priv) {
            throw new Error('this ID Card has no key pair in it');
        }
        // A v1 card carries no name. Keep the stored one only when it belongs to
        // this same key, or the previous user's name would end up on it.
        const sameIdentity = api.pub() === card.pub;

        held = { priv: card.priv, sec: secretKeyFrom(card.priv) };
        store()[PUB] = card.pub;
        if (idcard.cleanName(card.username) || !sameIdentity) {
            api.rememberUserName(card.username);
        }
        return api;
    };

    /**
     * A key pair that belongs to nobody yet: it is not held, not stored, and
     * signs nothing until `adopt` makes it this browser's identity. Reg.html
     * drafts one on every visit so the Save button always has a pair to save,
     * whether or not an ID Card happens to be loaded.
     */
    api.draft = function () {
        const keys = sjcl.ecc.ecdsa.generateKeys(256);
        return {
            pub: sjcl.codec.base64.fromBits(keys.pub.get().x.concat(keys.pub.get().y)),
            priv: sjcl.codec.base64.fromBits(keys.sec.get()),
            sec: keys.sec
        };
    };

    /** Takes a drafted pair as this browser's identity, replacing any other. */
    api.adopt = function (draft, username) {
        held = { priv: draft.priv, sec: draft.sec };
        store()[PUB] = draft.pub;
        api.rememberUserName(username);
        return api.card();
    };

    /** A brand new identity. It exists only in memory until its ID Card is saved. */
    api.generate = function (username) {
        return api.adopt(api.draft(), username);
    };

    /** The ID Card for download. Needs the key, so the page must be unlocked. */
    api.card = function () {
        if (!held) {
            throw new Error('load your ID Card first');
        }
        return idcard.build(api.userName(), api.pub(), held.priv);
    };

    /** What gets registered in the database: never the private key. */
    api.publicRecord = function () {
        return idcard.publicRecord(idcard.build(api.userName(), api.pub(), 'unused'));
    };

    /** Signs <pub>.<timestamp> and drops it in the ssid cookie. */
    api.mintCookie = function () {
        if (!held) {
            throw new Error('load your ID Card first');
        }
        const ssId = api.pub() + '.' + new Date().getTime();
        const sig = sjcl.codec.base64.fromBits(held.sec.sign(sjcl.hash.sha256.hash(ssId)));
        const value = ssId + '.' + sig;
        setCookie(COOKIE, value, DAYS);
        return value;
    };

    /** Forgets everything: the key in memory, the stored identity, the cookie. */
    api.forget = function () {
        held = null;
        store()[PUB] = LOGGED_OUT;
        delete store()[NAME];
        delete store()[LEGACY_PRIV];
        setCookie(COOKIE, '', -1);
    };

    /**
     * Earlier versions kept the private key in local storage. Take any key left
     * there into memory so the user stays signed in, and scrub it on the way
     * past - this runs once, when the script loads.
     */
    api.adoptLegacyKey = function () {
        let stored;
        try {
            stored = store()[LEGACY_PRIV];
        } catch (e) {
            return false;   // storage unavailable; nothing to adopt
        }
        if (!stored) {
            return false;
        }
        delete store()[LEGACY_PRIV];

        if (stored === LOGGED_OUT || !api.pub()) {
            return false;
        }
        try {
            held = { priv: stored, sec: secretKeyFrom(stored) };
            return true;
        } catch (e) {
            held = null;
            return false;
        }
    };

    api.adoptLegacyKey();

    return api;
})();
