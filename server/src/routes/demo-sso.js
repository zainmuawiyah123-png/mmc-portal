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

module.exports = router;
