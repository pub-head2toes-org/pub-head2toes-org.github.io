/* Muse - details screen for a single row */
(function () {
  MUSE.registerSW();

  var key = MUSE.getSelected();
  if (!key) { location.replace('index.html'); return; }

  var line = localStorage.getItem(key);
  if (line === null) { location.replace('index.html'); return; }

  var keywordEl = document.getElementById('keyword');
  var detailEl = document.getElementById('detail');

  var cfg = MUSE.getConfig();
  var headers = MUSE.parseCSVLine(MUSE.getHeader());
  var values = MUSE.parseCSVLine(line);
  var selected = 0;

  keywordEl.textContent = key;

  function isEditable(colName) {
    return cfg.editableColumns.indexOf(colName) !== -1;
  }

  function isURL(v) {
    return /^https?:\/\/\S+$/i.test((v || '').trim());
  }

  function selectedValue() {
    return (selected < values.length) ? values[selected] : '';
  }

  function render() {
    var lines = [];
    for (var i = 0; i < headers.length; i++) {
      var val = (i < values.length) ? values[i] : '';
      var mark = isEditable(headers[i]) ? ' ✎' : '';
      lines.push(headers[i] + ' : ' + val + mark);
    }
    detailEl.value = lines.join('\n');
    highlightSelected();
  }

  function highlightSelected() {
    var text = detailEl.value;
    var start = 0;
    for (var i = 0; i < selected; i++) {
      var nl = text.indexOf('\n', start);
      if (nl === -1) { start = text.length; break; }
      start = nl + 1;
    }
    // select only the current column value, not the "HEADER : " prefix or ✎ mark
    var prefix = headers[selected] + ' : ';
    var val = (selected < values.length) ? values[selected] : '';
    var valStart = start + prefix.length;
    var valEnd = valStart + val.length;
    detailEl.focus();
    detailEl.setSelectionRange(valStart, valEnd);
    scrollSelectedIntoView();
  }

  function scrollSelectedIntoView() {
    var style = getComputedStyle(detailEl);
    var lineHeight = parseFloat(style.lineHeight);
    if (isNaN(lineHeight)) { lineHeight = 20; }
    var padTop = parseFloat(style.paddingTop) || 0;
    var rowTop = padTop + selected * lineHeight;
    var rowBottom = rowTop + lineHeight;
    if (rowTop < detailEl.scrollTop) {
      detailEl.scrollTop = rowTop - padTop;
    } else if (rowBottom > detailEl.scrollTop + detailEl.clientHeight) {
      detailEl.scrollTop = rowBottom - detailEl.clientHeight + padTop;
    }
  }

  function move(delta) {
    selected = Math.min(headers.length - 1, Math.max(0, selected + delta));
    highlightSelected();
  }

  function openEdit() {
    if (!isEditable(headers[selected])) { return; }
    MUSE.setSelected(key);
    MUSE.setEditCol(selected);
    location.href = 'edit.html';
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      location.href = 'index.html';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var val = selectedValue();
      if (isURL(val)) {
        window.open(val.trim(), '_blank', 'noopener');
      } else {
        openEdit();
      }
    }
  });

  detailEl.addEventListener('blur', function () {
    setTimeout(function () { detailEl.focus(); }, 0);
  });

  render();
  detailEl.focus();
})();
