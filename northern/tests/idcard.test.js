'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const REG_DIR = path.join(import.meta.dirname, '..', 'src', 'fs', 'reg');

/**
 * oo.js and idcard.js are classic browser scripts that share one global scope.
 * They are loaded here as a single script in a vm context holding the handful
 * of browser globals they touch - Node supplies WebCrypto, TextEncoder and
 * base64 natively, so nothing has to be faked.
 */
function loadRegScripts() {
    const context = vm.createContext({
        window: { atob, btoa, crypto },
        crypto, TextEncoder, TextDecoder, atob, btoa, console
    });
    const source = [
        fs.readFileSync(path.join(REG_DIR, 'oo.js'), 'utf8'),
        fs.readFileSync(path.join(REG_DIR, 'idcard.js'), 'utf8'),
        ';({ oo, idcard });'
    ].join('\n');

    return vm.runInContext(source, context);
}

const { idcard } = loadRegScripts();

/** Objects made inside the vm carry its own prototypes; flatten before comparing to literals. */
const plain = value => JSON.parse(JSON.stringify(value));

const PUB = 'JaCSWcLSex79JkDmRHekEX33avJ9L9/dsTdWqBYk4WPSVy5mKRvFNTx+fqCHIHWba2Yr+8lVX938wQn3HHDkww==';
const PRIV = 'Q0oPz9y8DzB1Ux1S2vJk0jHFPBOTFAn7l2QolO+FvGE=';

// The user name travels with the key pair (UPDATE_2 improvements 1-3)
describe('idcard.build / serialize / parse', () => {
    it('carries the user name alongside the key pair', () => {
        const card = idcard.build('alice', PUB, PRIV);

        assert.strictEqual(card.username, 'alice');
        assert.strictEqual(card.pub, PUB);
        assert.strictEqual(card.priv, PRIV);
        assert.strictEqual(card.v, 2);
    });

    it('round trips through the file format', () => {
        const card = idcard.build('alice', PUB, PRIV);
        const reread = idcard.parse(idcard.serialize(card));

        assert.deepStrictEqual(reread, card);
    });

    it('trims the user name and tolerates it being absent', () => {
        assert.strictEqual(idcard.build('  alice  ', PUB, PRIV).username, 'alice');
        assert.strictEqual(idcard.build(undefined, PUB, PRIV).username, '');
        assert.strictEqual(idcard.build('', PUB, PRIV).username, '');
    });

    it('keeps user names with spaces and dots intact inside the card', () => {
        const card = idcard.build('Ann M. O’Neill', PUB, PRIV);
        assert.strictEqual(idcard.parse(idcard.serialize(card)).username, 'Ann M. O’Neill');
    });

    it('serialises as JSON with the keys the database record is built from', () => {
        const parsed = JSON.parse(idcard.serialize(idcard.build('alice', PUB, PRIV)));

        assert.deepStrictEqual(Object.keys(parsed).sort(), ['priv', 'pub', 'username', 'v']);
    });

    // Backwards compatibility: cards saved before this change
    it('still reads a v1 "<pub>.<priv>" card, with no user name', () => {
        const card = idcard.parse(`${PUB}.${PRIV}`);

        assert.strictEqual(card.v, 1);
        assert.strictEqual(card.pub, PUB);
        assert.strictEqual(card.priv, PRIV);
        assert.strictEqual(card.username, '');
    });

    it('rejects an empty file', () => {
        assert.throws(() => idcard.parse(''), /empty/);
        assert.throws(() => idcard.parse('   '), /empty/);
    });

    it('rejects a file that is not an ID Card', () => {
        assert.throws(() => idcard.parse('hello world'), /not an ID Card/);
        assert.throws(() => idcard.parse('a.b.c'), /not an ID Card/);
    });

    it('rejects JSON without a key pair', () => {
        assert.throws(() => idcard.parse('{"v":2,"username":"alice"}'), /no key pair/);
    });

    it('points at the passphrase when handed an encrypted card', () => {
        assert.throws(() => idcard.parse('{"v":2,"enc":"AES-256-CBC","ct":"abc"}'), /passphrase/);
    });
});

