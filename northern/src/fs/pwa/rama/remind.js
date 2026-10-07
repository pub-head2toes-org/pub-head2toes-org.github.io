'use strict';

/**
 * Shows the reminders that are due. The page runs it while it is open - on a
 * timer, and whenever it comes back into view - and the service worker when
 * the browser wakes it (periodic background sync). Whichever comes first
 * marks the reminder shown in `fired`, so the other does not show it again;
 * both use the note's tag, so even a race shows one notification.
 */
const RamaRemind = (function () {

    const api = {};

    /**
     * `show(title, options)` puts up one notification. Only `owner`'s notes
     * when one is given. Resolves with the notes it showed.
     */
    api.fire = function (show, now, owner) {
        return Promise.all([RamaStore.all('notes'), RamaStore.all('fired')]).then(function ([rows, marks]) {
            const fired = {};
            marks.forEach(mark => { fired[mark.key] = mark.value; });
            const notes = rows.map(row => RamaModel.clean(row.value))
                .filter(note => note && (!owner || note.owner === owner));
            const due = RamaModel.due(notes, fired, now);
            return Promise.all(due.map(function (note) {
                const notice = RamaModel.notice(note);
                return Promise.resolve(show(notice.title, notice.options))
                    .catch(() => {})
                    .then(() => RamaStore.put('fired', note.id, note.remind));
            })).then(() => due);
        });
    };

    return api;
})();
