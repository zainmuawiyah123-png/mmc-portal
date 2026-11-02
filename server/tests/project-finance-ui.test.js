'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const pagePath = path.join(__dirname, '../../webpages/technical-proposal-kit_v5/project-finance/index.html');
const html = fs.readFileSync(pagePath, 'utf8');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\\bsrc=)[^>]*>([\\s\\S]*?)<\\/script>/gi)].map((m) => m[1]).filter((s) => s.trim());

test('project finance UI page exists and has a responsive viewport', () => {
  assert.ok(html.includes('<meta name="viewport"'));
  assert.match(html, /@media\\s*\\(max-width:\s*700px\\)/);
  assert.ok(html.includes('دورة المشاريع والمستحقات'));
});

test('project finance inline JavaScript parses without syntax errors', () => {
  assert.ok(inlineScripts.length > 0, 'no inline application script found');
  inlineScripts.forEach((source, index) => new vm.Script(source, { filename: 'project-finance-inline-' + index + '.js' }));
});

test('project finance UI exposes every role workflow action', () => {
  const requiredIds = [
    'makeAward','makePO','review','forward','makeInvoice',
    'confirmOwner','approveFinance','recordPayment',
    'buyerTools','contractorTools','ownerTools','financeTools'
  ];
  for (const id of requiredIds) {
    assert.match(html, new RegExp('id=["\\']' + id + '["\\']'), 'missing UI control: ' + id);
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

test('project finance UI does not route project payments through MMC subscription billing', () => {
  assert.ok(html.includes('لا تدخل ضمن فواتير اشتراكات MMC'));
  assert.ok(html.includes('/project-finance/invoices/'));
  assert.ok(!html.includes("API.request('POST','/billing"));
});
