/* ============================================================
   حزمة العروض الفنية — سلوك النماذج القابلة للتعبئة
   Auto-save of filled fields (per browser, per document)
   ============================================================ */
(function () {
  var KEY = 'tp-kit:' + (document.body.getAttribute('data-doc') || location.pathname);

  function load() {
    var raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    var nodes = document.querySelectorAll('input.fi, textarea.fi, select.fi');
    nodes.forEach(function (el, i) {
      if (data[i] !== undefined && data[i] !== null) el.value = data[i];
    });
    recalc();
  }

  function save() {
    var nodes = document.querySelectorAll('input.fi, textarea.fi, select.fi');
    var data = [];
    nodes.forEach(function (el) { data.push(el.value); });
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
  }

  /* ---------- BOQ live arithmetic (only on pages that have it) ---------- */
  function recalc() {
    var rows = document.querySelectorAll('tr.calc');
    if (!rows.length) return;
    var sub = 0, wasteVal = 0;
    rows.forEach(function (tr) {
      var q = parseFloat((tr.querySelector('.q-qty') || {}).value) || 0;
      var w = parseFloat((tr.querySelector('.q-waste') || {}).value) || 0;
      var r = parseFloat((tr.querySelector('.q-rate') || {}).value) || 0;
      var qw = q * (1 + w / 100);
      var amt = qw * r;
      var cw = tr.querySelector('.q-qtyw'), ca = tr.querySelector('.q-amt');
      if (cw) cw.textContent = qw ? qw.toFixed(2) : '—';
      if (ca) ca.textContent = amt ? amt.toFixed(2) : '—';
      sub += q * r;
      wasteVal += q * (w / 100) * r;
    });
    var total = sub + wasteVal;
    var setTxt = function (sel, v) { var n = document.querySelector(sel); if (n) n.textContent = v; };
    setTxt('#sumSub', sub.toFixed(2));
    setTxt('#sumWaste', wasteVal.toFixed(2));
    setTxt('#sumTotal', total.toFixed(2));
    // 15% overhead & profit preview (editable factors)
    var oh = parseFloat((document.querySelector('#fOh') || {}).value) || 0;
    var pf = parseFloat((document.querySelector('#fProfit') || {}).value) || 0;
    var tv = parseFloat((document.querySelector('#fTax') || {}).value) || 0;
    var withOh = total * (1 + oh / 100);
    var withPf = withOh * (1 + pf / 100);
    var withTax = withPf * (1 + tv / 100);
    setTxt('#sumOh', withOh.toFixed(2));
    setTxt('#sumProf', withPf.toFixed(2));
    setTxt('#sumFinal', withTax.toFixed(2));
    setTxt('#sumOhVal', (withOh - total).toFixed(2));
    setTxt('#sumProfVal', (withPf - withOh).toFixed(2));
    setTxt('#sumTaxVal', (withTax - withPf).toFixed(2));
  }

  document.addEventListener('input', function (e) {
    if (e.target.matches && e.target.matches('input.fi, textarea.fi, select.fi')) {
      save();
      if (e.target.classList.contains('q-qty') || e.target.classList.contains('q-waste') ||
          e.target.classList.contains('q-rate') || e.target.id === 'fOh' ||
          e.target.id === 'fProfit' || e.target.id === 'fTax') { recalc(); }
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.matches && e.target.matches('select.fi')) { save(); recalc(); }
  });

  document.addEventListener('DOMContentLoaded', function () {
    load();
    document.querySelectorAll('[data-print]').forEach(function (b) {
      b.addEventListener('click', function () { window.print(); });
    });
    document.querySelectorAll('[data-reset]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!confirm('مسح جميع القيم المحفوظة في هذا النموذج؟')) return;
        try { localStorage.removeItem(KEY); } catch (e) {}
        document.querySelectorAll('input.fi, textarea.fi, select.fi').forEach(function (el) {
          if (el.tagName === 'SELECT') el.selectedIndex = 0; else el.value = '';
        });
        recalc();
      });
    });
  });
})();
