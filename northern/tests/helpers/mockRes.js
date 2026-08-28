'use strict';

import { Writable } from 'node:stream';

/**
 * Minimal stand-in for a node:http ServerResponse.
 *
 * It is a real Writable so that Render's streaming branches
 * (createReadStream(...).pipe(res)) work unchanged, while
 * writeHead/end are captured for assertions.
 */
export default class MockRes extends Writable {
    constructor() {
        super();
        this.statusCode = null;
        this.headers = null;
        this.chunks = [];
        this.ended = false;
        this.done = new Promise(resolve => { this._resolveDone = resolve; });
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        return this;
    }

    _write(chunk, encoding, cb) {
        this.chunks.push(Buffer.from(chunk));
        cb();
    }

    end(data) {
        if (data !== undefined && data !== null) {
            this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        }
        this.ended = true;
        this._resolveDone(this);
        return this;
    }

    get buffer() {
        return Buffer.concat(this.chunks);
    }

    get body() {
        return this.buffer.toString();
    }

    get json() {
        return JSON.parse(this.body);
    }

    get contentType() {
        return this.headers && this.headers['Content-Type'];
    }
}
