'use strict';

/**
 * Where Rama keeps things: IndexedDB, which the page and the service worker
 * can both reach (a service worker has no localStorage).
 *
 *   notes   one record per recording, by id: `RamaModel.note`
 *   audio   the sound of each, by the same id: `{type, bytes}`, apart from
 *           `notes` so the lists are read without the recordings
 *   fired   by note id, the reminder time last shown, so a reminder is shown
 *           once - by the page or the service worker, whichever comes first
 *   meta    one record per user, by public key: `{types}` the user added
 *
 * The page alone writes `notes`, `audio` and `meta`; the service worker only
 * writes `fired`. That way neither overwrites what the other wrote.
 */
const RamaStore = (function () {

    const NAME = 'rama';
    const VERSION = 1;
    const STORES = ['notes', 'audio', 'fired', 'meta'];

    let opening = null;

    const done = request => new Promise(function (resolve, reject) {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    function db() {
        if (!opening) {
            opening = new Promise(function (resolve, reject) {
                const request = indexedDB.open(NAME, VERSION);
                request.onupgradeneeded = function () {
                    const made = request.result;
                    STORES.forEach(function (name) {
                        if (!made.objectStoreNames.contains(name)) {
                            made.createObjectStore(name);
                        }
                    });
                };
                request.onsuccess = function () {
                    const handle = request.result;
                    // A newer version of Rama, in another tab or the worker,
                    // wants to upgrade: step aside, and open afresh next time.
                    handle.onversionchange = function () {
                        handle.close();
                        opening = null;
                    };
                    resolve(handle);
                };
                request.onerror = () => reject(request.error);
            });
            opening.catch(() => { opening = null; });
        }
        return opening;
    }

    /**
     * Runs requests against one store, in one transaction, and resolves with
     * the result - or the results, when `call` makes more than one.
     */
    function run(store, mode, call) {
        return db().then(function (handle) {
            const tx = handle.transaction(store, mode);
            const made = call(tx.objectStore(store));
            const result = Array.isArray(made) ? Promise.all(made.map(done)) : done(made);
            // A failed request fails its transaction, which is what is reported.
            result.catch(() => {});
            return new Promise(function (resolve, reject) {
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('the write did not go through'));
            });
        });
    }

    const api = {};

    api.get = (store, key) => run(store, 'readonly', s => s.get(key));
    api.put = (store, key, value) => run(store, 'readwrite', s => s.put(value, key));
    api.remove = (store, key) => run(store, 'readwrite', s => s.delete(key));

    /** Every record of a store, with its key: `[{key, value}]`, in key order. */
    api.all = function (store) {
        return run(store, 'readonly', s => [s.getAllKeys(), s.getAll()])
            .then(([keys, values]) => keys.map((key, i) => ({ key: key, value: values[i] })));
    };

    return api;
})();
