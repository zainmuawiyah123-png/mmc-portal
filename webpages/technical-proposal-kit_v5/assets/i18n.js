/* MMC shared i18n — same key as portal.js so language is shared across all portals */
(function (global) {
  'use strict';
  var LANG_KEY = 'tpkit-portal-lang';

  function lang() {
    try { return localStorage.getItem(LANG_KEY) || 'ar'; } catch (e) { return 'ar'; }
  }

  function T(ar, en) {
    return lang() === 'ar' ? ar : (en || ar);
  }

  function applyLang() {
    var l = lang();
    var html = document.documentElement;
    html.setAttribute('lang', l);
    html.setAttribute('dir', l === 'ar' ? 'rtl' : 'ltr');
    document.querySelectorAll('[data-ar]').forEach(function (n) {
      var v = n.getAttribute('data-' + l);
      if (v !== null) n.textContent = v;
    });
    document.querySelectorAll('[data-ar-ph]').forEach(function (n) {
      var p = n.getAttribute('data-' + l + '-ph');
      if (p !== null) n.setAttribute('placeholder', p);
    });
    document.querySelectorAll('[data-ar-title]').forEach(function (n) {
      var t = n.getAttribute('data-' + l + '-title');
      if (t !== null) n.setAttribute('title', t);
    });
    document.querySelectorAll('[data-lang-btn]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-lang-btn') === l);
    });
    var titleEl = document.querySelector('title');
    if (titleEl && titleEl.getAttribute('data-ar')) {
      titleEl.textContent = titleEl.getAttribute('data-' + l) || titleEl.getAttribute('data-ar');
    }
    try {
      global.dispatchEvent(new CustomEvent('mmc:lang', { detail: { lang: l } }));
    } catch (e) {}
  }

  function setLang(l) {
    if (l !== 'ar' && l !== 'en') return;
    try { localStorage.setItem(LANG_KEY, l); } catch (e) {}
    applyLang();
  }

  function mountSwitcher(parent) {
    if (!parent) return;
    if (parent.querySelector('[data-lang-switch]')) return;
    var wrap = document.createElement('div');
    wrap.setAttribute('data-lang-switch', '1');
    wrap.style.cssText = 'display:inline-flex;border:1px solid var(--line,#37506b);border-radius:6px;overflow:hidden;margin-inline-start:8px';
    wrap.innerHTML =
      '<button type="button" data-lang-btn="ar" class="btn sm" style="border:0;border-radius:0;padding:4px 10px;font-weight:800">AR</button>' +
      '<button type="button" data-lang-btn="en" class="btn sm" style="border:0;border-radius:0;padding:4px 10px;font-weight:800">EN</button>';
    parent.appendChild(wrap);
    wrap.querySelectorAll('[data-lang-btn]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang-btn')); });
    });
    applyLang();
  }

  function boot() {
    applyLang();
    document.querySelectorAll('[data-lang-btn]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang-btn')); });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.MMC_I18N = { lang: lang, T: T, setLang: setLang, applyLang: applyLang, mountSwitcher: mountSwitcher };
})(window);
