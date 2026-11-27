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
    location.replace('/');
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
  res.json({ ok: true, demo: true, user: { email: ALLOWED_EMAIL, name: identity.name }, redirect: '/' });
}));


/*
 * DEMO-only procurement workspace. This synthetic buyer and organization
 * are provisioned only in the isolated preview database; no LIVE verification
 * policy or production identity is changed.
 */
function presenterDemoIds() {
  const h = crypto.createHash('sha256').update(ALLOWED_EMAIL).digest('hex');
  return {
    presenter: 'demo_presenter_' + h.slice(0, 24),
    buyer: 'demo_procurement_' + h.slice(0, 20),
    consultant: 'demo_consultant_' + h.slice(0, 20),
    org: 'demo_org_procurement_' + h.slice(0, 16),
    verification: 'demo_verification_procurement_' + h.slice(0, 12)
  };
}
function ticketIdentity(req) {
  const ids = presenterDemoIds();
  if (req.user && [ids.buyer, ids.consultant].includes(req.user.id)) return A.loadUser(ids.presenter);
  return req.user;
}
function assertDemoIdentity(req) {
  const ids = presenterDemoIds();
  const email = String(req.user && req.user.email || '').toLowerCase();
  if (email !== ALLOWED_EMAIL && ![ids.buyer, ids.consultant].includes(req.user.id)) {
    throw E.forbidden('This account is not authorized for the MMC demo workspace.');
  }
  if (req.user.role === 'admin') throw E.forbidden('Admin accounts cannot use the demo workspace switch.');
}
function ensureDemoProcurementIdentity() {
  const db = getDB();
  const ids = presenterDemoIds();
  const now = Math.floor(Date.now() / 1000);
  return db.transaction(() => {
    const buyer = db.prepare('SELECT id,email,role FROM users WHERE id=?').get(ids.buyer);
    const emailOwner = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get('procurement-presenter@mmc-demo.invalid');
    if ((buyer && (buyer.email !== 'procurement-presenter@mmc-demo.invalid' || buyer.role !== 'buyer')) ||
        (emailOwner && emailOwner.id !== ids.buyer)) {
      throw E.conflict('The isolated demo procurement identity conflicts with an existing account.');
    }
    if (!buyer) {
      db.prepare("INSERT INTO users(id,email,password_hash,name,company,role,country,plan_key,account_status) VALUES(?,?,?,?,?,'buyer','JO','free','active')")
        .run(ids.buyer, 'procurement-presenter@mmc-demo.invalid',
          '!demo-sso-only:' + crypto.randomBytes(48).toString('hex'),
          'MMC Demo Procurement Manager', 'MMC DEMO — Sample Procurement Organization');
    }
    const org = db.prepare('SELECT id,created_by FROM organizations WHERE id=?').get(ids.org);
    if (org && org.created_by !== ids.buyer) throw E.conflict('The demo organization is not owned by its isolated buyer identity.');
    if (!org) {
      db.prepare('INSERT INTO organizations(id,name,created_by,require_approval,country) VALUES(?,?,?,0,?)')
        .run(ids.org, 'MMC DEMO — Sample Procurement Organization', ids.buyer, 'JO');
    }
    const member = db.prepare('SELECT org_id FROM org_members WHERE user_id=?').get(ids.buyer);
    if (member && member.org_id !== ids.org) throw E.conflict('The demo buyer already belongs to another organization.');
    if (!member) db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES(?,?,'manager')").run(ids.org, ids.buyer);

    /* Synthetic demo-only fixture. It is not a real-world legal verification. */
    const verification = db.prepare('SELECT id,user_id,org_id FROM org_verifications WHERE id=? OR user_id=? OR org_id=?')
      .get(ids.verification, ids.buyer, ids.org);
    if (verification && (verification.id !== ids.verification || verification.user_id !== ids.buyer || verification.org_id !== ids.org)) {
      throw E.conflict('The demo verification fixture conflicts with another organization record.');
    }
    if (!verification) {
      db.prepare("INSERT INTO org_verifications(id,user_id,org_id,org_name,org_type,country,reg_number,official_phone,official_email,status,review_note,verified_at,expires_at,reviewed_at,submitted_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'verified',?,?,?,?,?,?)")
        .run(ids.verification, ids.buyer, ids.org, 'MMC DEMO — Sample Procurement Organization',
          'company', 'JO', 'DEMO-NOT-A-LEGAL-REGISTRATION', '+962600000000',
          'procurement-presenter@mmc-demo.invalid',
          'DEMO ONLY — synthetic fixture for isolated presentation; not a legal verification.',
          now, now + 365 * 86400, now, now, now);
    }
    return db.prepare('SELECT * FROM users WHERE id=?').get(ids.buyer);
  }).immediate();
}

