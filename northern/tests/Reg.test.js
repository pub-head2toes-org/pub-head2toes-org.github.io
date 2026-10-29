'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegPage } from './helpers/regPage.js';
import { fakeIndexedDB } from './helpers/palsPage.js';
import Crypto from '../src/h2t/Crypto.js';

const REG_DIR = path.join(import.meta.dirname, '..', 'src', 'fs', 'reg');
const HTML = fs.readFileSync(path.join(REG_DIR, 'Reg.html'), 'utf8');
const CSS = fs.readFileSync(path.join(REG_DIR, 'style.css'), 'utf8');

const PUB = 'JaCSWcLSex79JkDmRHekEX33avJ9L9/dsTdWqBYk4WPSVy5mKRvFNTx+fqCHIHWba2Yr+8lVX938wQn3HHDkww==';
const PRIV = 'Q0oPz9y8DzB1Ux1S2vJk0jHFPBOTFAn7l2QolO+FvGE=';

const CARD = JSON.stringify({ v: 2, username: 'alice', pub: PUB, priv: PRIV });

// A browser that has registered before holds the public half only.
const known = (extra = {}) => ({ pub: PUB, ...extra });
const liveCookie = () => `ssid=${PUB}.${Date.now()}.somesignature`;

/** A page where the user has signed in the only way they can: by loading their ID Card. */
async function signedIn(options = {}) {
    const page = loadRegPage({ localStorage: known(), cookie: liveCookie(), ...options });
    await page.init();
    await page.upload(CARD);
    return page;
}

// The rule this whole design exists for
describe('the private key never reaches local storage', () => {
    it('is absent after a first registration', async () => {
        const page = loadRegPage();
        await page.init();

        assert.ok(page.localStorage.pub, 'the public key is stored');
        assert.ok(!('priv' in page.localStorage), 'the private key is not');
        assert.ok(!JSON.stringify(page.localStorage).includes(page.session.card().priv));
    });

    it('is absent after loading an ID Card', async () => {
        const page = await signedIn();

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.ok(!('priv' in page.localStorage));
        assert.ok(!JSON.stringify(page.localStorage).includes(PRIV));
    });

    it('is absent after saving an ID Card', async () => {
        const page = await signedIn();
        await page.saveToNamedFile();
        page.tapDownload();

        assert.ok(!JSON.stringify(page.localStorage).includes(PRIV));
    });

    it('lives in the page instead, where it can still sign', async () => {
        const page = await signedIn();

        assert.strictEqual(page.session.unlocked(), true);
        assert.strictEqual(page.session.card().priv, PRIV);
        assert.ok(page.session.mintCookie().startsWith(`${PUB}.`));
    });

    // Anyone who registered before this change has a key sitting in storage
    it('takes over a key left by an older version and scrubs it', async () => {
        const page = loadRegPage({ localStorage: { pub: PUB, priv: PRIV, pub_name: 'alice' } });

        assert.ok(!('priv' in page.localStorage), 'the old key is removed from storage');

        await page.init();
        assert.strictEqual(page.session.unlocked(), true, 'and kept in memory, so the user stays signed in');
        assert.ok(page.cookie().startsWith(`ssid=${PUB}.`));
    });

    it('scrubs a logged out marker without adopting it', async () => {
        const page = loadRegPage({ localStorage: { pub: 'notloggedin', priv: 'notloggedin' } });

        assert.ok(!('priv' in page.localStorage));
        assert.strictEqual(page.session.unlocked(), false);
    });
});

describe('Reg.html first visit', () => {
    it('generates a key pair and mints a session cookie', async () => {
        const page = loadRegPage();
        await page.init();

        const value = page.cookie().replace('ssid=', '');
        const parts = value.split('.');

        assert.strictEqual(parts.length, 3);
        assert.strictEqual(parts[0], page.localStorage.pub);
        assert.match(parts[1], /^\d{13}$/);
        assert.ok(parts[2].length > 0);
    });

    it('says the keys are only held in the page', async () => {
        const page = loadRegPage();
        await page.init();

        assert.match(page.element('msg').textContent, /NOT saved in the browser/);
    });

    it('warns before leaving while the new identity is unsaved', async () => {
        const page = loadRegPage();
        await page.init();

        assert.strictEqual(page.warnsOnLeave(), true);
    });

    it('stops warning once the ID Card has been downloaded', async () => {
        const page = loadRegPage();
        await page.init();
        await page.saveToNamedFile();
        page.tapDownload();

        assert.strictEqual(page.warnsOnLeave(), false);
    });

    it('shows the new public key in the Reg section, and only the public one', async () => {
        const page = loadRegPage();
        await page.init();

        assert.strictEqual(page.element('pubkey').value, page.localStorage.pub);
        assert.notStrictEqual(page.element('pubkey').value, page.session.card().priv);
    });

    it('leaves saving the ID Card as the only way on, so the identity cannot be lost by clicking through', async () => {
        const page = loadRegPage();
        await page.init();

        assert.strictEqual(page.window.location.href, '', 'nothing has navigated away yet');
        assert.strictEqual(page.warnsOnLeave(), true);
    });

    it('hides Continue while the new identity is unsaved, cookie or no cookie', async () => {
        const page = loadRegPage();
        await page.init();

        assert.ok(page.cookie().startsWith('ssid='), 'the session is live');
        assert.strictEqual(page.element('continue').hidden, true, 'but leaving now would lose the key');
    });
});

