'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import HttpClient from '../src/h2t/httpClient.js';

const client = new HttpClient();

let server;
let port;
let lastRequest;

before(async () => {
    server = http.createServer((req, res) => {
        lastRequest = { url: req.url, method: req.method };
        if (req.url.startsWith('/json')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'OK', url: req.url }));
        } else if (req.url.startsWith('/chunked')) {
            // Split so that neither half parses as JSON on its own.
            const body = JSON.stringify({ status: 'OK', chunked: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write(body.slice(0, 10));
            setTimeout(() => res.end(body.slice(10)), 20);
        } else {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('not json');
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
});

after(() => new Promise(resolve => server.close(resolve)));

// Feature I: the client used for replica fan-out (src/h2t/httpClient.js)
describe('HttpClient.execute', () => {
    it('performs the request and parses the JSON response', async () => {
        const data = await new Promise((resolve, reject) =>
            client.execute({ host: '127.0.0.1', port, path: '/json', method: 'GET' },
                (err, body) => err ? reject(err) : resolve(body)));

        assert.deepStrictEqual(data, { status: 'OK', url: '/json' });
    });

    it('sends the path and method it was given', async () => {
        await new Promise(resolve =>
            client.execute({ host: '127.0.0.1', port, path: '/json?a=1', method: 'GET' }, resolve));

        assert.deepStrictEqual(lastRequest, { url: '/json?a=1', method: 'GET' });
    });

    it('reports connection errors through the callback', async () => {
        const closed = http.createServer();
        await new Promise(r => closed.listen(0, '127.0.0.1', r));
        const deadPort = closed.address().port;
        await new Promise(r => closed.close(r));

        const err = await new Promise(resolve =>
            client.execute({ host: '127.0.0.1', port: deadPort, path: '/json', method: 'GET' },
                error => resolve(error)));

        assert.ok(err instanceof Error);
        assert.strictEqual(err.code, 'ECONNREFUSED');
    });

    it('surfaces a non JSON body as a parse error instead of throwing', async () => {
        const err = await new Promise(resolve =>
            client.execute({ host: '127.0.0.1', port, path: '/text', method: 'GET' }, resolve));

        assert.ok(err instanceof SyntaxError);
    });

    it('calls back once per response, not once per chunk', async () => {
        let calls = 0;
        await new Promise(resolve => {
            client.execute({ host: '127.0.0.1', port, path: '/chunked', method: 'GET' }, () => { calls++; resolve(); });
        });
        await new Promise(r => setTimeout(r, 50));

        assert.strictEqual(calls, 1);
    });

    it('reassembles a response split across several chunks', async () => {
        const data = await new Promise((resolve, reject) =>
            client.execute({ host: '127.0.0.1', port, path: '/chunked', method: 'GET' },
                (err, body) => err ? reject(err) : resolve(body)));

        assert.deepStrictEqual(data, { status: 'OK', chunked: true });
    });
});
