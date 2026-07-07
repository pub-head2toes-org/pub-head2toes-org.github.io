/* Muse - build CSV from local storage and download it */
(function () {
  MUSE.registerSW();

  var msgEl = document.getElementById('msg');
  var againEl = document.getElementById('again');

  function buildCSV() {
    var parts = [];
    var header = MUSE.getHeader();
    if (header) { parts.push(header); }
    var rows = MUSE.getAll();
    for (var i = 0; i < rows.length; i++) { parts.push(rows[i].line); }
    return parts.join('\r\n') + '\r\n';
  }

  function download() {
    var csv = buildCSV();
    var ts = MUSE.nowSeconds();
    var name = 'MUSE_' + ts + '.csv';
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    msgEl.textContent = 'Downloaded ' + name;
  }

  againEl.addEventListener('click', function (e) {
    e.preventDefault();
    download();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      location.href = 'index.html';
    }
  });

  // auto trigger on load
  download();
})();
