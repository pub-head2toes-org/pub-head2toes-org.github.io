'use strict';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import Render from '../src/h2t/Render.js';
import SezamApi from '../src/h2t/SezamApi.js';
import SezamConfig, { CONFIG_PATH, NEGATIVE_TTL_MS, defaultThreadPath } from '../src/h2t/SezamConfig.js';
import sqlite3 from 'sqlite3';
import SezamBuild, { DEPTH_CEILING } from '../src/h2t/SezamBuild.js';
import SezamDB from '../src/h2t/SezamDB.js';
import { buildFixture } from './helpers/sezamDb.js';
import MockRes from './helpers/mockRes.js';
import { freshDb, promisify1, TMP_DIR } from './helpers/db.js';

const render = new Render();
const OPERATOR = 'operator-public-key';
const quiet = () => {};

let abcd, abcdFile, insert;

/** An API wired to this test's abcd store, with the environment under control. */
function api (env = {}, openDb = () => ({ stub: true })){
    return new SezamApi(abcd, { render, env, openDb, log: quiet });
}

async function call (instance, pathname, query = {}){
    const res = new MockRes();
    await instance.handle(pathname, query, {}, res);
    await res.done;
    return res;
}

before(async () => {
    const fixture = await freshDb('sezam.config.test.db');
    abcd = fixture.db;
    abcdFile = fixture.absolute;
    insert = promisify1(abcd.insert, abcd);
});

after(() => fs.rmSync(abcdFile, { force: true }));

beforeEach(async () => {
    await abcd.runSql('DELETE FROM abcd', []);
});

// Phase 0: a node with no archive answers correctly, before any data is read.
describe('Sezam API when the archive is not configured', () => {
    it('answers 503 NotAvailable on every endpoint', async () => {
        const instance = api();
        for (const pathname of ['/api/sezam/meta', '/api/sezam/topic', '/api/sezam/message/1',
                                '/api/sezam/user?city=Beograd', '/api/sezam/nonsense']){
            const res = await call(instance, pathname.split('?')[0]);
            assert.strictEqual(res.statusCode, 503, pathname);
            assert.strictEqual(res.json.available, false, pathname);
            assert.strictEqual(res.json.error.code, 'NotAvailable', pathname);
            assert.strictEqual(res.json.error.param, CONFIG_PATH, pathname);
        }
    });

    it('tells a cache not to remember it', async () => {
        const res = await call(api(), '/api/sezam/meta');
        assert.strictEqual(res.headers['Cache-Control'], 'no-store');
    });

    it('never puts a filesystem path in the response body', async () => {
        const secret = path.join(TMP_DIR, 'private-corpus', 'not-your-business.db');
        await insert(CONFIG_PATH, 'json', JSON.stringify({ db: secret }), OPERATOR, OPERATOR);
        // Resolution fails because the file is absent - and the failure must not
        // echo back the path it was given.
        const res = await call(api(), '/api/sezam/meta');
        assert.strictEqual(res.statusCode, 503);
        assert.ok(!res.body.includes('not-your-business'), res.body);
        assert.ok(!res.body.includes('private-corpus'), res.body);
    });

    it('refuses a config row stored public, which would be served to anyone', async () => {
        // Render.render hands out any abcd row whose public column is 'public'.
        // A config row stored that way is a filesystem path at GET /config/sezam.
        const archive = archiveFile('public-config.db');
        await insert(CONFIG_PATH, 'json', JSON.stringify({ db: archive }), OPERATOR, 'public');
        const reasons = [];
        const config = new SezamConfig(abcd, { log: (...args) => reasons.push(args.join(' ')) });
        const resolved = await config.resolve();
        assert.strictEqual(resolved.available, false);
        assert.strictEqual(resolved.code, 'public-config');
        assert.match(reasons.join(' '), /public/);
    });
});

describe('SezamConfig resolution', () => {
    it('prefers SEZAM_DB over the abcd row', async () => {
        const fromEnv = archiveFile('env.db');
        const fromRow = archiveFile('row.db');
        await insert(CONFIG_PATH, 'json', JSON.stringify({ db: fromRow }), OPERATOR, OPERATOR);
        const config = new SezamConfig(abcd, { env: { SEZAM_DB: fromEnv }, log: quiet });
        const resolved = await config.resolve();
        assert.strictEqual(resolved.available, true);
        assert.strictEqual(resolved.db, fromEnv);
    });

    it('defaults the sidecar to <archive>-thread.db', async () => {
        const archive = archiveFile('defaults.db');
        const config = new SezamConfig(abcd, { env: { SEZAM_DB: archive }, log: quiet });
        const resolved = await config.resolve();
        assert.strictEqual(resolved.thread, defaultThreadPath(archive));
        assert.ok(resolved.thread.endsWith('defaults-thread.db'));
    });

    it('reports a reason for each way it can fail', async () => {
        const cases = [
            [null, 'no-config'],
            ['not json at all', 'bad-json'],
            [JSON.stringify({ notDb: 'x' }), 'no-db-path'],
            [JSON.stringify({ db: path.join(TMP_DIR, 'absent.db') }), 'missing']
        ];
        for (const [value, code] of cases){
            await abcd.runSql('DELETE FROM abcd', []);
            if (value !== null){
                await insert(CONFIG_PATH, 'json', value, OPERATOR, OPERATOR);
            }
            const config = new SezamConfig(abcd, { log: quiet });
            const resolved = await config.resolve();
            assert.strictEqual(resolved.available, false, code);
            assert.strictEqual(resolved.code, code);
        }
    });

    it('comes up after the row is added, without a restart', async () => {
        let clock = 1000;
        const config = new SezamConfig(abcd, { now: () => clock, log: quiet });
        assert.strictEqual((await config.resolve()).available, false);

        const archive = archiveFile('late.db');
        await insert(CONFIG_PATH, 'json', JSON.stringify({ db: archive }), OPERATOR, OPERATOR);

        // Still inside the negative window: the cached failure stands.
        clock += NEGATIVE_TTL_MS - 1;
        assert.strictEqual((await config.resolve()).available, false);

        clock += 2;
        const resolved = await config.resolve();
        assert.strictEqual(resolved.available, true);
        assert.strictEqual(resolved.db, archive);
    });

    it('resolves once for concurrent first requests', async () => {
        const archive = archiveFile('concurrent.db');
        await insert(CONFIG_PATH, 'json', JSON.stringify({ db: archive }), OPERATOR, OPERATOR);
        let reads = 0;
        const counting = {
            getConfig: p => { reads++; return abcd.getConfig(p); }
        };
        const config = new SezamConfig(counting, { log: quiet });
        const all = await Promise.all([config.resolve(), config.resolve(), config.resolve()]);
        assert.ok(all.every(r => r.available));
        assert.strictEqual(reads, 1);
    });
});

