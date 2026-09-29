/* Sezam PWA - the views. Each returns HTML for #view and a list of crumbs. */
'use strict';

const Views = (function () {

    const F = Format;
    const e = F.escapeHtml;

    // ---- small pieces -----------------------------------------------------

    function pill(text, title) {
        return '<span class="pill"' + (title ? ' title="' + e(title) + '"' : '') + '>' + e(text) + '</span>';
    }

    function authorLink(author) {
        if (!author || author.id === undefined || author.id === null) return '<span class="who">unknown</span>';
        return '<a class="who" href="#/author/' + e(author.id) + '">' + e(author.username) + '</a>';
    }

    /** The button that follows page.next. The router wires the click. */
    function more(next, label) {
        if (!next) return '';
        return '<div class="more"><button type="button" class="more-btn" data-next="' + e(next) + '">'
            + e(label || 'Load more') + '</button></div>';
    }

    function empty(message) {
        return '<p class="empty">' + e(message) + '</p>';
    }

    function counted(page, unit) {
        if (!page) return '';
        const shown = page.count === undefined ? 0 : page.count;
        if (page.total !== undefined) {
            return F.number(shown) + ' of ' + F.number(page.total) + ' ' + unit;
        }
        return F.number(shown) + ' ' + unit + (page.hasMore ? ' so far' : '');
    }

    // ---- conferences ------------------------------------------------------

    /**
     * The archive's front door: 104 conferences in 27 families.
     *
     * Grouped by family and sorted by `ord`, because the volume numbers are
     * text - FORUM.10 sorts before FORUM.2 every other way.
     */
    function conferences(rows, meta) {
        const families = [];
        const byFamily = {};
        rows.forEach(function (row) {
            if (!byFamily[row.family]) {
                byFamily[row.family] = [];
                families.push(row.family);
            }
            byFamily[row.family].push(row);
        });

        let html = '<div class="lede">'
            + '<h1>The Sezam archive</h1>'
            + '<p>' + (meta
                ? F.number(meta.counts.messages) + ' messages, ' + F.number(meta.counts.topics)
                  + ' topics, ' + F.number(meta.counts.authors) + ' posters. '
                  + meta.counts.firstYear + '–' + meta.counts.lastYear + '.'
                : '') + '</p></div>';

        html += '<div class="families">';
        families.forEach(function (family) {
            html += '<section class="family"><h2>' + e(family) + '</h2><ul class="volumes">';
            byFamily[family].forEach(function (conference) {
                html += '<li><a href="#/conference/' + e(conference.id) + '">'
                    + '<span class="volume">' + e(conference.volume) + '</span>'
                    + '<span class="meta">' + F.number(conference.msg_count) + ' messages</span>'
                    + '<span class="meta dates">' + e(F.span(conference.date_from, conference.date_to)) + '</span>'
                    + '</a></li>';
            });
            html += '</ul></section>';
        });
        html += '</div>';
        return html;
    }

    // ---- topics of a conference -------------------------------------------

    function topics(conference, result, filter) {
        let html = '<header class="page-head">'
            + '<h1>' + e(conference.volume) + '</h1>'
            + '<p class="sub">' + F.number(conference.msg_count) + ' messages · '
            + e(F.span(conference.date_from, conference.date_to)) + '</p>'
            + '<form class="filter" id="topic_filter">'
            + '<input type="search" name="name" id="topic_filter_input" placeholder="Filter topics"'
            + ' value="' + e(filter || '') + '" autocomplete="off" aria-label="Filter topics by name">'
            + '</form>'
            + '</header>';

        if (!result.data.length) {
            return html + empty(filter ? 'No topic here matches “' + filter + '”.' : 'No topics.');
        }

        html += '<ul class="topics" id="topic_list">';
        html += topicRows(result.data);
        html += '</ul>' + more(result.page.next, 'More topics');
        return html;
    }

    function topicRows(rows) {
        return rows.map(function (topic) {
            return '<li><a href="#/topic/' + e(topic.id) + '">'
                + '<span class="topic-name">' + e(topic.name) + '</span>'
                + '<span class="meta">' + F.number(topic.msg_count) + ' messages</span>'
                + '<span class="meta dates">' + e(F.date(topic.first_ts)) + ' – '
                + e(F.date(topic.last_ts)) + '</span>'
                + '</a></li>';
        }).join('');
    }

    // ---- a topic's threads -------------------------------------------------

    /**
     * A topic read as a list of threads.
     *
     * The limit here counts threads, not messages, so every row is a whole
     * conversation and the page can promise it is not showing half of one.
     */
    function threads(topic, result, order) {
        let html = topicHead(topic, order);
        if (!result.data.length) return html + empty('This topic has no messages.');

        html += '<ul class="threads" id="thread_list">' + threadRows(topic, result.data) + '</ul>';
        html += more(result.page.next, 'More threads');
        return html;
    }

    function threadRows(topic, rows) {
        return rows.map(function (thread) {
            return '<li><a href="#/topic/' + e(topic.id) + '/thread/' + e(thread.root_seq) + '">'
                + '<span class="thread-line">' + e(thread.opener || ('Message ' + thread.root_seq)) + '</span>'
                + '<span class="thread-meta">'
                + (thread.by ? '<span class="who-flat">' + e(thread.by) + '</span>' : '')
                + pill(thread.reply_count === 1 ? '1 reply' : F.number(thread.reply_count) + ' replies')
                + '<span class="meta">' + e(F.date(epochToTs(thread.last_epoch))) + '</span>'
                + '</span></a></li>';
        }).join('');
    }

    function topicHead(topic, order) {
        const tabs = [
            ['recent', '#/topic/' + topic.id, 'Recent'],
            ['thread', '#/topic/' + topic.id + '/threads', 'Threads'],
            ['seq', '#/topic/' + topic.id + '/read', 'Read all']
        ];
        return '<header class="page-head">'
            + '<h1>' + e(topic.name) + '</h1>'
            + '<p class="sub">'
            + (topic.conference_volume
                ? '<a href="#/conference/' + e(topic.conf_id) + '">' + e(topic.conference_volume) + '</a> · '
                : '')
            + F.number(topic.msg_count) + ' messages · '
            + e(F.date(topic.first_ts)) + ' – ' + e(F.date(topic.last_ts))
            + '</p>'
            + '<nav class="tabs">' + tabs.map(function (tab) {
                return '<a href="' + tab[1] + '"' + (order === tab[0] ? ' class="on" aria-current="page"' : '')
                    + '>' + tab[2] + '</a>';
            }).join('') + '</nav>'
            + '</header>';
    }

    function epochToTs(epoch) {
        if (!epoch && epoch !== 0) return '';
        return new Date(epoch * 1000).toISOString().slice(0, 16);
    }

    // ---- one thread --------------------------------------------------------

    function thread(topic, result) {
        const info = result.thread;
        let html = '<header class="page-head">'
            + '<p class="sub"><a href="#/topic/' + e(topic.id) + '">' + e(topic.name) + '</a></p>'
            + '<h1>' + e(F.firstLine(result.data.length ? result.data[0].body : '', 110)) + '</h1>'
            + '<p class="sub">' + F.number(info.size) + ' messages · '
            + (info.max_depth ? info.max_depth + ' deep' : 'no replies') + '</p>'
            + '</header>';
        html += '<ol class="messages thread-view">'
            + result.data.map(function (message) { return messageItem(message, topic, true); }).join('')
            + '</ol>';
        return html;
    }

    // ---- a topic read straight through ------------------------------------

    function reading(topic, result) {
        let html = topicHead(topic, 'seq');
        if (!result.data.length) return html + empty('This topic has no messages.');
        html += '<p class="count">' + counted(result.page, 'messages') + '</p>';
        html += '<ol class="messages" id="message_list">'
            + result.data.map(function (message) { return messageItem(message, topic, false); }).join('')
            + '</ol>';
        html += more(result.page.next, 'More messages');
        return html;
    }

    /**
     * One message.
     *
     * `indented` is the threaded reading: the left margin is the depth, capped
     * at eight, because the deepest chain in the archive is 81 and a literal
     * indent would walk off the screen long before that.
     */
    function messageItem(message, topic, indented) {
        const key = message.key;
        const depth = indented ? F.indent(message.depth) : 0;
        const anchor = 'm' + key.seq;
        let html = '<li class="message d' + depth + '" id="' + e(anchor) + '"'
            + ' data-seq="' + e(key.seq) + '" data-id="' + e(key.id) + '">';

        html += '<div class="message-head">'
            + authorLink(message.author)
            + '<span class="when">' + e(F.date(message.ts, true)) + '</span>'
            + '<span class="seq">#' + e(key.seq) + '</span>';
        if (key.reply_seq !== null && key.reply_seq !== undefined && key.reply_seq !== '') {
            // The composite key means the parent is one positional link away.
            html += '<a class="parent" href="#/topic/' + e(topic.id) + '/message/' + e(key.reply_seq) + '">'
                + '↰ ' + e(message.reply_author || ('#' + key.reply_seq)) + '</a>';
        }
        if (!indented && message.root_seq !== null && message.root_seq !== undefined) {
            html += '<a class="in-thread" href="#/topic/' + e(topic.id) + '/thread/' + e(message.root_seq)
                + '">in thread</a>';
        }
        html += '</div>';

        html += '<pre class="body">' + F.body(message.body) + '</pre>';
        html += '</li>';
        return html;
    }

    // ---- search ------------------------------------------------------------

    function searchForm(params) {
        return '<form class="search-panel" id="search_panel">'
            + '<div class="row">'
            + '<label for="sp_q">Words</label>'
            + '<input type="search" id="sp_q" name="q" value="' + e(params.q || '') + '"'
            + ' placeholder="amiga -atari &quot;hard disk&quot;" autocomplete="off">'
            + '</div>'
            + '<div class="row three">'
            + '<span><label for="sp_person">Person</label>'
            + '<input type="search" id="sp_person" name="person" value="' + e(params.person || '') + '"'
            + ' placeholder="name or handle" autocomplete="off"></span>'
            + '<span><label for="sp_from">From</label>'
            + '<input type="text" id="sp_from" name="from" value="' + e(params.from || '') + '"'
            + ' placeholder="1995" autocomplete="off"></span>'
            + '<span><label for="sp_to">To</label>'
            + '<input type="text" id="sp_to" name="to" value="' + e(params.to || '') + '"'
            + ' placeholder="1997-06" autocomplete="off"></span>'
            + '</div>'
            + '<div class="row actions"><button type="submit">Search</button>'
            + '<span class="hint">A word, a <code>&quot;phrase&quot;</code>, a <code>prefix*</code>,'
            + ' or <code>-excluded</code>. Accents optional.</span></div>'
            + '</form>';
    }

    function search(params, result) {
        let html = '<header class="page-head"><h1>Search</h1></header>' + searchForm(params);
        if (!result) return html;

        const page = result.page || {};
        let note = counted(page, 'messages');
        if (page.matches !== undefined) {
            note = F.number(page.matches) + ' matches';
            if (page.ranked === false) {
                note += ' — too many to rank, newest first';
            }
        }
        if (page.search === 'like') {
            note += ' · index unavailable, exact spelling only';
        }
        html += '<p class="count">' + e(note) + '</p>';

        if (!result.data.length) return html + empty('Nothing matched.');
        html += '<ul class="results">' + resultRows(result.data) + '</ul>';
        html += more(page.next, 'More results');
        return html;
    }

    function resultRows(rows) {
        return rows.map(function (message) {
            const key = message.key;
            const target = message.root_seq !== null && message.root_seq !== undefined
                ? '#/topic/' + key.topic_id + '/thread/' + message.root_seq + '?at=' + key.seq
                : '#/topic/' + key.topic_id + '/message/' + key.seq;
            return '<li><a href="' + e(target) + '">'
                + '<span class="result-text">'
                + (message.excerpt ? F.excerpt(message.excerpt) : e(F.firstLine(message.body, 160)))
                + '</span>'
                + '<span class="result-meta">'
                + '<span class="who-flat">' + e(message.author.username) + '</span>'
                + '<span class="meta">' + e(F.date(message.ts)) + '</span>'
                + (message.topic_name ? '<span class="meta">' + e(message.topic_name) + '</span>' : '')
                + '</span></a></li>';
        }).join('');
    }

    // ---- people ------------------------------------------------------------

    function people(params, result) {
        let html = '<header class="page-head"><h1>People</h1>'
            + '<p class="sub">The member directory, 8 105 names. Any fragment matches,'
            + ' with or without accents.</p></header>'
            + '<form class="search-panel" id="people_panel"><div class="row four">'
            + field('pp_full_name', 'full_name', 'Name', params.full_name)
            + field('pp_city', 'city', 'City', params.city)
            + field('pp_company', 'company', 'Company', params.company)
            + field('pp_username', 'username', 'Handle', params.username)
            + '</div><div class="row actions"><button type="submit">Find</button></div></form>';

        if (!result) return html;
        html += '<p class="count">' + counted(result.page, 'people') + '</p>';
        if (!result.data.length) return html + empty('Nobody matches.');
        html += '<ul class="people">' + result.data.map(function (user) {
            return '<li><a href="#/user/' + e(user.id) + '">'
                + '<span class="person-name">' + e(user.full_name || user.username) + '</span>'
                + '<span class="meta">' + e(user.username) + '</span>'
                + '<span class="meta">' + e([user.city, user.company].filter(Boolean).join(' · ')) + '</span>'
                + '</a></li>';
        }).join('') + '</ul>' + more(result.page.next, 'More people');
        return html;
    }

    function field(id, name, label, value) {
        return '<span><label for="' + id + '">' + e(label) + '</label>'
            + '<input type="search" id="' + id + '" name="' + name + '" value="' + e(value || '') + '"'
            + ' autocomplete="off"></span>';
    }

    function person(user, authors) {
        let html = '<header class="page-head">'
            + '<h1>' + e(user.full_name || user.username) + '</h1>'
            + '<p class="sub">' + e([user.username, user.city, user.company].filter(Boolean).join(' · ')) + '</p>'
            + (user.member_since ? '<p class="sub">Member since ' + e(user.member_since) + '</p>' : '')
            + '</header>';
        if (authors && authors.length) {
            html += '<ul class="handles">' + authors.map(function (author) {
                return '<li><a href="#/author/' + e(author.id) + '">' + e(author.username) + '</a>'
                    + '<span class="meta">' + F.number(author.msg_count) + ' messages</span></li>';
            }).join('') + '</ul>';
        } else {
            html += empty('No posting handle is linked to this member.');
        }
        return html;
    }

    function author(record, result) {
        let html = '<header class="page-head">'
            + '<h1>' + e(record.username) + '</h1>'
            + '<p class="sub">'
            + (record.full_name
                ? (record.user_id ? '<a href="#/user/' + e(record.user_id) + '">' + e(record.full_name) + '</a>'
                                  : e(record.full_name)) + ' · '
                : '')
            + F.number(record.msg_count) + ' messages · '
            + e(F.date(record.first_ts)) + ' – ' + e(F.date(record.last_ts))
            + '</p></header>';
        if (!result.data.length) return html + empty('No messages.');
        html += '<ul class="results">' + resultRows(result.data) + '</ul>';
        html += more(result.page.next, 'More messages');
        return html;
    }

    // ---- states ------------------------------------------------------------

    function unavailable() {
        return '<div class="notice">'
            + '<h1>The archive is not open here</h1>'
            + '<p>This node has no Sezam archive configured, so there is nothing to read yet.</p>'
            + '<p class="sub">An operator sets the path in <code>abcd.db</code> under'
            + ' <code>/config/sezam</code>, then builds the thread index with'
            + ' <code>npm run sezam:build</code>. See <code>API.md</code>.</p>'
            + '</div>';
    }

    function failed(error) {
        return '<div class="notice">'
            + '<h1>' + e(error.code === 'Offline' ? 'No connection' : 'That did not work') + '</h1>'
            + '<p>' + e(error.message) + '</p>'
            + (error.param ? '<p class="sub">Parameter: <code>' + e(error.param) + '</code></p>' : '')
            + '<p><a href="#/">Back to the conferences</a></p>'
            + '</div>';
    }

    return {
        conferences: conferences,
        topics: topics,
        topicRows: topicRows,
        threads: threads,
        threadRows: threadRows,
        thread: thread,
        reading: reading,
        messageItem: messageItem,
        search: search,
        resultRows: resultRows,
        people: people,
        person: person,
        author: author,
        unavailable: unavailable,
        failed: failed,
        more: more,
        counted: counted
    };
}());

if (typeof module !== 'undefined' && module.exports) {
    module.exports = Views;
}
