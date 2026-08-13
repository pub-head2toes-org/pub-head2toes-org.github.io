'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import sqlite3 from 'sqlite3';
import { freshDb, promisify1 } from './helpers/db.js';

let db;
let dbFile;
let get, insert, search, searchPlus, keyword, increment;

/** Polls until the predicate holds - the write paths finish work after their callback. */
async function eventually(fn, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('timed out waiting for condition');
        await new Promise(r => setTimeout(r, 25));
    }
}

before(async () => {
    const fixture = await freshDb('sqlitedb.test.db');
    db = fixture.db;
    dbFile = fixture.absolute;

    get = promisify1(db.get, db);
    insert = promisify1(db.insert, db);
    search = promisify1(db.search, db);
    searchPlus = promisify1(db.searchPlus, db);
    keyword = promisify1(db.keyword, db);
    increment = promisify1(db.increment, db);
});

after(() => fs.rmSync(dbFile, { force: true }));

// Feature D1: schema
describe('SqliteDB schema', () => {
    it('creates the abcd table with the key/value columns', async () => {
        const columns = await new Promise((resolve, reject) => {
            const raw = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY);
            raw.all('PRAGMA table_info(abcd)', (err, rows) => err ? reject(err) : resolve(rows.map(r => r.name)));
        });

        assert.deepStrictEqual(columns, ['path', 'type', 'value', 'counter', 'author', 'public']);
    });

    it('keeps path unique', async () => {
        const indexes = await new Promise((resolve, reject) => {
            const raw = new sqlite3.Database(dbFile, sqlite3.OPEN_READONLY);
            raw.all("SELECT name, sql FROM sqlite_master WHERE type='index'", (err, rows) => err ? reject(err) : resolve(rows));
        });

        assert.ok(indexes.some(i => i.name === 'PathUniqueIndex' && /UNIQUE/.test(i.sql)));
    });
});

// Feature D4: read a value by key
describe('SqliteDB.insert + get', () => {
    it('stores a value under a path and reads it back', async () => {
        const result = await insert('/t/note', 'txt', 'hello', 'alice', 'public');
        assert.deepStrictEqual(result, { status: 'OK', path: '/t/note' });

        const row = await get('/t/note', 'alice', 'public');
        assert.strictEqual(row.value, 'hello');
        assert.strictEqual(row.type, 'txt');
        assert.strictEqual(row.author, 'alice');
        assert.strictEqual(row.public, 'public');
        assert.strictEqual(row.counter, 0);
    });

    it('reports unknown keys as unavailable rather than erroring', async () => {
        const row = await get('/t/nothing-here', 'alice', 'public');
        assert.deepStrictEqual(row, { unavailable: '/t/nothing-here', author: 'alice' });
    });

    it('keeps the value opaque, so JSON, HTML and JS are all storable', async () => {
        const html = '<html><body><script>var a = "</script>"</script></body></html>';
        await insert('/t/page.html', 'html', html, 'alice', 'public');

        assert.strictEqual((await get('/t/page.html', 'alice', 'public')).value, html);
    });
});

// Feature D4/D3: row level access control
describe('SqliteDB access control', () => {
    before(async () => {
        await insert('/t/acl/private', 'txt', 'secret', 'alice', 'alice');
        await insert('/t/acl/public', 'txt', 'open', 'alice', 'public');
        await insert('/t/acl/group', 'txt', 'team only', 'alice', 'friends');
    });

    it('lets the author read their own private row', async () => {
        assert.strictEqual((await get('/t/acl/private', 'alice', 'alice')).value, 'secret');
    });

    it('hides a private row from another author', async () => {
        assert.deepStrictEqual(await get('/t/acl/private', 'bob', 'bob'), { unavailable: '/t/acl/private', author: 'bob' });
    });

    it('lets anyone read a row published to public', async () => {
        assert.strictEqual((await get('/t/acl/public', 'bob', 'bob')).value, 'open');
    });

    it('lets a group member read a group row', async () => {
        assert.strictEqual((await get('/t/acl/group', 'bob', 'friends')).value, 'team only');
    });

    it('hides a group row from a non member', async () => {
        assert.ok((await get('/t/acl/group', 'bob', 'others')).unavailable);
    });
});