describe('Reg.html returning visitor', () => {
    it('does not generate a new identity for a browser that already has one', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.strictEqual(page.session.unlocked(), false, 'no key is needed while the cookie is live');
        assert.strictEqual(page.warnsOnLeave(), false);
    });

    it('reports the live session and offers to load the ID Card', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();

        assert.match(page.element('msg').textContent, /Signed in as alice/);
    });

    it('asks for the ID Card when the session has expired, keeping the same identity', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }) });
        await page.init();

        assert.match(page.element('msg').textContent, /session has expired/);
        assert.strictEqual(page.localStorage.pub, PUB, 'the identity is not replaced');
        assert.strictEqual(page.cookie(), '', 'and no cookie is minted without the key');
    });

    // UPDATE_7: Reg is for a new identity, so it does not offer the last name
    it('starts with the user name field empty', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();

        assert.strictEqual(page.element('username').value, '');
        assert.match(page.element('msg').textContent, /Signed in as alice/, 'the name is still used to greet');
    });

    it('sends the visitor on to the path in the fragment once the ID Card is loaded', async () => {
        const page = loadRegPage({ hash: '#/fs/get/keyboard.html', localStorage: known(), cookie: liveCookie() });
        await page.init();
        assert.strictEqual(page.window.location.href, '', 'not before that');

        await page.upload(CARD);

        assert.strictEqual(page.window.location.href, '/fs/get/keyboard.html');
    });

    // A live cookie is not a loaded key: the Reg section can only offer a new pair
    it('shows the key it would save, which is not the one it cannot reach', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();

        const shown = page.element('pubkey').value;
        assert.ok(shown, 'a key is offered');
        assert.notStrictEqual(shown, PUB, 'not the signed-in one, whose private half is not here');
        assert.strictEqual(page.localStorage.pub, PUB, 'and the stored identity is left alone');
    });

    it('offers Continue as the user, so a live session needs no file', async () => {
        const page = loadRegPage({ hash: '#/fs/get/keyboard.html', localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();

        const button = page.element('continue');
        assert.strictEqual(button.hidden, false);
        assert.strictEqual(button.textContent, 'Continue as alice');
        assert.strictEqual(button.href, '/fs/get/keyboard.html');
    });

    it('names an unnamed visitor by the head of their public key', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();

        assert.strictEqual(page.element('continue').textContent, `Continue as ${PUB.substr(0, 8)}...`);
    });

    it('offers it to a browser whose key came from an older version', async () => {
        const page = loadRegPage({ localStorage: { pub: PUB, priv: PRIV, pub_name: 'alice' } });
        await page.init();

        assert.strictEqual(page.element('continue').hidden, false, 'the adopted key minted a cookie');
    });

    it('hides it when the session has expired, since there is nothing to continue', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }) });
        await page.init();

        assert.strictEqual(page.element('continue').hidden, true);
    });

    // UPDATE_4 of Pals: offering Reg as well made new users of people who
    // only had to sign in again.
    it('hides Reg when the session has expired, and opens Sign in', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }) });
        await page.init();

        assert.strictEqual(page.element('reg_section').hidden, true);
        assert.strictEqual(page.element('signin_panel').open, true);
        assert.match(page.element('msg').textContent, /Sign in again: load the ID Card for alice/);
        assert.doesNotMatch(page.element('msg').textContent, /open Reg/);
    });

    it('keeps Reg for a brand new visitor, a live session, and a browser that signed out', async () => {
        for (const options of [{}, { localStorage: known(), cookie: liveCookie() }, { localStorage: { pub: 'notloggedin' } }]) {
            const page = loadRegPage(options);
            await page.init();

            assert.notStrictEqual(page.element('reg_section').hidden, true, JSON.stringify(options));
            assert.notStrictEqual(page.element('signin_panel').open, true);
        }
    });

    it('hides Reg as a whole section, so no empty gap is left', () => {
        assert.match(HTML, /<section class="intro" id="reg_section">\s*<details class="panel" name="access" id="reg_panel"/);
    });
});

// UPDATE_2 improvements 1-3
describe('Reg.html user name', () => {
    it('saves the typed user name to local storage', async () => {
        const page = await signedIn();
        page.element('username').value = '  alice  ';

        assert.strictEqual(page.rememberUserName(), 'alice');
        assert.strictEqual(page.localStorage.pub_name, 'alice');
    });

    it('calls a visitor who types no name UNKNOWN', async () => {
        const page = await signedIn();
        page.element('username').value = '';

        assert.strictEqual(page.rememberUserName(), 'UNKNOWN');
        assert.strictEqual(page.localStorage.pub_name, 'UNKNOWN');
    });

    it('registers the user name with the ID Card in the database', async () => {
        const page = await signedIn();
        page.element('username').value = 'alice';

        page.saveIdCard();

        assert.strictEqual(page.requests.length, 1);
        assert.deepStrictEqual(JSON.parse(page.requests[0].body), { pub: PUB, pub_name: 'alice' });
    });

    it('posts the ID Card to /id/<ts>/<pub>.json as a public record', async () => {
        const page = await signedIn();
        page.saveIdCard();

        assert.strictEqual(page.requests[0].method, 'POST');
        assert.match(page.requests[0].url, /^\/id\/\d+\/.+\.json\?isPublic=true$/);
        assert.ok(page.requests[0].url.includes(PUB));
    });

    it('never sends the private key to the server', async () => {
        const page = await signedIn();
        page.element('username').value = 'alice';
        page.saveIdCard();

        assert.ok(!page.requests[0].body.includes(PRIV));
        assert.ok(!page.requests[0].url.includes(PRIV));
    });

    it('registers without the key loaded, since only the public half is sent', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        page.element('username').value = 'alice';

        page.saveIdCard();

        assert.deepStrictEqual(JSON.parse(page.requests[0].body), { pub: PUB, pub_name: 'alice' });
    });
});

// UPDATE_2 improvement 4
describe('Reg.html ID Card download', () => {
    it('names the file after the user and carries the user name inside it', async () => {
        const page = await signedIn();
        page.element('username').value = 'alice';

        await page.saveToNamedFile();
        page.tapDownload();

        assert.strictEqual(page.downloads.length, 1);
        assert.match(page.downloads[0].name, /^alice\.\d{8}T\d{6}\.id\.txt$/);

        const card = page.idcard.parse(page.downloads[0].content);
        assert.strictEqual(card.username, 'alice');
        assert.strictEqual(card.pub, PUB);
        assert.strictEqual(card.priv, PRIV);
    });

    it('registers the card in the database as well as downloading it', async () => {
        const page = await signedIn();

        await page.saveToNamedFile();
        page.tapDownload();
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.strictEqual(page.downloads.length, 1);
        assert.strictEqual(page.requests.length, 1);
    });

    it('names the file for UNKNOWN when no user name is given', async () => {
        const page = await signedIn();
        page.element('username').value = '';

        await page.saveToNamedFile();
        page.tapDownload();

        assert.match(page.downloads[0].name, /^UNKNOWN\.\d{8}T\d{6}\.id\.txt$/);
    });
});