router.get('/presenter-status', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE) throw E.notFound('Not found');
  assertDemoIdentity(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ demo: true, role: req.user.role, name: req.user.name, email: req.user.email });
}));

router.post('/switch-procurement', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE) throw E.notFound('Not found');
  assertDemoIdentity(req);
  const identity = ensureDemoProcurementIdentity();
  A.setSessionCookie(res, A.signToken(identity));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, redirect: '/org/' });
}));


function ensureDemoConsultantIdentity() {
  const db = getDB();
  const ids = presenterDemoIds();
  const email = 'consultant-presenter@mmc-demo.invalid';
  return db.transaction(() => {
    const byId = db.prepare('SELECT id,email,role FROM users WHERE id=?').get(ids.consultant);
    const byEmail = db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(email);
    if ((byId && (byId.email !== email || byId.role !== 'consultant')) ||
        (byEmail && byEmail.id !== ids.consultant)) {
      throw E.conflict('The isolated demo consultant identity conflicts with an existing account.');
    }
    if (!byId) {
      db.prepare("INSERT INTO users(id,email,password_hash,name,company,role,country,plan_key,account_status) VALUES(?,?,?,?,?,'consultant','JO','free','active')")
        .run(ids.consultant, email, '!demo-sso-only:' + crypto.randomBytes(48).toString('hex'),
          'MMC Demo Consultant', 'MMC DEMO — Sample Consulting Office');
    }
    return db.prepare('SELECT * FROM users WHERE id=?').get(ids.consultant);
  })();
}

router.post('/switch-consultant', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE) throw E.notFound('Not found');
  assertDemoIdentity(req);
  const identity = ensureDemoConsultantIdentity();
  A.setSessionCookie(res, A.signToken(identity));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, redirect: '/consulting/' });
}));

router.post('/switch-contractor', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE) throw E.notFound('Not found');
  assertDemoIdentity(req);
  const ids = presenterDemoIds();
  const identity = A.loadUser(ids.presenter);
  if (!identity || String(identity.email).toLowerCase() !== ALLOWED_EMAIL || identity.role !== 'contractor') {
    throw E.conflict('The MMC demo presenter contractor identity is not available.');
  }
  A.setSessionCookie(res, A.signToken(identity));
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, redirect: '/bid/' });
}));

// This issuer is enabled only on explicitly isolated preview environments.
router.post('/ai-ticket', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) throw E.notFound('Not found');
  assertDemoIdentity(req);
  const presenter = ticketIdentity(req);
  if (!presenter || String(presenter.email || '').toLowerCase() !== ALLOWED_EMAIL || presenter.role === 'admin') {
    throw E.forbidden('This account is not authorized for the demo presenter.');
  }
  const ticket = issueDemoTicket({
    user: presenter, audience: 'mmc-ai-staging', secret: config.DEMO_SSO_SECRET
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ticket, expiresIn: 90, destination: 'https://mmc-ai-staging.onrender.com/api/demo-sso/handoff' });
}));

router.get('/ai-handoff', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) throw E.notFound('Not found');
  assertDemoIdentity(req);
  const presenter = ticketIdentity(req);
  if (!presenter || String(presenter.email || '').toLowerCase() !== ALLOWED_EMAIL || presenter.role === 'admin') {
    throw E.forbidden('This account is not authorized for the demo presenter.');
  }
  const ticket = issueDemoTicket({
    user: presenter, audience: 'mmc-ai-staging', secret: config.DEMO_SSO_SECRET
  });
  const target = 'https://mmc-ai-staging.onrender.com/api/demo-sso/handoff#ticket=' + encodeURIComponent(ticket);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Opening MMC AI…</title><p>Opening your secure MMC AI demo session…</p><script>location.replace(' + JSON.stringify(target) + ');</script>');
}));

router.get('/vendor-handoff', A.requireAuth, wrap(async (req, res) => {
  if (!config.DEMO_MODE || !config.DEMO_SSO_SECRET) throw E.notFound('Not found');
  assertDemoIdentity(req);
  const presenter = ticketIdentity(req);
  if (!presenter || String(presenter.email || '').toLowerCase() !== ALLOWED_EMAIL || presenter.role === 'admin') {
    throw E.forbidden('This account is not authorized for the demo presenter.');
  }
  const ticket = issueDemoTicket({ user: presenter, audience: 'mmc-vendor-registry-preview', secret: config.DEMO_SSO_SECRET });
  const target = 'https://mmc-vendor-registry-preview.onrender.com/api/demo-sso/handoff#ticket=' + encodeURIComponent(ticket);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.type('html').send('<!doctype html><meta charset="utf-8"><title>Opening MMC Vendor Registry…</title><p>Opening your secure vendor registry demo…</p><script>location.replace(' + JSON.stringify(target) + ');</script>');
}));

module.exports = router;