describe('SqliteDB.getConfig', () => {
    it('reads a row the public/author filter would hide', async () => {
        await insert(CONFIG_PATH, 'json', '{"db":"/somewhere"}', OPERATOR, OPERATOR);
        const throughFilter = await promisify1(abcd.get, abcd)(CONFIG_PATH, 'public', 'public');
        assert.ok(throughFilter.unavailable, 'a browser must not see the config row');
        const row = await abcd.getConfig(CONFIG_PATH);
        assert.strictEqual(row.value, '{"db":"/somewhere"}');
        assert.strictEqual(row.public, OPERATOR);
    });
});

describe('Render.renderJSON', () => {
    it('still writes 200 when no status is given', async () => {
        const res = new MockRes();
        render.renderJSON({ ok: true }, res);
        await res.done;
        assert.strictEqual(res.statusCode, 200);
    });

    it('writes the status it is given', async () => {
        const res = new MockRes();
        render.renderJSON({ ok: false }, res, 503);
        await res.done;
        assert.strictEqual(res.statusCode, 503);
    });
});

/** Creates an empty file to stand in for an archive, and returns its path. */
function archiveFile (name){
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const file = path.join(TMP_DIR, name);
    fs.writeFileSync(file, '');
    return file;
}

// Phase 1: the build, and the findings it exists to handle.
describe('SezamBuild', () => {
    let fixture, db;

    before(async () => {
        fixture = await buildFixture('sezam.build.test.db');
        db = await SezamDB.open({ db: fixture.archive, thread: fixture.thread });
    });

    after(async () => {
        await db.close();
        fixture.cleanup();
    });

    it('puts every message in exactly one thread', async () => {
        const counts = await db.get(`SELECT
            (SELECT count(*) FROM message)      AS messages,
            (SELECT count(*) FROM message_thread) AS threaded,
            (SELECT sum(size) FROM thread)      AS inThreads`);
        assert.strictEqual(counts.threaded, counts.messages);
        assert.strictEqual(counts.inThreads, counts.messages);
    });

    it('threads the empty-string root as a root', async () => {
        // Finding (1): db/sample.db stores roots as '', which SQLite keeps as
        // text because it cannot convert it to the column's INTEGER affinity.
        const row = await db.get(
            "SELECT typeof(m.reply_seq) AS type, t.depth, t.root_seq FROM message m "
            + 'JOIN message_thread t ON t.topic_id = m.topic_id AND t.seq = m.seq '
            + 'WHERE m.topic_id = 2 AND m.seq = 1');
        assert.strictEqual(row.type, 'text');
        assert.strictEqual(row.depth, 0);
        assert.strictEqual(row.root_seq, 1);
    });

    it('promotes a self reference, a forward reference and an orphan to roots', async () => {
        // Finding (3): 2 226 messages in the archive have an unusable parent.
        // Dropped, they would vanish; promoted, they are still readable.
        for (const seq of [2, 3, 4]){
            const row = await db.get(
                'SELECT t.depth, t.root_seq, m.reply_seq FROM message m '
                + 'JOIN message_thread t ON t.topic_id = m.topic_id AND t.seq = m.seq '
                + 'WHERE m.topic_id = 2 AND m.seq = ?', [seq]);
            assert.strictEqual(row.depth, 0, `seq ${seq} should be a root`);
            assert.strictEqual(row.root_seq, seq, `seq ${seq} should root its own thread`);
            assert.ok(row.reply_seq !== null,
                `seq ${seq} must keep reply_seq so a page can still say "reply to N"`);
        }
    });

    it('survives a chain deeper than the first draft s ceiling of 64', async () => {
        // Finding (4): the archive's deepest chain is 81. At depth < 64 the
        // walk reaches 572 590 of 572 645 messages and silently stops.
        const row = await db.get('SELECT count(*) AS n, max(depth) AS depth FROM message_thread WHERE topic_id = 4');
        assert.strictEqual(row.n, 70);
        assert.strictEqual(row.depth, 69);
        assert.ok(row.depth > 64, 'the fixture must exceed the ceiling that was wrong');
    });

    it('numbers ord densely from 0 within each thread', async () => {
        const bad = await db.all(`SELECT topic_id, root_seq FROM (
            SELECT topic_id, root_seq, count(*) AS c, min(ord) AS lo, max(ord) AS hi,
                   count(DISTINCT ord) AS d
              FROM message_thread GROUP BY topic_id, root_seq)
            WHERE lo <> 0 OR hi <> c - 1 OR d <> c`);
        assert.deepStrictEqual(bad, []);
    });

    it('gives every reply a depth one below its parent, in the same thread', async () => {
        const bad = await db.all(
            'SELECT t.topic_id, t.seq FROM message_thread t '
            + 'JOIN message m ON m.topic_id = t.topic_id AND m.seq = t.seq '
            + 'JOIN message_thread p ON p.topic_id = t.topic_id AND p.seq = m.reply_seq '
            + 'WHERE t.depth > 0 AND (t.depth <> p.depth + 1 OR t.root_seq <> p.root_seq)');
        assert.deepStrictEqual(bad, []);
    });

    it('orders a thread root first, depth first, by ord', async () => {
        const rows = await db.all(
            'SELECT seq, depth FROM message_thread WHERE topic_id = 1 AND root_seq = 1 ORDER BY ord');
        assert.deepStrictEqual(rows.map(r => r.seq), [1, 2, 3, 4]);
        assert.deepStrictEqual(rows.map(r => r.depth), [0, 1, 2, 1]);
    });

    it('records what it built from', async () => {
        const info = Object.fromEntries((await db.all('SELECT key, value FROM build_info'))
            .map(r => [r.key, r.value]));
        assert.strictEqual(info.messages, '86');
        assert.strictEqual(info.depth_ceiling, String(DEPTH_CEILING));
        assert.ok(info.id, 'the ETag is keyed on the build id');
    });

    it('does not write to the archive', async () => {
        // The archive is attached through a file: URI in mode=ro, so a mistake
        // in the build fails with SQLITE_READONLY rather than editing 773 MB
        // of corpus. A bare ANALYZE, which analyses every attached database,
        // is how that was found.
        const before = fs.statSync(fixture.archive);
        await new SezamBuild({ log: () => {} }).build(fixture.archive, fixture.sidecar);
        const after = fs.statSync(fixture.archive);
        assert.strictEqual(after.size, before.size);
        assert.strictEqual(after.mtimeMs, before.mtimeMs);
    });

    it('leaves nothing behind when it fails', async () => {
        const target = path.join(TMP_DIR, 'never-built-thread.db');
        await assert.rejects(
            () => new SezamBuild({ log: () => {} }).build(path.join(TMP_DIR, 'no-such-archive.db'), target),
            /no archive at/);
        assert.ok(!fs.existsSync(target));
        assert.ok(!fs.existsSync(`${target}.building`));
    });

    it('refuses a database that is not a Sezam archive', async () => {
        const stranger = path.join(TMP_DIR, 'stranger.db');
        fs.rmSync(stranger, { force: true });
        await new Promise((resolve, reject) => {
            const raw = new sqlite3.Database(stranger);
            raw.run('CREATE TABLE unrelated(x)', err => err ? reject(err) : raw.close(resolve));
        });
        await assert.rejects(
            () => new SezamBuild({ log: () => {} }).build(stranger, path.join(TMP_DIR, 'stranger-thread.db')),
            /is this a Sezam database/);
        fs.rmSync(stranger, { force: true });
    });
});

