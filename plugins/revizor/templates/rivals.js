(function () {
  'use strict';
  // Marks «take / no / discuss» on idea cards: kept in localStorage of this browser only; copied as text for the chat.
  var root = document.documentElement;
  var KEY = 'revizor-marks:' + (root.getAttribute('data-key') || 'page');
  var box = document.getElementById('marks');
  if (!box) return;
  var out = document.getElementById('marks-text');
  var btn = document.getElementById('marks-copy');
  var status = document.getElementById('marks-status');
  var words = { take: box.getAttribute('data-take'), no: box.getAttribute('data-no'), discuss: box.getAttribute('data-discuss') };

  function load() {
    try { var v = JSON.parse(window.localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; }
    catch (e) { return {}; }
  }
  function save(m) {
    try { window.localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) { /* private mode or blocked storage */ }
  }
  var marks = load();
  var inputs = document.querySelectorAll('input[data-idea]');

  function text() {
    var lines = [];
    var seen = {};
    for (var i = 0; i < inputs.length; i++) {
      var id = inputs[i].getAttribute('data-idea');
      if (seen[id]) continue;
      seen[id] = true;
      var v = marks[id];
      if (!v || !words[v]) continue;
      lines.push(words[v] + ': ' + id + ' ' + (inputs[i].getAttribute('data-title') || ''));
    }
    return lines.join('\n');
  }
  function render() { if (out) out.value = text(); if (status) status.textContent = ''; }

  for (var i = 0; i < inputs.length; i++) {
    (function (el) {
      if (marks[el.getAttribute('data-idea')] === el.value) el.checked = true;
      el.addEventListener('change', function () {
        if (el.checked) { marks[el.getAttribute('data-idea')] = el.value; save(marks); render(); }
      });
    })(inputs[i]);
  }

  function fallbackCopy() {
    if (!out) return false;
    try { out.focus(); out.select(); return document.execCommand('copy'); } catch (e) { return false; }
  }
  if (btn) btn.addEventListener('click', function () {
    var t = text();
    var done = function () { if (status) status.textContent = box.getAttribute('data-copied') || ''; };
    var fail = function () { if (fallbackCopy()) done(); else if (status) status.textContent = box.getAttribute('data-fail') || ''; };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, fail);
      else fail();
    } catch (e) { fail(); }
  });
  render();
})();