// The bug: a live cookie is not a loaded key, and Save had nothing to write
describe('Reg.html saving without a card loaded', () => {
    it('saves the pair drafted on this visit', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        page.element('username').value = 'bob';

        await page.saveToNamedFile();
        page.tapDownload();

        assert.strictEqual(page.downloads.length, 1);
        const card = page.idcard.parse(page.downloads[0].content);
        assert.strictEqual(card.username, 'bob');
        assert.ok(card.priv, 'with the private half in it, which is the point');
        assert.notStrictEqual(card.pub, PUB, 'a new identity, since the old key is not here');
    });

    it('saves the key it showed in the Reg section', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const offered = page.element('pubkey').value;

        await page.saveToNamedFile();
        page.tapDownload();

        const card = page.idcard.parse(page.downloads[0].content);
        assert.strictEqual(card.pub, offered);
    });

    it('makes that pair the identity: stored, registered and signing the cookie', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();

        await page.saveToNamedFile();
        page.tapDownload();
        await new Promise(resolve => setTimeout(resolve, 0));

        const card = page.idcard.parse(page.downloads[0].content);
        assert.strictEqual(page.localStorage.pub, card.pub);
        assert.strictEqual(page.session.unlocked(), true);
        assert.ok(page.cookie().startsWith(`ssid=${card.pub}.`), 'the cookie is re-signed by the new key');
        assert.deepStrictEqual(JSON.parse(page.requests[0].body), { pub: card.pub, pub_name: 'UNKNOWN' });
        assert.ok(!('priv' in page.localStorage));
    });

    it('changes nothing until the card is actually built', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();
        page.element('passphrase').value = 's3cret';
        page.element('passphrase2').value = 'typo';

        await page.saveToNamedFile();

        assert.notStrictEqual(page.element('saved').hidden, false, 'nothing is offered');
        assert.strictEqual(page.localStorage.pub, PUB, 'the signed-in identity is untouched');
        assert.strictEqual(page.session.unlocked(), false);
    });

    it('also works for a visitor whose session has expired', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }) });
        await page.init();

        await page.saveToNamedFile();
        page.tapDownload();

        assert.strictEqual(page.downloads.length, 1);
        assert.ok(page.cookie().startsWith(`ssid=${page.localStorage.pub}.`));
        assert.notStrictEqual(page.localStorage.pub, PUB);
    });

    it('keeps saving the loaded card once one is loaded, rather than the draft', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const drafted = page.element('pubkey').value;

        await page.upload(CARD);
        await page.saveToNamedFile();
        page.tapDownload();

        assert.strictEqual(page.element('pubkey').value, PUB);
        const card = page.idcard.parse(page.downloads[0].content);
        assert.strictEqual(card.pub, PUB);
        assert.notStrictEqual(card.pub, drafted);
    });
});

// UPDATE_2 improvement 5
describe('Reg.html passphrase', () => {
    it('encrypts the download and marks the file name with *', async () => {
        const page = await signedIn();
        page.element('username').value = 'alice';
        page.element('passphrase').value = 's3cret';
        page.element('passphrase2').value = 's3cret';

        await page.saveToNamedFile();
        page.tapDownload();

        assert.match(page.downloads[0].name, /^alice\*\.\d{8}T\d{6}\.id\.txt$/);

        const content = page.downloads[0].content;
        assert.strictEqual(page.idcard.isEncrypted(content), true);
        assert.ok(!content.includes(PRIV), 'the private key must not be readable in the file');
        assert.ok(!content.includes('alice'), 'the user name must not be readable in the file');
    });

    it('refuses to save when the two passphrases differ', async () => {
        const page = await signedIn();
        page.element('passphrase').value = 's3cret';
        page.element('passphrase2').value = 'typo';

        await page.saveToNamedFile();

        assert.notStrictEqual(page.element('saved').hidden, false, 'nothing is offered');
        assert.strictEqual(page.requests.length, 0, 'nothing is registered');
        assert.strictEqual(page.element('passphrase_error').hidden, false, 'and it says so under the fields');
        assert.match(page.element('msg').textContent, /do not match/);
    });

    it('leaves the download unencrypted when no passphrase is set', async () => {
        const page = await signedIn();

        await page.saveToNamedFile();
        page.tapDownload();

        const content = page.downloads[0].content;
        assert.strictEqual(page.idcard.isEncrypted(content), false);
        assert.ok(!page.downloads[0].name.includes('*'));
    });
});