describe('SezamDB', () => {
    it('attaches the sidecar when the archive does not carry it', async () => {
        const fixture = await buildFixture('sezam.attached.test.db');
        const db = await SezamDB.open({ db: fixture.archive, thread: fixture.thread });
        assert.strictEqual(db.meta.threaded, true);
        assert.strictEqual(db.meta.thread, fixture.thread);
        assert.strictEqual((await db.get('SELECT count(*) AS n FROM message_thread')).n, 86);
        await db.close();
        fixture.cleanup();
    });

    it('uses the tables in the archive when they are already there', async () => {
        // Same SQL either way: SQLite resolves an unqualified table through
        // main, then temp, then each attached database.
        const fixture = await buildFixture('sezam.inline.test.db', { inline: true });
        const db = await SezamDB.open({ db: fixture.archive, thread: null });
        assert.strictEqual(db.meta.threaded, true);
        assert.strictEqual(db.meta.thread, fixture.archive);
        assert.strictEqual((await db.get('SELECT count(*) AS n FROM message_thread')).n, 86);
        await db.close();
        fixture.cleanup();
    });

    it('reports the FTS tables as healthy when they match their source', async () => {
        const fixture = await buildFixture('sezam.fts.test.db');
        const db = await SezamDB.open({ db: fixture.archive, thread: fixture.thread });
        assert.strictEqual(db.meta.fts.message.rows, 86);
        assert.strictEqual(db.meta.fts.message.expected, 86);
        assert.strictEqual(db.ftsReady, true);
        assert.strictEqual(db.userFtsReady, true);
        await db.close();
        fixture.cleanup();
    });

    it('opens the archive read only', async () => {
        const fixture = await buildFixture('sezam.readonly.test.db');
        const db = await SezamDB.open({ db: fixture.archive, thread: fixture.thread });
        await assert.rejects(() => db.run('DELETE FROM message'), /readonly/i);
        await db.close();
        fixture.cleanup();
    });
});

