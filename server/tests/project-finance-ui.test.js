'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '../../webpages/technical-proposal-kit_v5/project-finance/index.html');
const html = fs.readFileSync(pagePath, 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter((m) => !/\bsrc\s*=/.test(m[1]))
  .map((m) => m[2])
  .filter((s) => s.trim());

test('project finance UI page exists and has a responsive viewport', () => {
  assert.ok(html.includes('<meta name="viewport"'));
  assert.ok(html.includes('@media(max-width:700px)'));
  assert.ok(html.includes('دورة المشاريع والمستحقات'));
});

test('project finance inline JavaScript parses without syntax errors', () => {
  assert.ok(scripts.length > 0, 'no inline application script found');
  scripts.forEach((source, index) => new vm.Script(source, { filename: 'project-finance-inline-' + index + '.js' }));
});

test('project finance UI exposes every role workflow action', () => {
  const requiredIds = [
    'makeAward','makePO','review','forward','makeInvoice',
    'confirmOwner','approveFinance','recordPayment','invoiceItem',
    'buyerTools','contractorTools','ownerTools','financeTools'
  ];
  for (const id of requiredIds) {
    assert.ok(html.includes('id="' + id + '"') || html.includes("id='" + id + "'"), 'missing UI control: ' + id);
  }
  for (const endpoint of [
    '/project-finance/awards',
    '/project-finance/purchase-orders',
    '/project-finance/invoices',
    '/procurement-review',
    '/owner-confirmation',
    '/forward-to-finance',
    '/finance-approval',
    '/payments'
  ]) assert.ok(html.includes(endpoint), 'missing API workflow endpoint: ' + endpoint);
});

test('project finance UI keeps project invoices separate from MMC subscription billing', () => {
  assert.ok(html.includes('لا تدخل ضمن فواتير اشتراكات MMC'));
  assert.ok(html.includes('/project-finance/invoices/'));
  assert.ok(!html.includes("API.request('POST','/billing"));
  assert.ok(html.includes('poItemId:opt.value'), 'contractor invoices must identify the approved PO line');
});
