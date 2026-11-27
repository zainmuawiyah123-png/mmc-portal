'use strict';
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const A = require('../lib/auth');
const { getDB } = require('../db');
const { E, wrap } = require('../lib/errors');
const { consumeDemoTicket, ALLOWED_EMAIL } = require('../lib/demo-sso');
const router = express.Router();
const handoffLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const DESTINATION = '/vendor-registry/';
const AUDIENCE = 'mmc-vendor-registry-preview';
const ENABLED = () => config.DEMO_MODE === true && typeof config.DEMO_SSO_SECRET === 'string' && config.DEMO_SSO_SECRET.length >= 32;

router.get('/handoff', (req, res) => {
  if (!ENABLED()) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening MMC demo…</title><body style="font-family:Arial,sans-serif;padding:32px"><p id="status">Verifying your secure MMC demo session…</p><script>
(async()=>{
 const status=document.getElementById('status');
 const ticket=new URLSearchParams(location.hash.slice(1)).get('ticket');
 history.replaceState(null,'',location.pathname+location.search);
 if(!ticket){status.textContent='The secure demo link is missing or expired. Return to MMC and open the portal again.';return;}
 try{
  const response=await fetch('/api/demo-sso/handoff',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({ticket})});
  const data=await response.json();
  if(!response.ok||!data.ok) throw new Error(data.error?.message||'Unable to verify the demo session.');
  location.replace(data.redirect);
 }catch(error){status.textContent=error.message||'Unable to open the demo portal.';}
})();
</script></body></html>`);
});

router.post('/handoff', handoffLimiter, wrap(async (req, res) => {
  if (!ENABLED()) throw E.notFound('Not found');
  const token = String(req.body?.ticket || '');
  if (token.length < 40 || token.length > 4096) throw E.unauthorized('Invalid or expired demo ticket.');
  let ticket;
  try {
    ticket = consumeDemoTicket({ db: getDB(), token, audience: AUDIENCE, secret: config.DEMO_SSO_SECRET });
  } catch (_) {
    throw E.unauthorized('This demo link is invalid, expired, or already used. Return to MMC and open the portal again.');
  }
  if (ticket.email !== ALLOWED_EMAIL) throw E.forbidden('This account is not authorized for the MMC demo.');
  const db = getDB();
  const userId = 'demo_vendor_presenter_' + crypto.createHash('sha256').update(ALLOWED_EMAIL).digest('hex').slice(0, 24);
  const identity = db.transaction(() => {
    const byId = db.prepare('SELECT id,email,role FROM users WHERE id=?').get(userId);
    const byEmail = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(ALLOWED_EMAIL);
    if ((byId && (String(byId.email).toLowerCase() !== ALLOWED_EMAIL || byId.role !== 'contractor')) ||
        (byEmail && byEmail.id !== userId)) {
      throw E.conflict('The isolated MMC demo identity conflicts with an existing account.');
    }
    if (!byId) {
      db.prepare("INSERT INTO users(id,email,password_hash,name,company,role,country,plan_key) VALUES(?,?,?,?,?,'contractor','JO','free')")
        .run(userId, ALLOWED_EMAIL, '!demo-sso-only:' + crypto.randomBytes(48).toString('hex'),
          'MMC Demo Presenter', 'MMC DEMO — Isolated Vendor Registry Workspace');
    }
    db.prepare('UPDATE users SET last_login_at=unixepoch() WHERE id=?').run(userId);
    return A.loadUser(userId);
  }).immediate();
  A.setSessionCookie(res, A.signToken(identity));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, redirect: DESTINATION });
}));

module.exports = router;
