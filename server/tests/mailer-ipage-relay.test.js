'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendViaIpageRelay } = require('../src/lib/mailer');

test('iPage relay sends recipient, subject and OTP body over authenticated HTTPS', async () => {
  let request;
  const response = await sendViaIpageRelay(
    { to: 'company@example.com', subject: 'MMC email verification', text: 'Your code is 123456' },
    'https://mail.example.com/mmc-otp-relay/send.php', 'test-private-token',
    async (url, options) => { request = { url, options }; return { ok: true, status: 200, json: async () => ({ ok: true, provider_accepted: true }) }; }
  );
  assert.equal(request.url, 'https://mail.example.com/mmc-otp-relay/send.php');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-private-token');
  assert.equal(request.options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(request.options.body), { to: 'company@example.com', subject: 'MMC email verification', text: 'Your code is 123456' });
  assert.equal(response.provider_accepted, true);
});

test('iPage relay rejects provider refusal and never reports a false success', async () => {
  await assert.rejects(() => sendViaIpageRelay(
    { to: 'company@example.com', subject: 'OTP', text: '123456' },
    'https://mail.example.com/send.php', 'test-private-token',
    async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: 'unauthorized' }) })
  ), /iPage relay rejected/);
});
