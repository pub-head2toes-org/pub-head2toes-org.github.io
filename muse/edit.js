/* Muse - edit a single editable column value */
(function () {
  MUSE.registerSW();

  var key = MUSE.getSelected();
  var col = MUSE.getEditCol();
  if (!key || isNaN(col)) { location.replace('index.html'); return; }

  var line = localStorage.getItem(key);
  if (line === null) { location.replace('index.html'); return; }

  var headers = MUSE.parseCSVLine(MUSE.getHeader());
  var values = MUSE.parseCSVLine(line);

  var colNameEl = document.getElementById('colName');
  var colValueEl = document.getElementById('colValue');
  var inputEl = document.getElementById('editInput');

  var oldValue = (col < values.length) ? values[col] : '';
  colNameEl.textContent = headers[col] || ('column ' + col);
  colValueEl.textContent = oldValue;
  inputEl.value = oldValue;

  function save() {
    while (values.length <= col) { values.push(''); }
    values[col] = inputEl.value;
    localStorage.setItem(key, MUSE.buildCSVLine(values));
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      location.href = 'details.html'; // back without saving
    } else if (e.key === 'Enter') {
      e.preventDefault();
      save();
      location.href = 'details.html';
    }
  });

  inputEl.focus();
  inputEl.select();
})();
