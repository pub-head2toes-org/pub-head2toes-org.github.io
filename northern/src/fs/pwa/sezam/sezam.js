/* Sezam PWA - the router. */
'use strict';

(function () {

    const view = document.getElementById('view');
    const crumbsEl = document.getElementById('crumbs');
    const footEl = document.getElementById('foot_meta');
    const searchForm = document.getElementById('search_form');
    const searchInput = document.getElementById('search_input');

    // Bumped on every navigation. A response that comes back carrying an old
    // token belongs to a page the reader has already left, and is dropped.
    let token = 0;
    let meta = null;
    let append = null;      // { selector, render } for the "load more" button

    // ---- hash routing ------------------------------------------------------

    const parseHash = function () { return Router.parse(location.hash); };
    const href = Router.href;

    function navigate(to, replace) {
        if (replace) {
            location.replace(to);
        } else {
            location.hash = to;
        }
    }

    // ---- rendering ---------------------------------------------------------

    function show(html, crumbs, title) {
        view.innerHTML = html;
        crumbsEl.innerHTML = (crumbs || []).map(function (crumb, index, all) {
            const last = index === all.length - 1;
            const label = Format.escapeHtml(crumb.text);
            return last || !crumb.href
                ? '<span aria-current="page">' + label + '</span>'
                : '<a href="' + Format.escapeHtml(crumb.href) + '">' + label + '</a>';
        }).join('<span class="sep" aria-hidden="true">/</span>');
        document.title = title ? title + ' · Sezam' : 'Sezam';
        wire();
    }

    function loading() {
        view.innerHTML = '<p class="loading">Reading…</p>';
    }

    function fail(error) {
        append = null;
        if (error instanceof Api.ApiError && error.unavailable) {
            show(Views.unavailable(), [], 'Not available');
            return;
        }
        show(Views.failed(error), [], 'Error');
    }

    /** Wires whatever the freshly rendered view put on the page. */
    function wire() {
        const moreBtn = view.querySelector('.more-btn');
        if (moreBtn) moreBtn.addEventListener('click', loadMore);

        const topicFilter = document.getElementById('topic_filter');
        if (topicFilter) wireTopicFilter(topicFilter);

        const panel = document.getElementById('search_panel');
        if (panel) {
            panel.addEventListener('submit', function (event) {
                event.preventDefault();
                navigate(href('/search', formValues(panel)));
            });
        }

        const peoplePanel = document.getElementById('people_panel');
        if (peoplePanel) {
            peoplePanel.addEventListener('submit', function (event) {
                event.preventDefault();
                navigate(href('/people', formValues(peoplePanel)));
            });
        }
    }

    function formValues(form) {
        const values = {};
        Array.prototype.forEach.call(form.elements, function (element) {
            if (element.name) values[element.name] = element.value.trim();
        });
        return values;
    }

    function wireTopicFilter(form) {
        const input = document.getElementById('topic_filter_input');
        const conferenceId = form.getAttribute('data-conference');
        let timer = null;
        function go(replace) {
            navigate(href('/conference/' + conferenceId, { name: input.value.trim() }), replace);
        }
        form.addEventListener('submit', function (event) { event.preventDefault(); go(false); });
        // Typing replaces the history entry rather than adding one per keystroke,
        // so Back leaves the filter rather than walking through it.
        input.addEventListener('input', function () {
            clearTimeout(timer);
            timer = setTimeout(function () { go(true); }, 300);
        });
    }

    /**
     * Follows page.next and appends the rows, rather than replacing the view.
     *
     * The API's own next link is used verbatim - it already carries the cursor
     * and every filter, so the page never has to rebuild a query it did not
     * construct.
     */
    function loadMore(event) {
        const button = event.currentTarget;
        const next = button.getAttribute('data-next');
        if (!next || !append) return;
        const mine = token;
        button.disabled = true;
        button.textContent = 'Loading…';
        Api.follow(next).then(function (result) {
            if (mine !== token) return;
            const list = view.querySelector(append.selector);
            if (list) list.insertAdjacentHTML('beforeend', append.render(result.data));
            const wrap = button.parentNode;
            if (result.page && result.page.next) {
                button.setAttribute('data-next', result.page.next);
                button.disabled = false;
                button.textContent = append.label || 'Load more';
            } else {
                wrap.parentNode.removeChild(wrap);
            }
            const count = view.querySelector('.count');
            if (count && append.counter) count.textContent = append.counter(result);
        }, function (error) {
            if (mine !== token) return;
            button.disabled = false;
            button.textContent = 'Try again';
            console.warn('sezam:', error.message);
        });
    }

    function scrollToSeq(seq) {
        if (!seq) return;
        const target = document.getElementById('m' + seq);
        if (!target) return;
        target.classList.add('landed');
        target.scrollIntoView({ block: 'center' });
    }

    // ---- the routes --------------------------------------------------------

    const handlers = {
        conferences: showConferences,
        topics: showTopics,
        threadsRecent: showThreadsRecent,
        threadsOrdered: showThreadsOrdered,
        reading: showReading,
        thread: showThread,
        message: showMessage,
        search: showSearch,
        people: showPeople,
        person: showPerson,
        author: showAuthor
    };

    function route() {
        const here = parseHash();
        const found = Router.match(here.parts);
        token += 1;
        append = null;
        searchInput.value = here.parts[0] === 'search' ? (here.query.q || '') : '';
        if (!found) {
            show(Views.failed({ code: 'NotFound', message: 'No such page: ' + location.hash }), [], 'Not found');
            return;
        }
        loading();
        const mine = token;
        Promise.resolve()
            .then(function () { return handlers[found.name](found.params, here.query, mine); })
            .catch(function (error) {
                if (mine !== token) return;
                fail(error);
            });
    }

    /** Guards every render: a stale response never reaches the page. */
    function fresh(mine) {
        return mine === token;
    }

    // ---- handlers ----------------------------------------------------------

    function showConferences(params, query, mine) {
        // 104 conferences is one page; the sort makes FORUM.10 follow FORUM.2.
        return Api.conferences({ limit: 500, sort: 'volume' }).then(function (result) {
            if (!fresh(mine)) return;
            show(Views.conferences(result.data, meta), [{ text: 'Conferences' }], 'Conferences');
        });
    }

    function showTopics(params, query, mine) {
        return Promise.all([
            Api.conference(params.id),
            Api.topics({ conference: params.id, name: query.name, limit: 100, sort: 'name' })
        ]).then(function (both) {
            if (!fresh(mine)) return;
            const conference = both[0].data;
            const result = both[1];
            append = { selector: '#topic_list', render: Views.topicRows, label: 'More topics' };
            show(Views.topics(conference, result, query.name),
                [{ text: 'Conferences', href: '#/' }, { text: conference.volume }],
                conference.volume);
            const form = document.getElementById('topic_filter');
            if (form) form.setAttribute('data-conference', params.id);
            // Re-wire now that the conference id is on the form.
            if (form) wireTopicFilter(form);
        });
    }

    function threadList(params, query, mine, order) {
        return Promise.all([
            Api.topic(params.id),
            Api.topicMessages(params.id, { order: order, expand: 'false', limit: 40, total: 'true' })
        ]).then(function (both) {
            if (!fresh(mine)) return;
            const topic = both[0].data;
            const result = both[1];
            // The rows the API returns carry the root message's opening line and
            // its author, so a thread list reads as a list of conversations.
            result.data = result.data.map(decorateThread);
            append = {
                selector: '#thread_list',
                render: function (rows) { return Views.threadRows(topic, rows.map(decorateThread)); },
                label: 'More threads'
            };
            show(Views.threads(topic, result, order), topicCrumbs(topic), topic.name);
        });
    }

    function decorateThread(row) {
        return Object.assign({}, row, {
            opener: Format.firstLine(row.opener, 110),
            by: row.author ? row.author.username : ''
        });
    }

    function showThreadsRecent(params, query, mine) {
        return threadList(params, query, mine, 'recent');
    }

    function showThreadsOrdered(params, query, mine) {
        return threadList(params, query, mine, 'thread');
    }

    function showReading(params, query, mine) {
        return Promise.all([
            Api.topic(params.id),
            Api.topicMessages(params.id, { limit: 40, total: 'true' })
        ]).then(function (both) {
            if (!fresh(mine)) return;
            const topic = both[0].data;
            const result = both[1];
            append = {
                selector: '#message_list',
                render: function (rows) {
                    return rows.map(function (row) { return Views.messageItem(row, topic, false); }).join('');
                },
                label: 'More messages',
                counter: function (page) { return Views.counted(page.page, 'messages'); }
            };
            show(Views.reading(topic, result), topicCrumbs(topic, 'Read all'), topic.name);
            scrollToSeq(query.at);
        });
    }

    function showThread(params, query, mine) {
        return Promise.all([
            Api.topic(params.id),
            Api.thread(params.id, params.root)
        ]).then(function (both) {
            if (!fresh(mine)) return;
            const topic = both[0].data;
            show(Views.thread(topic, both[1]), topicCrumbs(topic, 'Thread'), topic.name);
            scrollToSeq(query.at);
        });
    }

    /**
     * A message named positionally - which is what a reply_seq gives you.
     *
     * It is shown where it belongs, inside its thread, rather than alone.
     */
    function showMessage(params, query, mine) {
        return Api.get('/topic/' + encodeURIComponent(params.id) + '/message/'
                       + encodeURIComponent(params.seq)).then(function (result) {
            if (!fresh(mine)) return;
            const message = result.data;
            if (message.root_seq !== null && message.root_seq !== undefined) {
                navigate(href('/topic/' + params.id + '/thread/' + message.root_seq,
                    { at: message.key.seq }), true);
                return;
            }
            return Api.topic(params.id).then(function (topicResult) {
                if (!fresh(mine)) return;
                const topic = topicResult.data;
                show('<ol class="messages">' + Views.messageItem(message, topic, false) + '</ol>',
                    topicCrumbs(topic, '#' + message.key.seq), topic.name);
            });
        });
    }

    function topicCrumbs(topic, tail) {
        const crumbs = [{ text: 'Conferences', href: '#/' }];
        if (topic.conference_volume) {
            crumbs.push({ text: topic.conference_volume, href: '#/conference/' + topic.conf_id });
        }
        crumbs.push({ text: topic.name, href: tail ? '#/topic/' + topic.id : undefined });
        if (tail) crumbs.push({ text: tail });
        return crumbs;
    }

    function showSearch(params, query, mine) {
        const asked = { q: query.q, person: query.person, from: query.from, to: query.to };
        if (!asked.q && !asked.person) {
            show(Views.search(asked, null), [{ text: 'Search' }], 'Search');
            const box = document.getElementById('sp_q');
            if (box) box.focus();
            return Promise.resolve();
        }
        return Api.messages({
            q: asked.q, person: asked.person, from: asked.from, to: asked.to,
            limit: 25, total: 'true'
        }).then(function (result) {
            if (!fresh(mine)) return;
            append = { selector: '.results', render: Views.resultRows, label: 'More results' };
            show(Views.search(asked, result), [{ text: 'Search' }],
                'Search: ' + (asked.q || asked.person));
        });
    }

    function showPeople(params, query, mine) {
        const asked = {
            full_name: query.full_name, city: query.city,
            company: query.company, username: query.username
        };
        const any = Object.keys(asked).some(function (key) { return asked[key]; });
        if (!any) {
            show(Views.people(asked, null), [{ text: 'People' }], 'People');
            return Promise.resolve();
        }
        return Api.users(Object.assign({ limit: 50, total: 'true' }, asked)).then(function (result) {
            if (!fresh(mine)) return;
            append = { selector: '.people', render: null, label: 'More people' };
            append.render = function (rows) {
                return rows.map(function (user) {
                    return '<li><a href="#/user/' + user.id + '">'
                        + '<span class="person-name">'
                        + Format.escapeHtml(user.full_name || user.username) + '</span>'
                        + '<span class="meta">' + Format.escapeHtml(user.username) + '</span>'
                        + '<span class="meta">'
                        + Format.escapeHtml([user.city, user.company].filter(Boolean).join(' · '))
                        + '</span></a></li>';
                }).join('');
            };
            show(Views.people(asked, result), [{ text: 'People' }], 'People');
        });
    }

    function showPerson(params, query, mine) {
        return Promise.all([
            Api.user(params.id),
            // A member may have posted under more than one handle.
            Api.authors({ limit: 50 })
        ]).then(function (both) {
            if (!fresh(mine)) return;
            const user = both[0].data;
            const handles = both[1].data.filter(function (author) {
                return String(author.user_id) === String(user.id);
            });
            show(Views.person(user, handles),
                [{ text: 'People', href: '#/people' }, { text: user.full_name || user.username }],
                user.full_name || user.username);
        });
    }

    function showAuthor(params, query, mine) {
        return Promise.all([
            Api.author(params.id),
            Api.authorMessages(params.id, { limit: 25, total: 'true' })
        ]).then(function (both) {
            if (!fresh(mine)) return;
            const record = both[0].data;
            append = { selector: '.results', render: Views.resultRows, label: 'More messages' };
            show(Views.author(record, both[1]),
                [{ text: 'People', href: '#/people' }, { text: record.username }], record.username);
        });
    }

    // ---- start -------------------------------------------------------------

    searchForm.addEventListener('submit', function (event) {
        event.preventDefault();
        const words = searchInput.value.trim();
        navigate(href('/search', { q: words }));
    });

    window.addEventListener('hashchange', route);

    /**
     * /meta first, so the front page can say how big the archive is - and so a
     * node with no archive says so once, plainly, instead of failing on every
     * view the reader tries.
     */
    Api.meta().then(function (result) {
        meta = result;
        footEl.textContent = 'Sezam BBS · ' + Format.number(result.counts.messages)
            + ' messages · ' + result.counts.firstYear + '–' + result.counts.lastYear
            + (result.threaded ? '' : ' · no thread index');
        route();
    }, function (error) {
        fail(error);
    });

    if ('serviceWorker' in navigator) {
        window.addEventListener('load', function () {
            navigator.serviceWorker.register('./sw.js').catch(function () { /* offline is a bonus */ });
        });
    }
}());
