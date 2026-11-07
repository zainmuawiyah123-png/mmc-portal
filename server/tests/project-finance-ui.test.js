'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '../../webpages/technical-proposal-kit_v5/project-finance/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
// Static UI contract checks; API workflow behavior is covered by integration tests.

test('PFUI-01 — صفحة دورة المالية موجودة وتحمّل مكتبات البوابة الحالية', () => {
  assert.ok(html.includes('<title>الترسيات وأوامر الشراء والفواتير · MMC</title>'));
  assert.match(html, /assets\/api\.js/);
  assert.match(html, /assets\/i18n\.js/);
});

test('PFUI-02 — جميع عناصر الواجهة المشار إليها بالمعرّف موجودة ومعرّفاتها فريدة', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size, 'لا يجوز تكرار HTML id');
  const referenced = [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  for (const id of new Set(referenced)) assert.ok(ids.includes(id), 'عنصر مفقود: ' + id);
});

test('PFUI-03 — أدوار المقاول والمشتريات والمالية والمالك لها مسارات عرض/إجراء', () => {
  for (const token of ['contractor', 'procurement', 'finance', 'owner', 'manager']) {
    assert.ok(html.includes(token), 'الدور غير ممثل في الواجهة: ' + token);
  }
  for (const route of ['/project-finance/awards', '/project-finance/purchase-orders', '/project-finance/invoices']) {
    assert.ok(html.includes(route), 'مسار API غير موجود: ' + route);
  }
});

test('PFUI-04 — إرسال الفاتورة ورفع المرفقات منفصلان مع إعادة المحاولة', () => {
  assert.match(html, /pendingInvoiceUploadId/);
  assert.match(html, /uploadInvoiceFiles/);
  assert.match(html, /data-retry-docs/);
  assert.match(html, /تم تقديم الفاتورة بنجاح، لكن تعذّر رفع المرفقات/);
  assert.match(html, /files\.length>5/);
});

test('PFUI-05 — الواجهة تستخدم ترميز النصوص قبل إدراج القيم الديناميكية', () => {
  assert.match(html, /function esc\(s\)/);
  assert.ok(html.includes('.replace(/[&<>'));
});

test('PFUI-06 — لا توجد روابط أو نماذج تعتمد على localhost أو بيانات اعتماد ثابتة', () => {
  assert.doesNotMatch(html, /https?:\/\/localhost(?::\d+)?/i);
  assert.doesNotMatch(html, /password\s*[:=]\s*['"][^'"]+['"]/i);
});


const tenderDirectoryPath = path.join(__dirname, '../../webpages/technical-proposal-kit_v5/tender-opportunities/index.html');
const tenderDirectory = fs.readFileSync(tenderDirectoryPath, 'utf8');
const contractorPortal = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/bid/index.html'), 'utf8');
const procurementPortal = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/procurement/index.html'), 'utf8');

