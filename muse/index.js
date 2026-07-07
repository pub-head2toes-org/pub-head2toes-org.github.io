/* Muse - main search screen (textarea + div implementation) */
(function () {
  MUSE.registerSW();

  // No data yet -> go to upload screen
  if (!MUSE.hasData()) {
    location.replace('upload.html');
    return;
  }

  var keywordEl = document.getElementById('keyword');
  var resultsEl = document.getElementById('results');
  var statusEl = document.getElementById('status');

  var all = MUSE.getAll();      // [{key, line}]
  var headers = MUSE.parseCSVLine(MUSE.getHeader());
  var visibleIdx = MUSE.visibleColumnIndices(headers);
  var searchKeys = [''];        // array of search terms (AND); last one is "active"
  var results = [];             // filtered [{key, line}]
  var selected = 0;             // index of selected result row

  // restore remembered state (search keys + selection) when coming back
  var saved = MUSE.getMainState();
  if (saved && Array.isArray(saved.searchKeys) && saved.searchKeys.length) {
    searchKeys = saved.searchKeys.slice();
    selected = (typeof saved.selected === 'number') ? saved.selected : 0;
  }

  function saveState() {
    MUSE.setMainState({ searchKeys: searchKeys, selected: selected });
  }

  // Reduce a full CSV line to only its ON (visible) columns for display
  function viewLine(line) {
    var values = MUSE.parseCSVLine(line);
    var out = [];
    for (var i = 0; i < visibleIdx.length; i++) {
      var idx = visibleIdx[i];
      out.push(idx < values.length ? values[idx] : '');
    }
    return MUSE.buildCSVLine(out);
  }

  function activeTerms() {
    return searchKeys.filter(function (t) { return t.length > 0; });
  }

  function renderKeyword() {
    keywordEl.innerHTML = '';
    var label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'search';
    keywordEl.appendChild(label);

    var terms = searchKeys;
    for (var i = 0; i < terms.length; i++) {
      var span = document.createElement('span');
      if (i === terms.length - 1) {
        span.className = 'caret';
        span.textContent = terms[i] + '█';
      } else if (terms[i].length > 0) {
        span.className = 'term';
        span.textContent = terms[i];
      } else {
        continue;
      }
      keywordEl.appendChild(span);
    }
    if (activeTerms().length === 0 && searchKeys[searchKeys.length - 1] === '') {
      var hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '  type to search · Space=OR · Tab=commands · Enter=details';
      keywordEl.appendChild(hint);
    }
  }

  function runSearch() {
    var terms = activeTerms().map(function (t) { return t.toLowerCase(); });
    if (terms.length === 0) {
      results = all.slice();
    } else {
      results = all.filter(function (row) {
        var hay = row.line.toLowerCase();
        for (var i = 0; i < terms.length; i++) {
          if (hay.indexOf(terms[i]) === -1) { return false; }
        }
        return true;
      });
    }
    if (selected >= results.length) { selected = Math.max(0, results.length - 1); }
    renderResults();
    saveState();
  }

  function renderResults() {
    resultsEl.value = results.map(function (r) { return viewLine(r.line); }).join('\n');
    statusEl.textContent = results.length + ' / ' + all.length + ' rows';
    highlightSelected();
  }

  // Select the text of the currently selected line inside the readonly textarea
  function highlightSelected() {
    if (results.length === 0) { return;}
    var text = resultsEl.value;
    var start = 0;
    for (var i = 0; i < selected; i++) {
      var nl = text.indexOf('\n', start);
      if (nl === -1) { start = text.length; break; }
      start = nl + 1;
    }
    var end = text.indexOf('\n', start);
    if (end === -1) { end = text.length; }
    resultsEl.focus();
    resultsEl.setSelectionRange(start, end);
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    var style = getComputedStyle(resultsEl);
    var lineHeight = parseFloat(style.lineHeight);
    if (isNaN(lineHeight)) { lineHeight = 20; }
    var padTop = parseFloat(style.paddingTop) || 0;
    var rowTop = padTop + selected * lineHeight;
    var rowBottom = rowTop + lineHeight;
    var viewTop = resultsEl.scrollTop;
    var viewBottom = viewTop + resultsEl.clientHeight;
    if (rowTop < viewTop) {
      resultsEl.scrollTop = rowTop - padTop;
    } else if (rowBottom > viewBottom) {
      resultsEl.scrollTop = rowBottom - resultsEl.clientHeight + padTop;
    }
  }

  function moveSelection(delta) {
    if (results.length === 0) { return; }
    selected = Math.min(results.length - 1, Math.max(0, selected + delta));
    highlightSelected();
    saveState();
  }

  function openDetails() {
    if (results.length === 0) { return; }
    saveState();
    MUSE.setSelected(results[selected].key);
    location.href = 'details.html';
  }

  document.addEventListener('keydown', function (e) {
    var key = e.key;

    if (key === 'Tab') {
      e.preventDefault();
      location.href = 'additional.html';
      return;
    }
    if (key === 'Enter') {
      e.preventDefault();
      openDetails();
      return;
    }
    if (key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
      return;
    }
    if (key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
      return;
    }
    if (key === 'Escape') {
      e.preventDefault();
      searchKeys = [''];
      selected = 0;
      renderKeyword();
      runSearch();
      return;
    }
    if (key === 'Backspace') {
      e.preventDefault();
      // delete last char but do NOT re-run search / refresh results
      var cur = searchKeys[searchKeys.length - 1];
      searchKeys[searchKeys.length - 1] = cur.slice(0, -1);
      renderKeyword();
      saveState();
      return;
    }
    if (key === ' ' || key === 'Spacebar') {
      e.preventDefault();
      // start a new search term (OR)
      if (searchKeys[searchKeys.length - 1] !== '') {
        searchKeys.push('');
        renderKeyword();
        saveState();
      }
      return;
    }
    // alphanumeric / printable single character
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      searchKeys[searchKeys.length - 1] += key;
      selected = 0;
      renderKeyword();
      runSearch();
      return;
    }
  });

  // keep the textarea focused so line selection stays visible
  resultsEl.addEventListener('blur', function () {
    setTimeout(function () { resultsEl.focus(); }, 0);
  });

  renderKeyword();
  runSearch();
  resultsEl.focus();
})();
