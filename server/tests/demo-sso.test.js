'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { issueDemoTicket, consumeDemoTicket, ALLOWED_EMAIL } = require('../src/lib/demo-sso');

const secret = 'test-only-secret-that-is-at-least-32-bytes-long';
function fixture(now = 2000000000) {
  const db = new Database(':memory:');
  const token = issueDemoTicket({
    user: { id: 'presenter-1', email: ALLOWED_EMAIL },
    audience: 'mmc-ai-staging', secret, now
  });
  return { db, token, now };
}

test('demo ticket is audience-bound and consumed exactly once', () => {
  const { db, token, now } = fixture();
  const identity = consumeDemoTicket({ db, token, audience: 'mmc-ai-staging', secret, now: now + 1 });
  assert.equal(identity.sourceUserId, 'presenter-1');
  assert.equal(identity.email, ALLOWED_EMAIL);
  assert.throws(() => consumeDemoTicket({ db, token, audience: 'mmc-ai-staging', secret, now: now + 2 }));
  assert.throws(() => consumeDemoTicket({ db, token, audience: 'other-service', secret, now: now + 2 }));
  db.close();
});

test('expired and wrong-secret tickets are rejected', () => {
  const { db, token, now } = fixture();
  assert.throws(() => consumeDemoTicket({ db, token, audience: 'mmc-ai-staging', secret, now: now + 100 }));
  assert.throws(() => consumeDemoTicket({ db, token, audience: 'mmc-ai-staging', secret: secret + 'wrong', now: now + 1 }));
  db.close();
});

test('issuer refuses any identity other than the exact presenter allowlist', () => {
  assert.throws(() => issueDemoTicket({
    user: { id: 'other', email: 'someone@example.com' },
    audience: 'mmc-ai-staging', secret
  }));
});