// UPDATE_10: an eye on each Reg passphrase, and the mismatch said under them
describe('Reg.html passphrase fields', () => {
    it('shows and hides a passphrase with its eye', async () => {
        const page = loadRegPage();
        await page.init();
        for (const id of ['passphrase', 'passphrase2']) {
            page.element(id).type = 'password';

            page.fire(`reveal_${id}`, 'click');
            assert.strictEqual(page.element(id).type, 'text', id);
            assert.strictEqual(page.element(`reveal_${id}`).getAttribute('aria-pressed'), 'true');

            page.fire(`reveal_${id}`, 'click');
            assert.strictEqual(page.element(id).type, 'password', id);
            assert.strictEqual(page.element(`reveal_${id}`).getAttribute('aria-pressed'), 'false');
        }
    });

    it('gives each eye a button that cannot submit anything, and a label', () => {
        for (const id of ['passphrase', 'passphrase2']) {
            const button = HTML.match(new RegExp(`<button[^>]*id="reveal_${id}"[^>]*>`))[0];
            assert.match(button, /type="button"/);
            assert.match(button, /aria-label="Show/);
            assert.match(button, new RegExp(`aria-controls="${id}"`));
        }
    });

    it('says a mismatch under the fields once the repeat is left', async () => {
        const page = loadRegPage();
        await page.init();
        page.element('passphrase_error').hidden = true;   // as the markup starts it
        assert.match(HTML, /<p id="passphrase_error"[^>]*hidden/);
        page.element('passphrase').value = 's3cret';
        page.element('passphrase2').value = 's3cr';

        page.fire('passphrase2', 'input');
        assert.notStrictEqual(page.element('passphrase_error').hidden, false, 'not while still typing');

        page.fire('passphrase2', 'change');
        assert.strictEqual(page.element('passphrase_error').hidden, false);
        assert.strictEqual(page.element('passphrase_error').textContent, 'The passphrases do not match.');
        assert.strictEqual(page.element('passphrase2').getAttribute('aria-invalid'), 'true');

        page.element('passphrase2').value = 's3cret';
        page.fire('passphrase2', 'input');
        assert.strictEqual(page.element('passphrase_error').hidden, true, 'gone as soon as they match');
        assert.strictEqual(page.element('passphrase2').getAttribute('aria-invalid'), 'false');
    });

    it('says it when Save Id Card is pressed, empty repeat included', async () => {
        const page = loadRegPage();
        await page.init();
        page.element('passphrase').value = 's3cret';

        await page.saveToNamedFile();

        assert.strictEqual(page.element('passphrase_error').hidden, false);
        assert.strictEqual(page.element('passphrase_error').textContent, 'Repeat the passphrase.');
        assert.notStrictEqual(page.element('saved').hidden, false, 'nothing offered');
    });

    it('refuses a repeat typed without a passphrase, rather than saving it unencrypted', async () => {
        const page = loadRegPage();
        await page.init();
        page.element('passphrase2').value = 's3cret';

        await page.saveToNamedFile();

        assert.strictEqual(page.element('passphrase_error').hidden, false);
        assert.notStrictEqual(page.element('saved').hidden, false);
    });

    it('marks the field in red, and keeps 16px text in it', () => {
        assert.match(CSS, /input\[aria-invalid="true"\] {[^}]*border-color/);
        assert.match(CSS, /\.field-error {[^}]*color: #f66/);
        assert.doesNotMatch(CSS.slice(CSS.indexOf('.pass-field')), /font-size: (?!16px|0\.9em)/);
    });
});

describe('Reg.html ID Card upload', () => {
    it('loads a v2 card, restoring the identity and the user name', async () => {
        const page = loadRegPage();
        await page.init();

        await page.upload(CARD);

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.strictEqual(page.localStorage.pub_name, 'alice');
        assert.strictEqual(page.element('username').value, 'alice');
        assert.match(page.element('msg').textContent, /ID loaded/);
    });

    it('still loads a v1 "<pub>.<priv>" card saved before user names existed', async () => {
        const page = loadRegPage();
        await page.init();

        await page.upload(`${PUB}.${PRIV}`);

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.strictEqual(page.session.card().priv, PRIV);
        assert.match(page.element('msg').textContent, /ID loaded/);
    });

    it('does not put the last user name on an unnamed card belonging to someone else', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();

        await page.upload(`otherpub.${PRIV}`);

        assert.strictEqual(page.localStorage.pub, 'otherpub');
        assert.strictEqual(page.localStorage.pub_name, 'UNKNOWN');
    });

    it('keeps the name when the unnamed card is that same identity', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();

        await page.upload(`${PUB}.${PRIV}`);

        assert.strictEqual(page.localStorage.pub_name, 'alice');
    });

    it('signs a fresh session cookie with the uploaded key', async () => {
        const page = loadRegPage({ localStorage: known() });
        await page.init();
        assert.strictEqual(page.cookie(), '', 'expired session, nothing signed yet');

        await page.upload(`${PUB}.${PRIV}`);

        assert.ok(page.cookie().startsWith(`ssid=${PUB}.`));
    });

    it('clears the unsaved warning, since the card is evidently already saved', async () => {
        const page = loadRegPage();
        await page.init();
        assert.strictEqual(page.warnsOnLeave(), true);

        await page.upload(CARD);

        assert.strictEqual(page.warnsOnLeave(), false);
    });

    it('decrypts a card when the passphrase field is filled in', async () => {
        const page = loadRegPage();
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        page.element('signin_passphrase').value = 's3cret';

        await page.upload(envelope);

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.strictEqual(page.localStorage.pub_name, 'alice');
    });

    it('asks for the passphrase rather than loading an encrypted card blindly', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');

        await page.upload(envelope);

        assert.match(page.element('msg').textContent, /passphrase/);
        assert.strictEqual(page.session.unlocked(), false, 'nothing was unlocked');
    });

    it('reports a wrong passphrase without disturbing the stored identity', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('bob', 'otherpub', 'otherpriv'), 's3cret');
        page.element('signin_passphrase').value = 'wrong';

        await page.upload(envelope);

        assert.match(page.element('msg').textContent, /wrong passphrase/);
        assert.strictEqual(page.localStorage.pub, PUB);
    });

    it('says under the Sign in passphrase that an encrypted card needs it', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');

        await page.upload(envelope);

        assert.strictEqual(page.element('signin_error').hidden, false);
        assert.strictEqual(page.element('signin_error').textContent,
            'This ID Card is encrypted - enter its passphrase, then tap Load Id Card & Continue.');
        assert.strictEqual(page.element('signin_passphrase').getAttribute('aria-invalid'), 'true');
        assert.match(page.element('msg').textContent, /the same file is opened, with no need to pick it/);
    });

    it('opens the remembered card on the next Load, skipping the file picker', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie(), hash: '#/fs/get/keyboard.html' });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        await page.upload(envelope);

        page.element('signin_passphrase').value = 's3cret';
        const tap = await page.tapLoad();

        assert.strictEqual(tap.picker, false, 'no file picker');
        assert.strictEqual(page.session.unlocked(), true);
        assert.strictEqual(page.session.card().priv, PRIV);
        assert.strictEqual(page.element('signin_error').hidden, true);
        assert.strictEqual(page.element('signin_passphrase').getAttribute('aria-invalid'), 'false');
        assert.strictEqual(page.window.location.href, '/fs/get/keyboard.html', 'and carries on');
    });

    it('opens the file picker once the remembered card failed with this passphrase - it may be the wrong file', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        await page.upload(envelope);

        page.element('signin_passphrase').value = 'wrong';
        assert.strictEqual((await page.tapLoad()).picker, false, 'the first Load after entering it retries');
        assert.strictEqual(page.element('signin_error').textContent,
            'Wrong passphrase for this ID Card - correct it, then tap Load Id Card & Continue.');
        assert.strictEqual((await page.tapLoad()).picker, true, 'the next one picks a file');

        page.element('signin_passphrase').value = 's3cret';
        assert.strictEqual((await page.tapLoad()).picker, false, 'a new passphrase retries the card again');
        assert.strictEqual(page.session.unlocked(), true);
    });

    it('opens the file picker when no passphrase was entered, or no card is waiting', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        assert.strictEqual((await page.tapLoad()).picker, true, 'nothing waiting');

        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        await page.upload(envelope);
        assert.strictEqual((await page.tapLoad()).picker, true, 'still no passphrase');
        assert.strictEqual(page.session.unlocked(), false);
    });

    it('opens no file picker while a card is still being opened', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        await page.upload(envelope);
        page.element('signin_passphrase').value = 's3cret';

        const first = page.tapLoad();
        const second = await page.tapLoad();
        assert.strictEqual(second.picker, false);
        assert.strictEqual((await first).picker, false);
        assert.strictEqual(page.session.unlocked(), true);
    });

    it('opens the remembered card on Enter too, and tries each passphrase once', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        await page.upload(envelope);
        let opened = 0;
        const open = page.idcard.open;
        page.idcard.open = (...args) => { opened++; return open(...args); };

        page.element('signin_passphrase').value = 'wrong';
        await page.fire('signin_passphrase', 'keydown', { key: 'a' });
        assert.strictEqual(opened, 0, 'not while typing');
        await page.fire('signin_passphrase', 'keydown', { key: 'Enter' });
        await page.fire('signin_passphrase', 'keydown', { key: 'Enter' });
        assert.strictEqual(opened, 1, 'the same passphrase is not tried twice');
        assert.strictEqual(page.session.unlocked(), false);

        page.element('signin_passphrase').value = 's3cret';
        await page.fire('signin_passphrase', 'keydown', { key: 'Enter' });
        assert.strictEqual(opened, 2);
        assert.strictEqual(page.session.unlocked(), true);
        assert.strictEqual(page.session.card().priv, PRIV);
        assert.strictEqual(page.element('signin_error').hidden, true);
    });

    it('forgets a waiting card once a card that is not encrypted is picked', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('alice', PUB, PRIV), 's3cret');
        await page.upload(envelope);
        await page.upload('this is just some text');

        page.element('signin_passphrase').value = 's3cret';
        assert.strictEqual((await page.tapLoad()).picker, true);

        assert.strictEqual(page.session.unlocked(), false, 'the encrypted card is no longer waiting');
        assert.strictEqual(page.element('signin_error').hidden, true);
        assert.match(page.element('msg').textContent, /not an ID Card/);
    });

    it('clears the file picker, so the same card can be picked again', async () => {
        const page = loadRegPage();
        await page.init();
        page.element('fileinput').value = 'C:\\fakepath\\card.id.txt';

        await page.upload(CARD);

        assert.strictEqual(page.element('fileinput').value, '');
    });

    it('gives the Sign in passphrase an eye as well', async () => {
        const page = loadRegPage();
        await page.init();
        page.element('signin_passphrase').type = 'password';

        page.fire('reveal_signin_passphrase', 'click');
        assert.strictEqual(page.element('signin_passphrase').type, 'text');
        page.fire('reveal_signin_passphrase', 'click');
        assert.strictEqual(page.element('signin_passphrase').type, 'password');

        const button = HTML.match(/<button[^>]*id="reveal_signin_passphrase"[^>]*>/)[0];
        assert.match(button, /type="button"/);
        assert.match(button, /aria-controls="signin_passphrase"/);
        assert.match(HTML, /<p id="signin_error"[^>]*hidden/);
    });

    it('reports a file that is not an ID Card at all', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();

        await page.upload('this is just some text');

        assert.match(page.element('msg').textContent, /not an ID Card/);
        assert.strictEqual(page.localStorage.pub, PUB);
    });

    // The journey the whole design rests on: save on one device, load on the next
    it('reloads a card it saved itself, passphrase and all', async () => {
        const saving = await signedIn();
        saving.element('username').value = 'alice';
        saving.element('passphrase').value = 'correct horse';
        saving.element('passphrase2').value = 'correct horse';
        await saving.saveToNamedFile();
        saving.tapDownload();
        const content = saving.downloads[0].content;

        const loading = loadRegPage();
        await loading.init();
        loading.element('signin_passphrase').value = 'correct horse';
        await loading.upload(content);

        assert.strictEqual(loading.localStorage.pub, PUB);
        assert.strictEqual(loading.localStorage.pub_name, 'alice');
        assert.strictEqual(loading.session.card().priv, PRIV);
        assert.ok(!('priv' in loading.localStorage));
    });
});

