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

test('MMCUI-02 — روابط المصادر الخارجية تفتح بأمان، والدليل لا يدّعي الاستيراد الآلي', () => {
  assert.match(tenderDirectory, /target="_blank" rel="noopener"/);
  assert.match(tenderDirectory, /لا ندّعي أن كل إعلان/);
  assert.match(tenderDirectory, /Verify the original notice/);
});

test('MMCUI-03 — دليل العطاءات متاح من بوابتي المقاول والمشتريات', () => {
  assert.match(contractorPortal, /\.\.\/tender-opportunities\/index\.html/);
  assert.match(procurementPortal, /\.\.\/tender-opportunities\/index\.html/);
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
  assert.ok(route.includes("status IN ('open','closed')"));
  assert.match(route, /router\.use\(A\.requireAuth, A\.requireRole\('admin'\)\)/);
  assert.match(route, /protocol !== 'https:'/);
});
