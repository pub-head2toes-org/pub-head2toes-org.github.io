/* Muse - view setup: toggle which columns show on the main results page */
(function () {
  MUSE.registerSW();

  var detailEl = document.getElementById('detail');

  var headers = MUSE.parseCSVLine(MUSE.getHeader());
  if (headers.length === 0 || (headers.length === 1 && headers[0] === '')) {
    location.replace('index.html');
    return;
  }

  var cfg = MUSE.getConfig();
  var selected = 0;

  function isOn(colName) {
    return cfg.hiddenColumns.indexOf(colName) === -1;
  }

  function toggle(colName) {
    var i = cfg.hiddenColumns.indexOf(colName);
    if (i === -1) { cfg.hiddenColumns.push(colName); } // now OFF
    else { cfg.hiddenColumns.splice(i, 1); }           // now ON
    MUSE.setConfig(cfg);
  }

  function render() {
    var lines = [];
    for (var i = 0; i < headers.length; i++) {
      lines.push(headers[i] + ': ' + (isOn(headers[i]) ? 'ON' : 'OFF'));
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
    var end = text.indexOf('\n', start);
    if (end === -1) { end = text.length; }
    detailEl.focus();
    detailEl.setSelectionRange(start, end);
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
      toggle(headers[selected]);
      render();
    }
  });

  detailEl.addEventListener('blur', function () {
    setTimeout(function () { detailEl.focus(); }, 0);
  });

  render();
  detailEl.focus();
})();
