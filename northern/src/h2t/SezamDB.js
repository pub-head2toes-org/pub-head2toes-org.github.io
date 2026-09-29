'use strict';

import fs from 'node:fs';
import sqlite3 from 'sqlite3';

/**
 * A read-only connection to the Sezam archive, plus its thread sidecar.
 *
 * The archive is 773 MB and arrives already built: eleven indexes and two
 * contentless FTS5 tables. Nothing here writes to it. The one thing it does
 * not carry is precomputed thread structure, which SezamBuild.js puts in a
 * separate file that this class attaches.
 *
 * Queries name `message_thread` and `thread` unqualified. SQLite resolves an
 * unqualified table through main, then temp, then each attached database, so
 * the same SQL works whether the sidecar is a separate file or - as in the
 * test fixture - built into the archive itself.
 */
export default class SezamDB {
    constructor(handle, meta){
        this.db = handle;
        this.meta = meta;
    }

    static open (resolved){
        return new Promise((resolve, reject) => {
            const handle = new sqlite3.Database(resolved.db, sqlite3.OPEN_READONLY, async err => {
                if (err){
                    reject(err);
                    return;
                }
                try {
                    const sezam = new SezamDB(handle, { archive: resolved.db, thread: null, threaded: false });
                    await sezam.attachThreads(resolved.thread);
                    await sezam.checkHealth();
                    resolve(sezam);
                } catch (openErr) {
                    handle.close(() => {});
                    reject(openErr);
                }
            });
        });
    }

    /**
     * The sidecar is attached only when the archive does not already carry the
     * tables. A future archive that ships them built in, and the fixture that
     * builds them inline, both take the first branch and need no file.
     */
    async attachThreads (threadPath){
        if (await this.hasTable('message_thread')){
            this.meta.threaded = true;
            this.meta.thread = this.meta.archive;
            return;
        }
        if (!threadPath || !fs.existsSync(threadPath)){
            return;
        }
        await this.run('ATTACH DATABASE ? AS x', [threadPath]);
        this.meta.threaded = await this.hasTable('message_thread');
        this.meta.thread = this.meta.threaded ? threadPath : null;
    }

    /**
     * Both FTS tables are contentless, so they cannot be rebuilt - there is no
     * text stored for 'rebuild' to read, and 'integrity-check' needs a write
     * handle besides. All this connection can do is notice a mismatch, say so,
     * and let keyword search fall back to LIKE rather than serve wrong answers
     * silently.
     */
    async checkHealth (){
        const counts = await this.get(
            'SELECT (SELECT count(*) FROM message) AS messages, (SELECT count(*) FROM user) AS users');
        this.meta.messages = counts.messages;
        this.meta.users = counts.users;
        this.meta.fts = {
            message: await this.ftsMatches('search', counts.messages),
            user: await this.ftsMatches('user_search', counts.users)
        };
        // The ETag is keyed on the build, not the archive, so rebuilding the
        // sidecar invalidates every cached page - which is right, because the
        // threading may have changed even though the corpus did not.
        this.meta.buildId = this.meta.threaded
            ? (await this.get("SELECT value FROM build_info WHERE key = 'id'").catch(() => null) || {}).value || null
            : null;
        return this.meta;
    }

    async ftsMatches (table, expected){
        if (!await this.hasTable(table)){
            return { present: false, rows: 0, expected, healthy: false };
        }
        try {
            const row = await this.get(`SELECT count(*) AS rows FROM ${table}`);
            return { present: true, rows: row.rows, expected, healthy: row.rows === expected };
        } catch (err) {
            return { present: false, rows: 0, expected, healthy: false, error: err.message };
        }
    }

    /** True when keyword search can use FTS rather than the LIKE fallback. */
    get ftsReady (){
        return Boolean(this.meta.fts && this.meta.fts.message && this.meta.fts.message.healthy);
    }

    get userFtsReady (){
        return Boolean(this.meta.fts && this.meta.fts.user && this.meta.fts.user.healthy);
    }

    // pragma_table_list spans every attached schema, so this answers the same
    // way whether the table is in the archive or in the sidecar.
    async hasTable (name){
        const row = await this.get('SELECT schema FROM pragma_table_list WHERE name = ?', [name]);
        return Boolean(row);
    }

