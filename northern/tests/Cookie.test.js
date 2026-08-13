'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert';
import Cookie from '../src/h2t/Cookie.js';

const cookie = new Cookie();

// Feature F1: Cookie header parsing (src/h2t/Cookie.js)
describe('Cookie.getCookie', () => {
    it('reads a single cookie by name', () => {
        assert.strictEqual(cookie.getCookie('ssid=abc123', 'ssid'), 'abc123');
    });

    it('reads a cookie from the middle of a list, ignoring padding spaces', () => {
        const header = 'theme=dark; ssid=pub.1700.sig; lang=en';
        assert.strictEqual(cookie.getCookie(header, 'ssid'), 'pub.1700.sig');
    });

    it('returns an empty string when the cookie is absent', () => {
        assert.strictEqual(cookie.getCookie('theme=dark', 'ssid'), '');
    });

    it('returns an empty string when there is no cookie header at all', () => {
        assert.strictEqual(cookie.getCookie(undefined, 'ssid'), '');
        assert.strictEqual(cookie.getCookie('', 'ssid'), '');
    });

    it('does not match a cookie whose name merely ends with the requested name', () => {
        assert.strictEqual(cookie.getCookie('xssid=nope', 'ssid'), '');
    });

    it('keeps base64 padding and dots in the value intact', () => {
        const ssid = 'BASE64PUB==.1700000000.BASE64SIG==';
        assert.strictEqual(cookie.getCookie(`ssid=${ssid}`, 'ssid'), ssid);
    });

    it('is detached from its instance (Server passes the method by reference)', () => {
        const { getCookie } = cookie;
        assert.strictEqual(getCookie('ssid=abc', 'ssid'), 'abc');
    });
});
