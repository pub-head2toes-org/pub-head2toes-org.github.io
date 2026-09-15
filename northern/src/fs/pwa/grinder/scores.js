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
 * No initials are asked for. The only control the game is played with is a
 * pad, and a pad is a poor thing to spell a name on; a score and the day it
 * was got say enough.
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
            .map(one => ({ score: Math.max(0, Math.floor(one.score)), at: String(one.at || '') }))
            .sort((one, other) => other.score - one.score)
            .slice(0, scores.KEEP);
    } catch (ignored) {
        return [];
    }
};

/** Puts a score in the table and gives the table back. A nothing is not kept. */
scores.add = function (store, score, at) {
    const table = scores.read(store);
    if (score > 0) {
        table.push({ score: Math.floor(score), at: at || new Date().toISOString() });
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

/** Where a score would come in the table, or 0 for nowhere. */
scores.place = function (table, score) {
    for (let index = 0; index < table.length; index++) {
        if (table[index].score === score) return index + 1;
    }
    return 0;
};
