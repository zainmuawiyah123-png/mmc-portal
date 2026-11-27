'use strict';
const express = require('express');
const config = require('../config');
const A = require('../lib/auth');
const { issueDemoTicket, ALLOWED_EMAIL } = require('../lib/demo-sso');
const { E, wrap } = require('../lib/errors');

const router = express.Router();

/*
 * Dedicated presenter sign-in for isolated DEMO previews.
 * The reusable access key is stored only in the preview service environment.
 * It is separate from the one-time cross-service SSO ticket secret.
 */
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getDB, uid } = require('../db');
const presenterLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => config.NODE_ENV === 'test'
});

function presenterLoginPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>MMC Demo Presenter</title></head><body style="font-family:Arial,sans-serif;max-width:420px;margin:12vh auto;padding:24px"><h1>MMC Demo Presenter</h1><p>Enter your private demo access key to open the isolated presentation workspace.</p><form id="login"><label for="key">Demo access key</label><br><input id="key" type="password" autocomplete="current-password" required minlength="32" style="box-sizing:border-box;width:100%;padding:12px;margin:12px 0"><button style="padding:12px 18px">Continue</button></form><p id="status" role="status"></p><script>
document.getElementById('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = document.getElementById('status');
  const key = document.getElementById('key').value;
  status.textContent = 'Checking access…';
  try {
    const response = await fetch('/api/demo-sso/presenter-login', {
      method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type':'application/json'}, body: JSON.stringify({accessKey:key})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error('Access denied. Check the key and try again.');
    location.replace('/portal/pt-9f3c7a1e5b2d/');
  } catch (error) { status.textContent = error.message || 'Unable to sign in.'; }
});
</script></body></html>`;
}

router.get('/presenter-login', (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_PRESENTER_ACCESS_KEY) return res.sendStatus(404);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send(presenterLoginPage());
});

router.post('/presenter-login', presenterLoginLimiter, wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_PRESENTER_ACCESS_KEY) throw E.notFound('Not found');
  const expected = Buffer.from(config.DEMO_PRESENTER_ACCESS_KEY, 'utf8');
  const supplied = Buffer.from(String(req.body?.accessKey || ''), 'utf8');
  if (expected.length < 32 || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw E.unauthorized('Invalid demo presenter access key.');
  }

  const db = getDB();
  const userId = 'demo_presenter_' + crypto.createHash('sha256').update(ALLOWED_EMAIL).digest('hex').slice(0, 24);
  const identity = db.transaction(() => {
    const byEmail = db.prepare('SELECT id,role FROM users WHERE lower(email)=lower(?)').get(ALLOWED_EMAIL);
    const byId = db.prepare('SELECT id,email,role FROM users WHERE id=?').get(userId);
    if ((byEmail && byEmail.id !== userId) || (byId && (byId.email.toLowerCase() !== ALLOWED_EMAIL || byId.role === 'admin'))) {
      throw E.conflict('The presenter identity conflicts with an existing non-demo account.');
    }
    if (!byId) {
      db.prepare(`INSERT INTO users(id,email,password_hash,name,company,role,country,plan_key,account_status)
        VALUES(?,?,?,?,?,'contractor','JO','free','active')`)
        .run(userId, ALLOWED_EMAIL, '!demo-sso-only:' + crypto.randomBytes(48).toString('hex'), 'MMC Demo Presenter', 'MMC DEMO');
    } else {
      db.prepare("UPDATE users SET account_status='active',name='MMC Demo Presenter',company='MMC DEMO',plan_key='free' WHERE id=?").run(userId);
    }
    const hasFreeSubscription = db.prepare("SELECT 1 FROM subscriptions WHERE user_id=? AND plan_key='free' AND status='active'").get(userId);
    if (!hasFreeSubscription) {
      db.prepare("INSERT INTO subscriptions(id,user_id,plan_key,status,source) VALUES(?,?,'free','active','system')")
        .run(uid('sub_'), userId);
    }
    db.prepare('UPDATE users SET last_login_at=unixepoch() WHERE id=?').run(userId);
    return db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  })();

  A.setSessionCookie(res, A.signToken(identity));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, demo: true, user: { email: ALLOWED_EMAIL, name: identity.name }, redirect: '/portal/pt-9f3c7a1e5b2d/' });
}));

// This issuer is enabled only on explicitly isolated preview environments.
router.post('/ai-ticket', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) throw E.notFound('Not found');
  if (String(req.user.email || '').toLowerCase() !== ALLOWED_EMAIL || req.user.role === 'admin') {
    throw E.forbidden('This account is not authorized for the demo presenter.');
  }
  const ticket = issueDemoTicket({
    user: req.user, audience: 'mmc-ai-staging', secret: config.DEMO_SSO_SECRET
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ticket, expiresIn: 90, destination: 'https://mmc-ai-staging.onrender.com/api/demo-sso/handoff' });
}));

router.get('/ai-handoff', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) throw E.notFound('Not found');
  if (String(req.user.email || '').toLowerCase() !== ALLOWED_EMAIL || req.user.role === 'admin') {
    throw E.forbidden('This account is not authorized for the demo presenter.');
  }
  const ticket = issueDemoTicket({
    user: req.user, audience: 'mmc-ai-staging', secret: config.DEMO_SSO_SECRET
  });
  const target = 'https://mmc-ai-staging.onrender.com/api/demo-sso/handoff#ticket=' + encodeURIComponent(ticket);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Opening MMC AI…</title><p>Opening your secure MMC AI demo session…</p><script>location.replace(' + JSON.stringify(target) + ');</script>');
}));

router.get('/vendor-handoff', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) throw E.notFound('Not found');
  if (String(req.user.email || '').toLowerCase() !== ALLOWED_EMAIL || req.user.role === 'admin') {
    throw E.forbidden('This account is not authorized for the demo presenter.');
  }
  const ticket = issueDemoTicket({ user: req.user, audience: 'mmc-vendor-registry-preview', secret: config.DEMO_SSO_SECRET });
  const target = 'https://mmc-vendor-registry-preview.onrender.com/api/demo-sso/handoff#ticket=' + encodeURIComponent(ticket);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Opening MMC Vendor Registry…</title><p>Opening your secure vendor registry demo…</p><script>location.replace(' + JSON.stringify(target) + ');</script>');
}));

module.exports = router;
