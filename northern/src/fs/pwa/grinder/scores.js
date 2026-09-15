'use strict';

/**
 * The high scores.
 *
 * Ten of them, kept in whatever store is handed over - `localStorage` in the
 * page, a plain object in a test. The store is passed in rather than reached
 * for because a browser with the site data turned off throws on the way in,
 * and a game that will not start because it cannot remember a score is worse
 * than one that forgets.
 *
 * A score in the top five carries three letters, spelt out on the pad the way
 * an arcade cabinet asks for them. Anything below that is kept as it was got,
 * under three dashes - there is no sense making somebody spell their name for
 * ninth place.
 */
const scores = {};

scores.KEY = 'grinder.scores';
scores.KEEP = 10;

/** The table, best first. Anything unreadable is treated as an empty table. */
scores.read = function (store) {
    try {
        const kept = JSON.parse(store.getItem(scores.KEY) || '[]');
        if (!Array.isArray(kept)) return [];
        return kept
            .filter(one => one && typeof one.score === 'number' && isFinite(one.score))
            .map(one => ({
                score: Math.max(0, Math.floor(one.score)),
                at: String(one.at || ''),
                who: scores.who(one.who)
            }))
            .sort((one, other) => other.score - one.score)
            .slice(0, scores.KEEP);
    } catch (ignored) {
        return [];
    }
};

/**
 * Three letters, as the table keeps them: upper case, no more than three, and
 * the dashes when there are none. Whatever comes out of the store has been in
 * the hands of whoever edited it, so it is cut to size here rather than
 * trusted.
 */
scores.who = function (letters) {
    const spelt = String(letters === undefined || letters === null ? '' : letters)
        .toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 3);
    return spelt || '---';
};

/** Puts a score in the table and gives the table back. A nothing is not kept. */
scores.add = function (store, score, at, who) {
    const table = scores.read(store);
    if (score > 0) {
        table.push({ score: Math.floor(score), at: at || new Date().toISOString(), who: scores.who(who) });
        table.sort((one, other) => other.score - one.score);
        table.length = Math.min(table.length, scores.KEEP);
    }
    scores.write(store, table);
    return table;
};

scores.write = function (store, table) {
    try {
        store.setItem(scores.KEY, JSON.stringify(table));
    } catch (ignored) {
        // A store that will not take it is a store the game plays on without.
    }
};

/** The best there has been, or nought. */
scores.best = function (store) {
    const table = scores.read(store);
    return table.length ? table[0].score : 0;
};

/**
 * Where a score would come if it were added now, 1 for the top, or 0 for a
 * score that would not make the table at all.
 *
 * A score ties with one already there comes under it, not over it: the table
 * was got there first.
 */
scores.would = function (table, score) {
    if (score <= 0) return 0;
    let place = 1;
    for (const row of table) {
        if (row.score < score) break;
        place += 1;
    }
    return place > scores.KEEP ? 0 : place;
};

/** Where a score came in the table, or 0 for nowhere. */
scores.place = function (table, score) {
    for (let index = 0; index < table.length; index++) {
        if (table[index].score === score) return index + 1;
    }
    return 0;
};
