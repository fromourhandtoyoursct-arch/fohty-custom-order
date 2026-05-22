// Minimal client-side glue — cart count placeholder until sub-phase 2 wires it up.
(function () {
  'use strict';
  // Read cart count from localStorage placeholder; future versions will sync server-side.
  try {
    var raw = localStorage.getItem('fothy.cart');
    var cart = raw ? JSON.parse(raw) : { items: [] };
    var count = (cart.items || []).reduce(function (n, it) { return n + (it.qty || 0); }, 0);
    document.querySelectorAll('[data-cart-count]').forEach(function (el) { el.textContent = String(count); });
  } catch (e) { /* ignore */ }
})();
