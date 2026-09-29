/* Sezam PWA - the API client. */
'use strict';

/**
 * Everything the page knows about /api/sezam/.
 *
 * One place that builds a URL, one place that knows what an error looks like,
 * so no view has to think about either.
 */
const Api = (function () {

    const BASE = '/api/sezam';

    /** Thrown for any answer that is not a 200. `code` is the API's own. */
    class ApiError extends Error {
        constructor(status, code, message, param) {
            super(message);
            this.status = status;
            this.code = code;
            this.param = param;
        }
        get unavailable() {
            return this.code === 'NotAvailable';
        }
    }

    function url(path, params) {
        const query = new URLSearchParams();
        const values = params || {};
        Object.keys(values).forEach(function (key) {
            const value = values[key];
            if (value === undefined || value === null || value === '') return;
            if (Array.isArray(value)) {
                value.forEach(function (one) { query.append(key, one); });
            } else {
                query.append(key, value);
            }
        });
        const search = query.toString();
        return BASE + path + (search ? '?' + search : '');
    }

    function get(path, params) {
        return request(url(path, params));
    }

    /** Follows a `page.next` link, which already carries its own query. */
    function follow(next) {
        return request(next);
    }

    function request(href) {
        return fetch(href, { headers: { Accept: 'application/json' } })
            .then(function (response) {
                return response.json().catch(function () {
                    return null;
                }).then(function (body) {
                    if (response.ok) return body;
                    const error = (body && body.error) || {};
                    throw new ApiError(response.status, error.code || 'HttpError',
                        error.message || ('the server answered ' + response.status), error.param);
                });
            }, function (networkError) {
                // Offline, or the node is not running. Either way the page can
                // say something better than a stack trace.
                throw new ApiError(0, 'Offline', networkError.message || 'no connection');
            });
    }

    return {
        ApiError: ApiError,
        url: url,
        get: get,
        follow: follow,
        meta: function () { return get('/meta'); },
        conferences: function (params) { return get('/conference', params); },
        conference: function (id) { return get('/conference/' + encodeURIComponent(id)); },
        topics: function (params) { return get('/topic', params); },
        topic: function (id) { return get('/topic/' + encodeURIComponent(id)); },
        topicMessages: function (id, params) {
            return get('/topic/' + encodeURIComponent(id) + '/message', params);
        },
        thread: function (topicId, rootSeq) {
            return get('/topic/' + encodeURIComponent(topicId) + '/thread/' + encodeURIComponent(rootSeq));
        },
        messages: function (params) { return get('/message', params); },
        message: function (id) { return get('/message/' + encodeURIComponent(id)); },
        users: function (params) { return get('/user', params); },
        user: function (id) { return get('/user/' + encodeURIComponent(id)); },
        authors: function (params) { return get('/author', params); },
        author: function (id) { return get('/author/' + encodeURIComponent(id)); },
        authorMessages: function (id, params) {
            return get('/author/' + encodeURIComponent(id) + '/message', params);
        }
    };
}());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Api;
}
