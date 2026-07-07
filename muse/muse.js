/*
 * Muse - shared core helpers
 * Local storage layout:
 *   MUSE:<TS><LINE_NUMBER>  -> a CSV data line (line number zero padded)
 *   MUSE_HEADER             -> the CSV header line
 *   MUSE_CONFIG             -> JSON app configuration
 *   MUSE_SELECTED           -> localStorage key of the row selected for details/edit
 *   MUSE_EDIT_COL           -> column index being edited
 */
var MUSE = (function () {
  var PREFIX = 'MUSE:';
  var HEADER_KEY = 'MUSE_HEADER';
  var CONFIG_KEY = 'MUSE_CONFIG';
  var SELECTED_KEY = 'MUSE_SELECTED';
  var EDIT_COL_KEY = 'MUSE_EDIT_COL';
  var MAIN_STATE_KEY = 'MUSE_MAIN_STATE';
  var LINE_PAD = 6;

  var defaultConfig = {
    implementation: 'textarea',
    editableColumns: ['playlist', 'downloaded'],
    hiddenColumns: []   // column names hidden from the main results view
  };

  function nowSeconds() {
    return Math.floor(Date.now() / 1000);
  }

  function pad(n, width) {
    var s = '' + n;
    while (s.length < width) { s = '0' + s; }
    return s;
  }

  function makeKey(ts, lineNumber) {
    return PREFIX + ts + pad(lineNumber, LINE_PAD);
  }

  function getConfig() {
    try {
      var raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) { return defaultConfig; }
      var cfg = JSON.parse(raw);
      if (!cfg.implementation) { cfg.implementation = defaultConfig.implementation; }
      if (!cfg.editableColumns) { cfg.editableColumns = defaultConfig.editableColumns; }
      if (!cfg.hiddenColumns) { cfg.hiddenColumns = []; }
      return cfg;
    } catch (e) {
      return defaultConfig;
    }
  }

  function setConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  function getHeader() {
    return localStorage.getItem(HEADER_KEY) || '';
  }

  function setHeader(h) {
    localStorage.setItem(HEADER_KEY, h);
  }

  // All data keys sorted (chronological, then by line number)
  function dataKeys() {
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) { keys.push(k); }
    }
    keys.sort();
    return keys;
  }

  // Returns array of { key, line }
  function getAll() {
    return dataKeys().map(function (k) {
      return { key: k, line: localStorage.getItem(k) };
    });
  }

  function hasData() {
    return dataKeys().length > 0;
  }

  // Parse one CSV line into an array of field values (handles quoted fields)
  function parseCSVLine(str) {
    var out = [];
    var cur = '';
    var inQuotes = false;
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (inQuotes) {
        if (c === '"') {
          if (str[i + 1] === '"') { cur += '"'; i++; }
          else { inQuotes = false; }
        } else {
          cur += c;
        }
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { out.push(cur); cur = ''; }
        else { cur += c; }
      }
    }
    out.push(cur);
    return out;
  }

  // Build a CSV line from an array of field values (quoting where needed)
  function buildCSVLine(arr) {
    return arr.map(function (v) {
      v = (v === null || v === undefined) ? '' : ('' + v);
      if (/[",\r\n]/.test(v)) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    }).join(',');
  }

  // Indices of columns that are ON (visible) given the header field array
  function visibleColumnIndices(headers) {
    var hidden = getConfig().hiddenColumns;
    var idx = [];
    for (var i = 0; i < headers.length; i++) {
      if (hidden.indexOf(headers[i]) === -1) { idx.push(i); }
    }
    return idx;
  }

  function clearData() {
    var keys = dataKeys();
    for (var i = 0; i < keys.length; i++) { localStorage.removeItem(keys[i]); }
    localStorage.removeItem(HEADER_KEY);
  }

  // Selection passing between pages
  function setSelected(key) { localStorage.setItem(SELECTED_KEY, key); }
  function getSelected() { return localStorage.getItem(SELECTED_KEY); }
  function setEditCol(idx) { localStorage.setItem(EDIT_COL_KEY, '' + idx); }
  function getEditCol() { return parseInt(localStorage.getItem(EDIT_COL_KEY), 10); }

  // Remembered main-page state (search keys + selected row)
  function setMainState(state) {
    localStorage.setItem(MAIN_STATE_KEY, JSON.stringify(state));
  }
  function getMainState() {
    try {
      var raw = localStorage.getItem(MAIN_STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(function (e) {
        console.log('SW registration failed', e);
      });
    }
  }

  return {
    PREFIX: PREFIX,
    HEADER_KEY: HEADER_KEY,
    nowSeconds: nowSeconds,
    pad: pad,
    makeKey: makeKey,
    getConfig: getConfig,
    setConfig: setConfig,
    getHeader: getHeader,
    setHeader: setHeader,
    dataKeys: dataKeys,
    getAll: getAll,
    hasData: hasData,
    parseCSVLine: parseCSVLine,
    buildCSVLine: buildCSVLine,
    visibleColumnIndices: visibleColumnIndices,
    clearData: clearData,
    setSelected: setSelected,
    getSelected: getSelected,
    setEditCol: setEditCol,
    getEditCol: getEditCol,
    setMainState: setMainState,
    getMainState: getMainState,
    registerSW: registerSW
  };
})();