// UPDATE_3: one title, three sections, and a passphrase in each place one is typed
describe('Reg.html layout', () => {
    // UPDATE_7: the header says what the page is for, not which domain it is on
    it('names the page once, at the top', () => {
        const titles = HTML.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) || [];

        assert.strictEqual(titles.length, 1);
        assert.match(titles[0], />\s*User Registration\s*</);
        assert.ok(!/pub\.head2toes\.org/.test(titles[0]));
    });

    it('has an Info, a Sign in and a Reg section, in that order', () => {
        const headings = [...HTML.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m => m[1].trim());

        assert.deepStrictEqual(headings, ['Info', 'Sign in', 'Reg']);
    });

    it('keeps the Info board small and without borders', () => {
        const board = CSS.match(/\.board \.info\s*{([^}]*)}/);

        assert.ok(board);
        assert.ok(!/border/.test(board[1]), 'a div has none unless it is given one');
        assert.match(board[1], /font-size:\s*0?\.\d+em/, 'smaller than the text around it');
        assert.match(board[1], /white-space:\s*pre-wrap/, 'and keeps the line breaks a message is written with');
        assert.match(CSS, /section\.intro\.board h2\s*{[^}]*border-bottom:\s*none/, 'its heading is not underlined either');
    });

    it('gives the buttons rounded corners and a little room around them', () => {
        const button = CSS.match(/\.menu-item\s*{([^}]*)}/);

        assert.match(button[1], /border-radius:\s*\d+px/);
        assert.match(button[1], /margin:\s*\d+px/);
    });

    // UPDATE_7: the Info board is a plain div, written as text
    it('makes the Info board a live region of its own', () => {
        const board = HTML.match(/<div[^>]*id="msg"[^>]*>/);

        assert.ok(board, 'the Info board is in the markup, not built by script');
        assert.match(board[0], /\baria-live="polite"/);
        assert.ok(!/<textarea/.test(HTML), 'and is no longer a text area');
        assert.match(HTML, /getElementById\("msg"\)\.textContent = text/);
        assert.ok(!/innerHTML/.test(HTML), 'and messages are written to it as text');
    });

    it('gives the Sign in section its own passphrase, apart from the one used to save', () => {
        assert.match(HTML, /id="signin_passphrase"[\s\S]*type="file" id="fileinput"/);
        assert.match(HTML, /const passphrase = getSignInPassphrase\(\);\s+let card;\s+try {\s+card = await idcard\.open\(text, passphrase\)/, 'loading uses it');
        assert.match(HTML, /idcard\.toFile\(currentIdCard\(\), passphrase\)/, 'saving uses the other one');
    });

    it('loads and saves through one button each, with no Continue before the card is saved', () => {
        assert.match(HTML, /Load Id Card &amp; Continue/);
        assert.match(HTML, />Save Id Card</);
        assert.ok(!/id="next"/.test(HTML), 'the Continue link is gone from the Reg section');
    });

    it('keeps the live-session Continue in the Sign in section, hidden until it applies', () => {
        const [sign, reg] = HTML.split(/<h2[^>]*>\s*Reg\s*<\/h2>/);
        const button = sign.match(/<a[^>]*id="continue"[^>]*>/);

        assert.ok(button, 'it belongs with Sign in, not with Reg');
        assert.match(button[0], /\bhidden\b/, 'and starts hidden, for the visitors it does not apply to');
        assert.ok(!/id="continue"/.test(reg));
    });

    // .menu-item sets a display, and an author display beats the browser's own
    // [hidden] rule - without this the "hidden" button would be on screen.
    it('makes hidden actually hide, given the class the button wears', () => {
        assert.match(CSS, /\[hidden\]\s*{[^}]*display:\s*none\s*!important/);
        assert.ok(CSS.indexOf('[hidden]') < CSS.indexOf('.menu-item {'), 'and says it before .menu-item');
    });

    // UPDATE_7: the key is still written to the field, but neither it nor its label shows
    it('keeps the public key in a hidden read only field, and never the private one', () => {
        const field = HTML.match(/<input[^>]*id="pubkey"[^>]*>/);
        const label = HTML.match(/<label[^>]*for="pubkey"[^>]*>/);

        assert.ok(field);
        assert.match(field[0], /\breadonly\b/);
        assert.match(field[0], /\bhidden\b/);
        assert.ok(label);
        assert.match(label[0], /\bhidden\b/);
        assert.ok(!/id="priv/.test(HTML), 'there is no field for the private key');
    });
});

