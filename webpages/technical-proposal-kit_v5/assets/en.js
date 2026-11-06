/* ============================================================
   MMC Technical Proposal Kit — English Edition behaviour
   · per-document autosave (localStorage)
   · currency switcher  USD / JOD / SAR / AED
   · live quantity take-off arithmetic
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- currency ---------------- */
  var FX = {
    USD: { rate: 1,      symbol: '$',   code: 'USD', label: 'US Dollar' },
    JOD: { rate: 0.709,  symbol: 'JD',  code: 'JOD', label: 'Jordanian Dinar' },
    SAR: { rate: 3.75,   symbol: 'SR',  code: 'SAR', label: 'Saudi Riyal' },
    AED: { rate: 3.673,  symbol: 'AED', code: 'AED', label: 'UAE Dirham' }
  };
  var CUR_KEY = 'tpkit-en-currency';

  function getCurrency() {
    var c = 'USD';
    try { c = localStorage.getItem(CUR_KEY) || 'USD'; } catch (e) {}
    return FX[c] ? c : 'USD';
  }

  function setCurrency(code) {
    if (!FX[code]) return;
    try { localStorage.setItem(CUR_KEY, code); } catch (e) {}
    applyCurrency(code);
    // any page with live arithmetic recomputes in the new currency
    if (typeof window.__tpkitRecalc === 'function') window.__tpkitRecalc();
  }

  function r2(v) { return Math.round((v + Number.EPSILON) * 100) / 100; }

  function fmtMoney(v, code) {
    var f = FX[code] || FX.USD;
    var n = r2(v * f.rate);
    return f.symbol + ' ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /* Replace every element carrying data-usd="<number>" with the converted figure.
     Elements may add data-money-style="plain" to drop the symbol. */
  function applyCurrency(code) {
    var f = FX[code] || FX.USD;
    var nodes = document.querySelectorAll('[data-usd]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var usd = parseFloat(el.getAttribute('data-usd'));
      if (!isFinite(usd)) continue;
      var conv = usd * f.rate;
      var plain = el.getAttribute('data-money-style') === 'plain';
      var txt = conv.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      el.textContent = plain ? txt : (f.symbol + ' ' + txt);
    }
    // labels that name the currency
    var labs = document.querySelectorAll('[data-currency-label]');
    for (var j = 0; j < labs.length; j++) labs[j].textContent = f.label;
    var codes = document.querySelectorAll('[data-currency-code]');
    for (var k = 0; k < codes.length; k++) codes[k].textContent = f.code;

    var sel = document.querySelectorAll('select.cur');
    for (var s = 0; s < sel.length; s++) sel[s].value = code;

    document.documentElement.setAttribute('data-currency', code);
  }

  /* ---------------- autosave ---------------- */
  var KEY = 'tpkit-en:' + (document.body.getAttribute('data-doc') || location.pathname);

  function fields() {
    return document.querySelectorAll('input.fi, textarea.fi, select.fi');
  }

  function save() {
    var nodes = fields(), data = [];
    for (var i = 0; i < nodes.length; i++) data.push(nodes[i].value);
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    var nodes = fields();
    for (var i = 0; i < nodes.length; i++) {
      if (data[i] !== undefined && data[i] !== null) nodes[i].value = data[i];
    }
  }

  document.addEventListener('input', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('input.fi, textarea.fi, select.fi')) {
      save();
      if (typeof window.__tpkitRecalc === 'function') window.__tpkitRecalc();
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('select.fi')) {
      save();
      if (typeof window.__tpkitRecalc === 'function') window.__tpkitRecalc();
    }
    if (t.matches('select.cur')) setCurrency(t.value);
  });

  /* ---------------- boot ---------------- */
  function boot() {
    load();

    // topbar buttons
    var prints = document.querySelectorAll('[data-print]');
    for (var i = 0; i < prints.length; i++) {
      prints[i].addEventListener('click', function () { window.print(); });
    }

    var resets = document.querySelectorAll('[data-reset]');
    for (var j = 0; j < resets.length; j++) {
      resets[j].addEventListener('click', function () {
        if (!window.confirm('Clear all saved values in this form?')) return;
        try { localStorage.removeItem(KEY); } catch (e) {}
        var nodes = fields();
        for (var k = 0; k < nodes.length; k++) {
          if (nodes[k].tagName === 'SELECT') nodes[k].selectedIndex = 0;
          else nodes[k].value = '';
        }
        if (typeof window.__tpkitRecalc === 'function') window.__tpkitRecalc();
      });
    }

    // currency selectors already in the DOM
    var sels = document.querySelectorAll('select.cur');
    for (var s = 0; s < sels.length; s++) {
      sels[s].value = getCurrency();
      sels[s].addEventListener('change', function () { setCurrency(this.value); });
    }
    applyCurrency(getCurrency());

    if (typeof window.__tpkitRecalc === 'function') window.__tpkitRecalc();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // expose for pages that need it
  window.TPKit = {
    money: fmtMoney,
    currency: getCurrency,
    setCurrency: setCurrency,
    refresh: function () { applyCurrency(getCurrency()); }
  };
})();

