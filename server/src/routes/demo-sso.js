'use strict';
const express = require('express');
const config = require('../config');
const A = require('../lib/auth');
const { issueDemoTicket, ALLOWED_EMAIL } = require('../lib/demo-sso');
const { E, wrap } = require('../lib/errors');

const router = express.Router();

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
  res.json({ ticket, expiresIn: 90, destination: 'https://mmc-ai-staging.onrender.com/api/demo-sso/exchange' });
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
