/* ============================================================
   MMC Portal — application layer (المرحلة الأولى: مرتبط بالخادم)
   كل البيانات من الـ API؛ لا IndexedDB ولا تخزين محلي للأعمال.
   ============================================================ */
(function () {
  'use strict';

  /* ---------------- ثوابت العرض ---------------- */
  var CATS = {
    arch:   { ar: 'معماري',            en: 'Architectural', cls: 'arch' },
    struct: { ar: 'إنشائي',            en: 'Structural',    cls: 'struct' },
    mep:    { ar: 'كهروميكانيكي MEP',  en: 'MEP',           cls: 'mep' },
    tender: { ar: 'كراسة شروط',        en: 'Tender docs',   cls: 'tender' },
    boq:    { ar: 'جدول كميات',        en: 'BOQ',           cls: 'boq' },
    other:  { ar: 'أخرى',              en: 'Other',         cls: 'other' }
  };
  var STATUS = {
    new:   { ar: 'جديد',        en: 'New',        cls: 'new' },
    proc:  { ar: 'قيد المعالجة', en: 'Processing', cls: 'proc' },
    ready: { ar: 'جاهز',        en: 'Ready',      cls: 'ready' }
  };

  var LANG_KEY = 'tpkit-portal-lang';
  var state = { user: null, plan: null, usage: null };

  /* ---------------- لغة ---------------- */
  function lang() { try { return localStorage.getItem(LANG_KEY) || 'ar'; } catch (e) { return 'ar'; } }
  function T(ar, en) { return lang() === 'ar' ? ar : en; }

  function applyLang() {
    var l = lang();
    document.documentElement.setAttribute('dir', l === 'ar' ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', l);
    document.querySelectorAll('[data-ar]').forEach(function (n) {
      var v = n.getAttribute('data-' + l);
      if (v !== null) n.textContent = v;
    });
    document.querySelectorAll('[data-ar-ph]').forEach(function (n) {
      var p = n.getAttribute('data-' + l + '-ph');
      if (p !== null) n.setAttribute('placeholder', p);
    });
    document.querySelectorAll('[data-lang-btn]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-lang-btn') === l);
    });
  }

  function setLang(l) {
    try { localStorage.setItem(LANG_KEY, l); } catch (e) {}
    applyLang();
    rerender();
  }

  /* ---------------- أدوات ---------------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /**
   * حجم مقروء. الأرقام والوحدات لاتينية داخل نص عربي ← نلفّها بـ LRI/PDI
   * (U+2066 / U+2069) حتى لا يعكس محرّك الـ bidi ترتيب "32 B" إلى "B 32".
   */
  function fmtBytes(b) {
    if (b === null || b === undefined) return '∞';
    var out;
    if (b < 1024) out = b + ' B';
    else if (b < 1048576) out = (b / 1024).toFixed(1) + ' KB';
    else if (b < 1073741824) out = (b / 1048576).toFixed(1) + ' MB';
    else out = (b / 1073741824).toFixed(2) + ' GB';
    return '\u2066' + out + '\u2069';
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(typeof ts === 'number' && ts < 1e12 ? ts * 1000 : ts);
    if (isNaN(d)) return '—';
    try {
      return d.toLocaleDateString(lang() === 'ar' ? 'ar-EG' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) +
        ' · ' + d.toLocaleTimeString(lang() === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function getVal(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function setVal(id, v) { var e = document.getElementById(id); if (e) e.value = v == null ? '' : v; }

  function toast(msg, kind) {
    var t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.className = 'toast'; }, 4200);
  }

  function loading(host, label) {
    if (!host) return;
    host.innerHTML = '<div class="empty"><div class="ic">⏳</div><b>' +
      esc(label || T('جارٍ التحميل…', 'Loading…')) + '</b></div>';
  }
  function emptyBox(icon, title, text, ctaHref, ctaLabel) {
    return '<div class="empty"><div class="ic">' + icon + '</div><b>' + esc(title) + '</b><p>' + esc(text) + '</p>' +
      (ctaHref ? '<a class="btn amber" href="' + ctaHref + '">' + esc(ctaLabel) + '</a>' : '') + '</div>';
  }
  function errorBox(host, err) {
    if (!host) return;
    host.innerHTML = '<div class="note warn"><h4>' + esc(T('تعذّر تحميل البيانات', 'Could not load data')) + '</h4><p>' +
      esc(err && err.message ? err.message : String(err)) + '</p>' +
      '<p class="small">' + esc(T('رمز الخطأ: ', 'Error code: ')) + esc(err && err.code ? err.code : '—') + '</p></div>';
  }

  /* ---------------- الجلسة ---------------- */
  function guard() {
    return API.me().then(function (data) {
      state.user = data.user;
      state.plan = data.plan.plan;
      state.usage = data.plan.usage;
      paintUser();
      return data;
    }).catch(function (err) {
      if (err.status === 401) {
        var next = encodeURIComponent(location.pathname.split('/').pop() + location.search);
        location.replace('login.html?next=' + next);
        var rej = new Error('redirected'); rej.redirected = true;
        return Promise.reject(rej);
      }
      throw err;
    });
  }

  function paintUser() {
    document.querySelectorAll('[data-user-name]').forEach(function (e) {
      e.textContent = state.user ? state.user.name : '';
    });
    document.querySelectorAll('[data-user-email]').forEach(function (e) {
      e.textContent = state.user ? state.user.email : '';
    });
    document.querySelectorAll('[data-plan-badge]').forEach(function (el) {
      if (!state.plan) return;
      el.textContent = lang() === 'ar' ? state.plan.nameAr : state.plan.nameEn;
      el.className = 'plan-badge' + (state.plan.key === 'pro' ? ' pro' : state.plan.key === 'ent' ? ' ent' : '');
    });
  }

  function doLogout() {
    API.logout().catch(function () {}).then(function () { location.href = 'login.html'; });
  }

  /* ---------------- عناصر مشتركة ---------------- */
  function usageBar(label, used, max, pct) {
    var cls = pct === null ? '' : pct >= 100 ? 'full' : pct >= 75 ? 'warn' : '';
    return '<div class="usage"><div class="lbl"><span>' + label + '</span><span>' +
      used + ' / ' + (max === null ? '∞' : max) + '</span></div>' +
      '<div class="bar ' + cls + '"><i style="width:' + (pct === null ? 6 : pct) + '%"></i></div></div>';
  }
  function statCard(cls, k, v, d) {
    return '<div class="stat ' + cls + '"><div class="k">' + k + '</div><div class="v">' + v +
      '</div><div class="d">' + d + '</div></div>';
  }

  /* ==========================================================
     لوحة التحكم
     ========================================================== */
  function initDashboard() {
    var host = document.getElementById('dashBody');
    if (!host) return;
    loading(host);

    API.listTenders().then(function (data) {
      var tenders = data.tenders || [];
      var u = state.usage || { tenders: 0, tendersMax: 0, tendersPct: null, bytes: 0, bytesMax: null, bytesPct: null, files: 0, ready: 0, processing: 0 };

      var st = document.getElementById('dashStats');
      if (st) {
        st.innerHTML =
          statCard('accent', T('إجمالي العطاءات', 'Total tenders'), u.tenders, T('من ', 'of ') + (u.tendersMax === null ? '∞' : u.tendersMax)) +
          statCard('teal', T('جاهزة للتقديم', 'Ready to submit'), u.ready, T('مخرجات مكتملة', 'outputs complete')) +
          statCard('blue', T('قيد المعالجة', 'In progress'), u.processing, T('بانتظار المعالجة', 'awaiting processing')) +
          statCard('', T('حجم المرفوعات', 'Uploaded volume'), fmtBytes(u.bytes), u.files + ' ' + T('ملف', 'files'));
      }

      var ub = document.getElementById('dashUsage');
      if (ub) {
        ub.innerHTML =
          usageBar(T('العطاءات المستهلكة', 'Tenders used'), u.tenders, u.tendersMax, u.tendersPct) +
          usageBar(T('مساحة الرفع المستهلكة', 'Upload space used'), fmtBytes(u.bytes),
            u.bytesMax === null ? null : fmtBytes(u.bytesMax), u.bytesPct);
      }

      if (!tenders.length) {
        host.innerHTML = emptyBox('📁', T('لا توجد عطاءات بعد', 'No tenders yet'),
          T('ابدأ برفع مخططات ووثائق أول عطاء.', 'Start by uploading the drawings and documents for your first tender.'),
          'upload.html', T('➕ رفع عطاء جديد', '➕ Upload a tender'));
        return;
      }

      var rows = tenders.map(function (t) {
        var s = STATUS[t.status] || STATUS.new;
        return '<tr>' +
          '<td><a href="outputs.html?t=' + encodeURIComponent(t.id) + '" style="font-weight:800">' + esc(t.name) + '</a>' +
            '<div class="small">' + esc(t.authority || '—') + '</div></td>' +
          '<td class="c"><span class="badge ' + s.cls + '">' + T(s.ar, s.en) + '</span></td>' +
          '<td class="n">' + t.fileCount + '</td>' +
          '<td class="n">' + fmtBytes(t.bytes) + '</td>' +
          '<td class="small">' + fmtDate(t.updatedAt) + '</td>' +
          '<td><div class="actions">' +
            '<a class="btn sm light" href="outputs.html?t=' + encodeURIComponent(t.id) + '">' + T('المخرجات', 'Outputs') + '</a>' +
            '<a class="btn sm light" href="upload.html?t=' + encodeURIComponent(t.id) + '">' + T('رفع', 'Upload') + '</a>' +
            '<button class="btn sm danger" data-del="' + esc(t.id) + '">' + T('حذف', 'Delete') + '</button>' +
          '</div></td></tr>';
      }).join('');

      host.innerHTML =
        '<table class="p-table"><thead><tr>' +
        '<th>' + T('المشروع / الجهة', 'Project / authority') + '</th>' +
        '<th class="c">' + T('الحالة', 'Status') + '</th>' +
        '<th class="c">' + T('الملفات', 'Files') + '</th>' +
        '<th class="c">' + T('الحجم', 'Size') + '</th>' +
        '<th>' + T('آخر تحديث', 'Last update') + '</th>' +
        '<th>' + T('إجراءات', 'Actions') + '</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';

      host.querySelectorAll('[data-del]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-del');
          if (!confirm(T('حذف هذا العطاء وكل ملفاته؟ لا يمكن التراجع.', 'Delete this tender and all its files? This cannot be undone.'))) return;
          btn.disabled = true;
          API.deleteTender(id).then(function () {
            toast(T('تم حذف العطاء من الخادم', 'Tender deleted from the server'), 'ok');
            return refreshUsage().then(initDashboard);
          }).catch(function (e) { btn.disabled = false; toast(e.message, 'err'); });
        });
      });
    }).catch(function (e) {
      if (e && e.redirected) return;
      errorBox(host, e);
    });
  }

  /* ==========================================================
     الرفع
     ========================================================== */
  var staged = [];

  function initUpload() {
    var drop = document.getElementById('drop');
    if (!drop) return;

    var params = new URLSearchParams(location.search);
    var preTender = params.get('t');

    API.listTenders().then(function (data) {
      var sel = document.getElementById('tenderSel');
      if (sel) {
        sel.innerHTML = '<option value="__new">' + T('➕ عطاء جديد', '➕ New tender') + '</option>' +
          data.tenders.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('');
        if (preTender && data.tenders.some(function (t) { return t.id === preTender; })) {
          sel.value = preTender;
          fillTender(preTender);
        }
        sel.addEventListener('change', function () {
          if (sel.value === '__new') clearTenderFields(); else fillTender(sel.value);
        });
      }
    }).catch(function (e) {
      if (e && e.redirected) return;
      toast(e.message, 'err');
    });

    var input = document.getElementById('fileInput');
    drop.addEventListener('click', function () { input.click(); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) stage(Array.prototype.slice.call(e.dataTransfer.files));
    });
    input.addEventListener('change', function () {
      stage(Array.prototype.slice.call(input.files));
      input.value = '';
    });

    var saveBtn = document.getElementById('saveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveAll);
  }

  function fillTender(id) {
    API.getTender(id).then(function (d) {
      setVal('fName', d.tender.name); setVal('fAuth', d.tender.authority);
      setVal('fClose', d.tender.closing); setVal('fNotes', d.tender.notes);
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  function clearTenderFields() { ['fName', 'fAuth', 'fClose', 'fNotes'].forEach(function (i) { setVal(i, ''); }); }

  function guessCat(name) {
    var n = String(name).toLowerCase();
    if (/\.(dwg|dxf)$/.test(n)) return 'arch';
    if (/(boq|كميات|quantity|pricing|price)/.test(n)) return 'boq';
    if (/(tender|كراسة|شروط|spec|itt|rfp)/.test(n)) return 'tender';
    if (/(mep|elec|mech|plumb|hvac|كهرب|ميكان|صحي|تكييف)/.test(n)) return 'mep';
    if (/(struct|إنشائ|انشائ|foundation|column|beam|slab)/.test(n)) return 'struct';
    if (/(arch|معمار|plan|elevation|section|facade)/.test(n)) return 'arch';
    return 'other';
  }

  function stage(files) {
    var list = document.getElementById('fileList');
    if (!list) return;
    files.forEach(function (f) {
      var item = { uid: 'u' + Date.now() + Math.random().toString(36).slice(2, 7), file: f, cat: guessCat(f.name) };
      staged.push(item);

      var row = document.createElement('div');
      row.className = 'frow';
      row.innerHTML =
        '<div class="top"><span class="fname">' + esc(f.name) + '</span>' +
        '<span class="fsize">' + fmtBytes(f.size) + '</span>' +
        '<button class="btn sm danger" data-rm="' + item.uid + '">' + T('إزالة', 'Remove') + '</button></div>' +
        '<div class="meta"><label class="small">' + T('التصنيف', 'Category') + '</label>' +
        '<select data-cat="' + item.uid + '">' +
        Object.keys(CATS).map(function (k) {
          return '<option value="' + k + '"' + (k === item.cat ? ' selected' : '') + '>' + T(CATS[k].ar, CATS[k].en) + '</option>';
        }).join('') + '</select></div>' +
        '<div class="pbar"><i></i></div><div class="pct">0%</div>';

      list.appendChild(row);
      row.querySelector('[data-rm]').addEventListener('click', function () {
        staged = staged.filter(function (s) { return s.uid !== item.uid; });
        row.remove(); updateSaveState();
      });
      row.querySelector('[data-cat]').addEventListener('change', function () { item.cat = this.value; });
      item.row = row;
    });
    updateSaveState();
  }

  function updateSaveState() {
    var b = document.getElementById('saveBtn');
    if (!b) return;
    var n = staged.length;
    b.disabled = n === 0;
    b.textContent = n ? T('حفظ ' + n + ' ملف', 'Save ' + n + ' file' + (n > 1 ? 's' : '')) : T('حفظ الملفات', 'Save files');
  }

  function saveAll() {
    var name = getVal('fName');
    if (!name) { toast(T('أدخل اسم المشروع أولاً', 'Enter the project name first'), 'err'); return; }
    if (!staged.length) { toast(T('لا توجد ملفات مرفوعة', 'No files staged'), 'err'); return; }

    var sel = document.getElementById('tenderSel');
    var existing = sel && sel.value !== '__new' ? sel.value : null;
    var btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = T('جارٍ الحفظ…', 'Saving…');

    var payload = {
      name: name, authority: getVal('fAuth') || null,
      closing: getVal('fClose') || null, notes: getVal('fNotes') || null
    };

    var tenderPromise = existing ? API.updateTender(existing, payload) : API.createTender(payload);

    tenderPromise.then(function (res) {
      var tid = res.tender.id;

      // ملف واحد لكل طلب → تقدّم دقيق لكل ملف
      var chain = Promise.resolve();
      staged.forEach(function (s) {
        chain = chain.then(function () {
          return API.upload(tid, [s.file], [s.cat], function (p) {
            var bar = s.row.querySelector('.pbar > i');
            var pct = s.row.querySelector('.pct');
            if (bar) bar.style.width = p + '%';
            if (pct) pct.textContent = p + '%';
          }).then(function () {
            var barEl = s.row.querySelector('.pbar');
            var pctEl = s.row.querySelector('.pct');
            s.row.classList.add('done');
            if (barEl) barEl.style.display = 'none';
            if (pctEl) pctEl.textContent = T('محفوظ على الخادم', 'Saved to server');
          });
        });
      });

      return chain.then(function () {
        toast(T('تم حفظ العطاء ورفع الملفات إلى الخادم', 'Tender saved and files uploaded to the server'), 'ok');
        setTimeout(function () { location.href = 'outputs.html?t=' + encodeURIComponent(tid); }, 700);
      });
    }).catch(function (e) {
      btn.disabled = false;
      updateSaveState();
      if (e.code === 'PLAN_LIMIT') {
        toast(T('وصلت لحد الباقة — رقِّ الباقة للمتابعة.', 'Plan limit reached — upgrade to continue.'), 'err');
      } else {
        toast(e.message || T('تعذّر الحفظ', 'Save failed'), 'err');
      }
    });
  }

  /* ==========================================================
     المخرجات
     ========================================================== */
  function initOutputs() {
    var host = document.getElementById('outBody');
    if (!host) return;
    loading(host);

    var params = new URLSearchParams(location.search);
    var tid = params.get('t');

    API.listTenders().then(function (data) {
      var tenders = data.tenders || [];
      if (!tenders.length) {
        host.innerHTML = emptyBox('📄', T('لا توجد عطاءات', 'No tenders'),
          T('ارفع عطاءً أولاً لتظهر مخرجاته هنا.', 'Upload a tender first.'),
          'upload.html', T('رفع عطاء', 'Upload a tender'));
        var sel0 = document.getElementById('outSel');
        if (sel0) sel0.innerHTML = '';
        return;
      }
      var sel = document.getElementById('outSel');
      if (sel) {
        sel.innerHTML = tenders.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('');
        if (tid && tenders.some(function (t) { return t.id === tid; })) sel.value = tid;
        else tid = tenders[0].id;
        sel.value = tid;
        sel.addEventListener('change', function () { location.href = 'outputs.html?t=' + encodeURIComponent(sel.value); });
      }
      return renderOutputs(tid);
    }).catch(function (e) {
      if (e && e.redirected) return;
      errorBox(host, e);
    });
  }

  function renderOutputs(tid) {
    var host = document.getElementById('outBody');
    loading(host);
    return API.getTender(tid).then(function (d) {
      var t = d.tender, files = d.files || [];
      var s = STATUS[t.status] || STATUS.new;

      var byCat = {};
      files.forEach(function (f) { byCat[f.category] = (byCat[f.category] || 0) + 1; });

      var head =
        '<div class="p-card"><h2>' + esc(t.name) + ' <span class="badge ' + s.cls + '">' + T(s.ar, s.en) + '</span></h2>' +
        '<p class="sub">' + esc(t.authority || '—') +
        (t.closing ? ' · ' + T('إغلاق', 'Closing') + ': ' + esc(t.closing) : '') +
        ' · ' + T('آخر تحديث', 'Updated') + ': ' + fmtDate(t.updatedAt) + '</p>' +
        (Object.keys(byCat).length ? '<div class="pill-row">' + Object.keys(CATS).filter(function (k) { return byCat[k]; }).map(function (k) {
          return '<span class="pill on">' + T(CATS[k].ar, CATS[k].en) + ' · ' + byCat[k] + '</span>';
        }).join('') + '</div>' : '') + '</div>';

      var q = '?p=' + encodeURIComponent(t.name) + '&a=' + encodeURIComponent(t.authority || '');
      var outs =
        '<div class="p-card"><h2><span class="n">01</span> ' + T('المخرجات', 'Outputs') + '</h2>' +
        '<p class="sub">' + T('تُبنى المخرجات من بيانات العطاء وملفاته. افتح النموذج ليُعبّأ مسبقاً.', 'Outputs are built from the tender data and its files. Open a form to have it pre-filled.') + '</p>' +
        '<div class="outs">' +
        outCard('TP-01…13', T('العرض الفني الكامل', 'Full technical proposal'),
          T('النماذج الثلاثة عشر معبّأة ببيانات المشروع والجهة.', 'The thirteen forms pre-filled with project and authority data.'),
          '../../en/index.html' + q, T('فتح النماذج', 'Open forms')) +
        outCard('TP-09', T('الجدول السعري BOQ', 'BOQ price schedule'),
          T('الكميات مربوطة بالأسعار مع المصاريف والأرباح.', 'Quantities linked to rates with overhead and profit.'),
          '../../en/09-boq.html' + q, T('فتح الجدول', 'Open schedule')) +
        outCard('TP-14', T('حساب الكميات', 'Quantity take-off'),
          T('جدول تفاعلي يحسب الصافي والهالك والإجمالي.', 'Interactive sheet computing net, waste and total.'),
          '../../en/12-takeoff.html' + q, T('فتح الحساب', 'Open take-off')) +
        outCard('XLSX', T('ملف Excel', 'Excel workbook'),
          T('سبع أوراق مترابطة بصيغ حقيقية.', 'Seven linked sheets with live formulas.'),
          '../../../../documents/technical-proposal-kit_v5/quantity-takeoff-en.xlsx', T('تحميل Excel', 'Download Excel')) +
        outCard('PDF', T('ملف PDF مجمّع', 'Consolidated PDF'),
          T('الحزمة كاملة جاهزة للطباعة والتقديم.', 'The whole kit, print-ready.'),
          '../../../../documents/technical-proposal-kit_v5/technical-proposal-kit-en.pdf', T('تحميل PDF', 'Download PDF')) +
        '</div></div>';

      var fl =
        '<div class="p-card"><h2><span class="n">02</span> ' + T('الملفات المرفوعة', 'Uploaded files') + '</h2>' +
        (files.length
          ? '<table class="p-table"><thead><tr><th>' + T('الملف', 'File') + '</th><th class="c">' + T('التصنيف', 'Category') +
            '</th><th class="c">' + T('الحجم', 'Size') + '</th><th>' + T('تاريخ الرفع', 'Uploaded') + '</th><th class="c">' +
            T('إجراء', 'Action') + '</th></tr></thead><tbody>' +
            files.map(function (f) {
              var c = CATS[f.category] || CATS.other;
              return '<tr><td style="font-weight:700;word-break:break-all">' + esc(f.name) + '</td>' +
                '<td class="c"><span class="badge ' + c.cls + '">' + T(c.ar, c.en) + '</span></td>' +
                '<td class="n">' + fmtBytes(f.size) + '</td>' +
                '<td class="small">' + fmtDate(f.uploadedAt) + '</td>' +
                '<td class="c"><a class="btn sm light" href="' + API.downloadUrl(f.id) + '" target="_blank" rel="noopener">' +
                T('تحميل', 'Download') + '</a> ' +
                '<button class="btn sm danger" data-delf="' + esc(f.id) + '">' + T('حذف', 'Delete') + '</button></td></tr>';
            }).join('') + '</tbody></table>'
          : emptyBox('📂', T('لا ملفات', 'No files'),
            T('ارفع المخططات والوثائق لهذا العطاء.', 'Upload drawings and documents for this tender.'),
            'upload.html?t=' + encodeURIComponent(tid), T('رفع ملفات', 'Upload files'))) +
        '</div>';

      host.innerHTML = head + outs + fl;

      host.querySelectorAll('[data-delf]').forEach(function (b) {
        b.addEventListener('click', function () {
          var id = b.getAttribute('data-delf');
          if (!confirm(T('حذف هذا الملف من الخادم؟', 'Delete this file from the server?'))) return;
          b.disabled = true;
          API.deleteFile(id).then(function () {
            toast(T('تم حذف الملف', 'File deleted'), 'ok');
            return renderOutputs(tid);
          }).catch(function (e) { b.disabled = false; toast(e.message, 'err'); });
        });
      });
    }).catch(function (e) { errorBox(host, e); });
  }

  function outCard(k, title, desc, href, cta) {
    return '<div class="out"><div class="k">' + k + '</div><b>' + title + '</b><p>' + desc + '</p>' +
      '<a class="btn teal" href="' + href + '" target="_blank" rel="noopener">' + cta + ' ↗</a></div>';
  }

  /* ==========================================================
     الطلبات
     ========================================================== */
  function initRequests() {
    var host = document.getElementById('reqBody');
    if (!host) return;
    var params = new URLSearchParams(location.search);
    var tid = params.get('t');
    var listHost = document.getElementById('reqList');

    API.listTenders().then(function (data) {
      var tenders = data.tenders || [];
      var sel = document.getElementById('reqSel');
      if (sel) {
        sel.innerHTML = tenders.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('');
        if (tenders.length) {
          if (tid && tenders.some(function (t) { return t.id === tid; })) sel.value = tid;
          else tid = tenders[0].id;
          sel.value = tid;
          sel.addEventListener('change', function () { location.href = 'requests.html?t=' + encodeURIComponent(sel.value); });
        }
      }

      if (!tenders.length) {
        if (listHost) {
          listHost.innerHTML = emptyBox('💬', T('لا توجد عطاءات', 'No tenders'),
            T('ارفع عطاءً أولاً لتتمكن من إرسال طلب عليه.', 'Upload a tender first.'),
            'upload.html', T('رفع عطاء', 'Upload a tender'));
        }
        var form0 = document.getElementById('reqForm');
        if (form0) form0.style.display = 'none';
        return;
      }

      renderRequests(tid);

      var form = document.getElementById('reqForm');
      if (form && !form._bound) {
        form._bound = true;
        form.addEventListener('submit', function (e) {
          e.preventDefault();
          var txt = getVal('reqText');
          if (!txt) { toast(T('اكتب نص الطلب', 'Enter your request'), 'err'); return; }
          var btn = form.querySelector('button[type="submit"]');
          if (btn) { btn.disabled = true; btn.textContent = T('جارٍ الإرسال…', 'Sending…'); }
          API.createRequest(tid, { text: txt, kind: getVal('reqKind') || 'note' })
            .then(function () {
              setVal('reqText', '');
              toast(T('تم إرسال الطلب إلى الخادم', 'Request sent to the server'), 'ok');
              renderRequests(tid);
            })
            .catch(function (e2) { toast(e2.message, 'err'); })
            .then(function () {
              if (btn) { btn.disabled = false; btn.textContent = T('إرسال الطلب', 'Send request'); }
            });
        });
      }
    }).catch(function (e) {
      if (e && e.redirected) return;
      if (listHost) errorBox(listHost, e);
    });
  }

  function renderRequests(tid) {
    var host = document.getElementById('reqList');
    if (!host) return;
    loading(host);
    API.listRequests(tid).then(function (d) {
      var rs = d.requests || [];
      if (!rs.length) {
        host.innerHTML = emptyBox('💬', T('لا توجد طلبات', 'No requests yet'),
          T('أرسل ملاحظة أو طلب تعديل على هذا العطاء.', 'Send a note or a change request for this tender.'));
        return;
      }
      var kinds = { note: T('ملاحظة', 'Note'), change: T('طلب تعديل', 'Change request'), question: T('استفسار', 'Question') };
      host.innerHTML = rs.map(function (r) {
        return '<div class="frow"><div class="top"><span class="badge proc">' + (kinds[r.kind] || kinds.note) + '</span>' +
          '<span class="fsize">' + fmtDate(r.createdAt) + '</span>' +
          '<button class="btn sm danger" data-delr="' + esc(r.id) + '">' + T('حذف', 'Delete') + '</button></div>' +
          '<p style="margin:8px 0 0;font-size:13px">' + esc(r.text) + '</p></div>';
      }).join('');
      host.querySelectorAll('[data-delr]').forEach(function (b) {
        b.addEventListener('click', function () {
          API.deleteRequest(b.getAttribute('data-delr'))
            .then(function () { renderRequests(tid); })
            .catch(function (e) { toast(e.message, 'err'); });
        });
      });
    }).catch(function (e) { errorBox(host, e); });
  }

  /* ==========================================================
     ترقية الباقة
     ========================================================== */
  function initUpgrade() {
    var host = document.getElementById('tierBody');
    if (!host) return;
    loading(host, T('تحميل الباقات…', 'Loading plans…'));

    Promise.all([API.listPlans(), API.usage()]).then(function (r) {
      var plans = r[0].plans, u = r[1];
      var cur = u.plan.key;

      host.innerHTML = plans.map(function (p) {
        var isCur = p.key === cur;
        var feat = p.key === 'pro';
        return '<div class="tier' + (isCur ? ' cur' : feat ? ' feat' : '') + '">' +
          (isCur ? '<span class="rib cur">' + T('باقتك الحالية', 'Your plan') + '</span>'
                 : feat ? '<span class="rib">' + T('الأكثر اختياراً', 'Most popular') + '</span>' : '') +
          '<h3>' + T(p.nameAr, p.nameEn) + '</h3>' +
          '<p class="for">' + planFor(p.key) + '</p>' +
          '<div class="amt">' + (p.priceMonth ? '<sup>$</sup>' + p.priceMonth : T('مجاناً', 'Free')) + '</div>' +
          '<div class="per">' + (p.priceMonth ? T('شهرياً · $' + p.priceYear + ' سنوياً', 'per month · $' + p.priceYear + '/yr') : T('بدون بطاقة', 'no card required')) + '</div>' +
          '<ul>' + planFeats(p) + '</ul>' +
          (isCur ? '<button class="btn light" disabled>' + T('مُفعّلة', 'Active') + '</button>'
                 : '<button class="btn ' + (feat ? 'amber' : 'teal') + '" data-pick="' + esc(p.key) + '">' +
                   T('تفعيل ' + p.nameEn, 'Activate ' + p.nameEn) + '</button>') +
          '</div>';
      }).join('');

      host.querySelectorAll('[data-pick]').forEach(function (b) {
        b.addEventListener('click', function () {
          var key = b.getAttribute('data-pick');
          if (key !== 'free') {
            location.href = 'billing.html?plan=' + encodeURIComponent(key);
            return;
          }
          if (!confirm(T('الرجوع إلى الباقة المجانية؟ ستُطبَّق حدودها على العطاءات والملفات الحالية.',
                         'Switch back to the free plan? Its tender and file limits will apply.'))) return;
          b.disabled = true;
          API.changePlan(key).then(function (res) {
            toast(res.message || T('تم تفعيل الباقة', 'Plan activated'), 'ok');
            return guard().then(function () { initUpgrade(); });
          }).catch(function (e) { b.disabled = false; toast(e.message, 'err'); });
        });
      });

      var ub = document.getElementById('upUsage');
      if (ub) {
        ub.innerHTML =
          usageBar(T('العطاءات المستهلكة', 'Tenders used'), u.usage.tenders, u.usage.tendersMax, u.usage.tendersPct) +
          usageBar(T('مساحة الرفع المستهلكة', 'Upload space used'), fmtBytes(u.usage.bytes),
            u.usage.bytesMax === null ? null : fmtBytes(u.usage.bytesMax), u.usage.bytesPct);
      }
    }).catch(function (e) {
      if (e && e.redirected) return;
      errorBox(host, e);
    });
  }

  function planFor(k) {
    return {
      free: T('لتجربة الحزمة على عطاء واحد', 'Try the kit on a single tender'),
      starter: T('لمقاول فردي أو مكتب صغير', 'Solo contractor or small office'),
      pro: T('لمكتب مقاولات بعدة مشاريع', 'Contracting office, several projects'),
      ent: T('لشركة بعدة فروع ومستخدمين', 'Multi-branch firm, many users')
    }[k] || '';
  }

  function planFeats(p) {
    var rows = [
      [T('عدد العطاءات', 'Active tenders'), p.maxTenders === null ? T('غير محدود', 'Unlimited') : p.maxTenders],
      [T('مساحة الرفع', 'Upload space'), p.maxBytes === null ? T('غير محدود', 'Unlimited') : fmtBytes(p.maxBytes)],
      [T('النماذج الثلاثة عشر', 'Thirteen forms'), '✓'],
      [T('حساب الكميات التفاعلي', 'Interactive take-off'), '✓'],
      [T('ملف Excel', 'Excel workbook'), p.key === 'free' ? null : '✓'],
      [T('النسخة العربية', 'Arabic edition'), p.key === 'free' ? null : '✓'],
      [T('العلامة التجارية الخاصة', 'Your own branding'), (p.key === 'pro' || p.key === 'ent') ? '✓' : null],
      [T('دعم فني', 'Support'), (p.key === 'pro' || p.key === 'ent') ? '✓' : null]
    ];
    return rows.map(function (r) {
      var off = r[1] === null;
      return '<li' + (off ? ' class="off"' : '') + '>' + r[0] + (off ? '' : ' — ' + r[1]) + '</li>';
    }).join('');
  }

  /* ==========================================================
     التشغيل
     ========================================================== */
  function refreshUsage() {
    return API.usage().then(function (d) {
      state.plan = d.plan; state.usage = d.usage; paintUser();
    }).catch(function () {});
  }

  var page = document.body.getAttribute('data-page');

  function rerender() {
    paintUser();
    if (page === 'dashboard') initDashboard();
    if (page === 'upload') initUpload();
    if (page === 'outputs') initOutputs();
    if (page === 'requests') initRequests();
    if (page === 'upgrade') initUpgrade();
  }

  function boot() {
    applyLang();

    document.querySelectorAll('[data-lang-btn]').forEach(function (b) {
      b.addEventListener('click', function () { setLang(b.getAttribute('data-lang-btn')); });
    });
    document.querySelectorAll('[data-print]').forEach(function (b) {
      b.addEventListener('click', function () { window.print(); });
    });
    document.querySelectorAll('[data-logout]').forEach(function (b) {
      b.addEventListener('click', doLogout);
    });

    guard().then(function () {
      paintUser();
      rerender();
    }).catch(function (e) {
      if (e && e.redirected) return;
      toast(e && e.message ? e.message : T('تعذّر تحميل الجلسة', 'Could not load session'), 'err');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.Portal = { state: state, T: T, lang: lang, setLang: setLang, toast: toast, refresh: rerender, logout: doLogout };
})();
