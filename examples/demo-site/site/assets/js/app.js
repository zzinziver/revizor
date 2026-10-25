/* Кофейня «Зёрна» — скрипты сайта */
(function () {
  'use strict';
  var d = document;

  // --- visit statistics ---
  try { navigator.sendBeacon('/api/visit', JSON.stringify({ page: location.pathname, t: Date.now() })); } catch (e) { /* old browsers */ }

  // --- preloader ---
  var pre = d.querySelector('.preloader');
  if (pre) setTimeout(function () { pre.classList.add('is-done'); }, 1200);

  // --- mobile menu ---
  var burger = d.querySelector('.burger');
  var mnav = d.querySelector('.mobile-nav');
  if (burger && mnav) {
    burger.addEventListener('click', function () {
      var open = mnav.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  // --- cookie banner ---
  var cookie = d.querySelector('.cookie');
  var saved = null;
  try { saved = localStorage.getItem('zerna_consent'); } catch (e) { /* private mode */ }
  if (cookie && (saved || /(^|;\s*)zerna_consent=/.test(d.cookie))) cookie.hidden = true;
  var accept = d.querySelector('.cookie__accept');
  var reject = d.querySelector('.cookie__reject');
  if (accept) accept.addEventListener('click', function () {
    cookie.hidden = true;
    try { localStorage.setItem('zerna_consent', 'all'); } catch (e) {}
    var s = d.createElement('script'); s.src = '/assets/js/after-consent.js'; s.async = true; d.body.appendChild(s);
  });
  if (reject) reject.addEventListener('click', function () {
    // the choice is stored on the server, the response sets the cookie
    fetch('/api/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'necessary' }) })
      .then(function (r) { if (r.ok) cookie.hidden = true; })
      .catch(function () {});
  });

  // --- booking modal ---
  var modal = d.getElementById('booking');
  function openModal() {
    if (!modal) { location.href = '/#booking'; return; }
    modal.hidden = false;
    var first = modal.querySelector('input');
    if (first) first.focus();
  }
  function closeModal() { if (modal) modal.hidden = true; }
  Array.prototype.forEach.call(d.querySelectorAll('.js-open-booking'), function (b) { b.addEventListener('click', openModal); });
  if (modal) {
    modal.querySelector('.modal__close').addEventListener('click', closeModal);
    modal.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = modal.querySelectorAll('input, select, button');
      var firstEl = f[0], lastEl = f[f.length - 1];
      if (e.shiftKey && d.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && d.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
    });
    if (location.hash === '#booking') openModal();
  }

  // --- menu tabs ---
  Array.prototype.forEach.call(d.querySelectorAll('.tab'), function (tab) {
    tab.addEventListener('click', function () {
      Array.prototype.forEach.call(d.querySelectorAll('.tab'), function (t) { t.setAttribute('aria-selected', 'false'); });
      Array.prototype.forEach.call(d.querySelectorAll('[role="tabpanel"]'), function (p) { p.hidden = true; });
      tab.setAttribute('aria-selected', 'true');
      d.getElementById(tab.getAttribute('aria-controls')).hidden = false;
    });
  });

  // --- beans calculator ---
  var cups = d.getElementById('calc-cups'), grams = d.getElementById('calc-grams'), out = d.getElementById('calc-out');
  function calc() {
    var kg = (parseFloat(cups.value) || 0) * (parseFloat(grams.value) || 0) * 30 / 1000;
    var rub = kg * 1950;
    out.textContent = 'В месяц нужно ' + kg.toFixed(2) + ' кг зерна — примерно ' + rub.toFixed(1) + ' ₽';
  }
  if (cups && grams && out) { cups.addEventListener('input', calc); grams.addEventListener('input', calc); calc(); }

  // --- autumn promo timer ---
  d.querySelector('.promo-timer').addEventListener('click', function () { /* open promo */ });
})();
//# sourceMappingURL=app.js.map