// Feature D2: auto versioning on duplicate key
describe('SqliteDB.insert versioning', () => {
    it('answers the second insert of a key with the constraint error', async () => {
        await insert('/t/ver', 'txt', 'v1', 'alice', 'public');
        const result = await insert('/t/ver', 'txt', 'v2', 'alice', 'public');

        assert.strictEqual(result.code, 'SQLITE_CONSTRAINT');
    });

    it('moves the new value to <path>/<counter> and bumps the counter', async () => {
        const versioned = await eventually(async () => {
            const row = await get('/t/ver/0', 'alice', 'public');
            return row.unavailable ? null : row;
        });

        assert.strictEqual(versioned.value, 'v2');
        assert.strictEqual((await get('/t/ver', 'alice', 'public')).value, 'v1', 'the original key keeps the first value');
        assert.strictEqual((await get('/t/ver', 'alice', 'public')).counter, 1);
    });

    it('keeps versioning further writes under increasing counters', async () => {
        await insert('/t/ver', 'txt', 'v3', 'alice', 'public');
        const versioned = await eventually(async () => {
            const row = await get('/t/ver/1', 'alice', 'public');
            return row.unavailable ? null : row;
        });

        assert.strictEqual(versioned.value, 'v3');
        assert.strictEqual((await get('/t/ver', 'alice', 'public')).counter, 2);
    });

    it('inherits the author and group of the original row when versioning', async () => {
        await insert('/t/ver2', 'txt', 'a', 'alice', 'friends');
        await insert('/t/ver2', 'txt', 'b', 'mallory', 'public');

        const versioned = await eventually(async () => {
            const row = await get('/t/ver2/0', 'alice', 'friends');
            return row.unavailable ? null : row;
        });

        assert.strictEqual(versioned.author, 'alice');
        assert.strictEqual(versioned.public, 'friends');
    });
});

// Feature D3: update in place
describe('SqliteDB.update', () => {
    it('replaces the value of an existing key', async () => {
        await insert('/t/upd', 'txt', 'before', 'alice', 'public');
        db.update('/t/upd', 'txt', 'after', 'alice', 'public');

        await eventually(async () => (await get('/t/upd', 'alice', 'public')).value === 'after');
    });

    it('can change the type and the group of a row', async () => {
        await insert('/t/upd2', 'txt', 'x', 'alice', 'public');
        db.update('/t/upd2', 'html', '<b>x</b>', 'alice', 'friends');

        const row = await eventually(async () => {
            const r = await get('/t/upd2', 'alice', 'friends');
            return r.type === 'html' ? r : null;
        });

        assert.strictEqual(row.value, '<b>x</b>');
        assert.strictEqual(row.public, 'friends');
    });

    it('ignores an update from another author', async () => {
        await insert('/t/upd3', 'txt', 'mine', 'alice', 'public');
        db.update('/t/upd3', 'txt', 'hijacked', 'mallory', 'public');

        await new Promise(r => setTimeout(r, 200));
        assert.strictEqual((await get('/t/upd3', 'alice', 'public')).value, 'mine');
    });

    it('lets anybody update a row authored by "public"', async () => {
        await insert('/t/upd4', 'txt', 'anon', 'public', 'public');
        db.update('/t/upd4', 'txt', 'edited by bob', 'bob', 'public');

        await eventually(async () => (await get('/t/upd4', 'bob', 'public')).value === 'edited by bob');
    });

    it('reports the outcome of the write', { todo: 'update() always returns undefined (REFACTORING.md #4)' }, () => {
        const result = db.update('/t/upd', 'txt', 'x', 'alice', 'public');
        assert.deepStrictEqual(result, { status: 'OK', path: '/t/upd' });
    });
});

