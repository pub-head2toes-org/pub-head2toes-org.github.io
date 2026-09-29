'use strict';

import crypto from 'node:crypto';
import SezamConfig from './SezamConfig.js';
import { excerpt, fold, likeFragment, ParseError, parseSearchQuery } from './SezamText.js';

/**
 * An error with a status and a parameter name, so that a bad request is
 * reported as one rather than surfacing as a stack trace and a 500.
 */
export class ApiError extends Error {
    constructor(status, code, message, param){
        super(message);
        this.status = status;
        this.code = code;
        this.param = param;
    }
    static badRequest (message, param){ return new ApiError(400, 'BadRequest', message, param); }
    static notFound (message, param){ return new ApiError(404, 'NotFound', message, param); }
}

/**
 * The REST API over the Sezam archive, mounted at /api/sezam/.
 *
 * Every route is a GET, every response is JSON, and nothing here writes: the
 * archive is closed, and a write path that cannot exist cannot be exploited.
 */
export default class SezamApi {
    constructor(abcdDb, { render, config, openDb, env = process.env, log = console.log,
                          maxThreadMessages = MAX_THREAD_MESSAGES,
                          maxRankedMatches = MAX_RANKED_MATCHES } = {}){
        this.render = render;
        this.log = log;
        this.maxThreadMessages = maxThreadMessages;
        this.maxRankedMatches = maxRankedMatches;
        this.config = config || new SezamConfig(abcdDb, { env, log });
        this.openDb = openDb;
        this.dbPromise = null;
        this.routes = [];
        this.registerRoutes();
    }

    /** True for the paths this API owns, so Server can branch on it. */
    static owns (pathname){
        return pathname === '/api/sezam' || pathname.startsWith('/api/sezam/');
    }

    registerRoutes (){
        this.route('meta', this.getMeta);
        this.route('conference', this.listConferences);
        this.route('conference/:id', this.getConference);
        this.route('conference/:id/topic', this.listTopicsOfConference);
        this.route('topic', this.listTopics);
        this.route('topic/:id', this.getTopic);
        this.route('author', this.listAuthors);
        this.route('author/:id', this.getAuthor);
        this.route('user', this.listUsers);
        this.route('user/:id', this.getUser);
        this.route('message', this.listMessages);
        this.route('message/:id', this.getMessage);
        this.route('topic/:id/message', this.listTopicMessages);
        this.route('topic/:id/message/:seq', this.getTopicMessage);
        this.route('topic/:id/thread/:root_seq', this.getThread);
        this.route('author/:id/message', this.listAuthorMessages);
    }

    // --- handlers --------------------------------------------------------

    async getMeta ({ db }){
        const overview = await db.overview();
        return {
            available: true,
            counts: overview.counts,
            build: overview.build,
            threaded: db.meta.threaded,
            search: {
                message: db.ftsReady ? 'fts' : 'like',
                user: db.userFtsReady ? 'fts' : 'like',
                detail: db.meta.fts
            }
        };
    }

    async listConferences ({ db, query, pathname }){
        checkParams(query, ['family', 'volume']);
        const page = pageSpec(query, CONFERENCE_SORTS);
        const where = [];
        const params = [];
        if (present(query.family)){
            where.push('lower(family) = lower(?)');
            params.push(requireText(query.family, 'family'));
        }
        if (present(query.volume)){
            where.push('lower(volume) = lower(?)');
            params.push(requireText(query.volume, 'volume'));
        }
        applyCursor(where, params, page, 'id');
        const result = await db.conferences({ ...page, where, params });
        return envelope(result, page, pathname, query, filtersOf(query, ['family', 'volume']));
    }

    async getConference ({ db, params }){
        return { data: await one(db, 'conference', numericId(params.id, 'id')) };
    }

    async listTopicsOfConference ({ db, params, query, pathname }){
        const id = numericId(params.id, 'id');
        await one(db, 'conference', id);
        return this.topicPage({ db, query, pathname, conference: id, fromPath: true });
    }

    async listTopics ({ db, query, pathname }){
        return this.topicPage({ db, query, pathname, conference: query.conference });
    }

    /** Shared by /topic and /conference/:id/topic - the filters are the same. */
    async topicPage ({ db, query, pathname, conference, fromPath = false }){
        checkParams(query, fromPath ? ['name'] : ['conference', 'name']);
        const page = pageSpec(query, TOPIC_SORTS);
        const where = [];
        const params = [];
        if (present(conference)){
            // A conference may be named by id or by volume, because a page that
            // has a volume in its URL should not have to look the id up first.
            const volumes = [];
            const ids = [];
            for (const value of asList(conference, 'conference')){
                if (/^[0-9]+$/.test(value)){
                    ids.push(Number(value));
                } else {
                    volumes.push(value.toLowerCase());
                }
            }
            const parts = [];
            if (ids.length){
                parts.push(`t.conf_id IN (${ids.map(() => '?').join(',')})`);
                params.push(...ids);
            }
            if (volumes.length){
                parts.push(`lower(c.volume) IN (${volumes.map(() => '?').join(',')})`);
                params.push(...volumes);
            }
            where.push(`(${parts.join(' OR ')})`);
        }
        if (present(query.name)){
            where.push('EXISTS (SELECT 1 FROM topic_norm n WHERE n.id = t.id AND n.name LIKE ? ESCAPE \'\\\')');
            params.push(likeFragment(requireText(query.name, 'name')));
        }
        applyCursor(where, params, page, 't.id');
        const result = await db.topics({ ...page, where, params, orderBy: qualify(page.orderBy, 't') });
        return envelope(result, page, pathname, query, filtersOf(query, ['conference', 'name']));
    }