/* ============================================================
   Pricing page: monthly / annual toggle
   ============================================================ */
(function () {
  var wrap = document.querySelector('[data-pricing]');
  if (!wrap) return;

  var MONTHLY = { starter: 39, pro: 89, ent: 199 };
  var ANNUAL = { starter: 390, pro: 890, ent: 1990 };   // ~2 months free

  function render(mode) {
    var annual = mode === 'annual';
    Object.keys(MONTHLY).forEach(function (k) {
      var amtEl = wrap.querySelector('[data-amt="' + k + '"]');
      var perEl = wrap.querySelector('[data-per="' + k + '"]');
      var billEl = wrap.querySelector('[data-bill="' + k + '"]');
      if (!amtEl) return;
      if (annual) {
        amtEl.innerHTML = '<sup>$</sup>' + ANNUAL[k];
        if (perEl) perEl.textContent = 'per year';
        if (billEl) billEl.textContent = 'equivalent to $' + (ANNUAL[k] / 12).toFixed(2) + '/mo — save $' + ((MONTHLY[k] * 12) - ANNUAL[k]);
      } else {
        amtEl.innerHTML = '<sup>$</sup>' + MONTHLY[k];
        if (perEl) perEl.textContent = 'per month';
        if (billEl) billEl.textContent = 'billed monthly';
      }
    });
    var btns = wrap.querySelectorAll('[data-cycle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-cycle') === mode);
    }
    try { localStorage.setItem('tpkit-en-cycle', mode); } catch (e) {}
  }

  var saved = 'monthly';
  try { saved = localStorage.getItem('tpkit-en-cycle') || 'monthly'; } catch (e) {}
  render(saved);

  wrap.addEventListener('click', function (e) {
    var b = e.target.closest('[data-cycle]');
    if (b) render(b.getAttribute('data-cycle'));
  });
})();

/* ============================================================
   Subscribe page: plan pre-selection + UI-only submit
   ============================================================ */
(function () {
  var form = document.getElementById('subscribeForm');
  if (!form) return;

  // ?plan=pro pre-selects the tier
  var q = new URLSearchParams(location.search).get('plan');
  if (q) {
    var radio = form.querySelector('input[name="plan"][value="' + q + '"]');
    if (radio) radio.checked = true;
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var out = document.getElementById('formResult');
    var name = (form.querySelector('[name="name"]') || {}).value || '';
    var company = (form.querySelector('[name="company"]') || {}).value || '';
    var email = (form.querySelector('[name="email"]') || {}).value || '';
    var planEl = form.querySelector('input[name="plan"]:checked');
    var plan = planEl ? planEl.value : '—';

    if (!name.trim() || !email.trim()) {
      if (out) {
        out.className = 'box red';
        out.innerHTML = '<h4>Missing required fields</h4><p>Please enter at least your name and email so we can reach you.</p>';
        out.style.display = 'block';
        out.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }

    var names = { starter: 'Starter', pro: 'Professional', ent: 'Enterprise' };
    if (out) {
      out.className = 'box teal';
      out.innerHTML =
        '<h4>Request captured — demo form only</h4>' +
        '<p>Thank you, <strong>' + name.replace(/[<>&]/g, '') + '</strong>' +
        (company ? ' (' + company.replace(/[<>&]/g, '') + ')' : '') + '. ' +
        'We recorded your interest in the <strong>' + (names[plan] || plan) + '</strong> plan and would reply to <strong>' +
        email.replace(/[<>&]/g, '') + '</strong>.</p>' +
        '<p style="margin-top:8px"><strong>No payment was taken and no account was created.</strong> ' +
        'This form is a working interface prototype — there is no payment gateway, no card field and no backend connected. ' +
        'Wire it to your own CRM or billing provider before going live.</p>';
      out.style.display = 'block';
      out.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    form.reset();
    var again = new URLSearchParams(location.search).get('plan');
    if (again) {
      var r2 = form.querySelector('input[name="plan"][value="' + again + '"]');
      if (r2) r2.checked = true;
    }
  });
})();
