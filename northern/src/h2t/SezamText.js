'use strict';

/**
 * Folds text the way the archive's search index was folded.
 *
 * The two FTS5 tables are tokenized `unicode61 remove_diacritics 2`, and the
 * text was ASCII-folded before it was indexed. That combination behaves
 * asymmetrically on Serbian, and the asymmetry is easy to miss:
 *
 *   - č ć š ž are a base letter plus a combining mark, so NFD decomposition
 *     strips them and both the index and a typed query fold the same way.
 *     Searching `čolić` and `colic` both find Čolić.
 *   - đ (U+0111) is not a base letter plus a mark, it is its own letter. NFD
 *     leaves it alone and so does unicode61. The index holds `duric` for
 *     Đurić, because the importer folded it, but a query for `đuric` tokenizes
 *     to `đuric` and matches nothing at all - silently, with no error.
 *
 * So every term this API sends to MATCH is folded here first, and the fold
 * maps đ explicitly. Verified against the archive: all 8 102 users with a
 * name are found by the fold of that name, and 704 of them contain đ.
 */
export function fold (text){
    if (text === null || text === undefined){
        return '';
    }
    return String(text)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // combining marks: č ć š ž and the rest
        .replace(/đ/g, 'd')           // đ
        .replace(/Đ/g, 'D')           // Đ
        .toLowerCase();
}

/** The characters SQLite's LIKE treats as wildcards, escaped with a backslash. */
export function likeFragment (term){
    return '%' + fold(term).replace(/[\\%_]/g, c => '\\' + c) + '%';
}

/**
 * Parses a search box into a safe FTS5 expression.
 *
 * Raw FTS5 syntax never reaches SQLite. A stray quote there is an
 * `fts5: syntax error` thrown from inside the query, which surfaces as a 500
 * on what is really a typo; and the operators would let a caller reach columns
 * the endpoint did not offer. So the query is parsed from a small grammar and
 * re-emitted:
 *
 *   word        a term
 *   word*       a prefix
 *   "two words" a phrase
 *   -word       excluded
 *
 * Every term is folded first, because the index holds folded text: an
 * unfolded `Đurić` would match nothing at all and look like an empty result
 * rather than a mistake.
 *
 * Returns { expression, terms, excluded } or throws ParseError.
 */
export class ParseError extends Error {}

export function parseSearchQuery (raw, column = 'body'){
    const text = String(raw);
    if ((text.match(/"/g) || []).length % 2 === 1){
        throw new ParseError('unbalanced quote in q');
    }
    const positives = [];
    const negatives = [];
    const terms = [];
    const pattern = /(-?)(?:"([^"]*)"|(\S+))/g;
    let match;
    while ((match = pattern.exec(text)) !== null){
        const negated = match[1] === '-';
        const isPhrase = match[2] !== undefined;
        const body = isPhrase ? match[2] : match[3];
        const prefix = !isPhrase && body.endsWith('*');
        const cleaned = sanitise(prefix ? body.slice(0, -1) : body);
        if (!cleaned){
            continue;   // punctuation only, e.g. a lone "-" or "?"
        }
        const piece = isPhrase ? `"${cleaned}"` : (prefix ? `${cleaned}*` : cleaned);
        if (negated){
            negatives.push(piece);
        } else {
            positives.push(piece);
            terms.push({ text: cleaned, prefix });
        }
    }
    if (!positives.length){
        throw new ParseError(negatives.length
            ? 'a search needs at least one word to look for, not only words to exclude'
            : 'q has no searchable words');
    }
    let expression = `${column}:(${positives.join(' AND ')})`;
    if (negatives.length){
        expression += ` NOT ${column}:(${negatives.join(' OR ')})`;
    }
    return { expression, terms, excluded: negatives };
}

/** Folded, and reduced to what the tokenizer would keep. */
function sanitise (value){
    return fold(value).replace(/[^a-z0-9À-￿ ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Folds a string and remembers where each folded character came from.
 *
 * Folding can change length - a combining mark disappears - so an offset found
 * in the folded text is not an offset in the original. Almost always the two
 * are the same length and the map is the identity, which is worth checking
 * before doing the per-character walk.
 */
export function foldWithMap (text){
    const folded = fold(text);
    if (folded.length === text.length){
        return { folded, map: null };
    }
    let built = '';
    const map = [];
    for (let i = 0; i < text.length; i++){
        for (const character of fold(text[i])){
            built += character;
            map.push(i);
        }
    }
    return { folded: built, map };
}

/**
 * A window of the original body around the first match, with the match ranges
 * reported separately.
 *
 * snippet() cannot do this: both FTS tables are contentless, so it has no text
 * to cut and returns the empty string. Doing it here is not a workaround but
 * an improvement - the excerpt folds the way the tokenizer does, so a search
 * for Ristanovic highlights Ristanović, which snippet() would not have.
 *
 * Offsets in the result are relative to the returned text, never to the body.
 */
export function excerpt (body, terms, { radius = 120 } = {}){
    if (!body || !terms.length){
        return null;
    }
    const { folded, map } = foldWithMap(body);
    const at = position => (map ? map[position] : position);

    const hits = [];
    for (const term of terms){
        if (!term.text){
            continue;
        }
        let from = 0;
        for (;;){
            const found = folded.indexOf(term.text, from);
            if (found === -1){
                break;
            }
            // A non-prefix term still matches inside a longer word here, which
            // is deliberate: the excerpt marks what a reader would see, and
            // being generous about it costs nothing.
            const end = term.prefix ? wordEnd(folded, found) : found + term.text.length;
            // end is exclusive, so map the last included character and step past it
            hits.push([at(found), at(Math.min(end, folded.length) - 1) + 1]);
            from = found + Math.max(term.text.length, 1);
            if (hits.length > 200){
                break;
            }
        }
    }
    if (!hits.length){
        return null;
    }
    hits.sort((a, b) => a[0] - b[0]);

    const first = hits[0][0];
    const start = Math.max(0, first - radius);
    const stop = Math.min(body.length, first + radius);
    const text = body.slice(start, stop);
    const matches = hits
        .filter(([s, e]) => s >= start && e <= stop)
        .map(([s, e]) => [s - start, e - start]);
    return {
        text,
        offset: start,
        truncatedStart: start > 0,
        truncatedEnd: stop < body.length,
        matches
    };
}

function wordEnd (folded, from){
    let end = from;
    while (end < folded.length && /[a-z0-9]/.test(folded[end])){
        end++;
    }
    return end;
}