    async getTopic ({ db, params }){
        const id = numericId(params.id, 'id');
        const topic = await db.get(
            'SELECT t.*, c.volume AS conference_volume, c.family AS conference_family '
            + 'FROM topic t JOIN conference c ON c.id = t.conf_id WHERE t.id = ?', [id]);
        if (!topic){
            throw ApiError.notFound(`no topic ${id}`, 'id');
        }
        return { data: topic };
    }

    async listAuthors ({ db, query, pathname }){
        checkParams(query, ['username']);
        const page = pageSpec(query, AUTHOR_SORTS);
        const where = [];
        const params = [];
        if (present(query.username)){
            where.push('EXISTS (SELECT 1 FROM author_norm n WHERE n.id = a.id AND n.username LIKE ? ESCAPE \'\\\')');
            params.push(likeFragment(requireText(query.username, 'username')));
        }
        applyCursor(where, params, page, 'a.id');
        const result = await db.authors({ ...page, where, params, orderBy: qualify(page.orderBy, 'a') });
        return envelope(result, page, pathname, query, filtersOf(query, ['username']));
    }

    async getAuthor ({ db, params }){
        const id = numericId(params.id, 'id');
        const author = await db.get(
            'SELECT a.*, u.full_name, u.city, u.company FROM author a '
            + 'LEFT JOIN user u ON u.id = a.user_id WHERE a.id = ?', [id]);
        if (!author){
            throw ApiError.notFound(`no author ${id}`, 'id');
        }
        return { data: author };
    }

    async listUsers ({ db, query, pathname }){
        checkParams(query, ['full_name', 'city', 'company', 'username']);
        const page = pageSpec(query, USER_SORTS);
        const where = [];
        const params = [];
        // Every fragment filter goes through the folded sidecar columns, never
        // the display column: LIKE is ASCII-only, and 6 565 of 8 105 users
        // carry diacritics. Typing Ristanovic has to find Ristanović.
        for (const field of ['full_name', 'city', 'company', 'username']){
            if (present(query[field])){
                where.push(`EXISTS (SELECT 1 FROM user_norm n WHERE n.id = user.id AND n.${field} LIKE ? ESCAPE '\\')`);
                params.push(likeFragment(requireText(query[field], field)));
            }
        }
        applyCursor(where, params, page, 'id');
        const result = await db.users({ ...page, where, params });
        return envelope(result, page, pathname, query,
            filtersOf(query, ['full_name', 'city', 'company', 'username']));
    }

    async getUser ({ db, params }){
        return { data: await one(db, 'user', numericId(params.id, 'id')) };
    }

    // --- messages --------------------------------------------------------

    /**
     * The flat, cross-topic list.
     *
     * A thread only coheres inside one topic, so a search that spans topics
     * cannot be threaded and is not pretended to be: every row still carries
     * root_seq, depth and a link to its thread, which is what a result list
     * needs anyway.
     */
    async listMessages ({ db, query, pathname }){
        checkParams(query, MESSAGE_FILTER_PARAMS);
        const built = messageFilters(db, query);
        const page = pageSpec(query, MESSAGE_SORTS, { defaultSort: defaultSort(db, built) });
        const ranking = await this.rankingFor(db, page, built);
        applyCursor(built.where, built.params, page, 'm.id');
        const result = await db.messages({
            ...page, where: built.where, params: built.params,
            orderBy: qualify(ranking.orderBy, 'm'), search: built.search
        });
        return messageEnvelope(result, page, pathname, query, built.filters, built, ranking);
    }

    /**
     * Whether this page can be ranked, and what to order it by if not.
     *
     * Ranking costs time in proportion to how many messages match, and the
     * archive has words that match a lot of them: `je` hits 349 334 and takes
     * 525 ms to rank, against 28 ms to count. So the count is checked first,
     * and a query too broad to rank is served in date order with
     * `page.ranked: false` rather than refused - a common word should still be
     * searchable, and the caller is told what it got.
     */
    async rankingFor (db, page, built){
        if (page.sort !== 'relevance'){
            return { orderBy: page.orderBy, ranked: false, applies: false };
        }
        if (!built.search || !db.ftsReady){
            throw ApiError.badRequest('sort=relevance needs a q or person search', 'sort');
        }
        const matches = await db.matchCount(built.expression);
        if (matches > this.maxRankedMatches){
            return {
                orderBy: MESSAGE_SORTS.epoch, ranked: false, applies: true,
                matches, reason: 'too many matches to rank'
            };
        }
        return { orderBy: page.orderBy, ranked: true, applies: true, matches };
    }

    async getMessage ({ db, params }){
        const id = numericId(params.id, 'id');
        const row = await db.message(id);
        if (!row){
            throw ApiError.notFound(`no message ${id}`, 'id');
        }
        return { data: shapeMessage(row) };
    }

