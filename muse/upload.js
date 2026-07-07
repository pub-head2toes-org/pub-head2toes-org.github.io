/* Muse - CSV upload screen */
(function () {
  MUSE.registerSW();

  var fileEl = document.getElementById('file');
  var progressEl = document.getElementById('progress');

  fileEl.addEventListener('change', function () {
    var file = fileEl.files && fileEl.files[0];
    if (!file) { return; }

    var reader = new FileReader();
    reader.onload = function () {
      var text = ('' + reader.result).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var lines = text.split('\n');

      // trailing empty line from final newline
      while (lines.length && lines[lines.length - 1] === '') { lines.pop(); }

      if (lines.length === 0) {
        progressEl.textContent = 'File is empty.';
        return;
      }

      // start clean, then load
      MUSE.clearData();

      // first line is the header
      MUSE.setHeader(lines[0]);

      var ts = MUSE.nowSeconds();
      var count = 0;
      try {
        for (var i = 1; i < lines.length; i++) {
          var csv = lines[i];
          if (csv === '') { continue; }
          var key = MUSE.makeKey(ts, i); // line number = position in upload
          localStorage.setItem(key, csv);
          count++;
        }
      } catch (err) {
        progressEl.textContent = 'Storage limit reached after ' + count +
          ' rows. Try a smaller file. (' + err.name + ')';
        return;
      }

      progressEl.textContent = 'Loaded ' + count + ' rows. Returning…';
      location.replace('index.html');
    };
    reader.onerror = function () {
      progressEl.textContent = 'Failed to read file.';
    };
    reader.readAsText(file);
  });
})();
