'use strict';
// DEMO-only, short-lived, single-use SSO tickets. This module is inert unless
// explicitly imported by a route guarded by DEMO_MODE and the exact allowlist.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'mmc-demo-presenter';
const ALLOWED_EMAIL = 'samarzaro4@gmail.com';
const TTL_SECONDS = 90;

function requiredSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new Error('DEMO_SSO_SECRET must contain at least 32 bytes');
  }
  return secret;
}

function issueDemoTicket({ user, audience, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!user || String(user.email || '').toLowerCase() !== ALLOWED_EMAIL) {
    throw new Error('Not an authorized demo presenter');
  }
  if (!audience || typeof audience !== 'string') throw new Error('A target audience is required');
  const jti = crypto.randomBytes(24).toString('base64url');
  return jwt.sign(
    { email: ALLOWED_EMAIL, purpose: 'demo-sso', jti, iat: now },
    requiredSecret(secret),
    { algorithm: 'HS256', issuer: ISSUER, audience, subject: String(user.id), expiresIn: TTL_SECONDS }
  );
}

function consumeDemoTicket({ db, token, audience, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!db || typeof db.prepare !== 'function') throw new Error('A database connection is required');
  const claims = jwt.verify(token, requiredSecret(secret), {
    algorithms: ['HS256'], issuer: ISSUER, audience, clockTimestamp: now, maxAge: TTL_SECONDS
  });
  if (claims.purpose !== 'demo-sso' || String(claims.email || '').toLowerCase() !== ALLOWED_EMAIL ||
      typeof claims.sub !== 'string' || typeof claims.jti !== 'string') {
    throw new Error('Invalid demo SSO ticket');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS demo_sso_consumed (
    jti TEXT PRIMARY KEY,
    consumed_at INTEGER NOT NULL
  )`);
  // The primary key makes consumption atomic across concurrent requests.
  db.prepare('INSERT INTO demo_sso_consumed(jti, consumed_at) VALUES(?, ?)').run(claims.jti, now);
  db.prepare('DELETE FROM demo_sso_consumed WHERE consumed_at < ?').run(now - 86400);
  return { sourceUserId: claims.sub, email: ALLOWED_EMAIL, expiresAt: claims.exp };
}

module.exports = { issueDemoTicket, consumeDemoTicket, ALLOWED_EMAIL, TTL_SECONDS };