// Phase 2: /meta and the four lookup resources.
describe('Sezam API lookup resources', () => {
    let fixture, instance;

    before(async () => {
        fixture = await buildFixture('sezam.api.test.db');
        instance = new SezamApi(null, {
            render,
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: quiet
        });
    });

    after(async () => {
        const db = await instance.archive();
        await db.close();
        fixture.cleanup();
    });

    const hit = (pathname, query = {}) => call(instance, pathname, query);

    it('reports what it is serving', async () => {
        const res = await hit('/api/sezam/meta');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.json.available, true);
        assert.strictEqual(res.json.counts.messages, 86);
        assert.strictEqual(res.json.counts.conferences, 3);
        assert.strictEqual(res.json.threaded, true);
        assert.strictEqual(res.json.search.message, 'fts');
        assert.strictEqual(res.json.build.depth_ceiling, String(DEPTH_CEILING));
    });

    it('serves an immutable answer as cacheable', async () => {
        const res = await hit('/api/sezam/conference');
        assert.strictEqual(res.headers['Cache-Control'], 'public, max-age=86400');
    });

    it('lists and fetches conferences', async () => {
        const list = await hit('/api/sezam/conference');
        assert.strictEqual(list.json.data.length, 3);
        const one = await hit('/api/sezam/conference/2');
        assert.strictEqual(one.json.data.volume, 'FORUM.2');
    });

    it('filters conferences by family and volume', async () => {
        const family = await hit('/api/sezam/conference', { family: 'forum' });
        assert.deepStrictEqual(family.json.data.map(c => c.volume), ['FORUM.2', 'FORUM.10']);
        const volume = await hit('/api/sezam/conference', { volume: 'amiga.2' });
        assert.strictEqual(volume.json.data.length, 1);
    });

    it('sorts FORUM.10 after FORUM.2, which a text sort would not', async () => {
        const res = await hit('/api/sezam/conference', { sort: 'volume' });
        assert.deepStrictEqual(res.json.data.map(c => c.volume), ['AMIGA.2', 'FORUM.2', 'FORUM.10']);
    });

    it('lists the topics of a conference, and 404s for one that is not there', async () => {
        const res = await hit('/api/sezam/conference/1/topic');
        assert.deepStrictEqual(res.json.data.map(t => t.id).sort(), [1, 2]);
        const missing = await hit('/api/sezam/conference/99/topic');
        assert.strictEqual(missing.statusCode, 404);
    });

    it('takes a conference as an id or as a volume', async () => {
        const byId = await hit('/api/sezam/topic', { conference: '1' });
        const byVolume = await hit('/api/sezam/topic', { conference: 'AMIGA.2' });
        assert.deepStrictEqual(byId.json.data.map(t => t.id), byVolume.json.data.map(t => t.id));
        assert.strictEqual(byId.json.data.length, 2);
    });

    it('finds a topic name through its diacritics, in both directions', async () => {
        for (const term of ['štampa', 'stampa', 'ŠTAMPA']){
            const res = await hit('/api/sezam/topic', { name: term });
            assert.strictEqual(res.json.data.length, 1, term);
            assert.strictEqual(res.json.data[0].name, 'grafika i štampa');
        }
    });

    it('matches a fragment inside a name, not only a prefix', async () => {
        const res = await hit('/api/sezam/topic', { name: 'ampa' });
        assert.strictEqual(res.json.data.length, 1);
    });

    it('filters authors by a username fragment', async () => {
        const res = await hit('/api/sezam/author', { username: 'ristan' });
        assert.deepStrictEqual(res.json.data.map(a => a.username), ['mristan']);
    });

    it('carries the linked user onto the author, and copes with none', async () => {
        const linked = await hit('/api/sezam/author/1');
        assert.strictEqual(linked.json.data.full_name, 'Rastko Čolić');
        const ghost = await hit('/api/sezam/author/5');
        assert.strictEqual(ghost.json.data.user_id, null);
        assert.strictEqual(ghost.json.data.full_name, null);
    });

    it('filters users on each of the four fragments the brief asks for', async () => {
        const cases = [
            ['full_name', 'ristanovic', ['Milan Ristanović', 'Dejan Ristanovic']],
            ['city', 'ograd', ['Rastko Čolić', 'Dejan Ristanovic']],
            ['company', 'knjiga', ['Rastko Čolić']],
            ['username', 'ristan', ['Milan Ristanović']]
        ];
        for (const [field, term, expected] of cases){
            const res = await hit('/api/sezam/user', { [field]: term });
            assert.deepStrictEqual(res.json.data.map(u => u.full_name).sort(), expected.slice().sort(),
                `${field}=${term}`);
        }
    });

    it('finds Ristanović by typing Ristanovic, and the other way round', async () => {
        // LIKE is ASCII-only and 6 565 of 8 105 users carry diacritics, so
        // both spellings have to reach the same folded column.
        const ascii = await hit('/api/sezam/user', { full_name: 'Ristanovic' });
        const typed = await hit('/api/sezam/user', { full_name: 'Ristanović' });
        assert.strictEqual(ascii.json.data.length, 2);
        assert.deepStrictEqual(ascii.json.data.map(u => u.id), typed.json.data.map(u => u.id));
    });

    it('folds đ, which NFD decomposition alone does not touch', async () => {
        const res = await hit('/api/sezam/user', { city: 'cacak' });
        assert.deepStrictEqual(res.json.data.map(u => u.city), ['Čačak']);
    });

    it('combines fragments with AND', async () => {
        const res = await hit('/api/sezam/user', { city: 'ograd', full_name: 'ristanovic' });
        assert.deepStrictEqual(res.json.data.map(u => u.full_name), ['Dejan Ristanovic']);
    });

    it('pages with limit and offset, with nothing missing or repeated', async () => {
        const all = (await hit('/api/sezam/user', { limit: '100' })).json.data.map(u => u.id);
        const collected = [];
        for (let offset = 0; offset < all.length; offset += 2){
            const page = await hit('/api/sezam/user', { limit: '2', offset: String(offset) });
            collected.push(...page.json.data.map(u => u.id));
        }
        assert.deepStrictEqual(collected, all);
    });

    it('pages with the after cursor, and follows its own next link', async () => {
        const all = (await hit('/api/sezam/user', { limit: '100' })).json.data.map(u => u.id);
        const collected = [];
        let next = '/api/sezam/user?limit=2';
        for (let guard = 0; guard < 20 && next; guard++){
            const [pathname, search] = next.split('?');
            const res = await hit(pathname, Object.fromEntries(new URLSearchParams(search)));
            collected.push(...res.json.data.map(u => u.id));
            next = res.json.page.next;
        }
        assert.deepStrictEqual(collected, all);
    });

    it('counts only when asked', async () => {
        const without = await hit('/api/sezam/user', { limit: '1' });
        assert.strictEqual(without.json.page.total, undefined);
        const with_ = await hit('/api/sezam/user', { limit: '1', total: 'true' });
        assert.strictEqual(with_.json.page.total, 5);
        assert.strictEqual(with_.json.page.hasMore, true);
    });

    it('treats an empty parameter as no filter, the way a blank form field is', async () => {
        const blank = await hit('/api/sezam/user', { city: '', full_name: '' });
        const all = await hit('/api/sezam/user');
        assert.deepStrictEqual(blank.json.data.map(u => u.id), all.json.data.map(u => u.id));
    });

    it('narrows the payload to the requested fields', async () => {
        const res = await hit('/api/sezam/user', { fields: 'id,full_name', limit: '1' });
        assert.deepStrictEqual(Object.keys(res.json.data[0]), ['id', 'full_name']);
    });

    it('rejects what it cannot understand, with the parameter named', async () => {
        const cases = [
            [{ limit: '0' }, 'limit'], [{ limit: '10000' }, 'limit'], [{ limit: 'abc' }, 'limit'],
            [{ offset: '-1' }, 'offset'], [{ offset: '200000' }, 'offset'],
            [{ sort: 'body; DROP TABLE user' }, 'sort'], [{ total: 'maybe' }, 'total'],
            [{ after: '3', sort: 'city' }, 'after']
        ];
        for (const [query, param] of cases){
            const res = await hit('/api/sezam/user', query);
            assert.strictEqual(res.statusCode, 400, JSON.stringify(query));
            assert.strictEqual(res.json.error.code, 'BadRequest');
            assert.strictEqual(res.json.error.param, param, JSON.stringify(query));
        }
    });

    it('404s an unknown id and an unknown endpoint', async () => {
        assert.strictEqual((await hit('/api/sezam/user/999')).statusCode, 404);
        assert.strictEqual((await hit('/api/sezam/topic/999')).statusCode, 404);
        assert.strictEqual((await hit('/api/sezam/nonsense')).statusCode, 404);
    });

    it('never uses declared_count, which disagrees with reality', async () => {
        // Finding (2): topic.msg_count is exact, topic.declared_count is the
        // count the BBS header claimed and is wrong for 1 225 of 1 405 topics.
        const res = await hit('/api/sezam/topic/1', {});
        assert.strictEqual(res.json.data.declared_count, 99);
        assert.strictEqual(res.json.data.msg_count, 6);
        const list = await hit('/api/sezam/topic', { total: 'true' });
        assert.strictEqual(list.json.page.total, 4);
    });
});