    /** Chronological reading of one topic. order=thread arrives in phase 4. */
    async listTopicMessages ({ db, query, pathname, params }){
        const topicId = numericId(params.id, 'id');
        // The topic is in the path, so a topic= filter here would be two answers
        // to the same question.
        checkParams(query, [...MESSAGE_FILTER_PARAMS.filter(p => p !== 'topic'), 'order', 'expand']);
        const topic = await one(db, 'topic', topicId);
        const order = parseOrder(query.order);
        if (order !== 'seq'){
            return this.threadPage({ db, query, pathname, topicId, order });
        }
        if (query.expand !== undefined){
            throw ApiError.badRequest('expand only applies to order=thread or order=recent', 'expand');
        }
        const built = messageFilters(db, query);
        const page = pageSpec(query, MESSAGE_SORTS, { cursorSort: 'seq', defaultSort: 'seq' });
        const ranking = await this.rankingFor(db, page, built);
        built.where.push('m.topic_id = ?');
        built.params.push(topicId);
        // Within a topic the cursor is seq, which is the reading order itself.
        if (page.after !== null){
            built.where.push('m.seq > ?');
            built.params.push(page.after);
        }
        const result = await db.messages({
            ...page, where: built.where, params: built.params,
            orderBy: qualify(ranking.orderBy, 'm'), search: built.search,
            // msg_count agrees with COUNT(*) for every topic in the archive,
            // so an unfiltered total is already on the row - no scan needed.
            knownTotal: unfiltered(built) ? topic.msg_count : undefined
        });
        return messageEnvelope(result, page, pathname, query,
            { ...built.filters, topic: topicId, order }, built, ranking);
    }

    /**
     * order=thread and order=recent: the limit counts threads, not messages.
     *
     * A LIMIT cuts a list, and a thread is not a list - it is a subtree - so a
     * limit counted in messages can land in the middle of one. Counting it in
     * the unit the caller is reading in is the whole fix: ask for N threads,
     * get N complete threads.
     */
    async threadPage ({ db, query, pathname, topicId, order }){
        if (!db.meta.threaded){
            throw new ApiError(503, 'NotAvailable',
                'this node has no thread index; rebuild the sidecar or read with order=seq', 'order');
        }
        // A filter and a completeness guarantee cannot both hold: filtering
        // removes messages from the middle of a thread, which is the one thing
        // this mode exists to prevent.
        const filtered = MESSAGE_FILTER_PARAMS.filter(p => present(query[p]));
        if (filtered.length){
            throw ApiError.badRequest(
                `order=${order} returns whole threads and cannot also filter by ${filtered.join(', ')}; `
                + 'use order=seq, or /api/sezam/message for a flat filtered list', filtered[0]);
        }
        if (query.sort !== undefined){
            throw ApiError.badRequest(`order=${order} sets its own ordering; sort does not apply`, 'sort');
        }
        const recent = order === 'recent';
        const limit = parseLimit(query.limit);
        const offset = parseOffset(query.offset);
        const after = parseAfter(query.after);
        const total = parseBool(query.total, 'total');
        const fields = parseFields(query.fields);
        const expand = query.expand === undefined ? true : parseBool(query.expand, 'expand');
        if (after !== null && recent){
            // last_epoch is not unique, so it cannot key a cursor. Say so.
            throw ApiError.badRequest('after is not available with order=recent; use offset', 'after');
        }

        const roots = await db.threadRoots({ topicId, limit, offset, after, recent });
        let hasMore = roots.length > limit;
        if (hasMore){
            roots.pop();
        }

        const body = {
            data: [],
            page: { limit, offset, count: 0, threads: roots.length, hasMore },
            filters: { topic: topicId, order, expand }
        };
        if (total){
            body.page.total = await db.threadCount(topicId);
        }

        if (!expand){
            const openers = new Map((await db.threadOpeners(topicId, roots.map(r => r.root_seq)))
                .map(row => [row.root_seq, row]));
            body.data = roots.map(root => {
                const opener = openers.get(root.root_seq) || {};
                return {
                    root_seq: root.root_seq,
                    size: root.size,
                    reply_count: root.size - 1,
                    max_depth: root.max_depth,
                    last_seq: root.last_seq,
                    last_epoch: root.last_epoch,
                    opener: opener.opener || null,
                    ts: opener.ts || null,
                    author: opener.author_id === undefined
                        ? null
                        : { id: opener.author_id, username: opener.author_username },
                    thread: `/api/sezam/topic/${topicId}/thread/${root.root_seq}`
                };
            });
            body.page.count = body.data.length;
            return this.finishThreadPage(body, pathname, query, roots, hasMore, recent, limit, offset);
        }

        // The ceiling is a safety valve, not a normal path: the largest thread
        // in the archive is 1 731 messages and the mean is 3.26, so no thread
        // reaches it on its own. A page stops before the thread that would
        // cross it, and a single thread that exceeds it is still returned
        // whole - completeness wins, because half a thread is the failure this
        // mode exists to prevent.
        const kept = [];
        let messages = 0;
        for (const root of roots){
            if (kept.length && messages + root.size > this.maxThreadMessages){
                body.page.truncated = true;
                hasMore = true;
                break;
            }
            kept.push(root);
            messages += root.size;
            if (root.size > this.maxThreadMessages){
                body.page.oversizeThread = root.root_seq;
            }
        }

        const rows = await db.messagesInThreads(topicId, kept.map(r => r.root_seq));
        const byRoot = new Map();
        for (const row of rows){
            if (!byRoot.has(row.root_seq)){
                byRoot.set(row.root_seq, []);
            }
            byRoot.get(row.root_seq).push(row);
        }
        // The SQL orders by root_seq; order=recent wants the roots in their own
        // order, so they are emitted in the order they were paged in.
        const ordered = [];
        for (const root of kept){
            ordered.push(...(byRoot.get(root.root_seq) || []));
        }
        body.data = ordered.map(shapeMessage);
        body.page.count = body.data.length;
        body.page.threads = kept.length;
        return this.finishThreadPage(body, pathname, query, kept, hasMore, recent, limit, offset, fields);
    }

