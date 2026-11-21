/* MMC AI — standalone demo backend (v2, with boq-imports + image-aware).
 *
 * Intercepts every fetch('/api/mmc-ai/...') call made by index.html and
 * routes it to an in-browser implementation backed by localStorage + the
 * pure-JS engines from mmc-ai-bundle.js. No Node.js, no SQLite, no server.
 *
 * v2 changes:
 *   - Added /boq-imports endpoint (CSV parser, localStorage store)
 *   - Added GET /boq to list imported BOQ items
 *   - Cleaner error messages in Arabic + English
 */
(function() {
  'use strict';
  if (!window.MmcAi) {
    console.error('[mmc-ai-demo] mmc-ai-bundle.js must load before mmc-ai-demo-backend.js');
    return;
  }
  const M = window.MmcAi;

  const STORAGE_KEY = 'mmc-ai-demo-v2';
  const uid = (prefix) => prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const nowISO = () => new Date().toISOString();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { projects: {}, documents: {}, runs: {}, items: {}, boqItems: {}, currentUser: { id: 'demo_user', name: 'Demo Engineer', role: 'owner' } };
      const s = JSON.parse(raw);
      s.projects = s.projects || {};
      s.documents = s.documents || {};
      s.runs = s.runs || {};
      s.items = s.items || {};
      s.boqItems = s.boqItems || {};
      s.currentUser = s.currentUser || { id: 'demo_user', name: 'Demo Engineer', role: 'owner' };
      return s;
    } catch (e) {
      console.warn('[mmc-ai-demo] state reset:', e.message);
      return { projects: {}, documents: {}, runs: {}, items: {}, boqItems: {}, currentUser: { id: 'demo_user', name: 'Demo Engineer', role: 'owner' } };
    }
  }
  function saveState(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    catch (e) { console.error('[mmc-ai-demo] save failed:', e.message); }
  }

  let state = loadState();
  const fileContentStore = new Map();

  function jsonResponse(obj, status) {
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  }
  function errorResponse(message, code, status) {
    return jsonResponse({ error: { code: code || 'DEMO_ERROR', message }, message }, status || 400);
  }

  const routes = [];
  function addRoute(method, pattern, handler) {
    const paramNames = [];
    const regexStr = '^' + pattern.replace(/:[^/]+/g, (m) => {
      paramNames.push(m.slice(1));
      return '([^/]+)';
    }) + '$';
    routes.push({ method, regex: new RegExp(regexStr), paramNames, handler });
  }
  function matchRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.paramNames.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  }

  // ── Auth ─────────────────────────────────────────────────────────────
  addRoute('GET',  '/api/mmc-ai/me', async () => jsonResponse({ user: state.currentUser }));

  // ── Projects ─────────────────────────────────────────────────────────
  addRoute('GET',  '/api/mmc-ai/projects', async () => {
    const list = Object.values(state.projects).map(p => ({ ...p, summary: projectSummary(p.id) }));
    return jsonResponse({ projects: list });
  });

  addRoute('POST', '/api/mmc-ai/projects', async (req, body) => {
    if (!body.name || body.name.trim().length < 3) return errorResponse('Project name too short. / اسم المشروع قصير جداً.', 'VALIDATION', 400);
    const id = uid('aip');
    const project = {
      id, project_id: id,
      name: body.name.trim(),
      description: body.description || 'مشروع تجريبي — البيانات محفوظة محلياً في المتصفح فقط (وضع demo).',
      country: body.country || 'JO',
      currency: body.currency || 'JOD',
      created_by: state.currentUser.id,
      created_at: nowISO(),
      status: 'active'
    };
    state.projects[id] = project;
    state.projects[id].members = [{ user_id: state.currentUser.id, role: 'owner' }];
    saveState(state);
    return jsonResponse({ project }, 201);
  });

  addRoute('GET',  '/api/mmc-ai/projects/:projectId', async (req) => {
    const p = state.projects[req.params.projectId];
    if (!p) return errorResponse('Project not found. / المشروع غير موجود.', 'NOT_FOUND', 404);
    return jsonResponse({ project: { ...p, summary: projectSummary(p.id) } });
  });

  function projectSummary(pid) {
    const docs = Object.values(state.documents).filter(d => d.project_id === pid);
    const runs = Object.values(state.runs).filter(r => r.project_id === pid);
    const boq = (state.boqItems[pid] || []);
    return {
      boqItems: boq.length,
      estimatedCost: boq.reduce((s, x) => s + (Number(x.quantity) || 0) * (Number(x.rate) || 0), 0),
      projectDurationWorkingDays: 0, criticalTasks: 0, averageTaskProgress: 0,
      completedTasks: 0, blockedTasks: 0, inProgressTasks: 0, criticalRisks: 0,
      bimModels: 0, bimIssues: 0, criticalBimIssues: 0,
      contractEvents: 0, documents: docs.length, sitePhotos: 0,
      takeoffRuns: runs.length
    };
  }

  // ── Documents ────────────────────────────────────────────────────────
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/documents', async (req) => {
    const docs = Object.values(state.documents)
      .filter(d => d.project_id === req.params.projectId)
      .map(d => ({ ...d, detail_json: undefined }));
    return jsonResponse({ documents: docs });
  });

  addRoute('POST', '/api/mmc-ai/projects/:projectId/documents', async (req, body, formData) => {
    const pid = req.params.projectId;
    if (!state.projects[pid]) return errorResponse('Project not found. / المشروع غير موجود.', 'NOT_FOUND', 404);
    const file = formData.get('file');
    if (!file) return errorResponse('No file in upload. / لا يوجد ملف.', 'VALIDATION', 400);
    const name = file.name || 'unknown.dxf';
    const ext = (name.toLowerCase().match(/\.[^.]+$/) || ['.dxf'])[0];
    const content = await file.text();
    const bytes = new TextEncoder().encode(content).length;
    const id = uid('aidoc');
    const doc = {
      id, project_id: pid,
      original_name: name, file_name: name, file_ext: ext,
      size_bytes: bytes, sha256: 'demo_' + id,
      storage_key: 'inmemory:' + id,
      discipline: formData.get('discipline') || 'unclassified',
      sheet_number: formData.get('sheetNumber') || '',
      revision: formData.get('revision') || '',
      drawing_title: formData.get('drawingTitle') || '',
      uploaded_by: state.currentUser.id,
      created_at: nowISO()
    };
    state.documents[id] = doc;
    fileContentStore.set(id, content);
    saveState(state);
    return jsonResponse({ document: doc, automaticAnalysis: null }, 201);
  });

  addRoute('GET',  '/api/mmc-ai/projects/:projectId/documents/:documentId/download', async (req) => {
    const doc = state.documents[req.params.documentId];
    if (!doc) return errorResponse('Document not found. / المستند غير موجود.', 'NOT_FOUND', 404);
    const content = fileContentStore.get(doc.id) || '';
    return new Response(content, { status: 200, headers: { 'Content-Type': 'application/dxf', 'Content-Disposition': 'attachment; filename="' + doc.original_name + '"' } });
  });

  // ── DXF takeoff ──────────────────────────────────────────────────────
  addRoute('POST', '/api/mmc-ai/projects/:projectId/documents/:documentId/takeoff/dxf', async (req, body) => {
    const doc = state.documents[req.params.documentId];
    if (!doc) return errorResponse('Document not found. / المستند غير موجود.', 'NOT_FOUND', 404);
    if (doc.file_ext !== '.dxf') return errorResponse('DXF takeoff only supports .dxf files. / الحصر يدعم DXF فقط.', 'VALIDATION', 400);
    const content = fileContentStore.get(doc.id);
    if (!content) return errorResponse('File content lost (page reloaded). Re-upload the DXF. / محتوى الملف مفقود، أعد رفع DXF.', 'GONE', 410);

    let result;
    try {
      const layerMap = (body && typeof body.layerMap === 'object' && body.layerMap) ? body.layerMap : {};
      result = M.takeoffDxf(content, { layerMap });
    } catch (err) {
      return errorResponse(err.message || 'DXF parsing failed. / فشل تحليل DXF.', 'DXF_ERROR', 400);
    }

    const runId = uid('aitake');
    const run = {
      id: runId, project_id: doc.project_id, document_id: doc.id,
      created_by: state.currentUser.id,
      engine: result.engine, status: 'needs_review',
      units: result.units,
      summary: { ...result.summary, sourceSha256: 'demo_' + doc.id, byDiscipline: result.byDiscipline || [] },
      unsupported: result.unsupported,
      limitations: result.limitations,
      created_at: nowISO()
    };
    const items = result.rows.map((row) => ({
      id: uid('aitem'), run_id: runId,
      entity_index: row.entityIndex, entity_type: row.entity,
      layer_name: row.layer || '0',
      quantity: row.quantity, unit: row.unit,
      detail: row,
      review_status: 'needs_review'
    }));
    state.runs[runId] = run;
    items.forEach(it => { state.items[it.id] = it; });
    saveState(state);

    return jsonResponse({
      run: {
        id: run.id, project_id: run.project_id, document_id: run.document_id,
        engine: run.engine, status: run.status, units: run.units,
        summary: run.summary, byDiscipline: result.byDiscipline || [],
        unsupported: run.unsupported, limitations: run.limitations,
        items: items.map(it => ({ ...it, detail_json: undefined, detail: it.detail }))
      }
    }, 201);
  });

  // ── Takeoff runs ─────────────────────────────────────────────────────
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/takeoff/runs', async (req) => {
    const runs = Object.values(state.runs)
      .filter(r => r.project_id === req.params.projectId)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    return jsonResponse({ runs });
  });

  addRoute('GET',  '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId', async (req) => {
    const run = state.runs[req.params.runId];
    if (!run) return errorResponse('Run not found. / نتيجة الحصر غير موجودة.', 'NOT_FOUND', 404);
    const items = Object.values(state.items).filter(it => it.run_id === run.id).sort((a, b) => a.entity_index - b.entity_index);
    return jsonResponse({
      run: { ...run, items: undefined },
      items: items.map(it => ({ ...it, detail_json: undefined, detail: it.detail }))
    });
  });

  addRoute('GET',  '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/layers', async (req) => {
    const run = state.runs[req.params.runId];
    if (!run) return errorResponse('Run not found. / نتيجة الحصر غير موجودة.', 'NOT_FOUND', 404);
    const items = Object.values(state.items).filter(it => it.run_id === run.id);
    const byLayer = {};
    for (const it of items) {
      const l = it.layer_name || '0';
      if (!byLayer[l]) byLayer[l] = { name: l, entities: 0, length_m: 0, area_m2: 0, source: 'native', visible: true };
      byLayer[l].entities++;
      if (it.unit === 'm') byLayer[l].length_m += Number(it.quantity) || 0;
      if (it.detail && it.detail.area_m2) byLayer[l].area_m2 += Number(it.detail.area_m2) || 0;
    }
    return jsonResponse({
      runId: run.id,
      layers: Object.values(byLayer),
      assignments: [],
      notice: 'Demo mode — native DXF layers only. User layer management not enabled. / وضع تجريبي — الطبقات الأصلية فقط.'
    });
  });

  // ── Discipline classification ────────────────────────────────────────
  addRoute('POST', '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/disciplines', async (req, body) => {
    const run = state.runs[req.params.runId];
    if (!run) return errorResponse('Run not found. / نتيجة الحصر غير موجودة.', 'NOT_FOUND', 404);
    const items = Object.values(state.items).filter(it => it.run_id === run.id);
    const layerMap = (body && typeof body.layerMap === 'object' && body.layerMap) ? body.layerMap : {};
    const disciplines = M.summarizeByDiscipline(items.map(it => ({
      entity: it.entity_type, layer: it.layer_name,
      quantity: Number(it.quantity) || 0, unit: it.unit,
      detail: it.detail || {}
    })), layerMap);
    return jsonResponse({
      runId: run.id, disciplines,
      notice: 'أطوال CAD خام — ليست كميات صافية. تحتاج مراجعة مهندس وقاعدة قياس. (وضع demo)'
    });
  });

  // ── Quantity rules ───────────────────────────────────────────────────
  addRoute('GET',  '/api/mmc-ai/takeoff/quantity-rules', async () => {
    return jsonResponse({
      rules: M.listRules(),
      notice: 'Rules list required inputs per category. Quantities stay needs_review. (Demo mode)'
    });
  });

  addRoute('POST', '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/quantity-rules', async (req, body) => {
    const run = state.runs[req.params.runId];
    if (!run) return errorResponse('Run not found. / نتيجة الحصر غير موجودة.', 'NOT_FOUND', 404);
    const items = Object.values(state.items)
      .filter(it => it.run_id === run.id)
      .map(it => ({
        entity: it.entity_type, layer: it.layer_name,
        quantity: Number(it.quantity) || 0, unit: it.unit,
        detail: it.detail || {}
      }));
    const opts = {
      layerMap: (body && body.layerMap) || {},
      defaults: (body && body.defaults) || {},
      byCategory: (body && body.byCategory) || {},
      byDiscipline: (body && body.byDiscipline) || {}
    };
    const report = M.proposeDisciplineQuantities(items, opts);
    return jsonResponse({ runId: run.id, ...report });
  });

  // ── Review ───────────────────────────────────────────────────────────
  addRoute('PATCH', '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/review', async (req, body) => {
    const run = state.runs[req.params.runId];
    if (!run) return errorResponse('Run not found. / نتيجة الحصر غير موجودة.', 'NOT_FOUND', 404);
    if (!['approved', 'rejected'].includes(body && body.status)) return errorResponse('Status must be approved or rejected. / الحالة يجب أن تكون approved أو rejected.', 'VALIDATION', 400);
    run.status = body.status;
    Object.values(state.items).forEach(it => { if (it.run_id === run.id) it.review_status = body.status; });
    saveState(state);
    return jsonResponse({ ok: true, runId: run.id, status: body.status });
  });

  // ── BOQ import (NEW in v2) — CSV parser, localStorage store ──────────
  addRoute('POST', '/api/mmc-ai/projects/:projectId/boq-imports', async (req, body, formData) => {
    const pid = req.params.projectId;
    if (pid === 'null' || !pid || !state.projects[pid]) {
      return errorResponse('اختر مشروعاً أولاً قبل استيراد BOQ. / Select a project before importing a BOQ.', 'NO_PROJECT', 400);
    }
    if (!formData) return errorResponse('لم يُرفع أي ملف. / No file uploaded.', 'VALIDATION', 400);
    const file = formData.get('file');
    if (!file) return errorResponse('لم يُرفع أي ملف. / No file in upload.', 'VALIDATION', 400);
    const text = await file.text();
    // CSV parser: comma or semicolon, optional quoted fields, header row required
    const delim = text.includes(';') && !text.includes(',') ? ';' : ',';
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return errorResponse('الملف يجب أن يحوي صف عنوان + صفوف بيانات. / File must have a header row + at least one data row.', 'VALIDATION', 400);
    const parseLine = (line) => {
      const out = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
          if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
          else if (c === '"') q = false;
          else cur += c;
        } else {
          if (c === '"') q = true;
          else if (c === delim) { out.push(cur); cur = ''; }
          else cur += c;
        }
      }
      out.push(cur);
      return out.map(x => x.trim());
    };
    const headers = parseLine(lines[0]).map(h => h.toLowerCase());
    const findHeader = (names) => headers.findIndex(h => names.some(n => h.includes(n)));
    const iCode = findHeader(['رقم','code','بند']);
    const iDesc = findHeader(['بيان','description','item']);
    const iUnit = findHeader(['وحدة','unit']);
    const iQty  = findHeader(['كمية','quantity','qty']);
    const iRate = findHeader(['سعر','rate','price']);
    const items = [];
    let rejected = 0;
    for (let li = 1; li < lines.length; li++) {
      const cols = parseLine(lines[li]);
      if (!cols.length || cols.every(c => !c)) continue;
      const itemCode  = (iCode >= 0 && cols[iCode])  || ('B' + li);
      const desc      = (iDesc >= 0 && cols[iDesc])  || '';
      const unit      = (iUnit >= 0 && cols[iUnit])  || 'nr';
      const qty       = parseFloat((iQty >= 0 ? cols[iQty] : '0').toString().replace(/[^\d.\-]/g,'')) || 0;
      const rate      = parseFloat((iRate >= 0 ? cols[iRate] : '0').toString().replace(/[^\d.\-]/g,'')) || 0;
      if (!desc || qty <= 0) { rejected++; continue; }
      items.push({ id: uid('aiboq'), project_id: pid, item_code: itemCode, description: desc, unit, quantity: qty, rate });
    }
    state.boqItems[pid] = (state.boqItems[pid] || []).concat(items);
    saveState(state);
    return jsonResponse({
      ok: true,
      imported: items.length,
      rejected,
      total: state.boqItems[pid].length,
      notice: 'BOQ imported in demo mode. Items stored in browser localStorage only. / تم استيراد BOQ في الوضع التجريبي. البنود محفوظة محلياً.'
    }, 201);
  });

  // GET BOQ items list
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/boq', async (req) => {
    const pid = req.params.projectId;
    if (!state.projects[pid]) return errorResponse('Project not found.', 'NOT_FOUND', 404);
    const items = state.boqItems[pid] || [];
    return jsonResponse({ items });
  });

  // Single BOQ item create (manual)
  addRoute('POST', '/api/mmc-ai/projects/:projectId/boq', async (req, body) => {
    const pid = req.params.projectId;
    if (!state.projects[pid]) return errorResponse('Project not found.', 'NOT_FOUND', 404);
    if (!body.description) return errorResponse('Description required. / البيان مطلوب.', 'VALIDATION', 400);
    const item = {
      id: uid('aiboq'), project_id: pid,
      item_code: body.itemCode || '',
      description: body.description,
      unit: body.unit || 'nr',
      quantity: Number(body.quantity) || 0,
      rate: Number(body.rate) || 0,
      source_takeoff_item_id: body.sourceTakeoffItemId || null
    };
    state.boqItems[pid] = state.boqItems[pid] || [];
    state.boqItems[pid].push(item);
    saveState(state);
    return jsonResponse({ item, amount: item.quantity * item.rate }, 201);
  });

  // ── Layers CRUD (minimal) ────────────────────────────────────────────
  addRoute('POST',   '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/layers', async () => errorResponse('User layer management not enabled in demo mode. / إدارة الطبقات غير مفعّلة في الوضع التجريبي.', 'DEMO_LIMIT', 501));
  addRoute('PATCH',  '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/layers/:layerId', async () => errorResponse('Demo mode — layer editing disabled. / الوضع التجريبي — تعديل الطبقات معطل.', 'DEMO_LIMIT', 501));
  addRoute('DELETE', '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/layers/:layerId', async () => errorResponse('Demo mode — layer editing disabled. / الوضع التجريبي — حذف الطبقات معطل.', 'DEMO_LIMIT', 501));
  addRoute('PATCH',  '/api/mmc-ai/projects/:projectId/takeoff/runs/:runId/items/:itemId/layer', async () => errorResponse('Demo mode — item layer assignment disabled. / الوضع التجريبي — إسناد العناصر معطل.', 'DEMO_LIMIT', 501));

  // ── Drawing packages ─────────────────────────────────────────────────
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/drawing-packages', async () => jsonResponse({ packages: [] }));
  addRoute('PUT',  '/api/mmc-ai/projects/:projectId/drawing-packages/:discipline', async () => jsonResponse({ ok: true }));

  // ── BIM, schedule, risks, contracts — demo-mode placeholder ─────────
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/bim/models', async () => jsonResponse({ models: [] }));
  addRoute('POST', '/api/mmc-ai/projects/:projectId/bim/models', async () => errorResponse('BIM upload disabled in demo mode. / رفع BIM معطل في الوضع التجريبي.', 'DEMO_LIMIT', 501));
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/bim/issues', async () => jsonResponse({ issues: [] }));
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/schedule/tasks', async () => jsonResponse({ tasks: [] }));
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/risks', async () => jsonResponse({ risks: [] }));
  addRoute('GET',  '/api/mmc-ai/projects/:projectId/contract-events', async () => jsonResponse({ events: [] }));
  addRoute('POST', '/api/mmc-ai/projects/:projectId/assistant', async () => errorResponse('AI assistant not available in demo mode. / المساعد الذكي غير متاح في الوضع التجريبي.', 'DEMO_LIMIT', 501));

  // ── Fetch override ───────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    let url = (typeof input === 'string') ? input : (input && input.url);
    if (!url || !url.startsWith('/api/mmc-ai/')) {
      return originalFetch.call(this, input, init);
    }
    const method = (init && init.method && init.method.toUpperCase()) || 'GET';
    const u = new URL(url, window.location.origin);
    const pathname = u.pathname;
    const match = matchRoute(method, pathname);
    if (!match) {
      return errorResponse('Endpoint ' + method + ' ' + pathname + ' is not implemented in demo mode. / نقطة النهاية غير مُنفَّذة في الوضع التجريبي.', 'DEMO_NOT_IMPLEMENTED', 501);
    }
    let body = null, formData = null;
    if (init && init.body) {
      const ctype = (init.headers && (init.headers['Content-Type'] || init.headers.get && init.headers.get('Content-Type'))) || '';
      if (typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch { body = {}; }
      } else if (init.body instanceof FormData) {
        formData = init.body;
        body = {};
      } else if (init.body instanceof Blob) {
        try { body = JSON.parse(await init.body.text()); } catch { body = {}; }
      } else if (typeof init.body === 'object') {
        body = init.body;
      }
    }
    try {
      const req = { params: match.params, method, pathname, search: u.searchParams };
      return await match.handler(req, body, formData);
    } catch (err) {
      console.error('[mmc-ai-demo] handler error:', err);
      return errorResponse(err.message || 'Demo backend error.', 'DEMO_ERROR', 500);
    }
  };

  // ── Demo banner ──────────────────────────────────────────────────────
  function injectBanner() {
    if (document.querySelector('#mmc-ai-demo-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'mmc-ai-demo-banner';
    banner.setAttribute('role', 'status');
    banner.style.cssText = 'position:sticky;top:0;z-index:1000;background:#0f5132;color:#d1f7e0;border-bottom:1px solid #2faa72;padding:9px 18px;text-align:center;font-size:11px;font-weight:600';
    banner.textContent = 'وضع تجريبي مستقل (Standalone Demo v2) — البيانات محفوظة محلياً في المتصفح فقط. لا خادم، لا قاعدة بيانات. للاختبار الحقيقي استخدم خادم v13.';
    const main = document.querySelector('.main');
    if (main) main.prepend(banner);
    else document.body.prepend(banner);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectBanner);
  } else {
    injectBanner();
  }

  console.info('[mmc-ai-demo] v2 backend ready. State:', Object.keys(state.projects).length, 'project(s),', Object.keys(state.boqItems).reduce((n, k) => n + (state.boqItems[k] || []).length, 0), 'BOQ item(s).');
  // Tell the page the shim is live so it can re-run its initial data loads
  // (the page's own loadProjects() fires before this script is evaluated).
  window.__MMC_AI_DEMO_READY__ = true;
  try { window.dispatchEvent(new Event('mmc-ai-demo-ready')); } catch (e) {}
})();
