(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ---------- CSRF ----------
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrfMeta ? csrfMeta.getAttribute('content') || '' : '';

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- Toast ----------
  const toastEl = $('[data-toast]');
  let toastTimer = null;
  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.remove('on');
      setTimeout(() => { toastEl.hidden = true; }, 250);
    }, 2400);
  }

  // ---------- Cart Drawer ----------
  const drawer = $('[data-drawer]');
  const scrim = $('[data-drawer-scrim]');
  const drawerBody = $('[data-drawer-body]');
  const drawerFoot = $('[data-drawer-foot]');
  const drawerEmpty = $('[data-drawer-empty]');
  const drawerSubtotal = $('[data-drawer-subtotal]');
  const drawerShipHint = $('[data-drawer-ship-hint]');
  const drawerWarning = $('[data-drawer-warning]');
  const drawerCheckoutBtn = $('[data-drawer-checkout]');
  const cartCountEls = $$('[data-cart-count]');

  function openDrawer() {
    if (!drawer) return;
    drawer.hidden = false;
    scrim.hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => {
      drawer.classList.add('on');
      scrim.classList.add('on');
    });
    drawer.setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('on');
    scrim.classList.remove('on');
    drawer.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      drawer.hidden = true;
      scrim.hidden = true;
      document.body.style.overflow = '';
    }, 250);
  }

  function renderCart(state) {
    if (!state) return;
    cartCountEls.forEach((el) => { el.textContent = String(state.item_count || 0); });
    if (!drawerBody) return;
    if (!state.lines || state.lines.length === 0) {
      drawerBody.innerHTML = '<p class="drawer-empty">Your bag is empty.</p>';
      drawerFoot.hidden = true;
      return;
    }
    drawerFoot.hidden = false;
    const linesHtml = state.lines.map((l) => {
      const img = l.image ? `<img src="${escapeHtml(l.image)}" alt="" width="72" height="90">` : '<div class="cline-ph"></div>';
      const unavail = !l.available
        ? `<div class="cline-reason">${escapeHtml(l.reason || 'Unavailable')}</div>`
        : '';
      return `
        <div class="cline" data-variation-id="${escapeHtml(l.variation_id)}">
          <div class="cline-img">${img}</div>
          <div class="cline-info">
            <div class="cline-name">${escapeHtml(l.name)}</div>
            ${l.variation ? `<div class="cline-variation">${escapeHtml(l.variation)}</div>` : ''}
            <div class="cline-price">${escapeHtml(l.unit_price_label)}</div>
            ${unavail}
            <div class="cline-qty">
              <button type="button" data-qty-action="dec" aria-label="Decrease">−</button>
              <span class="cline-qty-n">${l.qty}</span>
              <button type="button" data-qty-action="inc" aria-label="Increase">+</button>
            </div>
          </div>
          <div class="cline-side">
            <div class="cline-subtotal">${escapeHtml(l.subtotal_label)}</div>
            <button type="button" class="cline-remove" data-qty-action="remove">Remove</button>
          </div>
        </div>
      `;
    }).join('');
    drawerBody.innerHTML = linesHtml;
    drawerSubtotal.textContent = state.subtotal_label || '';
    if (state.subtotal_cents > 0 && state.subtotal_cents < 6000) {
      const remaining = (6000 - state.subtotal_cents) / 100;
      drawerShipHint.textContent = `Add $${remaining.toFixed(2)} for free shipping.`;
      drawerShipHint.hidden = false;
    } else {
      drawerShipHint.hidden = true;
    }
    drawerWarning.hidden = !state.any_unavailable;
    if (drawerCheckoutBtn) {
      drawerCheckoutBtn.disabled = !!state.any_unavailable;
      if (state.any_unavailable) drawerCheckoutBtn.setAttribute('aria-disabled', 'true');
      else drawerCheckoutBtn.removeAttribute('aria-disabled');
    }
  }

  async function fetchCart() {
    try {
      const resp = await fetch('/cart/contents', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (!resp.ok) return null;
      const json = await resp.json();
      renderCart(json);
      return json;
    } catch (e) { return null; }
  }

  async function cartAction(path, body) {
    const fd = new URLSearchParams();
    if (csrfToken) fd.set('_csrf', csrfToken);
    Object.entries(body || {}).forEach(([k, v]) => fd.set(k, String(v)));
    const resp = await fetch(path, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': csrfToken,
      },
      body: fd.toString(),
      credentials: 'same-origin',
    });
    if (!resp.ok) return null;
    return resp.json();
  }

  // Open drawer when bag pill clicked
  $$('[data-cart-open]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openDrawer();
      fetchCart();
    });
  });
  if (scrim) scrim.addEventListener('click', closeDrawer);
  $$('[data-drawer-close]').forEach((b) => b.addEventListener('click', closeDrawer));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer && !drawer.hidden) closeDrawer();
  });

  // Qty steppers + remove inside drawer (event delegation)
  if (drawerBody) {
    drawerBody.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-qty-action]');
      if (!btn) return;
      const lineEl = btn.closest('[data-variation-id]');
      if (!lineEl) return;
      const variationId = lineEl.dataset.variationId;
      const nEl = lineEl.querySelector('.cline-qty-n');
      const current = parseInt(nEl ? nEl.textContent : '0', 10) || 0;
      const action = btn.dataset.qtyAction;
      let next = current;
      if (action === 'inc') next = current + 1;
      else if (action === 'dec') next = current - 1;
      else if (action === 'remove') next = 0;
      if (next <= 0) {
        const json = await cartAction('/cart/remove', { variation_id: variationId });
        if (json) renderCart(json);
      } else {
        const json = await cartAction('/cart/update', { variation_id: variationId, quantity: next });
        if (json) renderCart(json);
      }
    });
  }

  // Intercept add-to-cart forms — AJAX submit, open drawer + toast
  $$('form[data-cart-form][action="/cart/add"]').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const variationId = data.get('variation_id');
      const quantity = data.get('quantity') || 1;
      const json = await cartAction('/cart/add', { variation_id: variationId, quantity });
      if (!json || !json.ok) {
        showToast(json && json.error ? String(json.error) : 'Could not add to bag.');
        return;
      }
      renderCart(json);
      const nameSrc = form.closest('[data-product-name]');
      const itemName = (nameSrc && nameSrc.dataset.productName) || 'item';
      showToast(`Added ${itemName} to your bag`);
      openDrawer();
    });
  });

  // Quick-add buttons on product cards
  $$('[data-quick-add]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const variationId = btn.dataset.variationId;
      const itemName = btn.dataset.productName || 'item';
      if (!variationId) return;
      const json = await cartAction('/cart/add', { variation_id: variationId, quantity: 1 });
      if (!json || !json.ok) {
        showToast(json && json.error ? String(json.error) : 'Could not add to bag.');
        return;
      }
      renderCart(json);
      showToast(`Added ${itemName} to your bag`);
      openDrawer();
    });
  });

  // Initial cart-count fetch (lightweight) so the header reflects server state.
  fetchCart();

  // ---------- Search overlay ----------
  const overlay = $('[data-search-overlay]');
  const searchInput = $('[data-search-input]');
  const searchForm = $('[data-search-form]');
  const searchBody = $('[data-search-body]');
  const searchEmpty = $('[data-search-empty]');
  let searchTimer = null;

  function renderSearchResults(items, q) {
    if (!searchBody) return;
    if (!q) {
      if (searchEmpty) searchBody.innerHTML = searchEmpty.outerHTML;
      else searchBody.innerHTML = '';
      return;
    }
    if (!items || items.length === 0) {
      searchBody.innerHTML = `<div class="search-empty"><p class="search-empty-text">No matches for "${escapeHtml(q)}".</p><a class="btn-link" href="/custom-order">Design something custom →</a></div>`;
      return;
    }
    const list = items.map((p) => `
      <li>
        <a class="search-result" href="${escapeHtml(p.url)}">
          ${p.image ? `<img class="search-result-thumb" src="${escapeHtml(p.image)}" alt="" width="56" height="56">` : '<div class="search-result-thumb"></div>'}
          <span class="search-result-text">
            <span class="search-result-name">${escapeHtml(p.name)}</span>
          </span>
          <span class="search-result-price">${escapeHtml(p.price || '')}</span>
        </a>
      </li>`).join('');
    searchBody.innerHTML = `<ul class="search-results">${list}</ul>`;
  }

  async function runSearch(q) {
    if (!q) { renderSearchResults([], ''); return; }
    try {
      const resp = await fetch(`/catalog/search.json?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      if (!resp.ok) { renderSearchResults([], q); return; }
      const json = await resp.json();
      renderSearchResults(json.results || [], q);
    } catch (e) {
      renderSearchResults([], q);
    }
  }

  if (overlay) {
    function openSearch() {
      overlay.hidden = false;
      document.body.style.overflow = 'hidden';
      setTimeout(() => { if (searchInput) searchInput.focus(); }, 0);
    }
    function closeSearch() {
      overlay.hidden = true;
      document.body.style.overflow = '';
      if (searchInput) searchInput.value = '';
      renderSearchResults([], '');
    }
    $$('[data-search-open]').forEach((btn) => btn.addEventListener('click', openSearch));
    $$('[data-search-close]').forEach((btn) => btn.addEventListener('click', closeSearch));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSearch(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeSearch(); });
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim();
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => runSearch(q), 180);
      });
    }
    if (searchForm) {
      searchForm.addEventListener('submit', async (e) => {
        const q = (searchInput && searchInput.value || '').trim();
        if (!q) { e.preventDefault(); return; }
        // Match design: Enter navigates directly to the first result.
        e.preventDefault();
        try {
          const resp = await fetch(`/catalog/search.json?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
          const json = resp.ok ? await resp.json() : null;
          const first = json && json.results && json.results[0];
          if (first && first.url) { window.location.href = first.url; return; }
        } catch (_) { /* fall through */ }
        // No matches → submit to /catalog?q= as a fallback browse.
        window.location.href = `/catalog?q=${encodeURIComponent(q)}`;
      });
    }
  }

  // PDP image swap
  $$('[data-pdp-thumb]').forEach((thumb) => {
    thumb.addEventListener('click', () => {
      const src = thumb.dataset.imageSrc;
      const main = $('[data-pdp-main]');
      if (src && main) main.src = src;
      $$('[data-pdp-thumb]').forEach((t) => t.classList.remove('on'));
      thumb.classList.add('on');
    });
  });
})();
