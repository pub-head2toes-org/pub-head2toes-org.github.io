'use strict';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { loadSezam, mountSezam, apiFetch, fakeFetch, read, PWA_DIR } from './helpers/sezamPage.js';
import Render from '../src/h2t/Render.js';
import SezamApi from '../src/h2t/SezamApi.js';
import SezamDB from '../src/h2t/SezamDB.js';
import MockRes from './helpers/mockRes.js';
import { buildFixture } from './helpers/sezamDb.js';

const { Api, Format, Router, Views } = loadSezam();

describe('Sezam page - routing', () => {
    it('reads every route the page links to', () => {
        const cases = [
            ['#/', 'conferences', {}],
            ['', 'conferences', {}],
            ['#/conference/7', 'topics', { id: '7' }],
            ['#/topic/12', 'threadsRecent', { id: '12' }],
            ['#/topic/12/threads', 'threadsOrdered', { id: '12' }],
            ['#/topic/12/read', 'reading', { id: '12' }],
            ['#/topic/12/thread/3', 'thread', { id: '12', root: '3' }],
            ['#/topic/12/message/9', 'message', { id: '12', seq: '9' }],
            ['#/search', 'search', {}],
            ['#/people', 'people', {}],
            ['#/user/1687', 'person', { id: '1687' }],
            ['#/author/2', 'author', { id: '2' }]
        ];
        for (const [hash, name, params] of cases){
            const found = Router.match(Router.parse(hash).parts);
            assert.ok(found, hash);
            assert.strictEqual(found.name, name, hash);
            // Spread into this realm: objects made inside the vm have a
            // different Object.prototype, which deepStrictEqual rejects.
            assert.deepStrictEqual({ ...found.params }, params, hash);
        }
    });

    it('returns nothing for a route it does not have', () => {
        for (const hash of ['#/nope', '#/topic', '#/topic/1/2/3/4', '#/user']){
            assert.strictEqual(Router.match(Router.parse(hash).parts), null, hash);
        }
    });

    it('decodes the query, and survives a broken escape', () => {
        assert.deepStrictEqual({ ...Router.parse('#/conference/7?name=knji%C5%BE').query }, { name: 'knjiž' });
        assert.doesNotThrow(() => Router.parse('#/%E0%A4%A'));
        assert.deepStrictEqual({ ...Router.parse('#/search?q=amiga+-atari').query }, { q: 'amiga -atari' });
    });

    it('leaves empty parameters out of a link', () => {
        assert.strictEqual(Router.href('/search', { q: 'amiga', person: '', from: null, to: undefined }),
            '#/search?q=amiga');
        assert.strictEqual(Router.href('/', {}), '#/');
    });

    it('round trips a hash through parse and href', () => {
        const parsed = Router.parse('#/topic/12/thread/3?at=5');
        assert.strictEqual(Router.href('/topic/12/thread/3', parsed.query), '#/topic/12/thread/3?at=5');
    });
});