    // --- resources -------------------------------------------------------
    //
    // Each list method takes an already validated spec from SezamApi and
    // returns { rows, hasMore, total }. Nothing here parses user input, and
    // every value is bound - the only strings interpolated into SQL are
    // whitelisted column names the API has already checked.

    async overview (){
        const counts = await this.get(`SELECT
            (SELECT count(*) FROM conference) AS conferences,
            (SELECT count(*) FROM topic)      AS topics,
            (SELECT count(*) FROM author)     AS authors,
            (SELECT count(*) FROM user)       AS users,
            (SELECT count(*) FROM message)    AS messages,
            (SELECT min(year) FROM message)   AS firstYear,
            (SELECT max(year) FROM message)   AS lastYear`);
        const build = this.meta.threaded
            ? Object.fromEntries((await this.all('SELECT key, value FROM build_info')).map(r => [r.key, r.value]))
            : {};
        return { counts, build };
    }

    conferences (spec){
        return this.listPage({
            columns: 'id, family, volume, ord, date_from, date_to, msg_count',
            from: 'conference',
            ...spec
        });
    }

    topics (spec){
        return this.listPage({
            columns: 't.id AS id, t.conf_id AS conf_id, t.name AS name, t.declared_count AS declared_count, '
                   + 't.msg_count AS msg_count, t.first_ts AS first_ts, t.last_ts AS last_ts, '
                   + 'c.volume AS conference_volume, c.family AS conference_family',
            from: 'topic t JOIN conference c ON c.id = t.conf_id',
            ...spec
        });
    }

    authors (spec){
        return this.listPage({
            columns: 'a.id AS id, a.username AS username, a.msg_count AS msg_count, '
                   + 'a.first_ts AS first_ts, a.last_ts AS last_ts, a.user_id AS user_id, '
                   + 'u.full_name AS full_name, u.city AS city',
            from: 'author a LEFT JOIN user u ON u.id = a.user_id',
            ...spec
        });
    }

    users (spec){
        return this.listPage({
            columns: 'id, username, full_name, city, company, member_since, member_since_iso, '
                   + 'last_seen, last_seen_iso',
            from: 'user',
            ...spec
        });
    }

    // Every message carries its whole composite key, plus the root_seq and
    // depth that say where it sits in its thread. The thread join is LEFT so
    // that a node whose sidecar has not been built yet still serves messages,
    // just without their thread position.
    // A missing sidecar means message_thread does not exist at all, and a join
    // to a table that is not there is a hard error, not a null. So an
    // unthreaded node selects the two columns as NULL and omits the join
    // entirely - it still serves every message, just without its position.
    get messageColumns (){
        const base = 'm.id AS id, m.topic_id AS topic_id, m.seq AS seq, m.reply_seq AS reply_seq, '
             + 'm.author_id AS author_id, a.username AS author_username, '
             + 'm.ts AS ts, m.epoch AS epoch, m.year AS year, m.reply_author AS reply_author, '
             + 'm.body AS body';
        return this.meta.threaded
            ? `${base}, mt.root_seq AS root_seq, mt.depth AS depth`
            : `${base}, NULL AS root_seq, NULL AS depth`;
    }

    // An FTS5 table cannot be given an alias - MATCH and bm25() both need the
    // table's own name - so the search join appears unaliased when it is used.
    messageFrom ({ search = false } = {}){
        let from = 'message m JOIN author a ON a.id = m.author_id';
        if (this.meta.threaded){
            from += ' LEFT JOIN message_thread mt ON mt.topic_id = m.topic_id AND mt.seq = m.seq';
        }
        if (search){
            from += ' JOIN search ON search.rowid = m.id';
        }
        return from;
    }

    /** How many messages a MATCH expression hits - cheap even at 349 334. */
    matchCount (expression){
        return this.get('SELECT count(*) AS n FROM search WHERE search MATCH ?', [expression])
            .then(row => row.n);
    }

    messages (spec){
        return this.listPage({ columns: this.messageColumns, from: this.messageFrom(spec), ...spec });
    }

