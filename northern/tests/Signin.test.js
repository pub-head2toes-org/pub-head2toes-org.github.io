'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadRegPage } from './helpers/regPage.js';

const PUB = 'JaCSWcLSex79JkDmRHekEX33avJ9L9/dsTdWqBYk4WPSVy5mKRvFNTx+fqCHIHWba2Yr+8lVX938wQn3HHDkww==';
const PRIV = 'Q0oPz9y8DzB1Ux1S2vJk0jHFPBOTFAn7l2QolO+FvGE=';
const CARD = JSON.stringify({ v: 2, username: 'alice', pub: PUB, priv: PRIV });

const signinPage = (options = {}) => loadRegPage({ page: 'Signin.html', ...options });

/**
 * Signin.html is the other door into the same identity: load an ID Card, get a
 * session cookie. It goes through session.js too, so the private key is held in
 * the page and never stored.
 */
describe('Signin.html', () => {
    it('signs in from an ID Card and mints a session cookie', async () => {
        const page = signinPage();

        await page.upload(CARD);

        assert.ok(page.cookie().startsWith(`ssid=${PUB}.`));
        assert.strictEqual(page.cookie().split('.').length, 3);
    });

    it('stores the public half and the user name, never the private key', async () => {
        const page = signinPage();

        await page.upload(CARD);

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.strictEqual(page.localStorage.pub_name, 'alice');
        assert.ok(!('priv' in page.localStorage));
        assert.ok(!JSON.stringify(page.localStorage).includes(PRIV));
    });

    it('keeps the key in memory, where it can sign', async () => {
        const page = signinPage();

        await page.upload(CARD);

        assert.strictEqual(page.session.unlocked(), true);
        assert.strictEqual(page.session.card().priv, PRIV);
    });

    it('still accepts a v1 card', async () => {
        const page = signinPage();

        await page.upload(`${PUB}.${PRIV}`);

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.ok(page.cookie().startsWith(`ssid=${PUB}.`));
    });

    // New here: the old page could only read the plain "<pub>.<priv>" format
    it('accepts an encrypted card with its passphrase', async () => {
        const page = signinPage();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        page.element('passphrase').value = 's3cret';

        await page.upload(envelope);

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.ok(page.cookie().startsWith(`ssid=${PUB}.`));
    });

    it('reports a wrong passphrase and signs nobody in', async () => {
        const page = signinPage();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        page.element('passphrase').value = 'wrong';

        await page.upload(envelope);

        assert.match(page.element('msg').innerHTML, /wrong passphrase/);
        assert.strictEqual(page.cookie(), '');
        assert.strictEqual(page.session.unlocked(), false);
    });

    it('reports a file that is not an ID Card', async () => {
        const page = signinPage();

        await page.upload('nonsense');

        assert.match(page.element('msg').innerHTML, /not an ID Card/);
        assert.strictEqual(page.cookie(), '');
    });
});
