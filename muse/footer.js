/* Muse - touch footer: buttons that mimic the physical keys.
 * Each button dispatches a synthetic keydown so the page's existing
 * keyboard handlers react exactly as they do for real key presses. */
(function () {
  var keys = [
    ['Esc', 'Escape'],
    ['Tab', 'Tab'],
    ['Up', 'ArrowUp'],
    ['Down', 'ArrowDown'],
    ['Enter', 'Enter']
  ];

  var bar = document.createElement('div');
  bar.id = 'touchbar';

  keys.forEach(function (k) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = k[0];
    // keep focus/selection on the current element (e.g. readonly textarea)
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () {
      var evt = new KeyboardEvent('keydown', {
        key: k[1],
        bubbles: true,
        cancelable: true
      });
      document.dispatchEvent(evt);
    });
    bar.appendChild(b);
  });

  document.body.appendChild(bar);
})();