    finishThreadPage (body, pathname, query, kept, hasMore, recent, limit, offset, fields){
        body.page.hasMore = hasMore;
        if (fields){
            body.data = body.data.map(row => pick(row, fields));
        }
        if (hasMore && kept.length){
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(query)){
                if (key === 'offset' || key === 'after'){
                    continue;
                }
                for (const single of Array.isArray(value) ? value : [value]){
                    params.append(key, single);
                }
            }
            if (recent){
                params.set('offset', String(offset + kept.length));
            } else {
                params.set('after', String(kept[kept.length - 1].root_seq));
            }
            body.page.next = `${pathname}?${params.toString()}`;
        }
        return body;
    }

    /** One complete chain, with no limit - it is already bounded by the thread. */
    async getThread ({ db, params, query, pathname }){
        checkParams(query, ['fields']);
        const topicId = numericId(params.id, 'id');
        const rootSeq = numericId(params.root_seq, 'root_seq');
        await one(db, 'topic', topicId);
        if (!db.meta.threaded){
            throw new ApiError(503, 'NotAvailable', 'this node has no thread index', 'root_seq');
        }
        const summary = await db.threadSummary(topicId, rootSeq);
        if (!summary){
            throw ApiError.notFound(`no thread rooted at ${rootSeq} in topic ${topicId}`, 'root_seq');
        }
        const rows = await db.messagesInThreads(topicId, [rootSeq]);
        const fields = parseFields(query.fields);
        const data = rows.map(shapeMessage);
        return {
            data: fields ? data.map(row => pick(row, fields)) : data,
            thread: {
                topic_id: topicId,
                root_seq: rootSeq,
                size: summary.size,
                reply_count: summary.size - 1,
                max_depth: summary.max_depth,
                last_epoch: summary.last_epoch
            },
            page: { count: data.length, complete: true }
        };
    }

    async getTopicMessage ({ db, params }){
        const topicId = numericId(params.id, 'id');
        const seq = numericId(params.seq, 'seq');
        const row = await db.messageAt(topicId, seq);
        if (!row){
            throw ApiError.notFound(`no message ${seq} in topic ${topicId}`, 'seq');
        }
        return { data: shapeMessage(row) };
    }

    async listAuthorMessages ({ db, query, pathname, params }){
        const authorId = numericId(params.id, 'id');
        checkParams(query, MESSAGE_FILTER_PARAMS.filter(p => p !== 'author'));
        const author = await one(db, 'author', authorId);
        const built = messageFilters(db, query);
        const page = pageSpec(query, MESSAGE_SORTS, { defaultSort: defaultSort(db, built) });
        const ranking = await this.rankingFor(db, page, built);
        built.where.push('m.author_id = ?');
        built.params.push(authorId);
        applyCursor(built.where, built.params, page, 'm.id');
        const result = await db.messages({
            ...page, where: built.where, params: built.params,
            orderBy: qualify(ranking.orderBy, 'm'), search: built.search,
            knownTotal: unfiltered(built) ? author.msg_count : undefined
        });
        return messageEnvelope(result, page, pathname, query,
            { ...built.filters, author: authorId }, built, ranking);
    }

    route (pattern, handler){
        this.routes.push({ segments: pattern.split('/').filter(Boolean), handler });
    }

    /**
     * Resolves the archive handle, or null when this node has none.
     * The handle is built once; a failure is retried per SezamConfig's TTL.
     */
    async archive (){
        const resolved = await this.config.resolve();
        if (!resolved.available){
            return null;
        }
        if (!this.dbPromise){
            this.dbPromise = Promise.resolve(this.openDb ? this.openDb(resolved) : null);
        }
        return this.dbPromise;
    }

    async handle (pathname, query, req, res){
        try {
            const body = await this.dispatch(pathname, query, req);
            const status = body.status || 200;
            if (body && body.headers){
                for (const [name, value] of Object.entries(body.headers)){
                    res.setHeader(name, value);
                }
            }
            // The archive is immutable, so a 200 is good until the sidecar is
            // rebuilt. Errors and NotAvailable carry no validator: there is
            // nothing there worth revalidating.
            if (status === 200 && body.etag){
                res.setHeader('ETag', body.etag);
                if (ifNoneMatch(req) === body.etag){
                    res.writeHead(304, {});
                    res.end();
                    return;
                }
            }
            this.render.renderJSON(body.data, res, status);
        } catch (err) {
            this.fail(err, res);
        }
    }

    async dispatch (pathname, query, req){
        const db = await this.archive();
        if (!db){
            return notAvailable();
        }
        const segments = pathname.replace(/^\/api\/sezam\/?/, '').split('/').filter(Boolean);
        const match = this.match(segments);
        if (!match){
            throw ApiError.notFound(`no such endpoint: ${pathname}`, 'path');
        }
        const data = await match.handler.call(this, { db, params: match.params, query, req, pathname });
        return { data, headers: IMMUTABLE_HEADERS, etag: etagFor(db, pathname, query) };
    }

    match (segments){
        for (const route of this.routes){
            if (route.segments.length !== segments.length){
                continue;
            }
            const params = {};
            let ok = true;
            for (let i = 0; i < route.segments.length; i++){
                const want = route.segments[i];
                if (want.startsWith(':')){
                    params[want.slice(1)] = decodeURIComponent(segments[i]);
                } else if (want !== segments[i]){
                    ok = false;
                    break;
                }
            }
            if (ok){
                return { handler: route.handler, params };
            }
        }
        return null;
    }

    fail (err, res){
        if (err instanceof ApiError){
            this.render.renderJSON(errorBody(err.code, err.message, err.param), res, err.status);
            return;
        }
        // Anything unrecognised is this node's fault, and its text is this
        // node's business - the caller gets the status and nothing else.
        this.log('sezam: unhandled error:', err && err.stack ? err.stack : err);
        this.render.renderJSON(errorBody('ServerError', 'the request could not be completed'), res, 500);
    }
}

