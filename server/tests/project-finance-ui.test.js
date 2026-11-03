'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '../../webpages/technical-proposal-kit_v5/project-finance/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

test('PFUI-01 — صفحة دورة المالية موجودة وتحمّل مكتبات البوابة الحالية', () => {
  assert.match(html, /<title>[^<]*Project Finance/i);
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
  assert.match(html, /\.replace\(\/\[&<>/);
});

test('PFUI-06 — لا توجد روابط أو نماذج تعتمد على localhost أو بيانات اعتماد ثابتة', () => {
  assert.doesNotMatch(html, /https?:\/\/localhost(?::\d+)?/i);
  assert.doesNotMatch(html, /password\s*[:=]\s*['"][^'"]+['"]/i);
});