test('MMCUI-01 — دليل العطاءات يضم مصادر الأردن والدولية والإقليمية وروابطها الرسمية', () => {
  for (const token of ['JONEPS', 'Government Tenders Department', 'UNGM', 'World Bank', 'TED', 'Etimad', 'Tender.jo']) {
    assert.ok(tenderDirectory.includes(token), 'مصدر مفقود من الدليل: ' + token);
  }
  const links = [...tenderDirectory.matchAll(/href="https?:/g)];
  assert.ok(links.length >= 10, 'يجب توفير مجموعة روابط مصادر مباشرة');
});

test('MMCUI-02 — روابط المصادر الخارجية تفتح بأمان وتوضح حدود التسجيل والوثائق', () => {
  assert.match(tenderDirectory, /target="_blank" rel="noopener"/);
  assert.match(tenderDirectory, /لا يتجاوز MMC تسجيل المورد أو شراء الوثائق/);
  assert.match(tenderDirectory, /does not bypass vendor registration or document purchases/);
});

test('MMCUI-03 — دليل العطاءات الخارجية متاح للمقاول وغير مربوط ببوابة المشتريات', () => {
  assert.match(contractorPortal, /\.\.\/tender-opportunities\/index\.html/);
  assert.doesNotMatch(procurementPortal, /tender-opportunities\/index\.html/);
});


test('OPP-01 — دليل العطاءات مربوط بواجهة API عامة قابلة للبحث والتصفية', () => {
  assert.ok(tenderDirectory.includes("fetch('/api/opportunities?"));
  assert.ok(tenderDirectory.includes("opp-q"));
  assert.ok(tenderDirectory.includes("opp-country"));
  assert.ok(tenderDirectory.includes("opp-status"));
  assert.ok(tenderDirectory.includes("opp-results"));
});

test('OPP-02 — إدخال الإعلانات متاح للمسؤول فقط ومن خلال واجهة موثقة', () => {
  assert.ok(tenderDirectory.includes("fetch('/api/auth/me'"));
  assert.ok(tenderDirectory.includes("me.user?.role==='admin'"));
  assert.ok(tenderDirectory.includes("fetch('/api/opportunities/admin'"));
  assert.ok(tenderDirectory.includes('externalId'));
  assert.ok(tenderDirectory.includes('sourceUrl'));
});

test('OPP-03 — قاعدة البيانات تدعم معرف المصدر الفريد وروابط التقديم وحالات الإعلان', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/migrate.js'), 'utf8');
  for (const token of ['tender_opportunities','source_key','external_id','application_url','closing_at','UNIQUE(source_key, external_id)']) {
    assert.ok(migration.includes(token), 'حقل أو قيد مفقود: ' + token);
  }
});

test('OPP-04 — واجهة API تعرض بيانات منشورة فقط وتفرض المصادقة على الإدارة', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.ok(route.includes("router.get('/', A.requireAuth, A.requireRole('contractor', 'admin')"));
  assert.ok(route.includes("status IN ('open','closed')"));
  assert.match(route, /router\.use\(A\.requireAuth, A\.requireRole\('admin'\)\)/);
  assert.match(route, /protocol !== 'https:'/);
});


test('OPP-05 — موصل البنك الدولي يستخدم واجهة الإعلانات الرسمية العامة مع مهلة اتصال', () => {
  const connector = fs.readFileSync(path.join(__dirname, '../src/lib/opportunity-sync.js'), 'utf8');
  assert.ok(connector.includes('https://search.worldbank.org/api/v2/procnotices'));
  assert.ok(connector.includes('AbortController'));
  assert.ok(connector.includes("source_key='worldbank'") || connector.includes("'worldbank'"));
  assert.ok(connector.includes('ON CONFLICT(source_key,external_id) DO UPDATE'));
});