// --- parameters ----------------------------------------------------------
//
// Everything a caller sends is either bound as a parameter or matched against
// a whitelist. No query string ever reaches SQL as text.

export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 500;
export const OFFSET_MAX = 100000;

// A page of threads stops before crossing this many messages. The archive's
// largest thread is 1 731, so nothing reaches it alone.
export const MAX_THREAD_MESSAGES = 2000;

// Above this many matches a page is served in date order instead of ranked.
// Ranking is linear in matches: 12 141 costs 37 ms, 349 334 costs 525 ms.
export const MAX_RANKED_MATCHES = 50000;

const CONFERENCE_SORTS = { id: 'id', volume: 'family, ord, id', family: 'family, ord, id', ord: 'ord, id' };
const TOPIC_SORTS = { id: 'id', name: 'name, id', messages: 'msg_count DESC, id' };
const AUTHOR_SORTS = { id: 'id', username: 'username, id', messages: 'msg_count DESC, id' };
const USER_SORTS = { id: 'id', username: 'username, id', full_name: 'full_name, id', city: 'city, id' };

/** limit, offset, after and sort, validated once for every list endpoint. */
function pageSpec (query, sorts, { cursorSort = 'id', defaultSort = 'id' } = {}){
    const sortKey = query.sort === undefined ? defaultSort : String(query.sort);
    if (!Object.prototype.hasOwnProperty.call(sorts, sortKey)){
        throw ApiError.badRequest(
            `unknown sort ${sortKey}; try one of ${Object.keys(sorts).join(', ')}`, 'sort');
    }
    const spec = {
        limit: parseLimit(query.limit),
        offset: parseOffset(query.offset),
        after: parseAfter(query.after),
        sort: sortKey,
        cursorSort,
        orderBy: sorts[sortKey],
        total: parseBool(query.total, 'total'),
        fields: parseFields(query.fields)
    };
    if (spec.after !== null && sortKey !== cursorSort){
        // A keyset cursor only means anything against the column it is a key
        // for. Saying so is better than quietly returning the wrong page.
        throw ApiError.badRequest(
            `after is only valid with sort=${cursorSort}, not sort=${sortKey}`, 'after');
    }
    return spec;
}

function parseLimit (raw){
    if (raw === undefined || raw === ''){
        return LIMIT_DEFAULT;
    }
    const value = integer(raw, 'limit');
    if (value < 1 || value > LIMIT_MAX){
        throw ApiError.badRequest(`limit must be between 1 and ${LIMIT_MAX}`, 'limit');
    }
    return value;
}

function parseOffset (raw){
    if (raw === undefined || raw === ''){
        return 0;
    }
    const value = integer(raw, 'offset');
    if (value < 0){
        throw ApiError.badRequest('offset cannot be negative', 'offset');
    }
    if (value > OFFSET_MAX){
        throw ApiError.badRequest(
            `offset above ${OFFSET_MAX} is refused; use the after cursor instead`, 'offset');
    }
    return value;
}

function parseAfter (raw){
    if (raw === undefined || raw === ''){
        return null;
    }
    const value = integer(raw, 'after');
    if (value < 0){
        throw ApiError.badRequest('after cannot be negative', 'after');
    }
    return value;
}

function parseBool (raw, param){
    if (raw === undefined || raw === ''){
        return false;
    }
    if (raw === 'true' || raw === '1'){
        return true;
    }
    if (raw === 'false' || raw === '0'){
        return false;
    }
    throw ApiError.badRequest(`${param} must be true or false`, param);
}

function parseFields (raw){
    if (raw === undefined || raw === ''){
        return null;
    }
    const fields = String(raw).split(',').map(f => f.trim()).filter(Boolean);
    for (const field of fields){
        if (!/^[a-z_][a-z0-9_]*$/.test(field)){
            throw ApiError.badRequest(`unknown field ${field}`, 'fields');
        }
    }
    return fields.length ? fields : null;
}

/**
 * An empty parameter means "no filter", not a mistake.
 *
 * A form with optional fields submits all of them, so `city=` has to mean the
 * box was left blank rather than earn a 400.
 */
