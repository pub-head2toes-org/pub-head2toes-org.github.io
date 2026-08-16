'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegPage } from './helpers/regPage.js';

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

        assert.match(page.element('msg').value, /NOT saved in the browser/);
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

        assert.match(page.element('msg').value, /Signed in as alice/);
    });

    it('asks for the ID Card when the session has expired, keeping the same identity', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }) });
        await page.init();

        assert.match(page.element('msg').value, /session has expired/);
        assert.strictEqual(page.localStorage.pub, PUB, 'the identity is not replaced');
        assert.strictEqual(page.cookie(), '', 'and no cookie is minted without the key');
    });

    it('prefills the user name field', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }), cookie: liveCookie() });
        await page.init();

        assert.strictEqual(page.element('username').value, 'alice');
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

        assert.strictEqual(page.downloads.length, 1);
        assert.match(page.downloads[0].name, /^alice\.\d{8}T\d{6}\.id\.txt$/);

        const card = page.idcard.parse(decodeURIComponent(page.downloads[0].href.split(',')[1]));
        assert.strictEqual(card.username, 'alice');
        assert.strictEqual(card.pub, PUB);
        assert.strictEqual(card.priv, PRIV);
    });

    it('registers the card in the database as well as downloading it', async () => {
        const page = await signedIn();

        await page.saveToNamedFile();

        assert.strictEqual(page.downloads.length, 1);
        assert.strictEqual(page.requests.length, 1);
    });

    it('names the file for UNKNOWN when no user name is given', async () => {
        const page = await signedIn();
        page.element('username').value = '';

        await page.saveToNamedFile();

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

        assert.strictEqual(page.downloads.length, 1);
        const card = page.idcard.parse(decodeURIComponent(page.downloads[0].href.split(',')[1]));
        assert.strictEqual(card.username, 'bob');
        assert.ok(card.priv, 'with the private half in it, which is the point');
        assert.notStrictEqual(card.pub, PUB, 'a new identity, since the old key is not here');
    });

    it('saves the key it showed in the Reg section', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const offered = page.element('pubkey').value;

        await page.saveToNamedFile();

        const card = page.idcard.parse(decodeURIComponent(page.downloads[0].href.split(',')[1]));
        assert.strictEqual(card.pub, offered);
    });

    it('makes that pair the identity: stored, registered and signing the cookie', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();

        await page.saveToNamedFile();

        const card = page.idcard.parse(decodeURIComponent(page.downloads[0].href.split(',')[1]));
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

        assert.strictEqual(page.downloads.length, 0);
        assert.strictEqual(page.localStorage.pub, PUB, 'the signed-in identity is untouched');
        assert.strictEqual(page.session.unlocked(), false);
    });

    it('also works for a visitor whose session has expired', async () => {
        const page = loadRegPage({ localStorage: known({ pub_name: 'alice' }) });
        await page.init();

        await page.saveToNamedFile();

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

        assert.strictEqual(page.element('pubkey').value, PUB);
        const card = page.idcard.parse(decodeURIComponent(page.downloads[0].href.split(',')[1]));
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

        assert.match(page.downloads[0].name, /^alice\*\.\d{8}T\d{6}\.id\.txt$/);

        const content = decodeURIComponent(page.downloads[0].href.split(',')[1]);
        assert.strictEqual(page.idcard.isEncrypted(content), true);
        assert.ok(!content.includes(PRIV), 'the private key must not be readable in the file');
        assert.ok(!content.includes('alice'), 'the user name must not be readable in the file');
    });

    it('refuses to save when the two passphrases differ', async () => {
        const page = await signedIn();
        page.element('passphrase').value = 's3cret';
        page.element('passphrase2').value = 'typo';

        await page.saveToNamedFile();

        assert.strictEqual(page.downloads.length, 0, 'nothing is downloaded');
        assert.strictEqual(page.requests.length, 0, 'nothing is registered');
        assert.match(page.element('msg').value, /do not match/);
    });

    it('leaves the download unencrypted when no passphrase is set', async () => {
        const page = await signedIn();

        await page.saveToNamedFile();

        const content = decodeURIComponent(page.downloads[0].href.split(',')[1]);
        assert.strictEqual(page.idcard.isEncrypted(content), false);
        assert.ok(!page.downloads[0].name.includes('*'));
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
        assert.match(page.element('msg').value, /ID loaded/);
    });

    it('still loads a v1 "<pub>.<priv>" card saved before user names existed', async () => {
        const page = loadRegPage();
        await page.init();

        await page.upload(`${PUB}.${PRIV}`);

        assert.strictEqual(page.localStorage.pub, PUB);
        assert.strictEqual(page.session.card().priv, PRIV);
        assert.match(page.element('msg').value, /ID loaded/);
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

        assert.match(page.element('msg').value, /passphrase/);
        assert.strictEqual(page.session.unlocked(), false, 'nothing was unlocked');
    });

    it('reports a wrong passphrase without disturbing the stored identity', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();
        const envelope = await page.idcard.encrypt(page.idcard.build('bob', 'otherpub', 'otherpriv'), 's3cret');
        page.element('signin_passphrase').value = 'wrong';

        await page.upload(envelope);

        assert.match(page.element('msg').value, /wrong passphrase/);
        assert.strictEqual(page.localStorage.pub, PUB);
    });

    it('reports a file that is not an ID Card at all', async () => {
        const page = loadRegPage({ localStorage: known(), cookie: liveCookie() });
        await page.init();

        await page.upload('this is just some text');

        assert.match(page.element('msg').value, /not an ID Card/);
        assert.strictEqual(page.localStorage.pub, PUB);
    });

    // The journey the whole design rests on: save on one device, load on the next
    it('reloads a card it saved itself, passphrase and all', async () => {
        const saving = await signedIn();
        saving.element('username').value = 'alice';
        saving.element('passphrase').value = 'correct horse';
        saving.element('passphrase2').value = 'correct horse';
        await saving.saveToNamedFile();
        const content = decodeURIComponent(saving.downloads[0].href.split(',')[1]);

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
    it('names the site once, at the top', () => {
        const titles = HTML.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) || [];

        assert.strictEqual(titles.length, 1);
        assert.match(titles[0], />\s*pub\.head2toes\.org\s*</);
    });

    it('has a Messages, a Sign in and a Reg section, in that order', () => {
        const headings = [...HTML.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map(m => m[1].trim());

        assert.deepStrictEqual(headings, ['Messages', 'Sign in', 'Reg']);
    });

    it('makes the message board a read only text area of its own', () => {
        const board = HTML.match(/<textarea[^>]*id="msg"[^>]*>/);

        assert.ok(board, 'the message area is a textarea in the markup, not built by script');
        assert.match(board[0], /\breadonly\b/);
        assert.ok(!/innerHTML/.test(HTML), 'and messages are written to it as text');
    });

    it('gives the Sign in section its own passphrase, apart from the one used to save', () => {
        assert.match(HTML, /id="signin_passphrase"[\s\S]*type="file" id="fileinput"/);
        assert.match(HTML, /idcard\.open\(text, getSignInPassphrase\(\)\)/, 'loading uses it');
        assert.match(HTML, /idcard\.toFile\(currentIdCard\(\), passphrase\)/, 'saving uses the other one');
    });

    it('loads and saves through one button each, with no separate Continue', () => {
        assert.match(HTML, /Load Id Card &amp; Continue/);
        assert.match(HTML, /Save Id Card &amp; Continue/);
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

    it('shows the public key in a read only field, and never the private one', () => {
        const field = HTML.match(/<input[^>]*id="pubkey"[^>]*>/);

        assert.ok(field);
        assert.match(field[0], /\breadonly\b/);
        assert.ok(!/id="priv/.test(HTML), 'there is no field for the private key');
    });
});
