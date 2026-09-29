/* Sezam PWA - hash routing, as pure functions. */
'use strict';

const Router = (function () {

    // Each route is a pattern and the name of the handler that serves it.
    // Keeping the table here, away from the handlers, makes the whole of the
    // routing testable without a browser.
    const ROUTES = [
        [[], 'conferences'],
        [['conference', ':id'], 'topics'],
        [['topic', ':id'], 'threadsRecent'],
        [['topic', ':id', 'threads'], 'threadsOrdered'],
        [['topic', ':id', 'read'], 'reading'],
        [['topic', ':id', 'thread', ':root'], 'thread'],
        [['topic', ':id', 'message', ':seq'], 'message'],
        [['search'], 'search'],
        [['people'], 'people'],
        [['user', ':id'], 'person'],
        [['author', ':id'], 'author']
    ];

    /** "#/topic/1/thread/3?at=5" -> { parts: [...], query: { at: '5' } }. */
    function parse(hash) {
        const raw = String(hash || '').replace(/^#/, '') || '/';
        const cut = raw.indexOf('?');
        const path = cut === -1 ? raw : raw.slice(0, cut);
        const search = cut === -1 ? '' : raw.slice(cut + 1);
        const query = {};
        new URLSearchParams(search).forEach(function (value, key) { query[key] = value; });
        return {
            parts: path.split('/').filter(Boolean).map(safeDecode),
            query: query
        };
    }

    // A stray % is a typo in the address bar, not a reason to throw.
    function safeDecode(part) {
        try {
            return decodeURIComponent(part);
        } catch (err) {
            return part;
        }
    }

    /** Builds a hash, leaving out the parameters that carry nothing. */
    function href(path, query) {
        const search = new URLSearchParams();
        const values = query || {};
        Object.keys(values).forEach(function (key) {
            const value = values[key];
            if (value === undefined || value === null || String(value) === '') return;
            search.append(key, value);
        });
        const tail = search.toString();
        return '#' + path + (tail ? '?' + tail : '');
    }

    /** The first route whose shape fits, with its path parameters. */
    function match(parts) {
        for (let i = 0; i < ROUTES.length; i++) {
            const pattern = ROUTES[i][0];
            if (pattern.length !== parts.length) continue;
            const params = {};
            let ok = true;
            for (let j = 0; j < pattern.length; j++) {
                if (pattern[j].charAt(0) === ':') {
                    params[pattern[j].slice(1)] = parts[j];
                } else if (pattern[j] !== parts[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return { name: ROUTES[i][1], params: params };
        }
        return null;
    }

    return { ROUTES: ROUTES, parse: parse, href: href, match: match };
}());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Router;
}
