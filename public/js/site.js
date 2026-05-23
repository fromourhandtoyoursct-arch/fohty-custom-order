(function () {
  'use strict';

  // Cart count from localStorage placeholder.
  try {
    var raw = localStorage.getItem('fothy.cart');
    var cart = raw ? JSON.parse(raw) : { items: [] };
    var count = (cart.items || []).reduce(function (n, it) { return n + (it.qty || 0); }, 0);
    document.querySelectorAll('[data-cart-count]').forEach(function (el) { el.textContent = String(count); });
  } catch (e) { /* ignore */ }

  // Search overlay
  var overlay = document.querySelector('[data-search-overlay]');
  var input = document.querySelector('[data-search-input]');
  var form = document.querySelector('[data-search-form]');
  if (!overlay) return;

  function openSearch() {
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(function () { if (input) input.focus(); }, 0);
  }
  function closeSearch() {
    overlay.hidden = true;
    document.body.style.overflow = '';
    if (input) input.value = '';
  }

  document.querySelectorAll('[data-search-open]').forEach(function (btn) {
    btn.addEventListener('click', openSearch);
  });
  document.querySelectorAll('[data-search-close]').forEach(function (btn) {
    btn.addEventListener('click', closeSearch);
  });
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeSearch();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !overlay.hidden) closeSearch();
  });
  if (form) {
    form.addEventListener('submit', function (e) {
      var q = (input && input.value || '').trim();
      if (!q) { e.preventDefault(); }
    });
  }
})();
