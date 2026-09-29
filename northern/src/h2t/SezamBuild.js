'use strict';

import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import SqliteDB from './SqliteDB.js';
import SezamConfig from './SezamConfig.js';
import { fold } from './SezamText.js';

// The deepest real chain in the archive is 81. The ceiling is not what stops
// the walk - because the recursive step requires reply_seq < seq, every hop
// strictly decreases seq and a cycle is arithmetically impossible - it is only
// there so that a future archive with a different shape fails loudly rather
// than spinning. The first draft's 64 would have silently lost 55 messages.
export const DEPTH_CEILING = 256;

/**
 * Builds the thread sidecar.
 *
 * The archive arrives already built: indexes, FTS, denormalised year, NULL
 * roots. The one thing it does not carry is precomputed thread structure, and
 * that is all this script adds. It writes a separate file, because a 773 MB
 * archive is not something to rewrite for the sake of two derived tables, and
 * it attaches the archive through a file: URI in mode=ro so that a bug here
 * cannot damage it.
 */
export default class SezamBuild {
    constructor({ log = console.log } = {}){
        this.log = log;
    }

    async build (archivePath, sidecarPath){
        if (!fs.existsSync(archivePath)){
            throw new Error(`no archive at ${archivePath}`);
        }
        const started = Date.now();
        // A half-written sidecar is worse than none: build beside the target and
        // move it into place only once it is complete and verified.
        const temporary = `${sidecarPath}.building`;
        fs.rmSync(temporary, { force: true });
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });

        const db = await openWritable(temporary);
        try {
            await run(db, 'PRAGMA page_size = 4096');
            await run(db, 'PRAGMA journal_mode = OFF');
            await run(db, `ATTACH DATABASE '${readOnlyUri(archivePath)}' AS s`);
            await this.requireArchive(db);
            await this.createTables(db);
            const walked = await this.walkThreads(db);
            // Before summarising, not after: the summary reads message_thread
            // back and the grouped join wants the index.
            await this.createIndexes(db);
            await this.summariseThreads(db);
            await this.foldNames(db);
            const stats = await this.verify(db, walked);
            await this.writeBuildInfo(db, archivePath, stats, started);
            // ANALYZE with no argument analyses every attached database, which
            // means trying to write sqlite_stat1 into the archive. Name the
            // sidecar explicitly.
            await run(db, 'ANALYZE main');
            await close(db);
        } catch (err) {
            await close(db).catch(() => {});
            fs.rmSync(temporary, { force: true });
            throw err;
        }
        fs.renameSync(temporary, sidecarPath);
        const stats = fs.statSync(sidecarPath);
        this.log(`sezam: built ${sidecarPath} (${(stats.size / 1048576).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return sidecarPath;
    }

    async requireArchive (db){
        for (const table of ['message', 'topic', 'author', 'conference', 'user']){
            const row = await get(db, "SELECT name FROM s.sqlite_schema WHERE type = 'table' AND name = ?", [table]);
            if (!row){
                throw new Error(`the archive has no ${table} table - is this a Sezam database?`);
            }
        }
    }

    async createTables (db){
        // ord rather than a materialised path. The path - each ancestor's seq
        // zero-padded and dotted - sorts a thread correctly with a plain ORDER
        // BY, and the archive's longest is 573 characters; storing it costs
        // 61 MB against 20 MB for the ordinal it can be reduced to. The path is
        // still computed during the walk, then thrown away.
        await run(db, `CREATE TABLE message_thread(
            topic_id INTEGER NOT NULL, seq INTEGER NOT NULL,
            root_seq INTEGER NOT NULL, depth INTEGER NOT NULL, ord INTEGER NOT NULL,
            PRIMARY KEY(topic_id, seq)) WITHOUT ROWID`);
        await run(db, `CREATE TABLE thread(
            topic_id INTEGER NOT NULL, root_seq INTEGER NOT NULL,
            size INTEGER NOT NULL, max_depth INTEGER NOT NULL,
            last_seq INTEGER NOT NULL, last_epoch INTEGER,
            PRIMARY KEY(topic_id, root_seq)) WITHOUT ROWID`);
        // Folded copies of the columns the brief wants fragment filters on.
        //
        // They cannot go in the archive - it is read-only and not ours - and
        // they cannot be computed in SQL, because node's sqlite3 has no way to
        // register a folding function. They also cannot be replaced by the
        // user_search FTS table: FTS matches whole tokens and prefixes, and a
        // "fragment" filter has to find `ograd` inside `Beograd`. So the
        // sidecar carries them: 8 105 users and 3 901 authors, about a
        // megabyte, and a LIKE scan over them costs 4 ms.
        await run(db, `CREATE TABLE user_norm(
            id INTEGER PRIMARY KEY, username TEXT, full_name TEXT, city TEXT, company TEXT)`);
        await run(db, 'CREATE TABLE author_norm(id INTEGER PRIMARY KEY, username TEXT)');
        // 23 topic names carry diacritics (književnost, trač); conference
        // families and author handles are pure ASCII today, but they fold the
        // same way so that an import which changes that needs no new code.
        await run(db, 'CREATE TABLE topic_norm(id INTEGER PRIMARY KEY, name TEXT)');
        await run(db, 'CREATE TABLE build_info(key TEXT PRIMARY KEY, value TEXT)');
    }

    /**
     * One recursive walk over the whole archive.
     *
     * A message is a root when it says so (reply_seq NULL), when its reply_seq
     * is unusable (the sample's empty string, which SQLite keeps as text
     * because it cannot convert it to the column's INTEGER affinity), when it
     * points forward or at itself, or when the parent it names is not in the
     * table. The last three are damage - 2 533 messages, 0.44 % - and every one
     * of them is promoted to a root rather than dropped, so that nothing in the
     * archive is unreachable. Each keeps its reply_seq and reply_author in the
     * payload, so a page can still say "reply to 41".
     */
    async walkThreads (db){
        await run(db, `INSERT INTO message_thread(topic_id, seq, root_seq, depth, ord)
            WITH RECURSIVE walk(topic_id, seq, root_seq, depth, path) AS (
                SELECT topic_id, seq, seq, 0, printf('%06d', seq)
                  FROM s.message m
                 WHERE m.reply_seq IS NULL
                    OR typeof(m.reply_seq) = 'text'
                    OR m.reply_seq >= m.seq
                    OR NOT EXISTS (SELECT 1 FROM s.message p
                                    WHERE p.topic_id = m.topic_id AND p.seq = m.reply_seq)
                UNION ALL
                SELECT m.topic_id, m.seq, walk.root_seq, walk.depth + 1,
                       walk.path || '.' || printf('%06d', m.seq)
                  FROM s.message m
                  JOIN walk ON m.topic_id = walk.topic_id AND m.reply_seq = walk.seq
                 WHERE walk.depth < ${DEPTH_CEILING} AND m.reply_seq < m.seq
            )
            SELECT topic_id, seq, root_seq, depth,
                   row_number() OVER (PARTITION BY topic_id, root_seq ORDER BY path) - 1
              FROM walk`);
        const row = await get(db, 'SELECT count(*) AS rows, max(depth) AS depth FROM message_thread');
        this.log(`sezam: threaded ${row.rows} messages, deepest chain ${row.depth}`);
        return row;
    }

    async summariseThreads (db){
        // size makes reply_count free for expand=false, and last_epoch is the
        // one ordering a forum index wants - threads by most recent reply -
        // which neither seq nor root_seq can express.
        await run(db, `INSERT INTO thread(topic_id, root_seq, size, max_depth, last_seq, last_epoch)
            SELECT t.topic_id, t.root_seq, count(*), max(t.depth), max(t.seq), max(m.epoch)
              FROM message_thread t
              JOIN s.message m ON m.topic_id = t.topic_id AND m.seq = t.seq
             GROUP BY t.topic_id, t.root_seq`);
        await run(db, 'CREATE INDEX ix_thread_last ON thread(topic_id, last_epoch)');
    }

    async createIndexes (db){
        // The partial index is what makes "the next page of threads" an
        // index-only scan of the roots rather than of every message.
        await run(db, 'CREATE INDEX ix_mt_read ON message_thread(topic_id, root_seq, ord)');
        await run(db, 'CREATE INDEX ix_mt_roots ON message_thread(topic_id, root_seq) WHERE depth = 0');
    }

    async foldNames (db){
        const users = await all(db, 'SELECT id, username, full_name, city, company FROM s.user');
        await run(db, 'BEGIN');
        for (const u of users){
            await run(db, 'INSERT INTO user_norm(id, username, full_name, city, company) VALUES (?,?,?,?,?)',
                [u.id, fold(u.username), fold(u.full_name), fold(u.city), fold(u.company)]);
        }
        const authors = await all(db, 'SELECT id, username FROM s.author');
        for (const a of authors){
            await run(db, 'INSERT INTO author_norm(id, username) VALUES (?,?)', [a.id, fold(a.username)]);
        }
        const topics = await all(db, 'SELECT id, name FROM s.topic');
        for (const t of topics){
            await run(db, 'INSERT INTO topic_norm(id, name) VALUES (?,?)', [t.id, fold(t.name)]);
        }
        await run(db, 'COMMIT');
        this.log(`sezam: folded ${users.length} users, ${authors.length} authors, ${topics.length} topics`);
    }

    /** Every message in exactly one thread, or the build is not usable. */
    async verify (db, walked){
        const counts = await get(db, `SELECT
            (SELECT count(*) FROM s.message)        AS messages,
            (SELECT count(*) FROM message_thread)   AS threaded,
            (SELECT count(*) FROM thread)           AS threads,
            (SELECT sum(size) FROM thread)          AS inThreads,
            (SELECT max(depth) FROM message_thread) AS maxDepth`);
        if (counts.threaded !== counts.messages){
            throw new Error(`the walk reached ${counts.threaded} of ${counts.messages} messages - `
                + `${counts.messages - counts.threaded} are unreachable at depth ${DEPTH_CEILING}`);
        }
        if (counts.inThreads !== counts.messages){
            throw new Error(`threads hold ${counts.inThreads} messages, the archive has ${counts.messages}`);
        }
        if (counts.maxDepth >= DEPTH_CEILING){
            throw new Error(`a chain reached the ceiling of ${DEPTH_CEILING}; raise it and rebuild`);
        }
        return { ...counts, deepest: walked.depth };
    }

    async writeBuildInfo (db, archivePath, stats, started){
        // The ETag is keyed on this id, so rebuilding the sidecar invalidates
        // every cached page - which is correct, because the threading may have
        // changed even though the archive did not.
        const archive = fs.statSync(archivePath);
        const info = {
            id: `${archive.size.toString(36)}-${Math.floor(archive.mtimeMs).toString(36)}-${started.toString(36)}`,
            built_at: new Date(started).toISOString(),
            archive: path.basename(archivePath),
            archive_size: archive.size,
            archive_mtime: new Date(archive.mtimeMs).toISOString(),
            messages: stats.messages,
            threads: stats.threads,
            max_depth: stats.maxDepth,
            depth_ceiling: DEPTH_CEILING
        };
        for (const [key, value] of Object.entries(info)){
            await run(db, 'INSERT INTO build_info(key, value) VALUES (?, ?)', [key, String(value)]);
        }
        return info;
    }
}

function openWritable (file){
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file,
            sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_URI,
            err => err ? reject(err) : resolve(db));
    });
}

/**
 * mode=ro makes the attached archive physically read-only, so a mistake in the
 * SQL above fails with SQLITE_READONLY instead of editing the corpus.
 */
function readOnlyUri (file){
    return `file:${encodeURI(path.resolve(file)).replace(/[?#]/g, c => '%' + c.charCodeAt(0).toString(16))}?mode=ro`;
}

const run = (db, sql, params = []) =>
    new Promise((resolve, reject) => db.run(sql, params, err => err ? reject(err) : resolve()));
const all = (db, sql, params = []) =>
    new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
const get = (db, sql, params = []) =>
    new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const close = db => new Promise((resolve, reject) => db.close(err => err ? reject(err) : resolve()));

// CLI: node src/h2t/SezamBuild.js [<archive.db> [<sidecar.db>]]
// With no arguments it builds whatever this node is configured to serve.
if (process.argv[1] && process.argv[1].endsWith('SezamBuild.js')){
    const [, , archiveArg, sidecarArg] = process.argv;
    let archivePath = archiveArg;
    let sidecarPath = sidecarArg;
    if (!archivePath){
        const config = new SezamConfig(new SqliteDB('../../../abcd.db'));
        const resolved = await config.resolve();
        if (!resolved.available){
            console.error(`sezam: ${resolved.reason}`);
            console.error('sezam: usage: node src/h2t/SezamBuild.js <archive.db> [sidecar.db]');
            process.exit(1);
        }
        archivePath = resolved.db;
        sidecarPath = sidecarPath || resolved.thread;
    }
    if (!sidecarPath){
        sidecarPath = archivePath.replace(/(\.db)?$/, '') + '-thread.db';
    }
    await new SezamBuild().build(archivePath, sidecarPath);
    process.exit(0);
}