// UPDATE_7: Sign in and Reg are an accordion, one panel open at most
describe('Reg.html accordion', () => {
    const panels = () => [...HTML.matchAll(/<details class="panel"[^>]*>/g)].map(m => m[0]);

    it('puts Sign in and Reg each in a panel of one exclusive group', () => {
        const [signin, reg] = panels();

        assert.strictEqual(panels().length, 2);
        assert.match(signin, /id="signin_panel"/);
        assert.match(reg, /id="reg_panel"/);
        for (const panel of [signin, reg]) {
            assert.match(panel, /\bname="access"/, 'a shared name makes the browser close the other one');
            assert.match(panel, /ontoggle="closeOtherPanels\(this\)"/, 'and the script does it where it does not');
        }
    });

    it('puts the same gap under each panel title', () => {
        assert.match(CSS, /details\.panel > \.summary\s*{[^}]*padding-top:\s*\d+px/);
        assert.strictEqual((HTML.match(/<\/summary>\s*<div class="summary"/g) || []).length, 2,
            'and both panels open onto that body');
    });

    it('starts with both panels collapsed', () => {
        for (const panel of panels()) {
            assert.ok(!/\bopen\b/.test(panel), panel);
        }
    });

    it('uses the section headings as the panels\' toggles', () => {
        assert.match(HTML, /<summary><h2>Sign in<\/h2><\/summary>/);
        assert.match(HTML, /<summary><h2>Reg<\/h2><\/summary>/);
    });

    it('closes the other panel when one is opened', () => {
        const page = loadRegPage();
        const signin = page.element('signin_panel');
        const reg = page.element('reg_panel');

        signin.open = true;
        page.closeOtherPanels(signin);
        reg.open = true;
        page.closeOtherPanels(reg);

        assert.strictEqual(reg.open, true);
        assert.strictEqual(signin.open, false);
    });

    it('leaves the other panel alone when one is closed', () => {
        const page = loadRegPage();
        const signin = page.element('signin_panel');
        const reg = page.element('reg_panel');

        reg.open = true;
        signin.open = false;
        page.closeOtherPanels(signin);

        assert.strictEqual(reg.open, true);
    });
});