// Phase 3: the flat message resource, its composite key and its filters.
describe('Sezam API messages, flat', () => {
    let fixture, instance;

    before(async () => {
        fixture = await buildFixture('sezam.message.test.db');
        instance = new SezamApi(null, {
            render,
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: quiet
        });
    });

    after(async () => {
        const db = await instance.archive();
        await db.close();
        fixture.cleanup();
    });

    const hit = (pathname, query = {}) => call(instance, pathname, query);

    it('carries the whole composite key on every message', async () => {
        const res = await hit('/api/sezam/message', { limit: '1' });
        const message = res.json.data[0];
        assert.deepStrictEqual(Object.keys(message.key).sort(),
            ['id', 'reply_seq', 'seq', 'topic_id']);
        assert.strictEqual(typeof message.root_seq, 'number');
        assert.strictEqual(typeof message.depth, 'number');
        assert.strictEqual(message.author.username, 'rcolic');
    });

    it('reaches the same message canonically and positionally', async () => {
        const canonical = await hit('/api/sezam/message/2');
        const positional = await hit('/api/sezam/topic/1/message/2');
        assert.deepStrictEqual(canonical.json.data, positional.json.data);
        assert.strictEqual(canonical.json.data.key.seq, 2);
    });

    it('lets a reply fetch its parent without a search', async () => {
        // What the composite key is for: reply_seq is a seq within the topic,
        // so the parent is one positional GET away.
        const child = (await hit('/api/sezam/message/3')).json.data;
        assert.strictEqual(child.key.reply_seq, 2);
        const parent = await hit(`/api/sezam/topic/${child.key.topic_id}/message/${child.key.reply_seq}`);
        assert.strictEqual(parent.json.data.key.seq, 2);
        assert.strictEqual(parent.json.data.author.username, child.reply_author);
    });

    it('links each message to its thread', async () => {
        const message = (await hit('/api/sezam/message/3')).json.data;
        assert.strictEqual(message.thread, '/api/sezam/topic/1/thread/1');
        assert.strictEqual(message.root_seq, 1);
        assert.strictEqual(message.depth, 2);
    });

    it('filters by topic, including several at once', async () => {
        const one = await hit('/api/sezam/message', { topic: '3', total: 'true' });
        assert.strictEqual(one.json.page.total, 4);
        const two = await hit('/api/sezam/message', { topic: ['1', '3'], total: 'true', limit: '100' });
        assert.strictEqual(two.json.page.total, 10);
    });

    it('filters by author, by id and by handle', async () => {
        const byId = await hit('/api/sezam/message', { author: '3', total: 'true', limit: '100' });
        const byHandle = await hit('/api/sezam/message', { author: 'dejanr', total: 'true', limit: '100' });
        assert.strictEqual(byId.json.page.total, byHandle.json.page.total);
        assert.ok(byId.json.page.total > 0);
        assert.ok(byId.json.data.every(m => m.author.username === 'dejanr'));
    });

    it('filters by a single year and by a span', async () => {
        const single = await hit('/api/sezam/message', { year: '1996', total: 'true', limit: '100' });
        assert.strictEqual(single.json.page.total, 1);
        const span = await hit('/api/sezam/message', { year: '1996-1997', total: 'true', limit: '100' });
        assert.strictEqual(span.json.page.total, 3);
        assert.ok(span.json.data.every(m => m.year >= 1996 && m.year <= 1997));
    });

    it('resolves reply_author through the graph, not the stored column', async () => {
        // Finding (5): topic 2 seq 6 stores reply_author 'mikis', but seq 5 -
        // the message it actually replies to - was posted by rcolic. The graph
        // is the authority; the column is display text.
        const stored = (await hit('/api/sezam/topic/2/message/6')).json.data;
        assert.strictEqual(stored.reply_author, 'mikis');
        assert.strictEqual(stored.key.reply_seq, 5);
        const parent = (await hit('/api/sezam/topic/2/message/5')).json.data;
        assert.strictEqual(parent.author.username, 'rcolic');

        const byGraph = await hit('/api/sezam/message', { reply_author: 'rcolic', limit: '100' });
        const ids = byGraph.json.data.map(m => m.key.id);
        assert.ok(ids.includes(stored.key.id),
            'the reply must be found under the parent’s real author');

        const byColumn = await hit('/api/sezam/message', { reply_author: 'mikis', limit: '100' });
        assert.ok(!byColumn.json.data.map(m => m.key.id).includes(stored.key.id),
            'and must not be found under the handle the column claims');
    });

    it('filters by a date range, widening the bound it is given', async () => {
        const year = await hit('/api/sezam/message', { from: '1997', to: '1997', total: 'true', limit: '100' });
        const viaYear = await hit('/api/sezam/message', { year: '1997', total: 'true', limit: '100' });
        assert.strictEqual(year.json.page.total, viaYear.json.page.total);
        assert.strictEqual(year.json.page.total, 2);
    });

    it('treats to=YYYY-MM-DD as the end of that day', async () => {
        const first = (await hit('/api/sezam/message', { limit: '1', sort: 'epoch' })).json.data[0];
        const day = first.ts.slice(0, 10);
        const res = await hit('/api/sezam/message', { from: day, to: day, total: 'true', limit: '100' });
        assert.ok(res.json.page.total >= 1);
        assert.ok(res.json.data.every(m => m.ts.slice(0, 10) === day));
    });

    it('reads a topic in seq order and pages it with a seq cursor', async () => {
        const all = (await hit('/api/sezam/topic/4/message', { limit: '100' })).json.data.map(m => m.key.seq);
        assert.deepStrictEqual(all, Array.from({ length: 70 }, (_, i) => i + 1));

        const collected = [];
        let next = '/api/sezam/topic/4/message?limit=25';
        for (let guard = 0; guard < 10 && next; guard++){
            const [pathname, search] = next.split('?');
            const res = await hit(pathname, Object.fromEntries(new URLSearchParams(search)));
            collected.push(...res.json.data.map(m => m.key.seq));
            next = res.json.page.next;
        }
        assert.deepStrictEqual(collected, all);
        assert.ok(next === undefined || next === null);
    });

    it('uses a seq cursor for a topic and an id cursor across topics', async () => {
        const topic = await hit('/api/sezam/topic/4/message', { limit: '2' });
        assert.match(topic.json.page.next, /after=2$/);
        const flat = await hit('/api/sezam/message', { limit: '2', sort: 'id' });
        assert.match(flat.json.page.next, /after=2$/);
    });

    it('lists an author’s messages, and 404s an author that is not there', async () => {
        const res = await hit('/api/sezam/author/1/message', { total: 'true', limit: '100' });
        assert.ok(res.json.data.every(m => m.author.id === 1));
        assert.strictEqual(res.json.page.total, res.json.data.length);
        assert.strictEqual((await hit('/api/sezam/author/999/message')).statusCode, 404);
    });

    it('rejects a parameter it does not know rather than ignoring it', async () => {
        // A misspelled filter that is silently dropped returns the whole
        // archive and looks like a working search.
        for (const [pathname, query, param] of [
            ['/api/sezam/message', { autor: 'dejanr' }, 'autor'],
            ['/api/sezam/message', { order: 'seq' }, 'order'],
            ['/api/sezam/user', { citty: 'Nis' }, 'citty'],
            ['/api/sezam/topic/1/message', { topic: '2' }, 'topic'],
            ['/api/sezam/author/1/message', { author: '2' }, 'author']
        ]){
            const res = await hit(pathname, query);
            assert.strictEqual(res.statusCode, 400, `${pathname} ${JSON.stringify(query)}`);
            assert.strictEqual(res.json.error.param, param);
        }
    });

    it('rejects malformed dates and years', async () => {
        for (const [query, param] of [
            [{ year: 'abc' }, 'year'], [{ year: '1999-1995' }, 'year'], [{ year: '97' }, 'year'],
            [{ from: '97' }, 'from'], [{ to: '1997-13' }, 'to'], [{ to: '1997-01-99' }, 'to'],
            [{ topic: 'x' }, 'topic']
        ]){
            const res = await hit('/api/sezam/message', query);
            assert.strictEqual(res.statusCode, 400, JSON.stringify(query));
            assert.strictEqual(res.json.error.param, param, JSON.stringify(query));
        }
    });

    it('rejects expand outside the threaded orders', async () => {
        const res = await hit('/api/sezam/topic/1/message', { expand: 'false' });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.json.error.param, 'expand');
    });
});