    /**
     * A page of thread roots - the unit order=thread counts its limit in.
     *
     * `size` comes back with them so the message ceiling can be enforced
     * before any message is fetched, rather than discovered afterwards.
     */
    threadRoots ({ topicId, limit, offset = 0, after = null, recent = false }){
        const where = ['topic_id = ?'];
        const params = [topicId];
        if (after !== null){
            where.push('root_seq > ?');
            params.push(after);
        }
        const orderBy = recent ? 'last_epoch DESC, root_seq DESC' : 'root_seq';
        return this.all(
            `SELECT root_seq, size, max_depth, last_seq, last_epoch FROM thread
              WHERE ${where.join(' AND ')} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
            [...params, limit + 1, offset]);
    }

    threadCount (topicId){
        return this.get('SELECT count(*) AS n FROM thread WHERE topic_id = ?', [topicId])
            .then(row => row.n);
    }

    /** Every message of the named threads, already in reading order. */
    messagesInThreads (topicId, rootSeqs){
        if (!rootSeqs.length){
            return Promise.resolve([]);
        }
        const holes = rootSeqs.map(() => '?').join(',');
        return this.all(
            `SELECT ${this.messageColumns} FROM ${this.messageFrom()}
              WHERE mt.topic_id = ? AND mt.root_seq IN (${holes})
              ORDER BY mt.root_seq, mt.ord`,
            [topicId, ...rootSeqs]);
    }

    /**
     * The root message of each named thread, for a thread list.
     *
     * A list of threads needs a line to show and a name to show it under, and
     * the sidecar holds neither. The body is cut to its first 300 characters
     * here rather than in the page: a thread list of 50 rows should not carry
     * 50 whole messages, some of which are 32 KB.
     */
    threadOpeners (topicId, rootSeqs){
        if (!rootSeqs.length){
            return Promise.resolve([]);
        }
        const holes = rootSeqs.map(() => '?').join(',');
        return this.all(
            `SELECT m.seq AS root_seq, m.ts AS ts, m.epoch AS epoch, m.author_id AS author_id,
                    a.username AS author_username, substr(m.body, 1, 300) AS opener
               FROM message m JOIN author a ON a.id = m.author_id
              WHERE m.topic_id = ? AND m.seq IN (${holes})`,
            [topicId, ...rootSeqs]);
    }

    threadSummary (topicId, rootSeq){
        return this.get(
            'SELECT root_seq, size, max_depth, last_seq, last_epoch FROM thread WHERE topic_id = ? AND root_seq = ?',
            [topicId, rootSeq]);
    }

    /** The canonical lookup, by message.id. */
    message (id){
        return this.get(`SELECT ${this.messageColumns} FROM ${this.messageFrom()} WHERE m.id = ?`, [id]);
    }

    /** The positional lookup - what a reply_seq gives you, without a search. */
    messageAt (topicId, seq){
        return this.get(
            `SELECT ${this.messageColumns} FROM ${this.messageFrom()} WHERE m.topic_id = ? AND m.seq = ?`,
            [topicId, seq]);
    }

    /**
     * One page, plus the one extra row that says whether there is another.
     *
     * The extra row is why hasMore never costs a second COUNT: ask for
     * limit + 1, and if it arrives there is more behind it.
     */
    async listPage ({ columns, from, where = [], params = [], orderBy, limit, offset = 0,
                      total = false, knownTotal = undefined }){
        const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const rows = await this.all(
            `SELECT ${columns} FROM ${from}${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
            [...params, limit + 1, offset]);
        const hasMore = rows.length > limit;
        if (hasMore){
            rows.pop();
        }
        let count = null;
        if (total){
            if (knownTotal !== undefined && knownTotal !== null){
                count = knownTotal;
            } else {
                const row = await this.get(`SELECT count(*) AS n FROM ${from}${clause}`, params);
                count = row.n;
            }
        }
        return { rows, hasMore, total: count };
    }

    all (sql, params = []){
        return new Promise((resolve, reject) =>
            this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
    }

    get (sql, params = []){
        return new Promise((resolve, reject) =>
            this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
    }

    run (sql, params = []){
        return new Promise((resolve, reject) =>
            this.db.run(sql, params, err => err ? reject(err) : resolve()));
    }

    close (){
        return new Promise(resolve => this.db.close(() => resolve()));
    }
}
