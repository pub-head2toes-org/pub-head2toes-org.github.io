'use strict';

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import nodeCrypto from 'node:crypto';
import Crypto from '../src/h2t/Crypto.js';
import sjclClass from '../src/h2t/sjclClass.js';

const crypto = new Crypto();
const sjcl = new sjclClass().get();

let keys;

/**
 * The bundled sjcl only auto-seeds its PRNG under CommonJS or in a browser,
 * so under ESM the tests must seed it before generating a key pair
 * (see REFACTORING.md #12).
 */
function seedSjcl() {
    const bytes = nodeCrypto.randomBytes(128);
    sjcl.random.addEntropy(Array.from(bytes), 1024, 'node-crypto');
}

/** Builds the ssid cookie value the browser client produces: pub.start.sig */
function makeSsid(pair, start = String(Date.now())) {
    const pubB64 = sjcl.codec.base64.fromBits(
        pair.pub.get().x.concat(pair.pub.get().y));
    const msg = `${pubB64}.${start}`;
    const sig = sjcl.codec.base64.fromBits(
        pair.sec.sign(sjcl.hash.sha256.hash(msg)));
    return { ssid: `${pubB64}.${start}.${sig}`, pubB64, start, sig };
}

// Feature F2/F3: ECDSA session id verification (src/h2t/Crypto.js)
describe('Crypto.verifySsid', () => {
    before(() => {
        seedSjcl();
        keys = sjcl.ecc.ecdsa.generateKeys(sjcl.ecc.curves.c256);
    });

    it('accepts a signature made by the matching private key', () => {
        const { ssid, pubB64, start } = makeSsid(keys);
        const result = crypto.verifySsid(ssid);

        assert.strictEqual(result.sValid, true);
        assert.strictEqual(result.pubB64, pubB64);
        assert.strictEqual(result.sStart, start);
        assert.strictEqual(result.ssid, ssid);
    });

    it('treats the public key as the author identity', () => {
        const { ssid, pubB64 } = makeSsid(keys);
        assert.strictEqual(crypto.verifySsid(ssid).pubB64, pubB64);
    });

    it('rejects a signature that does not match the signed message', () => {
        const { pubB64, sig } = makeSsid(keys);
        // Same signature, different timestamp -> different digest.
        assert.strictEqual(crypto.verifySsid(`${pubB64}.9999999999.${sig}`), false);
    });

    it('rejects a signature made by a different key pair', () => {
        const other = sjcl.ecc.ecdsa.generateKeys(sjcl.ecc.curves.c256);
        const mine = makeSsid(keys);
        const theirs = makeSsid(other, mine.start);
        assert.strictEqual(crypto.verifySsid(`${mine.pubB64}.${mine.start}.${theirs.sig}`), false);
    });

    it('rejects a malformed ssid instead of throwing', () => {
        assert.strictEqual(crypto.verifySsid('garbage'), false);
        assert.strictEqual(crypto.verifySsid('a.b.c'), false);
        assert.strictEqual(crypto.verifySsid(''), false);
    });

    it('rejects a non-string ssid instead of throwing', () => {
        assert.strictEqual(crypto.verifySsid(undefined), false);
        assert.strictEqual(crypto.verifySsid(null), false);
    });

    it('defaults to the EC algorithm when no 4th segment is present', () => {
        const { ssid } = makeSsid(keys);
        assert.strictEqual(ssid.split('.').length, 3);
        assert.strictEqual(crypto.verifySsid(ssid).sValid, true);
    });

    it('verifies explicitly EC-tagged ssids', () => {
        const { ssid } = makeSsid(keys);
        assert.strictEqual(crypto.verifySsid(`${ssid}.EC`).sValid, true);
    });

    // Feature F5: the RSA (Windows Hello) branch is dead code - it reads an
    // undefined `body` variable, so any non-EC alg fails closed.
    it('fails closed for the RSA branch', { todo: 'RSA branch references an undefined `body` (REFACTORING.md #8)' }, () => {
        const { ssid } = makeSsid(keys);
        assert.strictEqual(crypto.verifySsid(`${ssid}.RSA`).sValid, true);
    });
});