// Features D5/D6/D7: the three search modes
describe('SqliteDB search modes', () => {
    before(async () => {
        await insert('/t/s/1', 'txt', 'alpha bravo', 'alice', 'public');
        await insert('/t/s/2', 'txt', 'charlie delta', 'alice', 'public');
        await insert('/t/s/3', 'txt', 'echo foxtrot', 'alice', 'alice');
    });

    it('search returns metadata without the value', async () => {
        const rows = await search('/t/s/%', 'alice', 0, 'public');

        assert.strictEqual(rows.length, 3);
        assert.ok(rows.every(r => !('value' in r)));
        assert.ok(rows.every(r => 'path' in r && 'counter' in r && 'author' in r));
    });

    it('search orders by path descending', async () => {
        const rows = await search('/t/s/%', 'alice', 0, 'public');
        assert.deepStrictEqual(rows.map(r => r.path), ['/t/s/3', '/t/s/2', '/t/s/1']);
    });

    it('search honours the offset for paging', async () => {
        const rows = await search('/t/s/%', 'alice', 2, 'public');
        assert.deepStrictEqual(rows.map(r => r.path), ['/t/s/1']);
    });

    it('search applies the same access control as get', async () => {
        const rows = await search('/t/s/%', 'bob', 0, 'bob');
        assert.deepStrictEqual(rows.map(r => r.path), ['/t/s/2', '/t/s/1']);
    });

    it('search returns an empty list when nothing matches', async () => {
        assert.deepStrictEqual(await search('/t/no-such-prefix/%', 'alice', 0, 'public'), []);
    });

    it('searchPlus returns the values too', async () => {
        const rows = await searchPlus('/t/s/%', 'alice', 0, 'public');

        assert.strictEqual(rows.length, 3);
        assert.strictEqual(rows.find(r => r.path === '/t/s/1').value, 'alpha bravo');
    });

    it('keyword filters by value inside a path prefix', async () => {
        const rows = await keyword('/t/s/', '%delta%', 'alice', 0, 'public');

        assert.deepStrictEqual(rows.map(r => r.path), ['/t/s/2']);
        assert.strictEqual(rows[0].value, 'charlie delta');
    });

    it('keyword appends the wildcard to the path prefix itself', async () => {
        const rows = await keyword('/t/s', '%o%', 'alice', 0, 'alice');
        assert.ok(rows.length >= 1);
        assert.ok(rows.every(r => r.path.startsWith('/t/s')));
    });

    it('keyword applies access control', async () => {
        const rows = await keyword('/t/s/', '%foxtrot%', 'bob', 0, 'bob');
        assert.deepStrictEqual(rows, []);
    });

    it('caps a result page at 100 rows', async () => {
        for (let i = 0; i < 105; i++) {
            await insert(`/t/many/${String(i).padStart(3, '0')}`, 'txt', 'x', 'alice', 'public');
        }

        assert.strictEqual((await search('/t/many/%', 'alice', 0, 'public')).length, 100);
        assert.strictEqual((await search('/t/many/%', 'alice', 100, 'public')).length, 5);
    });
});

// Feature D8/H1: counters
describe('SqliteDB.increment', () => {
    it('increments the counter of an existing row and marks it as a counter', async () => {
        await insert('/metrics/counter/hits', 'txt', '', 'public', 'public');

        assert.strictEqual(
            (await increment('/metrics/counter/hits', 'public', 'public')).status, 'OK');

        const row = await get('/metrics/counter/hits', 'public', 'public');
        assert.strictEqual(row.counter, 1);
        assert.strictEqual(row.type, 'counter');
    });

    it('keeps counting on repeated calls', async () => {
        await increment('/metrics/counter/hits', 'public', 'public');
        await increment('/metrics/counter/hits', 'public', 'public');

        assert.strictEqual((await get('/metrics/counter/hits', 'public', 'public')).counter, 3);
    });

    it('creates the row on the first increment, already counting that one', async () => {
        const result = await increment('/metrics/counter/brand-new', 'public', 'public');
        assert.strictEqual(result.status, 'OK');

        const row = await get('/metrics/counter/brand-new', 'public', 'public');
        assert.strictEqual(row.counter, 1);
        assert.strictEqual(row.type, 'counter');
    });

    it('keeps counting after creating the row', async () => {
        await increment('/metrics/counter/brand-new', 'public', 'public');
        assert.strictEqual((await get('/metrics/counter/brand-new', 'public', 'public')).counter, 2);
    });

    it('files a new counter under the author and group it was given', async () => {
        await increment('/metrics/counter/alices', 'alice', 'alice');

        const row = await get('/metrics/counter/alices', 'alice', 'alice');
        assert.strictEqual(row.author, 'alice');
        assert.strictEqual(row.public, 'alice');
        assert.ok((await get('/metrics/counter/alices', 'bob', 'bob')).unavailable);
    });

    it('survives concurrent first increments of the same counter', async () => {
        const results = await Promise.all([
            increment('/metrics/counter/racy', 'public', 'public'),
            increment('/metrics/counter/racy', 'public', 'public'),
            increment('/metrics/counter/racy', 'public', 'public')
        ]);

        assert.ok(results.every(r => r.status === 'OK'), JSON.stringify(results));
        const row = await get('/metrics/counter/racy', 'public', 'public');
        assert.ok(row.counter >= 1 && row.counter <= 3);
    });
});
