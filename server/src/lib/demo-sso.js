'use strict';
const jwt = require('jsonwebtoken');
const ALLOWED_EMAIL = 'samarzaro4@gmail.com';
function consumeDemoTicket({ db, token, audience, secret, now = Math.floor(Date.now() / 1000) }) {
  if (!db || typeof db.prepare !== 'function') throw new Error('A database connection is required');
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('DEMO_SSO_SECRET must contain at least 32 bytes');
  const claims = jwt.verify(token, secret, { algorithms:['HS256'], issuer:'mmc-demo-presenter', audience, clockTimestamp:now, maxAge:90 });
  if (claims.purpose !== 'demo-sso' || String(claims.email||'').toLowerCase() !== ALLOWED_EMAIL || typeof claims.sub !== 'string' || typeof claims.jti !== 'string') throw new Error('Invalid MMC demo SSO ticket');
  db.exec(`CREATE TABLE IF NOT EXISTS demo_sso_consumed (jti TEXT PRIMARY KEY, consumed_at INTEGER NOT NULL)`);
  db.prepare('INSERT INTO demo_sso_consumed(jti,consumed_at) VALUES(?,?)').run(claims.jti,now);
  db.prepare('DELETE FROM demo_sso_consumed WHERE consumed_at < ?').run(now-86400);
  return {sourceUserId:claims.sub,email:ALLOWED_EMAIL,expiresAt:claims.exp};
}
module.exports={consumeDemoTicket,ALLOWED_EMAIL};