function present (value){
    if (value === undefined || value === null){
        return false;
    }
    if (Array.isArray(value)){
        return value.some(present);
    }
    return String(value).trim() !== '';
}

function integer (raw, param){
    const text = String(raw).trim();
    if (!/^-?[0-9]+$/.test(text)){
        throw ApiError.badRequest(`${param} must be a whole number`, param);
    }
    return Number(text);
}

function numericId (raw, param){
    const value = integer(raw, param);
    if (value < 1){
        throw ApiError.badRequest(`${param} must be a positive id`, param);
    }
    return value;
}

function requireText (raw, param){
    const text = String(Array.isArray(raw) ? raw[0] : raw).trim();
    if (!text){
        throw ApiError.badRequest(`${param} cannot be empty`, param);
    }
    return text;
}

/** node's url.parse gives an array when a parameter is repeated. */
function asList (raw, param){
    const values = (Array.isArray(raw) ? raw : [raw]).map(v => String(v).trim()).filter(Boolean);
    if (!values.length){
        throw ApiError.badRequest(`${param} cannot be empty`, param);
    }
    return values;
}

function applyCursor (where, params, page, column){
    if (page.after !== null){
        where.push(`${column} > ?`);
        params.push(page.after);
    }
}

/** Qualifies a whitelisted ORDER BY with a table alias. */
function qualify (orderBy, alias){
    return orderBy.split(',').map(part => {
        const trimmed = part.trim();
        // An expression - bm25(search) - is not a column of the aliased table.
        if (trimmed.includes('(') || trimmed.includes('.')){
            return trimmed;
        }
        const [name, ...rest] = trimmed.split(/\s+/);
        return [`${alias}.${name}`, ...rest].join(' ');
    }).join(', ');
}

const MESSAGE_SORTS = { id: 'id', epoch: 'epoch DESC, id', seq: 'seq, id', year: 'year, epoch, id',
                        relevance: 'bm25(search)' };
const MESSAGE_ORDERS = ['seq', 'thread', 'recent'];

// Every list endpoint takes these; everything else is declared per endpoint.
const COMMON_PARAMS = ['limit', 'offset', 'after', 'total', 'fields', 'sort'];
const MESSAGE_FILTER_PARAMS = ['topic', 'author', 'year', 'reply_author', 'from', 'to', 'q', 'person'];

/**
 * A parameter this endpoint does not know is a 400, not something to ignore.
 *
 * Silently dropping it is how a caller ends up believing a filter was applied
 * when it was not - a misspelled `autor=` would otherwise return the whole
 * archive and look like a working search.
 */
function checkParams (query, allowed){
    const known = new Set([...COMMON_PARAMS, ...allowed]);
    for (const name of Object.keys(query)){
        if (!known.has(name)){
            throw ApiError.badRequest(
                `unknown parameter ${name}; this endpoint takes ${[...known].sort().join(', ')}`, name);
        }
    }
}

function parseOrder (raw){
    if (raw === undefined || raw === ''){
        return 'seq';
    }
    const order = String(raw);
    if (!MESSAGE_ORDERS.includes(order)){
        throw ApiError.badRequest(`unknown order ${order}; try one of ${MESSAGE_ORDERS.join(', ')}`, 'order');
    }
    return order;
}

/**
 * The filters the brief asks for, as bound SQL.
 *
 * Returns the WHERE fragments, their parameters, and the filters echoed back
 * to the caller so a page can see what it actually asked for.
 */
