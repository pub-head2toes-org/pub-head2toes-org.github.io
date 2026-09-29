/* Sezam PWA - turning archive rows into readable HTML. */
'use strict';

const Format = (function () {

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** 572645 -> "572 645", the way the archive's own numbers read. */
    function number(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }

    /** "1995-03-11T00:25" -> "11 Mar 1995" (+ " · 00:25" when asked). */
    function date(ts, withTime) {
        if (!ts) return '';
        const match = String(ts).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
        if (!match) return String(ts);
        const day = Number(match[3]);
        const out = day + ' ' + MONTHS[Number(match[2]) - 1] + ' ' + match[1];
        if (withTime && match[4]) return out + ' · ' + match[4] + ':' + match[5];
        return out;
    }

    /** The conference's own "03 Feb 1995" strings, left as they are. */
    function span(from, to) {
        if (!from && !to) return '';
        if (from === to || !to) return String(from);
        return from + ' – ' + to;
    }

    // A quote marker is a leading run of >, |, +, -, : and spaces that ends in
    // a >. The depth is how many > it holds: the archive quotes as ">", ">>",
    // "+>", "-->", ">> >" and a dozen other shapes, all of which mean the same.
    const QUOTE = /^[ \t]*([-+|:>· \t]*>)/;

    function quoteDepth(line) {
        const match = line.match(QUOTE);
        if (!match) return 0;
        const arrows = match[1].split('>').length - 1;
        return Math.min(arrows, 4);
    }

    /**
     * A message body as HTML.
     *
     * Every line of these messages is hard wrapped to the width of a 1995
     * terminal, so the text is kept in a <pre> rather than reflowed - rewrapping
     * would ruin the ASCII tables and signatures that fill the archive. Quoted
     * lines are dimmed by depth, which is what makes a long reply readable.
     */
    function body(text) {
        if (!text) return '';
        const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        let html = '';
        let run = [];
        let runDepth = -1;

        function flush() {
            if (!run.length) return;
            const content = run.join('\n');
            html += runDepth > 0
                ? '<span class="q q' + runDepth + '">' + content + '</span>'
                : content;
            run = [];
        }

        lines.forEach(function (line, index) {
            const depth = quoteDepth(line);
            if (depth !== runDepth) {
                flush();
                runDepth = depth;
            }
            run.push(linkify(escapeHtml(line)) + (index < lines.length - 1 ? '' : ''));
        });
        flush();
        return html;
    }

    // Run over already escaped text, so the pattern can never see a tag.
    const LINK = /\b(https?:\/\/|www\.)[^\s<>"']+/g;

    function linkify(escaped) {
        return escaped.replace(LINK, function (found) {
            const href = found.indexOf('www.') === 0 ? 'http://' + found : found;
            return '<a href="' + href + '" rel="noopener noreferrer nofollow" target="_blank">' + found + '</a>';
        });
    }

    /**
     * An excerpt with its matches marked.
     *
     * The API reports `matches` as [start, end) offsets into `excerpt.text`,
     * never into the body, and leaves the markup to the page - so this is the
     * one place that decides what a hit looks like.
     */
    function excerpt(cut) {
        if (!cut) return '';
        const text = cut.text || '';
        const ranges = (cut.matches || []).slice().sort(function (a, b) { return a[0] - b[0]; });
        let html = '';
        let at = 0;
        ranges.forEach(function (range) {
            const start = Math.max(range[0], at);
            const end = Math.min(range[1], text.length);
            if (end <= start) return;
            html += escapeHtml(text.slice(at, start));
            html += '<mark>' + escapeHtml(text.slice(start, end)) + '</mark>';
            at = end;
        });
        html += escapeHtml(text.slice(at));
        const lead = cut.truncatedStart ? '…' : '';
        const tail = cut.truncatedEnd ? '…' : '';
        return lead + html.replace(/\r\n?|\n/g, ' ') + tail;
    }

    /**
     * The line to use as a thread's title.
     *
     * Not simply the first line: a good share of the archive opens with an
     * ASCII-art banner or a rule of box-drawing characters, and
     * ".\u2580\u2580\u2580\u2580diViDE+\u2580\u2580\u2580\u2580." is
     * no use in a list of conversations. Quoted lines are skipped too - a
     * reply's first line is usually somebody else's words - and a line only
     * counts if enough of it is letters. If none is, the first line stands,
     * because a bad title beats no title.
     */
    function firstLine(text, max) {
        if (!text) return '';
        const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        let fallback = '';
        for (let i = 0; i < lines.length; i++) {
            if (quoteDepth(lines[i])) continue;
            const line = lines[i].trim();
            if (line.length < 2) continue;
            if (!fallback) fallback = line;
            if (readable(line)) return clip(line, max || 90);
        }
        return clip(fallback || String(text).replace(/\s+/g, ' ').trim(), max || 90);
    }

    // A run of box drawing or block characters is never prose, so three of them
    // is enough; the ASCII ones a rule is made of (= _ ~ * # + - |) need four,
    // so that an ordinary "-->" or an ellipsis does not disqualify a line.
    const BLOCKS = /[\u2500-\u259f\u25a0-\u25ff]{3,}/;
    const RULES = /([=_~*#+|-])\1{3,}/;

    /** Letters against everything that is not a space. Decoration scores low. */
    function readable(line) {
        const solid = line.replace(/\s/g, '');
        if (!solid) return false;
        if (BLOCKS.test(line) || RULES.test(line)) return false;
        const letters = solid.replace(/[^0-9A-Za-z\u00c0-\u024f]/g, '').length;
        return letters >= 3 && letters / solid.length >= 0.4;
    }

    function clip(text, max) {
        return text.length <= max ? text : text.slice(0, max - 1).replace(/\s\S*$/, '') + '…';
    }

    /** Depth, but indented only so far - a 69 deep chain has to stay on screen. */
    function indent(depth) {
        return Math.min(Number(depth) || 0, 8);
    }

    return {
        escapeHtml: escapeHtml,
        number: number,
        date: date,
        span: span,
        body: body,
        excerpt: excerpt,
        firstLine: firstLine,
        clip: clip,
        indent: indent,
        quoteDepth: quoteDepth
    };
}());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Format;
}