test('OPP-06 — مزامنة المصدر اختيارية ومجدولة دون تغيير إعدادات الإنتاج تلقائياً', () => {
  const config = fs.readFileSync(path.join(__dirname, '../src/config.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(__dirname, '../src/lib/scheduler.js'), 'utf8');
  assert.ok(config.includes("OPPORTUNITY_SYNC_ENABLED: v('OPPORTUNITY_SYNC_ENABLED', 'false') === 'true'"));
  assert.ok(scheduler.includes('config.OPPORTUNITY_SYNC_ENABLED'));
  assert.ok(scheduler.includes('runOpportunitySyncJob'));
});


test('OPP-07 — المسؤول يستطيع تشغيل مزامنة البنك الدولي من واجهة الدليل', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.ok(tenderDirectory.includes('oa-sync-worldbank'));
  assert.ok(tenderDirectory.includes('/api/opportunities/admin/sync/worldbank'));
  assert.ok(route.includes("router.post('/admin/sync/worldbank'"));
  assert.ok(route.includes("router.post('/admin/bulk'"));
});


test('OPP-08 — موصل UNGM يستخدم API الرسمي ويتطلب رمز OAuth ولا ينشر المسودات', () => {
  const connector = fs.readFileSync(path.join(__dirname, '../src/lib/ungm-sync.js'), 'utf8');
  const config = fs.readFileSync(path.join(__dirname, '../src/config.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.ok(connector.includes('https://www.ungm.org/API/Notices'));
  assert.ok(connector.includes("Authorization:'Bearer '+accessToken"));
  assert.ok(connector.includes("statusText!=='finalized'"));
  assert.ok(connector.includes("'ungm'"));
  assert.ok(config.includes("UNGM_ACCESS_TOKEN: v('UNGM_ACCESS_TOKEN', '')"));
  assert.ok(route.includes("router.post('/admin/sync/ungm'"));
  assert.ok(route.includes("UNGM_ACCESS_TOKEN"));
});

test('OPP-09 — واجهة المدير توفر زر مزامنة UNGM مع عدم كشف الرمز في الواجهة', () => {
  assert.ok(tenderDirectory.includes('oa-sync-ungm'));
  assert.ok(tenderDirectory.includes('/api/opportunities/admin/sync/ungm'));
  assert.doesNotMatch(tenderDirectory, /UNGM_ACCESS_TOKEN\s*[:=]/);
});


test('OPP-10 — مستورد JONEPS يقرأ صفوف دعوات العطاءات المنشورة ويطبع المواعيد', () => {
  const { parseJonepsRows } = require('../src/lib/joneps-sync');
  const fixture = '<table><tr><th>رقم</th></tr><tr><td><a href="/ep/invt/view.do?id=1">2026004514-00</a></td><td><a href="/ep/invt/view.do?id=1">شراء قطع غيار</a></td><td>وزارة النقل</td><td>لوازم</td><td>02/11/2026</td><td>15/11/2026</td></tr></table>';
  const rows = parseJonepsRows(fixture);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '2026004514-00');
  assert.equal(rows[0].title, 'شراء قطع غيار');
  assert.equal(rows[0].authority, 'وزارة النقل');
  assert.equal(rows[0].publishedAt, '2026-11-02');
  assert.equal(rows[0].closingAt, '2026-11-15');
  assert.match(rows[0].sourceUrl, /^https:\/\/www\.joneps\.gov\.jo\//);
});

test('OPP-11 — زر JONEPS لا يتيح الاستيراد إلا من واجهة المدير', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  const connector = fs.readFileSync(path.join(__dirname, '../src/lib/joneps-sync.js'), 'utf8');
  assert.ok(tenderDirectory.includes('oa-sync-joneps'));
  assert.ok(tenderDirectory.includes('/api/opportunities/admin/sync/joneps'));
  assert.ok(route.includes("router.post('/admin/sync/joneps'"));
  assert.ok(connector.includes('www.joneps.gov.jo/ep/invt/selectListTendInvitAL.do'));
  assert.ok(connector.includes('no recognizable tender rows'));
});


test('OPP-12 — مرشح الدول يحافظ على رمز INT الدولي كاملاً', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.ok(route.includes('clean(req.query.country,3)'));
});


test('OPP-13 — روابط الصفحات التالية من UNGM لا تسمح بتغيير المضيف أو المسار', () => {
  const connector = fs.readFileSync(path.join(__dirname, '../src/lib/ungm-sync.js'), 'utf8');
  assert.ok(connector.includes("url.origin!=='https://www.ungm.org'||url.pathname!=='/API/Notices'"));
});


test('OPP-14 — مزامنة العطاءات مستقلة عن جدولة النسخ الاحتياطي والاشتراكات', () => {
  const scheduler = fs.readFileSync(path.join(__dirname, '../src/lib/scheduler.js'), 'utf8');
  assert.ok(scheduler.includes("'opportunity-sync'"));
  assert.ok(scheduler.includes('!config.SCHEDULER_ENABLED && !config.OPPORTUNITY_SYNC_ENABLED'));
  assert.ok(scheduler.includes('opportunitySyncEnabled: config.OPPORTUNITY_SYNC_ENABLED'));
  assert.ok(scheduler.includes('active: _jobs.length > 0'));
});


test('OPP-15 — مستورد JONEPS يتبع روابط ترقيم الصفحات الرسمية فقط', () => {
  const { extractPageUrls, LIST_URL } = require('../src/lib/joneps-sync');
  const html = '<a href="?page=2">2</a><a href="?page=3">3</a><a href="https://evil.example/page">4</a><a href="/other">5</a><a href="?page=11">11</a>';
  const urls = extractPageUrls(html, 10);
  assert.equal(urls.length, 3);
  assert.equal(urls[0], LIST_URL);
  assert.ok(urls[1].includes('page=2'));
  assert.ok(urls[2].includes('page=3'));
});


test('OPP-18 — تعطل مصدر عطاءات لا يمنع تشغيل بقية المصادر في المجدول', () => {
  const scheduler = fs.readFileSync(path.join(__dirname, '../src/lib/scheduler.js'), 'utf8');
  assert.ok(scheduler.includes('const runSource=async(name,fn)=>'));
  assert.ok(scheduler.includes("await runSource('joneps'"));
  assert.ok(scheduler.includes("await runSource('worldbank'"));
  assert.ok(scheduler.includes('partial:failed.length>0'));
});


test('OPP-19 — دليل المصادر الأردنية يعرض وزارة الأشغال والمياه وروابطها الرسمية', () => {
  assert.ok(tenderDirectory.includes('https://www.mpwh.gov.jo/Ar/Modules/Tenders'));
  assert.ok(tenderDirectory.includes('https://www.mwi.gov.jo/AR/Modules/tenders'));
  assert.ok(tenderDirectory.includes('https://www.gtd.gov.jo/AR/List/'));
  assert.ok(tenderDirectory.includes('https://www.gamtenders.gov.jo/'));
});

test('OPP-20 — لا يظهر زر مزامنة لدائرة العطاءات الحكومية دون موصل API فعال', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.doesNotMatch(tenderDirectory, /id="oa-sync-gtd"/);
  assert.ok(!tenderDirectory.includes("document.getElementById('oa-sync-gtd')"));
  assert.doesNotMatch(route, /router\.post\('\/admin\/sync\/gtd'/);
});


test('OPP-21 — JONEPS pagination supports page numbers above the first ten without inventing URLs', () => {
  const { extractPageUrls, LIST_URL } = require('../src/lib/joneps-sync');
  const html = '<a href="?page=2">2</a><a href="?page=82">82</a><a href="?page=101">101</a><a href="https://evil.example/?page=90">90</a>';
  const urls = extractPageUrls(html, 100);
  assert.equal(urls.length, 3);
  assert.equal(urls[0], LIST_URL);
  assert.ok(urls.some(u => u.includes('page=82')));
  assert.ok(!urls.some(u => u.includes('page=101')));
  assert.ok(!urls.some(u => u.includes('evil.example')));
});

test('OPP-22 — JONEPS marks cancelled tenders separately from expired tenders', () => {
  const { parseJonepsRows } = require('../src/lib/joneps-sync');
  const html = '<table><tr><td>2026-1234</td><td><a href="/detail?id=1">عطاء صيانة طريق</a></td><td>وزارة الأشغال</td><td>أشغال</td><td>01/11/2026</td><td>20/11/2026</td></tr><tr><td colspan="6">تم إلغاء العطاء</td></tr></table>';
  const rows = parseJonepsRows(html);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.ok(rows[0].sourceUrl.includes('/detail?id=1'));
});


test('OPP-23 — سجل المزامنة محفوظ لكل مصدر ويُعرض للمسؤول فقط', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../src/migrate.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(__dirname, '../src/lib/scheduler.js'), 'utf8');
  assert.ok(migration.includes('CREATE TABLE IF NOT EXISTS opportunity_sync_runs'));
  assert.ok(route.includes("router.get('/admin/sync-history'"));
  assert.ok(route.includes("A.requireAuth, A.requireRole('admin')"));
  assert.ok(route.includes('runAndRecordSync'));
  assert.ok(scheduler.includes('persistOpportunitySync'));
});

