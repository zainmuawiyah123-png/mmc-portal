'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { getDB, uid } = require('../db');
const A = require('../lib/auth');
const { consumeDemoTicket, ALLOWED_EMAIL } = require('../lib/demo-sso');
const router = express.Router();

router.post('/exchange', async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) return res.sendStatus(404);
  const ticket = String(req.body?.ticket || '');
  if (!ticket || ticket.length > 4096) return res.status(401).json({ error: 'Invalid demo ticket' });
  const db = getDB();
  let identity;
  try {
    identity = db.transaction(() => {
      const claims = consumeDemoTicket({ db, token: ticket, audience: 'mmc-vendor-registry-preview', secret: config.DEMO_SSO_SECRET });
      const userId = 'demo_vendor_' + crypto.createHash('sha256').update(ALLOWED_EMAIL).digest('hex').slice(0, 24);
      const existing = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(ALLOWED_EMAIL);
      if (existing && existing.id !== userId) throw new Error('Demo identity conflict');
      if (!existing) {
        const unusablePassword = '!demo-sso-only:' + crypto.randomBytes(48).toString('hex');
        db.prepare(`INSERT INTO users(id,email,password_hash,name,company,plan_key,role,account_status)
          VALUES(?,?,?,?,?,'free','contractor','active')`)
          .run(userId, ALLOWED_EMAIL, unusablePassword, 'MMC Demo Presenter', 'MMC DEMO');
      }
      db.prepare(`INSERT INTO vendor_profiles(
        id,user_id,legal_name,trading_name,country,city,contact_name,contact_email,contact_phone,
        entity_types_json,specializations_json,products_services_json,brands_json,service_regions_json,
        experience_summary,profile_status
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft') ON CONFLICT(user_id) DO NOTHING`)
        .run('demo_vendor_profile', userId, 'MMC DEMO — Sample Civil Contractor', 'MMC DEMO', 'JO', 'Amman',
          'MMC Demo Presenter', ALLOWED_EMAIL, '+962700000000',
          JSON.stringify(['contractor']), JSON.stringify(['civil construction']),
          JSON.stringify(['earthworks','concrete works']), JSON.stringify(['DEMO']), JSON.stringify(['Jordan']),
          'DEMO ONLY — sample profile for presentation. Not a verified company.');
      const profile = db.prepare('SELECT user_id,profile_status FROM vendor_profiles WHERE user_id=?').get(userId);
      if (!profile || profile.profile_status !== 'draft') throw new Error('Demo vendor profile conflict');
      return { user: db.prepare('SELECT * FROM users WHERE id=?').get(userId), sourceUserId: claims.sourceUserId };
    })();
  } catch (_) {
    return res.status(401).json({ error: { code: 'DEMO_SSO_INVALID', message: 'Demo access ticket is invalid or already used.' } });
  }
  A.setSessionCookie(res, A.signToken(identity.user));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, redirect: '/vendor-registry/' });
});

router.get('/handoff', (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>MMC Vendor Registry Demo</title></head><body><p id="status">Securing your demo session…</p><script>
  (async function () {
    const status = document.getElementById('status');
    const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
    history.replaceState(null, '', location.pathname);
    if (!ticket || ticket.length > 4096) { status.textContent = 'Invalid demo link. Return to MMC Portal and try again.'; return; }
    try {
      const response = await fetch('/api/demo-sso/exchange', { method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body:JSON.stringify({ticket}) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('exchange failed');
      location.replace('/vendor-registry/');
    } catch (_) { status.textContent = 'Unable to open the demo. Return to MMC Portal and start again.'; }
  })();
  </script></body></html>`);
});

module.exports = router;