// UPDATE_10: on the affected iPhones a data: download never finished, whether
// the page clicked it or the visitor tapped it, while a tapped Blob link and
// the share sheet both did (DownloadCheck.html, tests E, F and G). So Save Id
// Card builds the card and offers it; the visitor's own tap saves it. The page
// never leaves by itself, which closed the "Download?" prompt before it was answered.
describe('Reg.html saving on a phone', () => {
    // A few turns of the timers: registration goes on one after a tap, and a
    // retry on another.
    const settle = async () => {
        for (let i = 0; i < 5; i++) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    };

    /** A share sheet that takes files, recording what it was handed. */
    function shareSheet(outcome = async () => {}) {
        const shared = [];
        const navigator = {
            canShare(data) {
                if (this !== navigator) throw new TypeError('Illegal invocation');
                return !!(data.files && data.files.length);
            },
            async share(data) {
                if (this !== navigator) throw new TypeError('Illegal invocation');
                shared.push(data);
                return outcome();
            }
        };
        return { navigator, shared };
    }

    it('offers the card as a link to tap, and saves nothing by itself', async () => {
        const page = loadRegPage({ hash: '#/fs/get/keyboard.html' });
        await page.init();
        page.element('username').value = 'alice';
        await page.saveToNamedFile();
        await settle();

        assert.strictEqual(page.element('saved').hidden, false);
        assert.match(page.element('download_card').download, /^alice\.\d{8}T\d{6}\.id\.txt$/);
        assert.strictEqual(page.element('saved_continue').href, '/fs/get/keyboard.html');
        assert.strictEqual(page.window.location.href, '', 'nothing navigated away');
        assert.match(page.element('msg').textContent, /Your ID Card is ready: alice\./);
        assert.match(page.element('msg').textContent, /Tap "Download Id Card"/);
        assert.strictEqual(page.warnsOnLeave(), true, 'still only in the page');
        assert.strictEqual(page.requests.length, 0, 'not registered before it leaves the page');
    });

    it('links to a plain-text Blob, never a data: URL', async () => {
        const page = loadRegPage();
        await page.init();
        page.element('username').value = 'alice';
        await page.saveToNamedFile();
        page.tapDownload();

        assert.match(page.downloads[0].href, /^blob:/);
        assert.strictEqual(page.downloads[0].type, 'text/plain');
        assert.strictEqual(page.idcard.parse(page.downloads[0].content).username, 'alice');
        assert.doesNotMatch(HTML, /data:application/);
    });

    it('stops warning and registers once the link is tapped - once only', async () => {
        const page = loadRegPage();
        await page.init();
        await page.saveToNamedFile();

        page.tapDownload();
        await settle();
        assert.strictEqual(page.warnsOnLeave(), false);
        assert.strictEqual(page.requests.length, 1);
        assert.match(page.element('msg').textContent, /Saving your ID Card as /);
        assert.match(page.element('msg').textContent, /Registered on the server/);

        page.tapDownload();
        await settle();
        assert.strictEqual(page.downloads.length, 2, 'a second copy is fine');
        assert.strictEqual(page.requests.length, 1, 'but it is not registered again');
    });

    it('registers after the tap, not inside it, which would start the download over the POST', async () => {
        const page = loadRegPage();
        await page.init();
        await page.saveToNamedFile();
        assert.match(HTML, /var regTiming = \{ delay: [1-9]\d*,/, 'the page waits for real');

        page.tapDownload();
        assert.strictEqual(page.requests.length, 0, 'nothing sent while the tap is handled');

        await settle();
        assert.strictEqual(page.requests.length, 1);
        assert.strictEqual(page.requests[0].keepalive, true, 'a navigation does not stop it');
    });

    it('sends a registration that got no answer once more, to the same path', async () => {
        const page = loadRegPage();
        await page.init();
        await page.saveToNamedFile();
        let calls = 0;
        const sent = [];
        page.window.fetch = async (url) => {
            sent.push(url);
            if (calls++ === 0) {
                throw new TypeError('Load failed');
            }
            return { status: 200, json: async () => ({ status: 'OK' }) };
        };

        page.tapDownload();
        await settle();

        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[0], sent[1]);
        assert.match(page.element('msg').textContent, /Registered on the server/);
        assert.doesNotMatch(page.element('msg').textContent, /failed/);
    });

    it('warns on leaving after a save over a live session, until the new card is tapped', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        assert.strictEqual(page.warnsOnLeave(), false, 'the signed-in identity has a card already');

        await page.saveToNamedFile();
        assert.strictEqual(page.warnsOnLeave(), true, 'the new one has not left the page');
        assert.strictEqual(page.element('continue').hidden, true);

        page.tapDownload();
        assert.strictEqual(page.warnsOnLeave(), false);
        assert.strictEqual(page.element('continue').hidden, false);
    });

    it('has no share button where the share sheet takes no files', async () => {
        const page = loadRegPage();
        await page.init();
        await page.saveToNamedFile();

        assert.strictEqual(page.element('share_card').hidden, true);
        assert.doesNotMatch(page.element('msg').textContent, /Save to Files/);
    });

    it('hands the card to the share sheet, as a plain-text file', async () => {
        const { navigator, shared } = shareSheet();
        const page = loadRegPage({ navigator });
        await page.init();
        page.element('username').value = 'alice';
        page.element('passphrase').value = 's3cret';
        page.element('passphrase2').value = 's3cret';
        await page.saveToNamedFile();

        assert.strictEqual(page.element('share_card').hidden, false);
        assert.match(page.element('msg').textContent, /Or tap "Share \/ Save to Files"/);

        await page.shareCard();
        await settle();

        const [file] = shared[0].files;
        assert.match(file.name, /^alice\*\.\d{8}T\d{6}\.id\.txt$/);
        assert.strictEqual(file.type, 'text/plain');
        assert.strictEqual(page.idcard.isEncrypted(file.text), true);
        assert.strictEqual(page.warnsOnLeave(), false);
        assert.strictEqual(page.requests.length, 1);
        assert.match(page.element('msg').textContent, /went to the share sheet/);
    });

    it('keeps the warning when the share sheet is closed without saving', async () => {
        const { navigator } = shareSheet(async () => {
            throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        });
        const page = loadRegPage({ navigator });
        await page.init();
        await page.saveToNamedFile();
        await page.shareCard();

        assert.strictEqual(page.warnsOnLeave(), true);
        assert.strictEqual(page.requests.length, 0);
        assert.match(page.element('msg').textContent, /share sheet closed before the ID Card was saved/);
    });

    it('points at the link when the share sheet fails', async () => {
        const { navigator } = shareSheet(async () => {
            throw Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
        });
        const page = loadRegPage({ navigator });
        await page.init();
        await page.saveToNamedFile();
        await page.shareCard();

        assert.strictEqual(page.warnsOnLeave(), true);
        assert.match(page.element('msg').textContent, /could not take the ID Card: not allowed\nTap "Download Id Card" instead/);
    });

    it('reports a registration the server refused', async () => {
        const page = loadRegPage();
        await page.init();
        page.window.fetch = async () => ({ status: 500, statusText: 'Internal Server Error' });
        await page.saveToNamedFile();
        page.tapDownload();
        await settle();

        assert.match(page.element('msg').textContent, /Saving your ID Card/, 'the download advice stays');
        assert.match(page.element('msg').textContent, /Registration on the server failed: the server answered 500/);
    });

    it('reports a registration the database refused behind a 200', async () => {
        const page = loadRegPage();
        await page.init();
        page.window.fetch = async () => ({ status: 200,
            json: async () => ({ errno: 8, code: 'SQLITE_READONLY' }) });
        await page.saveToNamedFile();
        page.tapDownload();
        await settle();

        assert.doesNotMatch(page.element('msg').textContent, /Registered on the server/);
        assert.match(page.element('msg').textContent,
            /Registration on the server failed: the server did not store it \(SQLITE_READONLY\)/);
    });

    it('reports a registration that never reached the server', async () => {
        const page = loadRegPage();
        await page.init();
        page.window.fetch = async () => { throw new Error('offline'); };
        await page.saveToNamedFile();
        page.tapDownload();
        await settle();

        assert.match(page.element('msg').textContent, /Registration on the server failed: offline/);
    });

    it('reports a card that could not be built', async () => {
        const page = loadRegPage();
        await page.init();
        page.idcard.toFile = async () => { throw new Error('no crypto'); };
        await page.saveToNamedFile();

        assert.match(page.element('msg').textContent, /ID Card not saved: no crypto/);
        assert.notStrictEqual(page.element('saved').hidden, false);
    });

    it('gives the fields 16px text, so Safari does not zoom in on them', () => {
        assert.match(CSS, /\ninput {[^}]*font-size: 16px/);
    });
});

