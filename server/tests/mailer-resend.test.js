'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendViaResend } = require('../src/lib/mailer');

test('Resend sends email through HTTPS with the official sender and recipient', async () => {
  let request;
  const result = await sendViaResend({
    from: 'MMC Registration <m.madadha@mrc-jordan.com>',
    to: ['user@example.com'],
    subject: 'MMC verification',
    text: 'Test body'
  }, 're_test_key', async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ id: 'email_test_123' }) };
  });
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer re_test_key');
  assert.deepEqual(JSON.parse(request.options.body).to, ['user@example.com']);
  assert.match(JSON.parse(request.options.body).from, /m\\.madadha@mrc-jordan\\.com/);
  assert.equal(result.id, 'email_test_123');
});

test('Resend API errors are surfaced without exposing the API key', async () => {
  await assert.rejects(
    sendViaResend({ from: 'MMC <test@example.com>', to: ['user@example.com'], subject: 'x', text: 'y' },
      're_secret', async () => ({ ok: false, status: 403, json: async () => ({ message: 'domain not verified' }) })),
    /domain not verified/
  );
});