describe('Sezam page - formatting', () => {
    it('escapes anything that came out of the archive', () => {
        // Every message body is 1995 plain text that has never been through a
        // browser; one with a < in it must not become markup.
        const nasty = '<script>alert(1)</script> & "quotes"';
        const html = Format.body(nasty);
        assert.ok(!html.includes('<script>'), html);
        assert.ok(html.includes('&lt;script&gt;'));
        assert.strictEqual(Format.escapeHtml("it's <b>"), 'it&#39;s &lt;b&gt;');
    });

    it('dims quoted lines by their depth', () => {
        const body = '> first level\n>> second level\nplain reply\n+> another quote';
        const html = Format.body(body);
        assert.ok(html.includes('class="q q1"'), html);
        assert.ok(html.includes('class="q q2"'), html);
        assert.ok(html.includes('plain reply'));
    });

    it('reads every quote marker the archive actually uses', () => {
        // Measured over the corpus: >, >>, +>, ->, -->, >>>, ">> >" and more.
        const depths = {
            '> a': 1, '>> a': 2, '>>> a': 3, '+> a': 1, '-> a': 1, '--> a': 1,
            '>> > a': 3, '> >> a': 3, ':> a': 1, '|> a': 1,
            '  > indented': 1, 'no quote here': 0, 'a > b': 0
        };
        for (const [line, depth] of Object.entries(depths)){
            assert.strictEqual(Format.quoteDepth(line), depth, JSON.stringify(line));
        }
    });

    it('caps quote depth so the palette does not run out', () => {
        assert.strictEqual(Format.quoteDepth('>>>>>>>> deep'), 4);
    });

    it('keeps the line breaks the terminal put there', () => {
        // Hard wrapped at 80 columns, with ASCII tables and signatures; the
        // page must not reflow it.
        const html = Format.body('line one\r\nline two');
        assert.ok(html.includes('line one\nline two'), JSON.stringify(html));
    });

    it('marks the matches an excerpt reports, and nothing else', () => {
        const cut = { text: 'Dejan Ristanović pisao', matches: [[6, 16]] };
        const html = Format.excerpt(cut);
        assert.ok(html.includes('<mark>Ristanović</mark>'), html);
        assert.ok(html.startsWith('Dejan '));
    });

    it('shows an excerpt that was cut as cut', () => {
        const html = Format.excerpt({ text: 'middle', matches: [], truncatedStart: true, truncatedEnd: true });
        assert.strictEqual(html, '…middle…');
    });

    it('escapes inside an excerpt too', () => {
        const html = Format.excerpt({ text: '<b>x</b>', matches: [[0, 3]] });
        assert.ok(!html.includes('<b>'), html);
        assert.ok(html.includes('<mark>&lt;b&gt;</mark>'));
    });

    it('takes a thread title from the first line that is not a quote', () => {
        const body = '> he said this\n> and this\n\n   Actually the reply starts here.\n';
        assert.strictEqual(Format.firstLine(body), 'Actually the reply starts here.');
    });

    it('skips the ASCII art a good share of the archive opens with', () => {
        // Real openers from the corpus: a list of conversations titled
        // ".▀▀▀▀▀▀▀šdiViDE+▀▀▀▀▀▀▀." tells a reader nothing.
        assert.strictEqual(
            Format.firstLine('.\u2580\u2580\u2580\u0161diViDE+\u2580\u2580\u2580.\n\n  Evo nove demo grupe!\n'),
            'Evo nove demo grupe!');
        assert.strictEqual(
            Format.firstLine('=====================\nProstom racunicom dobio sam\n'),
            'Prostom racunicom dobio sam');
    });

    it('still gives a title when the whole message is decoration', () => {
        // A bad title beats no title.
        assert.strictEqual(Format.firstLine('.------[diViDE]------.\n.--------------------.'),
            '.------[diViDE]------.');
    });

    it('formats the numbers and dates the archive stores', () => {
        assert.strictEqual(Format.number(572645), '572 645');
        assert.strictEqual(Format.date('1995-03-11T00:25'), '11 Mar 1995');
        assert.strictEqual(Format.date('1995-03-11T00:25', true), '11 Mar 1995 · 00:25');
        assert.strictEqual(Format.date(null), '');
    });

    it('caps the indent, because the deepest chain is 81', () => {
        assert.strictEqual(Format.indent(0), 0);
        assert.strictEqual(Format.indent(5), 5);
        assert.strictEqual(Format.indent(81), 8);
    });

    it('links a url without letting it become markup', () => {
        const html = Format.body('see http://sezam.rs/x?a=1&b=2 for more');
        assert.ok(html.includes('<a href="http://sezam.rs/x?a=1&amp;b=2"'), html);
        assert.ok(html.includes('rel="noopener noreferrer nofollow"'));
    });
});

