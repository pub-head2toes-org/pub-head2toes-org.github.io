'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegPage } from './helpers/regPage.js';

const FS_ROOT = path.join(import.meta.dirname, '..', 'src', 'fs');
const PUB = 'JaCSWcLSex79JkDmRHekEX33avJ9L9/dsTdWqBYk4WPSVy5mKRvFNTx+fqCHIHWba2Yr+8lVX938wQn3HHDkww==';
const PRIV = 'Q0oPz9y8DzB1Ux1S2vJk0jHFPBOTFAn7l2QolO+FvGE=';
const liveCookie = () => `ssid=${PUB}.${Date.now()}.somesignature`;

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.(html|js)$/.test(entry.name) ? [full] : [];
    });
}

const sources = walk(FS_ROOT).map(file => ({
    file: path.relative(FS_ROOT, file),
    text: fs.readFileSync(file, 'utf8')
}));

/**
 * The private key is held in memory by session.js and nowhere else. This is an
 * invariant of the whole browser side, not of one page, so it is checked across
 * every file rather than through any single flow.
 */
describe('the private key is never written to local storage', () => {
    const writes = [
        /localStorage\s*\.\s*priv\s*=/,                  // localStorage.priv = ...
        /localStorage\s*\[\s*['"]priv['"]\s*\]\s*=/,     // localStorage['priv'] = ...
        /localStorage\s*\.\s*setItem\s*\(\s*['"]priv['"]/, // localStorage.setItem('priv', ...)
        /sessionStorage\s*\.\s*priv\s*=/
    ];

    for (const pattern of writes) {
        it(`no file matches ${pattern}`, () => {
            const offenders = sources.filter(s => pattern.test(s.text)).map(s => s.file);

            assert.deepStrictEqual(offenders, [], `these files store the private key: ${offenders.join(', ')}`);
        });
    }

    it('only session.js holds the key, and only in a closure', () => {
        const session = sources.find(s => s.file === path.join('reg', 'session.js'));

        assert.ok(session, 'reg/session.js exists');
        assert.match(session.text, /let held = null/, 'the key is a closure variable');
        assert.ok(!/store\(\)\[LEGACY_PRIV\]\s*=/.test(session.text), 'and is never written back to storage');
    });

    it('every page that needs to sign does so through the session', () => {
        // Rebuilding an sjcl secret key by hand is what session.unlock replaces.
        // sjcl.js itself is the library that defines the class, not a caller.
        const offenders = sources
            .filter(s => path.basename(s.file) !== 'sjcl.js')
            .filter(s => s.file !== path.join('reg', 'session.js'))
            .filter(s => /new sjcl\.ecc\.ecdsa\.secretKey/.test(s.text))
            .map(s => s.file);

        assert.deepStrictEqual(offenders, []);
    });
});

// session.js depends on sjcl, cookies and idcard being loaded before it.
describe('pages load the identity scripts they depend on', () => {
    const pages = sources.filter(s => s.file.endsWith('.html') && /src=["'][^"']*session\.js["']/.test(s.text));

    it('at least the registration and sign-in pages use it', () => {
        assert.ok(pages.length >= 4, `expected several pages, found ${pages.map(p => p.file).join(', ')}`);
    });

    for (const dependency of ['sjcl.js', 'cookies.js', 'idcard.js']) {
        it(`each of them loads ${dependency} first`, () => {
            for (const page of pages) {
                const dep = page.text.indexOf(dependency);
                const session = page.text.indexOf('session.js');

                assert.notStrictEqual(dep, -1, `${page.file} does not load ${dependency}`);
                assert.ok(dep < session, `${page.file} loads ${dependency} after session.js`);
            }
        });
    }

    it('every script src on those pages resolves to a file that exists', () => {
        for (const page of pages) {
            const dir = path.dirname(path.join(FS_ROOT, page.file));
            for (const [, src] of page.text.matchAll(/<script[^>]*src=["']([^"']+)["']/g)) {
                const resolved = src.startsWith('/')
                    ? path.join(FS_ROOT, src.replace('/fs/get/', ''))
                    : path.join(dir, src);

                assert.ok(fs.existsSync(resolved), `${page.file} references a missing script: ${src}`);
            }
        }
    });
});

/**
 * A.html and Remote.html used to rebuild the key from storage on every load.
 * With the key gone from storage they ride on the live session cookie instead,
 * and send the user to Reg.html when there is none.
 */
describe('reg/A.html', () => {
    const page = (options = {}) => loadRegPage({ page: 'reg/A.html', hash: '#/fs/get/keyboard.html', ...options });

    it('passes a signed in visitor straight through', async () => {
        const a = page({ localStorage: { pub: PUB }, cookie: liveCookie() });
        await a.init();

        assert.strictEqual(a.window.location.href, '/fs/get/keyboard.html');
    });

    it('sends a visitor with no session to registration, keeping the destination', async () => {
        const a = page({ localStorage: { pub: PUB } });
        await a.init();

        assert.strictEqual(a.window.location.href, '/fs/get/reg/Reg.html#/fs/get/keyboard.html');
    });

    it('refreshes the cookie when a key was adopted from an older version', async () => {
        const a = page({ localStorage: { pub: PUB, priv: PRIV } });
        await a.init();

        assert.ok(a.cookie().startsWith(`ssid=${PUB}.`));
        assert.strictEqual(a.window.location.href, '/fs/get/keyboard.html');
        assert.ok(!('priv' in a.localStorage));
    });
});

describe('reg/Remote.html', () => {
    const page = (options = {}) => loadRegPage({ page: 'reg/Remote.html', ...options });

    it('pairs using the live session cookie, without needing the key', async () => {
        const remote = page({ localStorage: { pub: PUB }, cookie: liveCookie() });
        await remote.init.call(remote.window);

        const keys = remote.global('keys');
        assert.ok(keys.cookie.startsWith(`${PUB}.`), 'the paired device gets a session cookie');
        assert.match(keys.pairing, /^[a-z]{4}$/);
        assert.strictEqual(remote.element('pairing').innerHTML, keys.pairing);
    });

    it('signs a fresh cookie when a key is in memory', async () => {
        const remote = page({ localStorage: { pub: PUB, priv: PRIV } });
        await remote.init.call(remote.window);

        assert.ok(remote.global('keys').cookie.startsWith(`${PUB}.`));
        assert.ok(!('priv' in remote.localStorage));
    });

    it('sends a visitor with no session to registration', async () => {
        const remote = page({ localStorage: { pub: PUB } });
        await remote.init.call(remote.window);

        assert.match(remote.window.location.href, /reg\/Reg\.html/);
    });
});