test('OPP-24 — لوحة العطاءات تعرض سجل المصدر ونتيجة المزامنة', () => {
  assert.ok(tenderDirectory.includes('id="oa-sync-history"'));
  assert.ok(tenderDirectory.includes('/api/opportunities/admin/sync-history?limit=30'));
  assert.ok(tenderDirectory.includes('oa-sync-history-refresh'));
  assert.ok(tenderDirectory.includes('received'));
  assert.ok(tenderDirectory.includes('duration_ms'));
});

test('OPP-25 — فشل المصادقة يعرض تسجيل الدخول وإعادة المحاولة بدلاً من مساحة بيضاء', () => {
  const login = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/portal/pt-9f3c7a1e5b2d/login.html'), 'utf8');
  assert.ok(tenderDirectory.includes('function showOpportunityLoadError'));
  assert.ok(tenderDirectory.includes("setAttribute('role','alert')"));
  assert.ok(tenderDirectory.includes("setAttribute('data-opp-retry','')"));
  assert.ok(tenderDirectory.includes('login.html?next=../../tender-opportunities/index.html'));
  assert.ok(login.includes('(bid|procurement|admin|tender-opportunities)'));
});

test('OPP-26 — لوحة تفاصيل سوق العطاءات مخفية تماماً قبل الفتح في RTL وLTR', () => {
  const market = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/bid/market.html'), 'utf8');
  assert.match(market, /\.mk-drawer\{[^}]*transform:translateX\(102%\)[^}]*visibility:hidden;pointer-events:none/);
  assert.match(market, /html\[dir=ltr\] \.mk-drawer\{transform:translateX\(-102%\)\}/);
  assert.match(market, /\.mk-drawer\.on\{transform:none;visibility:visible;pointer-events:auto/);
  assert.ok(market.includes("$('#dim').onclick=closeD"));
  assert.ok(market.includes("if(e.key==='Escape')closeD()"));
});

