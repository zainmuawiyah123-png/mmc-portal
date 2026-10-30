/* ============================================================
   API Client — بوابة العروض الفنية (المرحلة الأولى)
   كل الطلبات تذهب إلى الخادم مع الكوكي (credentials: 'include').
   ============================================================ */
(function () {
  'use strict';

  var BASE = (window.PORTAL_API_BASE === undefined ? '' : window.PORTAL_API_BASE) + '/api';

  function buildQuery(params) {
    if (!params) return '';
    var q = Object.keys(params)
      .filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); })
      .join('&');
    return q ? '?' + q : '';
  }

  /**
   * طلب JSON. يرمي خطأً يحتوي status و code و message (بالعربية من الخادم).
   */
  function request(method, path, body, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json' };
    var init = { method: method, credentials: 'include', headers: headers };

    if (body !== undefined && body !== null) {
      if (body instanceof FormData) {
        init.body = body;                    // المتصفح يضبط Content-Type بنفسه
      } else {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
    }

    return fetch(BASE + path + buildQuery(opts.query), init).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') !== -1 ? res.json() : res.text();
      return parse.then(function (data) {
        if (res.ok) return data;
        var err = new Error((data && data.error && data.error.message) || ('خطأ ' + res.status));
        err.status = res.status;
        err.code = data && data.error ? data.error.code : 'HTTP_' + res.status;
        err.details = data && data.error ? data.error.details : null;
        err.payload = data;
        throw err;
      });
    }, function (netErr) {
      var err = new Error('تعذّر الاتصال بالخادم. تأكد أن الخادم يعمل ثم أعد المحاولة.');
      err.status = 0;
      err.code = 'NETWORK';
      err.cause = netErr;
      throw err;
    });
  }

  /**
   * رفع ملفات مع شريط تقدّم حقيقي — XHR لأن fetch لا يعطي تقدم الرفع.
   * onProgress(percent 0..100)
   */
  function upload(tenderId, files, categories, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData();
      for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
      if (categories && categories.length) fd.append('categories', JSON.stringify(categories));

      var xhr = new XMLHttpRequest();
      xhr.open('POST', BASE + '/tenders/' + encodeURIComponent(tenderId) + '/files', true);
      xhr.withCredentials = true;

      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = function () {
        var data;
        try { data = JSON.parse(xhr.responseText); } catch (_) { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300) {
          if (onProgress) onProgress(100);
          resolve(data);
        } else {
          var err = new Error((data.error && data.error.message) || ('فشل الرفع (HTTP ' + xhr.status + ')'));
          err.status = xhr.status;
          err.code = data.error ? data.error.code : 'HTTP_' + xhr.status;
          err.details = data.error ? data.error.details : null;
          reject(err);
        }
      };
      xhr.onerror = function () {
        var err = new Error('انقطع الاتصال أثناء الرفع. تحقق من الشبكة وأعد المحاولة.');
        err.status = 0; err.code = 'NETWORK';
        reject(err);
      };
      xhr.send(fd);
    });
  }

  window.API = {
    base: BASE,
    request: request,
    upload: upload,

    /* ---- auth ---- */
    register: function (body) { return request('POST', '/auth/register', body); },
    login: function (body) { return request('POST', '/auth/login', body); },
    logout: function () { return request('POST', '/auth/logout'); },
    me: function () { return request('GET', '/auth/me'); },
    updateMe: function (body) { return request('PATCH', '/auth/me', body); },

    /* ---- tenders ---- */
    listTenders: function () { return request('GET', '/tenders'); },
    getTender: function (id) { return request('GET', '/tenders/' + encodeURIComponent(id)); },
    createTender: function (body) { return request('POST', '/tenders', body); },
    updateTender: function (id, body) { return request('PATCH', '/tenders/' + encodeURIComponent(id), body); },
    deleteTender: function (id) { return request('DELETE', '/tenders/' + encodeURIComponent(id)); },

    /* ---- files ---- */
    listFiles: function (tenderId) { return request('GET', '/tenders/' + encodeURIComponent(tenderId) + '/files'); },
    deleteFile: function (fileId) { return request('DELETE', '/files/' + encodeURIComponent(fileId)); },
    downloadUrl: function (fileId) { return BASE + '/files/' + encodeURIComponent(fileId) + '/download'; },

    /* ---- requests ---- */
    listRequests: function (tenderId) { return request('GET', '/tenders/' + encodeURIComponent(tenderId) + '/requests'); },
    createRequest: function (tenderId, body) { return request('POST', '/tenders/' + encodeURIComponent(tenderId) + '/requests', body); },
    deleteRequest: function (id) { return request('DELETE', '/requests/' + encodeURIComponent(id)); },

    /* ---- plan ---- */
    listPlans: function () { return request('GET', '/plans'); },
    usage: function () { return request('GET', '/usage'); },
    changePlan: function (planKey) { return request('POST', '/plan', { planKey: planKey }); },

    /* ---- billing / invoices ---- */
    createInvoice: function (body) { return request('POST', '/billing/invoices', body); },
    listInvoices: function () { return request('GET', '/billing/invoices'); },
    getInvoice: function (id) { return request('GET', '/billing/invoices/' + encodeURIComponent(id)); },
    uploadReceipt: function (id, file) {
      var fd = new FormData();
      fd.append('receipt', file);
      return request('POST', '/billing/invoices/' + encodeURIComponent(id) + '/receipt', fd);
    }
  };
})();