// Optional passphrase (UPDATE_2 improvement 5)
describe('idcard encryption', () => {
    it('encrypts a card so the keys are not readable in the file', async () => {
        const card = idcard.build('alice', PUB, PRIV);
        const envelope = await idcard.encrypt(card, 'correct horse battery staple');

        assert.ok(!envelope.includes(PRIV), 'private key must not appear in the file');
        assert.ok(!envelope.includes('alice'), 'user name must not appear in the file');
        assert.strictEqual(JSON.parse(envelope).enc, 'AES-256-CBC');
        assert.strictEqual(JSON.parse(envelope).kdf, 'PBKDF2-SHA256-1000');
    });

    it('decrypts back to the original card, user name included', async () => {
        const card = idcard.build('alice', PUB, PRIV);
        const envelope = await idcard.encrypt(card, 's3cret');

        assert.deepStrictEqual(await idcard.decrypt(envelope, 's3cret'), card);
    });

    it('refuses the wrong passphrase', async () => {
        const envelope = await idcard.encrypt(idcard.build('alice', PUB, PRIV), 's3cret');

        await assert.rejects(() => idcard.decrypt(envelope, 'not-it'), /wrong passphrase/);
    });

    it('refuses to decrypt with no passphrase at all', async () => {
        const envelope = await idcard.encrypt(idcard.build('alice', PUB, PRIV), 's3cret');

        await assert.rejects(() => idcard.decrypt(envelope, ''), /passphrase/);
    });

    it('will not encrypt without a passphrase', async () => {
        await assert.rejects(() => idcard.encrypt(idcard.build('alice', PUB, PRIV), ''), /passphrase is required/);
    });

    it('recognises which files are encrypted', async () => {
        const envelope = await idcard.encrypt(idcard.build('alice', PUB, PRIV), 's3cret');

        assert.strictEqual(idcard.isEncrypted(envelope), true);
        assert.strictEqual(idcard.isEncrypted(idcard.serialize(idcard.build('alice', PUB, PRIV))), false);
        assert.strictEqual(idcard.isEncrypted(`${PUB}.${PRIV}`), false);
        assert.strictEqual(idcard.isEncrypted('not json at all'), false);
    });

    it('survives a passphrase with spaces and unicode', async () => {
        const card = idcard.build('alice', PUB, PRIV);
        const passphrase = 'långt lösenord med ✨ mellanslag';

        assert.deepStrictEqual(await idcard.decrypt(await idcard.encrypt(card, passphrase), passphrase), card);
    });
});

// The single entry point the upload handler uses
describe('idcard.open', () => {
    it('opens a plain card without a passphrase', async () => {
        const card = idcard.build('alice', PUB, PRIV);

        assert.deepStrictEqual(await idcard.open(idcard.serialize(card)), card);
    });

    it('opens a v1 card without a passphrase', async () => {
        assert.strictEqual((await idcard.open(`${PUB}.${PRIV}`)).pub, PUB);
    });

    it('opens an encrypted card with its passphrase', async () => {
        const card = idcard.build('alice', PUB, PRIV);
        const envelope = await idcard.encrypt(card, 's3cret');

        assert.deepStrictEqual(await idcard.open(envelope, 's3cret'), card);
    });
});

// What the download button produces (UPDATE_2 improvement 4)
describe('idcard.toFile', () => {
    it('produces a plain file named after the user when there is no passphrase', async () => {
        const file = await idcard.toFile(idcard.build('alice', PUB, PRIV), '');

        assert.strictEqual(file.encrypted, false);
        assert.match(file.name, /^alice\.\d{8}T\d{6}\.id\.txt$/);
        assert.deepStrictEqual(idcard.parse(file.content), idcard.build('alice', PUB, PRIV));
    });

    it('marks the file name with * when a passphrase is set', async () => {
        const file = await idcard.toFile(idcard.build('alice', PUB, PRIV), 's3cret');

        assert.strictEqual(file.encrypted, true);
        assert.match(file.name, /^alice\*\.\d{8}T\d{6}\.id\.txt$/);
        assert.strictEqual(idcard.isEncrypted(file.content), true);
    });

    it('verifies the encrypted file can be read back before handing it over', async () => {
        const card = idcard.build('alice', PUB, PRIV);
        const file = await idcard.toFile(card, 's3cret');

        assert.deepStrictEqual(await idcard.open(file.content, 's3cret'), card);
    });
});

describe('idcard.fileName', () => {
    const date = new Date('2026-08-14T10:30:00.000Z');

    it('uses the user name and a timestamp', () => {
        assert.strictEqual(idcard.fileName('alice', false, date), 'alice.20260814T103000.id.txt');
    });

    it('appends * right after the user name when encrypted', () => {
        assert.strictEqual(idcard.fileName('alice', true, date), 'alice*.20260814T103000.id.txt');
    });

    it('falls back to the bare timestamp when there is no user name', () => {
        assert.strictEqual(idcard.fileName('', false, date), '20260814T103000.id.txt');
        assert.strictEqual(idcard.fileName('', true, date), '*.20260814T103000.id.txt');
    });

    it('keeps path separators and other awkward characters out of the name', () => {
        assert.strictEqual(idcard.safeName('../../etc/passwd'), 'etc-passwd');
        assert.strictEqual(idcard.safeName('Ann M. O’Neill'), 'Ann-M-O-Neill');
        assert.strictEqual(idcard.safeName('  '), '');
        assert.ok(!idcard.fileName('a/b\\c', false, date).includes('/'));
    });

    it('caps a very long user name', () => {
        assert.strictEqual(idcard.safeName('x'.repeat(200)).length, 40);
    });
});

// The record POSTed to /id/... - improvement 3, and the rule that outlives it
describe('idcard.publicRecord', () => {
    it('publishes the public key and the user name', () => {
        assert.deepStrictEqual(
            plain(idcard.publicRecord(idcard.build('alice', PUB, PRIV))),
            { pub: PUB, pub_name: 'alice' });
    });

    it('never includes the private key', () => {
        const record = idcard.publicRecord(idcard.build('alice', PUB, PRIV));

        assert.ok(!('priv' in record));
        assert.ok(!JSON.stringify(record).includes(PRIV));
    });

    it('leaves the user name out when there is none', () => {
        assert.deepStrictEqual(plain(idcard.publicRecord(idcard.build('', PUB, PRIV))), { pub: PUB });
    });
});