test('OPP-27 — سوق العطاءات يعرض المصادر المتصلة وروابط البوابات الرسمية', () => {
  const market = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/bid/market.html'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.ok(market.includes("amman:['أمانة عمّان الكبرى','Greater Amman Municipality']"));
  assert.ok(market.includes("jprc:['مصفاة البترول الأردنية','Jordan Petroleum Refinery']"));
  assert.ok(market.includes("jpmc:['مناجم الفوسفات الأردنية','Jordan Phosphate Mines']"));
  assert.ok(market.includes("nepco:['الكهرباء الوطنية','National Electric Power Company']"));
  assert.ok(route.includes("connectedSources:['joneps','apc','worldbank','ungm','amman','jprc','jpmc','nepco']"));
  assert.ok(market.includes('https://www.jopetrol.com.jo/ar/modules/tenders'));
  assert.ok(market.includes('https://www.jpmc.com.jo/en/tender'));
  assert.ok(market.includes('https://www.nepco.com.jo/en/Tenders.aspx'));
  assert.ok(market.includes('https://www.jepco.com.jo/ar/Home/'));
  assert.ok(market.includes('JEPCO — رابط رسمي'));
});

test('OPP-28 — تفاصيل سوق العطاءات تعرض مرفقات MMC مع فحص HEAD قبل التنزيل', () => {
  const market = fs.readFileSync(path.join(__dirname, '../../webpages/technical-proposal-kit_v5/bid/market.html'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/opportunities.js'), 'utf8');
  assert.ok(market.includes("API.request('GET','/opportunities/'+encodeURIComponent(id))"));
  assert.ok(market.includes('data-market-doc'));
  assert.ok(market.includes("method:'HEAD'"));
  assert.ok(market.includes("window.location.href=link.href"));
  assert.ok(market.includes('data.documents||[]'));
  assert.ok(route.includes("router.post('/admin/sync/jprc'"));
  assert.ok(route.includes("router.post('/admin/sync/nepco'"));
  assert.ok(route.includes("router.post('/admin/import/jpmc-curated'"));
  assert.ok(tenderDirectory.includes('id="oa-sync-jprc"'));
  assert.ok(tenderDirectory.includes('id="oa-sync-nepco"'));
  assert.ok(tenderDirectory.includes('id="oa-import-jpmc"'));
});


test('OPP-09 — تفاصيل العطاء والوثائق العامة تُعرض وتُنزل من داخل MMC بأمان', () => {
  const route=fs.readFileSync(path.join(__dirname,'../src/routes/opportunities.js'),'utf8');
  const downloader=fs.readFileSync(path.join(__dirname,'../src/lib/public-tender-documents.js'),'utf8');
  const migration=fs.readFileSync(path.join(__dirname,'../src/migrate.js'),'utf8');
  assert.ok(tenderDirectory.includes('data-opportunity-detail'));
  assert.ok(tenderDirectory.includes('showOpportunityDetails'));
  assert.ok(tenderDirectory.includes('data-doc-download'));
  assert.ok(tenderDirectory.includes('Download via MMC (public file)'));
  assert.match(tenderDirectory,/href="'\+esc\(doc\.downloadUrl\)\+'" download data-doc-download/);
  assert.ok(tenderDirectory.includes("method:'HEAD'"));
  assert.ok(tenderDirectory.includes('payload.error?.message'));
  assert.ok(tenderDirectory.includes('window.location.href=link.href'));
  assert.ok(!tenderDirectory.includes('URL.createObjectURL'));
  assert.ok(!tenderDirectory.includes('a.href=url'));
  assert.ok(route.includes("router.get('/:id', A.requireAuth, A.requireRole(...MARKET_ROLES)"));
  assert.ok(route.includes("'/:id/documents/:documentId/download'"));
  assert.ok(route.includes("'public-tenders/'+doc.source_key+'/'+doc.id"));
  assert.ok(route.includes("res.setHeader('Content-Disposition',`attachment;"));
  assert.ok(downloader.includes("redirect: 'manual'"));
  assert.ok(downloader.includes('DOCUMENT_REDIRECT_NOT_ALLOWED'));
  assert.ok(downloader.includes('MAX_REDIRECTS'));
  assert.ok(migration.includes('tender_opportunity_public_documents'));
  assert.ok(migration.includes('details_json'));
});