function messageFilters (db, query){
    const where = [];
    const params = [];
    const filters = {};

    if (present(query.topic)){
        const ids = asList(query.topic, 'topic').map(value => {
            if (!/^[0-9]+$/.test(value)){
                throw ApiError.badRequest('topic must be an id', 'topic');
            }
            return Number(value);
        });
        where.push(`m.topic_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
        filters.topic = ids.length === 1 ? ids[0] : ids;
    }

    if (present(query.author)){
        const value = requireText(query.author, 'author');
        if (/^[0-9]+$/.test(value)){
            where.push('m.author_id = ?');
            params.push(Number(value));
        } else {
            // A handle, matched exactly but accent- and case-blind, through the
            // folded sidecar column rather than author.username.
            where.push('m.author_id IN (SELECT id FROM author_norm WHERE username = ?)');
            params.push(fold(value));
        }
        filters.author = value;
    }

    if (present(query.year)){
        const { from, to } = parseYearRange(query.year);
        where.push('m.year BETWEEN ? AND ?');
        params.push(from, to);
        filters.year = query.year;
    }

    if (present(query.reply_author)){
        // Resolved through the graph, not through message.reply_author.
        //
        // The denormalised column disagrees with the parent's actual author on
        // 575 rows, and it carries no index, so a LIKE on it is a full scan of
        // 572 645 messages - 226 ms. Walking author -> their messages -> the
        // messages that reply to them uses ix_msg_author_id and the covering
        // ix_msg_reply, and answers in 29 ms for the heaviest poster.
        where.push(`m.id IN (
            SELECT child.id FROM author_norm an
              JOIN message parent ON parent.author_id = an.id
              JOIN message child ON child.topic_id = parent.topic_id AND child.reply_seq = parent.seq
             WHERE an.username LIKE ? ESCAPE '\\')`);
        params.push(likeFragment(requireText(query.reply_author, 'reply_author')));
        filters.reply_author = query.reply_author;
    }

    // Keyword search. Both FTS tables are contentless and indexed folded, so
    // the expression is built from a parsed grammar rather than passed through,
    // and every term is folded on the way in.
    const ftsParts = [];
    let terms = [];
    if (present(query.q)){
        const parsed = parse(query.q, 'body', 'q');
        ftsParts.push(parsed.expression);
        terms = parsed.terms;
        filters.q = query.q;
    }
    if (present(query.person)){
        // search.person carries the handle and the linked full name together,
        // so this reaches an author by either, across the whole archive.
        ftsParts.push(parse(query.person, 'person', 'person').expression);
        filters.person = query.person;
    }

    let expression = null;
    if (ftsParts.length){
        if (db.ftsReady){
            expression = ftsParts.map(part => `(${part})`).join(' AND ');
            where.push('search MATCH ?');
            params.push(expression);
        } else {
            // The index disagrees with its source, so it cannot be trusted.
            // LIKE still answers, but only for what is spelled the same way:
            // there is no folded copy of 572 645 bodies to match against.
            if (present(query.person)){
                throw new ApiError(503, 'NotAvailable',
                    'person search needs the message index, which is not healthy on this node', 'person');
            }
            for (const term of terms){
                where.push('m.body LIKE ? ESCAPE \'\\\'');
                params.push(`%${term.text.replace(/[\\%_]/g, c => '\\' + c)}%`);
            }
        }
    }

    for (const [param, comparison] of [['from', '>='], ['to', '<=']]){
        if (present(query[param])){
            where.push(`m.epoch ${comparison} ?`);
            params.push(parseDateBound(query[param], param));
            filters[param] = query[param];
        }
    }

    // `search` is whether the FTS join is needed; `mode` is how the keyword
    // search was actually answered. In the LIKE fallback there is a search but
    // no join, so the two are not the same question.
    const mode = ftsParts.length ? (expression ? 'fts' : 'like') : null;
    return { where, params, filters, expression, terms, mode, search: expression !== null };
}

/** Parse errors from the q grammar are the caller's typo, not a 500. */
function parse (raw, column, param){
    try {
        return parseSearchQuery(raw, column);
    } catch (err) {
        if (err instanceof ParseError){
            throw ApiError.badRequest(err.message, param);
        }
        throw err;
    }
}

/** `1997`, or `1995-1997` for a span. */
function parseYearRange (raw){
    const text = String(raw).trim();
    const single = text.match(/^([0-9]{4})$/);
    if (single){
        return { from: Number(single[1]), to: Number(single[1]) };
    }
    const span = text.match(/^([0-9]{4})-([0-9]{4})$/);
    if (!span){
        throw ApiError.badRequest('year must be YYYY or YYYY-YYYY', 'year');
    }
    const from = Number(span[1]);
    const to = Number(span[2]);
    if (from > to){
        throw ApiError.badRequest('year range runs backwards', 'year');
    }
    return { from, to };
}

/**
 * YYYY, YYYY-MM or YYYY-MM-DD, widened to the edge of the unit given.
 *
 * `from=1997` means the first instant of 1997 and `to=1997` the last, so that
 * a year, a month and a day all behave the way a reader would expect.
 */
function parseDateBound (raw, param){
    const text = String(raw).trim();
    const match = text.match(/^([0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?$/);
    if (!match){
        throw ApiError.badRequest(`${param} must be YYYY, YYYY-MM or YYYY-MM-DD`, param);
    }
    const year = Number(match[1]);
    const month = match[2] === undefined ? null : Number(match[2]);
    const day = match[3] === undefined ? null : Number(match[3]);
    if (month !== null && (month < 1 || month > 12)){
        throw ApiError.badRequest(`${param} has no month ${match[2]}`, param);
    }
    if (day !== null && (day < 1 || day > 31)){
        throw ApiError.badRequest(`${param} has no day ${match[3]}`, param);
    }
    if (param === 'from'){
        return Date.UTC(year, (month || 1) - 1, day || 1) / 1000;
    }
    // The last second of the unit: the end of the day, month or year given.
    if (day !== null){
        return Date.UTC(year, month - 1, day + 1) / 1000 - 1;
    }
    if (month !== null){
        return Date.UTC(year, month, 1) / 1000 - 1;
    }
    return Date.UTC(year + 1, 0, 1) / 1000 - 1;
}

/**
 * The composite key the brief asks for, carried on every message.
 *
 * (id, topic_id, seq, reply_seq) travels together under `key`, so a client
 * holding a reply_seq can fetch the parent positionally without a search.
 */
function shapeMessage (row){
    return {
        key: { id: row.id, topic_id: row.topic_id, seq: row.seq, reply_seq: row.reply_seq },
        root_seq: row.root_seq,
        depth: row.depth,
        thread: row.root_seq === null || row.root_seq === undefined
            ? null
            : `/api/sezam/topic/${row.topic_id}/thread/${row.root_seq}`,
        author: { id: row.author_id, username: row.author_username },
        ts: row.ts,
        epoch: row.epoch,
        year: row.year,
        reply_author: row.reply_author,
        body: row.body
    };
}

/**
 * True when nothing narrows the list beyond the resource in the path.
 *
 * Finding (2): topic.msg_count, conference.msg_count and author.msg_count each
 * agree with COUNT(*) for every row in the archive - 0 mismatches out of
 * 1 405, 104 and 3 901 - so an unfiltered total is already stored and needs no
 * scan. topic.declared_count, which is what the BBS header claimed, is the one
 * that is wrong, for 1 225 of 1 405 topics, and is never used for this.
 */
function unfiltered (built){
    return Object.keys(built.filters).length === 0;
}

/** A search reads best by relevance; everything else reads best by date. */
function defaultSort (db, built){
    return built.search && db.ftsReady ? 'relevance' : 'epoch';
}

function messageEnvelope (result, page, pathname, query, filters, built = {}, ranking = {}){
    const terms = built.terms || [];
    const rows = result.rows.map(row => {
        const message = shapeMessage(row);
        if (terms.length){
            // snippet() returns '' on a contentless table, so the excerpt is
            // cut here - and folds the way the tokenizer does, which snippet()
            // would not have.
            message.excerpt = excerpt(row.body, terms);
        }
        return message;
    });
    const body = envelope({ ...result, rows }, page, pathname, query, filters);
    if (built.mode){
        body.page.search = built.mode;
    }
    if (ranking.applies){
        body.page.ranked = ranking.ranked;
        body.page.matches = ranking.matches;
        if (!ranking.ranked){
            body.page.rankedReason = ranking.reason;
        }
    }
    return body;
}

function filtersOf (query, names){
    const filters = {};
    for (const name of names){
        if (present(query[name])){
            filters[name] = query[name];
        }
    }
    return filters;
}

async function one (db, table, id){
    const row = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
    if (!row){
        throw ApiError.notFound(`no ${table} ${id}`, 'id');
    }
    return row;
}

/** The shared list envelope: the rows, where the caller is, and what it asked. */
function envelope (result, page, pathname, query, filters){
    const rows = page.fields ? result.rows.map(row => pick(row, page.fields)) : result.rows;
    const body = {
        data: rows,
        page: {
            limit: page.limit,
            offset: page.offset,
            count: rows.length,
            hasMore: result.hasMore
        },
        filters: { ...filters, sort: page.sort }
    };
    if (result.total !== null && result.total !== undefined){
        body.page.total = result.total;
    }
    if (result.hasMore && rows.length){
        const last = result.rows[result.rows.length - 1];
        body.page.next = nextLink(pathname, query, page, cursorOf(last, page.cursorSort));
    }
    return body;
}

function nextLink (pathname, query, page, cursorValue){
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)){
        if (key === 'offset' || key === 'after'){
            continue;
        }
        for (const single of Array.isArray(value) ? value : [value]){
            params.append(key, single);
        }
    }
    // A cursor where the sort allows one, a page number where it does not.
    if (page.sort === page.cursorSort && cursorValue !== null && cursorValue !== undefined){
        params.set('after', String(cursorValue));
    } else {
        params.set('offset', String(page.offset + page.limit));
    }
    return `${pathname}?${params.toString()}`;
}

/** A shaped message keeps its key in `key`; a plain row has the column itself. */
function cursorOf (row, cursorSort){
    if (!row){
        return null;
    }
    if (row.key && row.key[cursorSort] !== undefined){
        return row.key[cursorSort];
    }
    return row[cursorSort];
}

function pick (row, fields){
    const out = {};
    for (const field of fields){
        if (Object.prototype.hasOwnProperty.call(row, field)){
            out[field] = row[field];
        }
    }
    return out;
}

// The archive is immutable, so a served answer stays correct until the sidecar
// is rebuilt. Phase 6 adds the ETag that makes that revalidatable.
const IMMUTABLE_HEADERS = { 'Cache-Control': 'public, max-age=86400' };

/**
 * The one answer every endpoint gives when this node has no archive.
 *
 * 503 rather than 404: the resource is not absent, this node just cannot serve
 * it, and a cache must not remember that. `available` sits at the top level so
 * a page can probe with one request and branch on a field. The message names
 * the condition and never the configured path - keeping that path off the wire
 * is why the config row is stored privately in the first place.
 */
export function notAvailable (){
    return {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
        data: {
            available: false,
            error: {
                code: 'NotAvailable',
                message: 'Sezam archive is not configured on this node',
                param: '/config/sezam'
            }
        }
    };
}

/**
 * `<build id>-<hash of path and query>`.
 *
 * Keyed on the build so that rebuilding the sidecar invalidates everything,
 * and on the query in a canonical order so that the same request spelled two
 * ways gets the same validator.
 */
function etagFor (db, pathname, query){
    const build = (db.meta && db.meta.buildId) || 'nobuild';
    const canonical = Object.keys(query).sort()
        .map(key => {
            const value = query[key];
            const values = (Array.isArray(value) ? value.slice().sort() : [value]);
            return `${key}=${values.join(',')}`;
        })
        .join('&');
    const digest = crypto.createHash('sha1').update(`${pathname}?${canonical}`).digest('base64url').slice(0, 22);
    return `"${build}-${digest}"`;
}

function ifNoneMatch (req){
    const headers = (req && req.headers) || {};
    return headers['if-none-match'] || headers['If-None-Match'] || null;
}

function errorBody (code, message, param){
    const error = { code, message };
    if (param){
        error.param = param;
    }
    return { error };
}
