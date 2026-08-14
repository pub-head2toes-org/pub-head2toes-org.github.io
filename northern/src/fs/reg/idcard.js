'use strict';

/**
 * The ID Card: the user's identity as it is held in local storage, registered
 * in the database, and carried between devices as a downloaded file.
 *
 * File format v2 is JSON and carries the user name alongside the key pair:
 *
 *     {"v":2,"username":"alice","pub":"<base64>","priv":"<base64>"}
 *
 * With a passphrase, that document is encrypted with AES-256-CBC and wrapped
 * in an envelope:
 *
 *     {"v":2,"enc":"AES-256-CBC","kdf":"PBKDF2-SHA256-1000","ct":"<base64>"}
 *
 * Uploads accept both, plus the v1 format ("<pub>.<priv>"), so ID Cards saved
 * before user names existed keep working.
 *
 * Depends on oo.js for the key derivation and the AES primitives.
 */
const idcard = {};

idcard.VERSION = 2;
idcard.ENC = 'AES-256-CBC';
idcard.KDF = 'PBKDF2-SHA256-1000';

idcard.build = function (username, pub, priv) {
    return {
        v: idcard.VERSION,
        username: idcard.cleanName(username),
        pub: pub,
        priv: priv
    };
};

idcard.serialize = function (card) {
    return JSON.stringify({
        v: idcard.VERSION,
        username: idcard.cleanName(card.username),
        pub: card.pub,
        priv: card.priv
    });
};

/** True when the text is an encrypted envelope rather than a plain card. */
idcard.isEncrypted = function (text) {
    const envelope = idcard.asJSON(text);
    return !!(envelope && envelope.ct);
};

idcard.asJSON = function (text) {
    if (typeof text !== 'string') {
        return null;
    }
    const trimmed = text.trim();
    if (trimmed.charAt(0) !== '{') {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch (e) {
        return null;
    }
};

/** Reads a plain (unencrypted) ID Card in either the v2 or the v1 format. */
idcard.parse = function (text) {
    if (typeof text !== 'string' || !text.trim()) {
        throw new Error('the ID Card file is empty');
    }
    const trimmed = text.trim();
    const parsed = idcard.asJSON(trimmed);

    if (parsed) {
        if (parsed.ct) {
            throw new Error('this ID Card is encrypted - enter its passphrase');
        }
        if (!parsed.pub || !parsed.priv) {
            throw new Error('this ID Card has no key pair in it');
        }
        return {
            v: parsed.v || idcard.VERSION,
            username: idcard.cleanName(parsed.username),
            pub: parsed.pub,
            priv: parsed.priv
        };
    }

    // v1: "<pub>.<priv>" - base64 never contains a dot, so there are exactly two parts.
    const parts = trimmed.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error('this file is not an ID Card');
    }
    return { v: 1, username: '', pub: parts[0], priv: parts[1] };
};

idcard.encrypt = async function (card, passphrase) {
    if (!passphrase) {
        throw new Error('a passphrase is required to encrypt an ID Card');
    }
    const keyObject = await oo.idme(passphrase);
    const ciphertext = await oo.encrypt(idcard.serialize(card), keyObject);

    return JSON.stringify({
        v: idcard.VERSION,
        enc: idcard.ENC,
        kdf: idcard.KDF,
        ct: oo.ab2b64(ciphertext)
    });
};

idcard.decrypt = async function (text, passphrase) {
    const envelope = idcard.asJSON(text);
    if (!envelope || !envelope.ct) {
        throw new Error('this ID Card is not encrypted');
    }
    if (!passphrase) {
        throw new Error('this ID Card is encrypted - enter its passphrase');
    }

    const keyObject = await oo.idme(passphrase);
    let plaintext;
    try {
        plaintext = await oo.decrypt(oo.str2ab(envelope.ct), keyObject);
    } catch (e) {
        // AES-CBC fails its padding check on a wrong key far more often than not,
        // but a wrong passphrase can also decrypt to garbage that parse() rejects.
        throw new Error('wrong passphrase for this ID Card');
    }
    return idcard.parse(plaintext);
};

/** Reads any ID Card; the passphrase is only consulted for encrypted ones. */
idcard.open = async function (text, passphrase) {
    if (idcard.isEncrypted(text)) {
        return await idcard.decrypt(text, passphrase);
    }
    return idcard.parse(text);
};

/** The file to download: encrypted when a passphrase is given, plain otherwise. */
idcard.toFile = async function (card, passphrase) {
    const encrypted = !!passphrase;
    const content = encrypted
        ? await idcard.encrypt(card, passphrase)
        : idcard.serialize(card);

    if (encrypted) {
        // Never hand out a file that cannot be read back.
        await idcard.decrypt(content, passphrase);
    }

    return { content: content, encrypted: encrypted, name: idcard.fileName(card.username, encrypted) };
};

idcard.cleanName = function (username) {
    return String(username === undefined || username === null ? '' : username).trim();
};

/** The user name reduced to characters that survive a round trip through a file system. */
idcard.safeName = function (username) {
    return idcard.cleanName(username)
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
};

idcard.timestamp = function (date) {
    return (date || new Date()).toISOString().slice(0, 19).replace(/[-:]/g, '');
};

/** e.g. alice.20260814T103000.id.txt, or alice*.20260814T103000.id.txt when encrypted. */
idcard.fileName = function (username, encrypted, date) {
    const prefix = idcard.safeName(username) + (encrypted ? '*' : '');
    return (prefix ? prefix + '.' : '') + idcard.timestamp(date) + '.id.txt';
};

/** What gets registered in the database - the private key never leaves the device. */
idcard.publicRecord = function (card) {
    const record = { pub: card.pub };
    const username = idcard.cleanName(card.username);
    if (username) {
        record.pub_name = username;
    }
    return record;
};