describe('Sezam page - the API client', () => {
    it('builds a url, leaving empty parameters out', () => {
        assert.strictEqual(Api.url('/message', { q: 'amiga', year: '', person: null, limit: 25 }),
            '/api/sezam/message?q=amiga&limit=25');
        assert.strictEqual(Api.url('/meta', {}), '/api/sezam/meta');
    });

    it('repeats a parameter given a list', () => {
        assert.strictEqual(Api.url('/message', { topic: [1, 2] }), '/api/sezam/message?topic=1&topic=2');
    });

    it('turns the API error envelope into an error', async () => {
        const page = loadSezam({ fetch: fakeFetch({
            '/api/sezam/message?q=%22x': [400, { error: { code: 'BadRequest', message: 'unbalanced quote in q', param: 'q' } }]
        }) });
        await assert.rejects(
            () => page.Api.messages({ q: '"x' }),
            error => {
                assert.strictEqual(error.status, 400);
                assert.strictEqual(error.code, 'BadRequest');
                assert.strictEqual(error.param, 'q');
                assert.strictEqual(error.unavailable, false);
                return true;
            });
    });

    it('recognises a node with no archive', async () => {
        const page = loadSezam({ fetch: fakeFetch({
            '/api/sezam/meta': [503, { available: false, error: { code: 'NotAvailable', message: 'not configured' } }]
        }) });
        await assert.rejects(() => page.Api.meta(), error => {
            assert.strictEqual(error.unavailable, true);
            return true;
        });
    });

    it('turns a dead connection into an error the page can show', async () => {
        const page = loadSezam({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
        await assert.rejects(() => page.Api.meta(), error => {
            assert.strictEqual(error.code, 'Offline');
            return true;
        });
    });

    it('follows a next link exactly as the API gave it', async () => {
        const next = '/api/sezam/topic/1/message?order=thread&limit=2&after=16';
        const fetch = fakeFetch({ [next]: [200, { data: [], page: {} }] });
        const page = loadSezam({ fetch });
        await page.Api.follow(next);
        assert.strictEqual(fetch.calls[0].href, next);
    });
});

describe('Sezam page - views against real API output', () => {
    let fixture, api, db;

    before(async () => {
        fixture = await buildFixture('sezam.page.test.db');
        api = new SezamApi(null, {
            render: new Render(),
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: () => {}
        });
        db = await api.archive();
    });

    after(async () => {
        await db.close();
        fixture.cleanup();
    });

    /** The real API, answering the way it will in the browser. */
    async function call (pathname, query = {}){
        const res = new MockRes();
        await api.handle(pathname, query, { headers: {} }, res);
        await res.done;
        assert.strictEqual(res.statusCode, 200, `${pathname} ${JSON.stringify(query)}`);
        return res.json;
    }

    it('renders the conference list from what the API returns', async () => {
        const result = await call('/api/sezam/conference', { sort: 'volume', limit: '500' });
        const meta = await call('/api/sezam/meta');
        const html = Views.conferences(result.data, meta);
        assert.ok(html.includes('AMIGA.2'));
        // FORUM.10 must follow FORUM.2, which a text sort would get wrong.
        assert.ok(html.indexOf('FORUM.2') < html.indexOf('FORUM.10'), 'volumes out of order');
        assert.ok(html.includes('href="#/conference/1"'));
    });

    it('renders a topic list with links the router understands', async () => {
        const conference = (await call('/api/sezam/conference/1')).data;
        const result = await call('/api/sezam/topic', { conference: '1' });
        const html = Views.topics(conference, result, '');
        const match = html.match(/href="#\/topic\/(\d+)"/);
        assert.ok(match, 'a topic link');
        assert.strictEqual(Router.match(Router.parse('#/topic/' + match[1]).parts).name, 'threadsRecent');
        assert.ok(html.includes('grafika i štampa'));
    });

    it('renders a thread list with an opening line and a name', async () => {
        const topic = (await call('/api/sezam/topic/1')).data;
        const result = await call('/api/sezam/topic/1/message',
            { order: 'recent', expand: 'false', limit: '40' });
        const rows = result.data.map(row => Object.assign({}, row, {
            opener: Format.firstLine(row.opener, 110),
            by: row.author ? row.author.username : ''
        }));
        const html = Views.threads(topic, Object.assign({}, result, { data: rows }), 'recent');
        assert.ok(html.includes('SyberStorm') || html.includes('Nova nit'), html.slice(0, 400));
        assert.ok(html.includes('rcolic'));
        assert.ok(/\d+ repl(y|ies)/.test(html), 'a reply count');
    });

    it('renders a thread indented by depth, capped', async () => {
        const topic = (await call('/api/sezam/topic/4')).data;
        const result = await call('/api/sezam/topic/4/thread/1');
        const html = Views.thread(topic, result);
        assert.ok(html.includes('class="message d0"'));
        assert.ok(html.includes('class="message d8"'), 'the 69 deep chain is capped at 8');
        assert.ok(!html.includes('d9'), 'and never deeper');
        assert.strictEqual((html.match(/class="message d/g) || []).length, 70);
    });

    it('gives every message its parent link, which is the composite key at work', async () => {
        const topic = (await call('/api/sezam/topic/1')).data;
        const result = await call('/api/sezam/topic/1/thread/1');
        const html = Views.thread(topic, result);
        // seq 2 replies to seq 1, so the link is positional within the topic.
        assert.ok(html.includes('href="#/topic/1/message/1"'), html.slice(0, 600));
        assert.strictEqual(Router.match(Router.parse('#/topic/1/message/1').parts).name, 'message');
    });

    it('renders search results with the matches marked', async () => {
        const result = await call('/api/sezam/message', { q: 'Ristanović', limit: '10' });
        const html = Views.search({ q: 'Ristanović' }, result);
        assert.ok(html.includes('<mark>'), 'a hit is marked');
        assert.ok(html.includes('matches'));
        assert.ok(html.includes('href="#/topic/'));
    });

    it('says when a search was too broad to rank', async () => {
        const tight = new SezamApi(null, {
            render: new Render(),
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: () => Promise.resolve(db),
            log: () => {},
            maxRankedMatches: 1
        });
        const res = new MockRes();
        await tight.handle('/api/sezam/message', { q: 'poruka', limit: '5' }, { headers: {} }, res);
        await res.done;
        const html = Views.search({ q: 'poruka' }, res.json);
        assert.ok(html.includes('too many to rank'), html.slice(0, 500));
    });

    it('renders the people directory and a member', async () => {
        const result = await call('/api/sezam/user', { city: 'ograd' });
        const html = Views.people({ city: 'ograd' }, result);
        assert.ok(html.includes('Rastko Čolić'), html.slice(0, 400));
        assert.ok(html.includes('href="#/user/1"'));

        const user = (await call('/api/sezam/user/1')).data;
        const authors = (await call('/api/sezam/author', { limit: '50' })).data
            .filter(a => String(a.user_id) === '1');
        const person = Views.person(user, authors);
        assert.ok(person.includes('href="#/author/1"'));
    });

    it('renders an author page', async () => {
        const record = (await call('/api/sezam/author/1')).data;
        const result = await call('/api/sezam/author/1/message', { limit: '10', total: 'true' });
        const html = Views.author(record, result);
        assert.ok(html.includes('rcolic'));
        assert.ok(html.includes('Rastko Čolić'));
    });

    it('never emits a raw body into the page', async () => {
        // The one thing a rendering bug here would cost: a message body from
        // 1995 reaching the DOM as markup.
        const topic = (await call('/api/sezam/topic/2')).data;
        const result = await call('/api/sezam/topic/2/message', { limit: '50' });
        result.data[0].body = '<img src=x onerror=alert(1)> & <b>bold</b>';
        result.data[0].author.username = '<script>';
        const html = Views.reading(topic, result);
        assert.ok(!html.includes('<img'), html.slice(0, 300));
        assert.ok(!html.includes('<b>bold</b>'));
        assert.ok(!html.includes('<script>'));
        assert.ok(html.includes('&lt;img'));
    });

    it('offers a next link only when there is more', async () => {
        const firstPage = await call('/api/sezam/topic/4/message', { limit: '10' });
        const topic = (await call('/api/sezam/topic/4')).data;
        assert.ok(Views.reading(topic, firstPage).includes('data-next='));
        const wholeTopic = await call('/api/sezam/topic/4/message', { limit: '500' });
        assert.ok(!Views.reading(topic, wholeTopic).includes('data-next='));
    });
});

describe('Sezam page - the files it ships', () => {
    it('loads every script it ships, and caches every script it loads', () => {
        // Both directions, because either one alone misses something: a module
        // that exists but is never loaded breaks the page, and one that is
        // loaded but never cached breaks it offline.
        const html = read('index.html');
        const sw = read('sw.js');
        const scripts = [...html.matchAll(/<script src="\.\/([^"]+)"/g)].map(m => m[1]);
        const shipped = fs.readdirSync(PWA_DIR)
            .filter(name => name.endsWith('.js') && name !== 'sw.js');

        assert.deepStrictEqual(scripts.slice().sort(), shipped.slice().sort(),
            'index.html must load exactly the scripts this folder ships');
        for (const script of scripts){
            assert.ok(sw.includes(`./${script}`), `${script} is in the service worker cache list`);
        }
        assert.ok(sw.includes('./styles.css'));
    });

    it('never caches the archive in the service worker', () => {
        // A stale search result is worse than a slow one, and the API already
        // answers with an ETag and a day of max-age.
        assert.ok(read('sw.js').includes("indexOf('/api/sezam') !== -1"));
    });

    it('ships the icons the manifest promises', () => {
        const manifest = JSON.parse(read('manifest.json'));
        for (const icon of manifest.icons){
            assert.ok(fs.existsSync(`${PWA_DIR}/${icon.src.replace('./', '')}`), icon.src);
        }
        assert.strictEqual(manifest.start_url, './index.html');
    });
});

describe('Sezam page - the app, driven through its routes', () => {
    let fixture, api, db;

    before(async () => {
        fixture = await buildFixture('sezam.mount.test.db');
        api = new SezamApi(null, {
            render: new Render(),
            env: { SEZAM_DB: fixture.archive, SEZAM_THREAD_DB: fixture.thread },
            openDb: resolved => SezamDB.open(resolved),
            log: () => {}
        });
        db = await api.archive();
    });

    after(async () => {
        await db.close();
        fixture.cleanup();
    });

    /** The page, talking to the real API over the real database. */
    const mount = () => mountSezam({ fetch: apiFetch(api, MockRes) });

    it('opens on the conference list and says how big the archive is', async () => {
        const page = await mount().settled();
        assert.match(page.foot, /86 messages/);
        assert.match(page.foot, /1995.1997/);
        assert.ok(page.html.includes('AMIGA.2'));
        assert.ok(page.html.includes('FORUM.10'));
    });

    it('walks conference to topic to thread to message', async () => {
        const page = await mount().settled();

        await page.go('#/conference/1');
        assert.ok(page.html.includes('asembler'), page.html.slice(0, 200));
        assert.match(page.crumbs, /AMIGA\.2/);

        await page.go('#/topic/1');
        assert.ok(page.html.includes('thread_list'));
        assert.match(page.crumbs, /asembler/);

        await page.go('#/topic/1/thread/1');
        assert.ok(page.html.includes('class="message d0"'));
        assert.ok(page.html.includes('class="message d2"'), 'the chain is indented');

        await page.go('#/topic/1/read');
        assert.ok(page.html.includes('message_list'));
    });

    it('sends a positional message link to its thread, and lands on it', async () => {
        // #/topic/1/message/3 is what a reply_seq gives you. The page shows it
        // in its thread rather than alone, and scrolls to it.
        const page = await mount().settled();
        await page.go('#/topic/1/message/3');
        await page.settled();
        assert.strictEqual(page.location.hash, '#/topic/1/thread/1?at=3');
        assert.ok(page.location.replaced, 'the redirect must not add a history entry');
        assert.ok(page.html.includes('id="m3"'));
    });

    it('searches, and marks the hits', async () => {
        const page = await mount().settled();
        await page.go('#/search?q=Ristanovi%C4%87');
        assert.ok(page.html.includes('<mark>'), page.html.slice(0, 300));
        assert.ok(page.html.includes('matches'));
    });

    it('shows the search form with nothing asked for', async () => {
        const page = await mount().settled();
        await page.go('#/search');
        assert.ok(page.html.includes('id="sp_q"'));
        assert.ok(!page.html.includes('<mark>'));
    });

    it('finds people, and follows one to their handle and messages', async () => {
        const page = await mount().settled();
        await page.go('#/people?city=ograd');
        assert.ok(page.html.includes('Rastko Čolić'), page.html.slice(0, 300));

        await page.go('#/user/1');
        assert.ok(page.html.includes('href="#/author/1"'));

        await page.go('#/author/1');
        assert.ok(page.html.includes('rcolic'));
    });

    it('appends the next page rather than replacing what is on screen', async () => {
        const page = await mount().settled();
        await page.go('#/topic/4/read');
        const first = (page.html.match(/data-seq="/g) || []).length;
        assert.ok(first > 0 && first < 70, 'the first page is only part of the topic');

        await page.loadMore();
        const second = (page.html.match(/data-seq="/g) || []).length;
        assert.ok(second > first, `expected more than ${first}, got ${second}`);
        assert.ok(page.html.includes('id="m1"'), 'the first page is still there');
    });

    it('reaches the end of a topic by following load more', async () => {
        const page = await mount().settled();
        await page.go('#/topic/4/read');
        for (let guard = 0; guard < 10; guard++){
            if (!page.html.includes('more-btn')) break;
            await page.loadMore();
        }
        const seqs = [...page.html.matchAll(/data-seq="(\d+)"/g)].map(m => Number(m[1]));
        assert.deepStrictEqual(seqs, Array.from({ length: 70 }, (_, i) => i + 1),
            'every message, once, in order');
    });

    it('says plainly when the node has no archive', async () => {
        const page = mountSezam({ fetch: fakeFetch({
            '/api/sezam/meta': [503, { available: false,
                error: { code: 'NotAvailable', message: 'Sezam archive is not configured on this node' } }]
        }) });
        await page.settled();
        assert.ok(page.html.includes('not open here'), page.html.slice(0, 300));
        assert.ok(page.html.includes('/config/sezam'));
    });

    it('says plainly when there is no connection', async () => {
        const page = mountSezam({ fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
        await page.settled();
        assert.ok(page.html.includes('No connection'), page.html.slice(0, 300));
    });

    it('shows an unknown route as not found rather than doing nothing', async () => {
        const page = await mount().settled();
        await page.go('#/nowhere');
        assert.ok(page.html.includes('No such page'), page.html.slice(0, 200));
    });

    it('reports a bad request from the API in the page', async () => {
        const page = await mount().settled();
        await page.go('#/search?q=%22unbalanced');
        assert.ok(page.html.includes('unbalanced quote'), page.html.slice(0, 300));
    });
});
