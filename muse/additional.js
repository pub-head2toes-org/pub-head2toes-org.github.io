/* Muse - additional commands list */
(function () {
  MUSE.registerSW();

  var commandsEl = document.getElementById('commands');

  // each command: { label, run }
  var commands = [
    { label: 'Download CSV', run: function () { location.href = 'download.html'; } },
    { label: 'View setup', run: function () { location.href = 'viewSetup.html'; } },
    { label: 'Upload new CSV', run: function () { location.href = 'upload.html'; } }
  ];
  var selected = 0;

  function render() {
    commandsEl.value = commands.map(function (c) { return c.label; }).join('\n');
    highlightSelected();
  }

  function highlightSelected() {
    var text = commandsEl.value;
    var start = 0;
    for (var i = 0; i < selected; i++) {
      var nl = text.indexOf('\n', start);
      if (nl === -1) { start = text.length; break; }
      start = nl + 1;
    }
    var end = text.indexOf('\n', start);
    if (end === -1) { end = text.length; }
    commandsEl.focus();
    commandsEl.setSelectionRange(start, end);
  }

  function move(delta) {
    selected = Math.min(commands.length - 1, Math.max(0, selected + delta));
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
      commands[selected].run();
    }
  });

  commandsEl.addEventListener('blur', function () {
    setTimeout(function () { commandsEl.focus(); }, 0);
  });

  render();
  commandsEl.focus();
})();