// Phase 4: order=thread, order=recent, expand and /thread/:root_seq.
describe('Sezam API messages, threaded', () => {
    let fixture, instance, tight;

    before(async () => {
        fixture = await buildFixture('sezam.thread.test.db');
        const options = {
            render,
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: quiet
        };
        instance = new SezamApi(null, options);
        // A ceiling low enough to be reached by a fixture, so the safety valve
        // is exercised rather than assumed.
        tight = new SezamApi(null, { ...options, maxThreadMessages: 5 });
    });

    after(async () => {
        await (await instance.archive()).close();
        await (await tight.archive()).close();
        fixture.cleanup();
    });

    const hit = (pathname, query = {}) => call(instance, pathname, query);

    it('never cuts a thread: every root on a page comes back whole', async () => {
        const db = await instance.archive();
        const sizes = new Map((await db.all('SELECT root_seq, size FROM thread WHERE topic_id = 2'))
            .map(r => [r.root_seq, r.size]));
        for (let limit = 1; limit <= 4; limit++){
            let next = `/api/sezam/topic/2/message?order=thread&limit=${limit}`;
            while (next){
                const [pathname, search] = next.split('?');
                const res = await hit(pathname, Object.fromEntries(new URLSearchParams(search)));
                const counted = new Map();
                for (const message of res.json.data){
                    counted.set(message.root_seq, (counted.get(message.root_seq) || 0) + 1);
                }
                for (const [root, n] of counted){
                    assert.strictEqual(n, sizes.get(root),
                        `limit=${limit}: thread ${root} came back ${n} of ${sizes.get(root)}`);
                }
                next = res.json.page.next;
            }
        }
    });

    it('the pages of a topic, concatenated, are the topic', async () => {
        for (const limit of [1, 2, 3, 7]){
            const collected = [];
            let next = `/api/sezam/topic/1/message?order=thread&limit=${limit}`;
            for (let guard = 0; guard < 50 && next; guard++){
                const [pathname, search] = next.split('?');
                const res = await hit(pathname, Object.fromEntries(new URLSearchParams(search)));
                collected.push(...res.json.data.map(m => m.key.id));
                next = res.json.page.next;
            }
            assert.strictEqual(new Set(collected).size, collected.length, `limit=${limit} repeated a message`);
            assert.strictEqual(collected.length, 6, `limit=${limit} lost a message`);
        }
    });

    it('reads a thread root first, depth first', async () => {
        const res = await hit('/api/sezam/topic/1/message', { order: 'thread', limit: '1' });
        assert.deepStrictEqual(res.json.data.map(m => m.key.seq), [1, 2, 3, 4]);
        assert.deepStrictEqual(res.json.data.map(m => m.depth), [0, 1, 2, 1]);
        assert.strictEqual(res.json.page.threads, 1);
        assert.strictEqual(res.json.page.count, 4);
    });

    it('counts the limit in threads, and reports both units', async () => {
        const res = await hit('/api/sezam/topic/1/message', { order: 'thread', limit: '2' });
        assert.strictEqual(res.json.page.threads, 2);
        assert.strictEqual(res.json.page.count, 6);
        assert.strictEqual(res.json.page.limit, 2);
    });

    it('gives roots only, with a reply count, when expand is false', async () => {
        const res = await hit('/api/sezam/topic/1/message', { order: 'thread', expand: 'false' });
        assert.deepStrictEqual(res.json.data.map(t => t.root_seq), [1, 5]);
        assert.deepStrictEqual(res.json.data.map(t => t.reply_count), [3, 1]);
        assert.deepStrictEqual(res.json.data.map(t => t.size), [4, 2]);
        assert.strictEqual(res.json.data[0].thread, '/api/sezam/topic/1/thread/1');
    });

    it('orders by the most recent reply, which seq cannot express', async () => {
        const res = await hit('/api/sezam/topic/2/message', { order: 'recent', expand: 'false' });
        const epochs = res.json.data.map(t => t.last_epoch);
        assert.deepStrictEqual(epochs, epochs.slice().sort((a, b) => b - a));
        assert.ok(epochs.length > 1);
    });

    it('pages order=recent by offset, since last_epoch cannot key a cursor', async () => {
        const res = await hit('/api/sezam/topic/2/message', { order: 'recent', expand: 'false', limit: '2' });
        assert.match(res.json.page.next, /offset=2/);
        const refused = await hit('/api/sezam/topic/2/message', { order: 'recent', after: '1' });
        assert.strictEqual(refused.statusCode, 400);
        assert.strictEqual(refused.json.error.param, 'after');
    });

    it('stops before the thread that would cross the ceiling', async () => {
        // Topic 1 is two threads of 4 and 2. With a ceiling of 5 the second
        // does not fit, so the page stops at the first and says so.
        const res = await call(tight, '/api/sezam/topic/1/message', { order: 'thread', limit: '10' });
        assert.strictEqual(res.json.page.threads, 1);
        assert.strictEqual(res.json.page.count, 4);
        assert.strictEqual(res.json.page.truncated, true);
        assert.strictEqual(res.json.page.hasMore, true);
    });

    it('returns an oversize thread whole rather than cutting it', async () => {
        // Topic 4 is one 70 message thread against a ceiling of 5.
        // Completeness wins: half a thread is the failure this mode prevents.
        const res = await call(tight, '/api/sezam/topic/4/message', { order: 'thread' });
        assert.strictEqual(res.json.page.count, 70);
        assert.strictEqual(res.json.page.oversizeThread, 1);
        assert.strictEqual(res.json.page.truncated, undefined);
    });

    it('serves one complete chain, with no limit', async () => {
        const res = await hit('/api/sezam/topic/4/thread/1');
        assert.strictEqual(res.json.page.count, 70);
        assert.strictEqual(res.json.page.complete, true);
        assert.strictEqual(res.json.thread.size, 70);
        assert.strictEqual(res.json.thread.reply_count, 69);
        assert.strictEqual(res.json.thread.max_depth, 69);
        assert.deepStrictEqual(res.json.data.map(m => m.depth), res.json.data.map((_, i) => i));
    });

    it('404s a thread that is not rooted where it was asked for', async () => {
        assert.strictEqual((await hit('/api/sezam/topic/1/thread/2')).statusCode, 404);
        assert.strictEqual((await hit('/api/sezam/topic/1/thread/999')).statusCode, 404);
    });

    it('threads the promoted roots as their own threads', async () => {
        // The self reference, forward reference and orphan of topic 2 are
        // roots, so a threaded read of the topic reaches all six messages.
        const res = await hit('/api/sezam/topic/2/message', { order: 'thread', limit: '10' });
        assert.strictEqual(res.json.page.threads, 4);
        assert.strictEqual(res.json.page.count, 6);
        assert.deepStrictEqual(res.json.data.map(m => m.key.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    });

    it('refuses to filter a mode whose promise is completeness', async () => {
        for (const filter of [{ year: '1995' }, { author: 'rcolic' }, { from: '1995' }]){
            const res = await hit('/api/sezam/topic/1/message', { order: 'thread', ...filter });
            assert.strictEqual(res.statusCode, 400, JSON.stringify(filter));
            assert.match(res.json.error.message, /whole threads/);
        }
        const sorted = await hit('/api/sezam/topic/1/message', { order: 'thread', sort: 'epoch' });
        assert.strictEqual(sorted.statusCode, 400);
        assert.strictEqual(sorted.json.error.param, 'sort');
    });

    it('says so when the node has no thread index', async () => {
        const bare = await buildFixture('sezam.unthreaded.test.db');
        fs.rmSync(bare.thread, { force: true });
        const api = new SezamApi(null, {
            render,
            env: { SEZAM_DB: bare.archive, SEZAM_THREAD_DB: bare.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: quiet
        });
        const db = await api.archive();
        assert.strictEqual(db.meta.threaded, false);

        // Flat reading still works; only the threaded modes are unavailable.
        const flat = await call(api, '/api/sezam/topic/1/message');
        assert.strictEqual(flat.statusCode, 200);
        assert.strictEqual(flat.json.data[0].root_seq, null);
        assert.strictEqual(flat.json.data[0].thread, null);

        const threaded = await call(api, '/api/sezam/topic/1/message', { order: 'thread' });
        assert.strictEqual(threaded.statusCode, 503);
        assert.strictEqual(threaded.json.error.code, 'NotAvailable');

        await db.close();
        bare.cleanup();
    });
});

// Phase 5: keyword search over the FTS tables the archive already ships.
describe('Sezam API search', () => {
    let fixture, instance, tight;

    before(async () => {
        fixture = await buildFixture('sezam.search.test.db');
        const options = {
            render,
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: quiet
        };
        instance = new SezamApi(null, options);
        tight = new SezamApi(null, { ...options, maxRankedMatches: 1 });
    });

    after(async () => {
        await (await instance.archive()).close();
        await (await tight.archive()).close();
        fixture.cleanup();
    });

    const hit = (pathname, query = {}) => call(instance, pathname, query);

    it('finds a word in a body', async () => {
        const res = await hit('/api/sezam/message', { q: 'CyberStorm' });
        assert.strictEqual(res.json.data.length, 1);
        assert.match(res.json.data[0].body, /CyberStorm/);
        assert.strictEqual(res.json.page.search, 'fts');
    });

    it('finds a diacritic word by its ASCII spelling, and the other way round', async () => {
        // The index holds folded text, so an unfolded term would match nothing
        // at all and look like an empty result rather than a mistake.
        for (const term of ['dijakritikom', 'Ristanović', 'ristanovic']){
            const res = await hit('/api/sezam/message', { q: term });
            assert.ok(res.json.data.length >= 1, term);
        }
        const typed = await hit('/api/sezam/message', { q: 'Ristanović' });
        const ascii = await hit('/api/sezam/message', { q: 'Ristanovic' });
        assert.deepStrictEqual(typed.json.data.map(m => m.key.id), ascii.json.data.map(m => m.key.id));
    });

    it('excludes with a leading minus', async () => {
        const both = await hit('/api/sezam/message', { q: 'amiga', limit: '100' });
        const without = await hit('/api/sezam/message', { q: 'amiga -atari', limit: '100' });
        assert.ok(both.json.data.length > without.json.data.length);
        assert.ok(without.json.data.every(m => !/atari/i.test(m.body)));
    });

    it('matches a phrase as a phrase', async () => {
        const phrase = await hit('/api/sezam/message', { q: '"duboka nit"', limit: '100' });
        assert.ok(phrase.json.data.length > 0);
        assert.ok(phrase.json.data.every(m => /duboka nit/i.test(m.body)));
    });

    it('matches a prefix with a star', async () => {
        const res = await hit('/api/sezam/message', { q: 'asembl*', limit: '100' });
        assert.ok(res.json.data.length >= 1);
    });

    it('searches people by handle and by their real name', async () => {
        // search.person carries the handle and the linked full name together.
        const byHandle = await hit('/api/sezam/message', { person: 'rcolic', limit: '100' });
        const byName = await hit('/api/sezam/message', { person: 'Čolić', limit: '100' });
        assert.ok(byHandle.json.data.length > 0);
        assert.deepStrictEqual(byHandle.json.data.map(m => m.key.id), byName.json.data.map(m => m.key.id));
        assert.ok(byHandle.json.data.every(m => m.author.username === 'rcolic'));
    });

    it('combines a keyword with the other filters', async () => {
        const res = await hit('/api/sezam/message', { q: 'poruka', topic: '4', limit: '200', total: 'true' });
        assert.ok(res.json.data.every(m => m.key.topic_id === 4));
        assert.strictEqual(res.json.page.total, 70);
        const narrowed = await hit('/api/sezam/message', { q: 'dijakritikom', year: '1996', total: 'true' });
        assert.strictEqual(narrowed.json.page.total, 1);
    });

    it('cuts an excerpt around the match, with the offsets of the hits', async () => {
        // snippet() returns '' on a contentless table, so this is cut here.
        const res = await hit('/api/sezam/message', { q: 'Ristanović' });
        const { excerpt: cut, body } = res.json.data[0];
        assert.ok(cut, 'a search result carries an excerpt');
        assert.ok(cut.matches.length >= 1);
        for (const [start, end] of cut.matches){
            assert.strictEqual(cut.text.slice(start, end).toLowerCase().normalize('NFD')
                .replace(/[̀-ͯ]/g, ''), 'ristanovic');
        }
        assert.ok(body.includes(cut.text.slice(0, 20)), 'the excerpt is cut from the real body');
    });

    it('keeps the excerpt offsets valid when folding changes length', async () => {
        const res = await hit('/api/sezam/message', { q: 'stampa OR dijakritikom', limit: '100' });
        for (const message of res.json.data){
            if (!message.excerpt){
                continue;
            }
            for (const [start, end] of message.excerpt.matches){
                assert.ok(start >= 0 && end <= message.excerpt.text.length);
                assert.ok(end > start);
            }
        }
    });

    it('ranks by relevance by default, and says that it did', async () => {
        const res = await hit('/api/sezam/message', { q: 'poruka', limit: '5' });
        assert.strictEqual(res.json.filters.sort, 'relevance');
        assert.strictEqual(res.json.page.ranked, true);
        assert.strictEqual(typeof res.json.page.matches, 'number');
    });

    it('falls back to date order when a query is too broad to rank', async () => {
        // Ranking is linear in matches: `je` hits 349 334 of the archive and
        // costs 525 ms. A common word should still be searchable, so the page
        // is served in date order and says so rather than being refused.
        const res = await call(tight, '/api/sezam/message', { q: 'poruka', limit: '5' });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.json.page.ranked, false);
        assert.match(res.json.page.rankedReason, /too many/);
        assert.ok(res.json.page.matches > 1);
        assert.ok(res.json.data.length > 0);
    });

    it('refuses sort=relevance without anything to be relevant to', async () => {
        const res = await hit('/api/sezam/message', { sort: 'relevance' });
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.json.error.param, 'sort');
    });

    it('turns a malformed query into a 400, not a stack trace', async () => {
        // Raw FTS5 syntax would be an `fts5: syntax error` thrown from inside
        // the query, surfacing as a 500 on what is really a typo.
        for (const q of ['"unbalanced', '-only', '???', 'NEAR(', 'a OR', '*', '""']){
            const res = await hit('/api/sezam/message', { q });
            assert.ok(res.statusCode === 400 || res.statusCode === 200,
                `q=${q} gave ${res.statusCode}`);
            if (res.statusCode === 400){
                assert.strictEqual(res.json.error.code, 'BadRequest');
                assert.strictEqual(res.json.error.param, 'q');
            }
        }
    });

    it('searches within a topic and within an author', async () => {
        const inTopic = await hit('/api/sezam/topic/4/message', { q: 'poruka', limit: '200' });
        assert.ok(inTopic.json.data.every(m => m.key.topic_id === 4));
        const byAuthor = await hit('/api/sezam/author/1/message', { q: 'nit', limit: '200' });
        assert.ok(byAuthor.json.data.every(m => m.author.id === 1));
    });

    it('serves keyword search through LIKE when the index does not match its source', async () => {
        // A contentless FTS table cannot be rebuilt or integrity-checked, so
        // all the API can do is notice the count disagrees and degrade.
        const broken = await buildFixture('sezam.brokenfts.test.db', { fts: false });
        const api = new SezamApi(null, {
            render,
            env: { SEZAM_DB: broken.archive, SEZAM_THREAD_DB: broken.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: quiet
        });
        const db = await api.archive();
        assert.strictEqual(db.ftsReady, false);

        const meta = await call(api, '/api/sezam/meta');
        assert.strictEqual(meta.json.search.message, 'like');

        const res = await call(api, '/api/sezam/message', { q: 'CyberStorm' });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.json.page.search, 'like');
        assert.strictEqual(res.json.data.length, 1);

        // person search has no LIKE equivalent - there is no folded copy of
        // every body to match against - so it says so instead of guessing.
        const person = await call(api, '/api/sezam/message', { person: 'rcolic' });
        assert.strictEqual(person.statusCode, 503);
        assert.strictEqual(person.json.error.code, 'NotAvailable');

        await db.close();
        broken.cleanup();
    });
});

// Phase 6: caching, free totals and the hardening that spans every endpoint.
describe('Sezam API caching and totals', () => {
    let fixture, instance;

    before(async () => {
        fixture = await buildFixture('sezam.cache.test.db');
        instance = new SezamApi(null, {
            render,
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: quiet
        });
    });

    after(async () => {
        await (await instance.archive()).close();
        fixture.cleanup();
    });

    const hit = (pathname, query = {}, headers = {}) => {
        const res = new MockRes();
        return instance.handle(pathname, query, { headers }, res).then(() => res.done);
    };

    it('gives every answer an ETag keyed on the build', async () => {
        const db = await instance.archive();
        const res = await hit('/api/sezam/topic/1/message');
        assert.ok(res.headers.ETag);
        assert.ok(res.headers.ETag.includes(db.meta.buildId),
            'rebuilding the sidecar has to invalidate every cached page');
    });

    it('answers 304 with no body when the caller already has it', async () => {
        const first = await hit('/api/sezam/topic/1/message');
        const again = await hit('/api/sezam/topic/1/message', {}, { 'if-none-match': first.headers.ETag });
        assert.strictEqual(again.statusCode, 304);
        assert.strictEqual(again.buffer.length, 0);
    });

    it('gives the same validator however the query is spelled', async () => {
        const one = await hit('/api/sezam/user', { limit: '2', total: 'true' });
        const other = await hit('/api/sezam/user', { total: 'true', limit: '2' });
        assert.strictEqual(one.headers.ETag, other.headers.ETag);
        const different = await hit('/api/sezam/user', { limit: '3', total: 'true' });
        assert.notStrictEqual(one.headers.ETag, different.headers.ETag);
    });

    it('does not let a stale validator serve a different page', async () => {
        const first = await hit('/api/sezam/user', { limit: '2' });
        const other = await hit('/api/sezam/user', { limit: '3' }, { 'if-none-match': first.headers.ETag });
        assert.strictEqual(other.statusCode, 200);
    });

    it('puts no validator on an error', async () => {
        const res = await hit('/api/sezam/user/999');
        assert.strictEqual(res.statusCode, 404);
        assert.strictEqual(res.headers.ETag, undefined);
    });

    it('takes an unfiltered total from msg_count and counts only when filtered', async () => {
        const db = await instance.archive();
        const topic = await db.get('SELECT msg_count FROM topic WHERE id = 1');
        const free = await hit('/api/sezam/topic/1/message', { limit: '1', total: 'true' });
        assert.strictEqual(free.json.page.total, topic.msg_count);

        const filtered = await hit('/api/sezam/topic/1/message', { limit: '1', total: 'true', author: 'rcolic' });
        assert.ok(filtered.json.page.total < topic.msg_count);
        assert.ok(filtered.json.page.total > 0);
    });

    it('agrees with a real count on every topic', async () => {
        // The free total is only free if it is also right.
        const db = await instance.archive();
        for (const topic of await db.all('SELECT id FROM topic')){
            const res = await hit(`/api/sezam/topic/${topic.id}/message`, { limit: '1', total: 'true' });
            const counted = await db.get('SELECT count(*) AS n FROM message WHERE topic_id = ?', [topic.id]);
            assert.strictEqual(res.json.page.total, counted.n, `topic ${topic.id}`);
        }
    });

    it('never lets a query string reach SQL as text', async () => {
        const injections = ['1; DROP TABLE message', "1' OR '1'='1", '1 UNION SELECT 1', '../../etc/passwd'];
        for (const value of injections){
            for (const [pathname, param] of [['/api/sezam/user', 'city'], ['/api/sezam/message', 'author'],
                                             ['/api/sezam/topic', 'name'], ['/api/sezam/message', 'q']]){
                const res = await hit(pathname, { [param]: value });
                assert.ok(res.statusCode === 200 || res.statusCode === 400,
                    `${param}=${value} gave ${res.statusCode}`);
            }
        }
        const db = await instance.archive();
        assert.strictEqual((await db.get('SELECT count(*) AS n FROM message')).n, 86,
            'the archive is still there');
    });

    it('treats a LIKE wildcard in a fragment as a literal', async () => {
        const wild = await hit('/api/sezam/user', { city: '%' });
        assert.strictEqual(wild.json.data.length, 0, 'a % must not match every city');
        const underscore = await hit('/api/sezam/user', { city: '_' });
        assert.strictEqual(underscore.json.data.length, 0);
    });
});