// UPDATE_8: the key kept in IndexedDB signs a new cookie when the old one has
// run out, and whoever signed in here before can Logout.
describe('Reg.html signing in again by itself', () => {
    const DESTINATION = '/fs/get/pwa/pals/index.html';

    /**
     * A browser where alice loaded her ID Card once, and the cookie has since
     * run out. Her key pair is a real one: WebCrypto checks that the halves
     * match, which PUB and PRIV do not.
     */
    async function expired(options = {}) {
        const indexedDB = fakeIndexedDB();
        const first = loadRegPage({ indexedDB });
        const { pub, priv } = first.session.draft();
        await first.upload(JSON.stringify({ v: 2, username: 'alice', pub, priv }));
        assert.strictEqual(await first.session.kept(), true, 'the keys are kept on loading the card');

        const page = loadRegPage({ localStorage: first.localStorage, indexedDB, hash: `#${DESTINATION}`, ...options });
        return { page, indexedDB, pub };
    }

    it('keeps a signing key beside the key-agreement one, neither extractable', async () => {
        const { indexedDB, pub } = await expired();
        const record = indexedDB.stores.keys.get(pub);

        assert.strictEqual(record.key.algorithm.name, 'ECDH');
        assert.deepStrictEqual([...record.key.usages], ['deriveBits']);
        assert.strictEqual(record.signer.algorithm.name, 'ECDSA');
        assert.deepStrictEqual([...record.signer.usages], ['sign']);
        assert.strictEqual(record.key.extractable, false);
        assert.strictEqual(record.signer.extractable, false);
    });

    it('signs a new session cookie and goes on to the destination', async () => {
        const { page, pub } = await expired();
        assert.strictEqual(page.cookie(), '', 'the cookie has run out');

        await page.init();

        assert.ok(page.cookie().startsWith(`ssid=${pub}.`), page.cookie());
        assert.strictEqual(page.session.signedIn(), true);
        assert.strictEqual(page.session.unlocked(), false, 'without the ID Card in the page');
        assert.strictEqual(page.window.location.href, DESTINATION);
    });

    it('signs a cookie the server accepts as alice', async () => {
        const { page, pub } = await expired();
        await page.init();

        const checked = new Crypto().verifySsid(page.cookie().slice('ssid='.length));
        assert.strictEqual(checked.sValid, true);
        assert.strictEqual(checked.pubB64, pub);
    });

    it('asks for the ID Card as before when nothing signing is kept here', async () => {
        // A key kept before UPDATE_8 was for key agreement only.
        const { page, indexedDB, pub } = await expired();
        const record = indexedDB.stores.keys.get(pub);
        indexedDB.stores.keys.set(pub, { key: record.key, at: record.at });

        await page.init();

        assert.strictEqual(page.cookie(), '');
        assert.strictEqual(page.window.location.href, '');
        assert.strictEqual(page.element('reg_section').hidden, true);
        assert.match(page.element('msg').textContent, /Sign in again: load the ID Card for alice/);
    });

    it('does not sign in again once logged out', async () => {
        const { page, indexedDB, pub } = await expired();
        await page.logout();

        assert.strictEqual(indexedDB.stores.keys.has(pub), false, 'the kept keys are gone');
        const later = loadRegPage({ localStorage: { pub: 'notloggedin' }, indexedDB });
        await later.init();
        assert.ok(!later.cookie().startsWith(`ssid=${pub}.`));
        assert.strictEqual(later.window.location.href, '');
    });
});

describe('Reg.html Logout', () => {
    it('is offered to whoever signed in here before, live session or not', async () => {
        for (const options of [{ localStorage: known(), cookie: liveCookie() }, { localStorage: known() }, { localStorage: known({ priv: PRIV }) }]) {
            const page = loadRegPage(options);
            await page.init();

            assert.strictEqual(page.element('logout').hidden, false, JSON.stringify(options));
        }
    });

    it('is not offered to a brand new visitor, nor after signing out', async () => {
        for (const options of [{}, { localStorage: { pub: 'notloggedin' } }]) {
            const page = loadRegPage(options);
            await page.init();

            assert.strictEqual(page.element('logout').hidden, true, JSON.stringify(options));
        }
    });

    it('forgets the identity, and starts over as on a first visit', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }) });
        await page.init();
        assert.strictEqual(page.element('reg_section').hidden, true);

        await page.logout();

        assert.notStrictEqual(page.localStorage.pub, PUB);
        assert.ok(!page.cookie().includes(PUB), 'the old cookie is gone');
        assert.notStrictEqual(page.element('reg_section').hidden, true, 'Reg is back');
        assert.strictEqual(page.element('logout').hidden, true);
        assert.match(page.element('msg').textContent, /^Logged out alice\.\n\nNew ID keys generated/);
        assert.strictEqual(page.warnsOnLeave(), true, 'the new identity is unsaved, as on any first visit');
    });

    it('is a link on the Info board, which says how to use it when the session expires', () => {
        const board = HTML.slice(HTML.indexOf('class="intro board"'), HTML.indexOf('id="signin_panel"'));
        assert.match(board, /<a id="logout"[^>]*hidden[^>]*>Logout<\/a>/);
        assert.match(HTML, /To register as somebody new, Logout first\./);
    });
});
