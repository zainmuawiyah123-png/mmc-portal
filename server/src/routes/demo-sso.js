'use strict';
const express=require('express'),crypto=require('crypto'),rateLimit=require('express-rate-limit');
const config=require('../config'),A=require('../lib/auth'),{getDB}=require('../db'),{E,wrap}=require('../lib/errors');
const {consumeDemoTicket,ALLOWED_EMAIL}=require('../lib/demo-sso');
const router=express.Router(), limiter=rateLimit({windowMs:15*60*1000,max:20,standardHeaders:true,legacyHeaders:false});
const DESTINATION='/mmc-ai/index.html?page=dashboard', AUDIENCE='mmc-ai-staging';
const enabled=()=>config.DEMO_MODE===true&&typeof config.DEMO_SSO_SECRET==='string'&&config.DEMO_SSO_SECRET.length>=32;
router.get('/handoff',(req,res)=>{
 if(!enabled())return res.sendStatus(404);
 res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
 res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening MMC AI</title><p id="s">Verifying your secure MMC AI demo session…</p><script>(async()=>{const s=document.getElementById('s'),t=new URLSearchParams(location.hash.slice(1)).get('ticket');history.replaceState(null,'',location.pathname);if(!t){s.textContent='Demo link missing or expired. Return to MMC and open MMC AI again.';return;}try{const r=await fetch('/api/demo-sso/handoff',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:t})}),d=await r.json();if(!r.ok||!d.ok)throw Error(d.error?.message||'Unable to verify session');location.replace(d.redirect)}catch(e){s.textContent=e.message}})()</script>`);
});
router.post('/handoff',limiter,wrap(async(req,res)=>{
 if(!enabled())throw E.notFound('Not found');
 const token=String(req.body?.ticket||'');if(token.length<40||token.length>4096)throw E.unauthorized('Invalid or expired demo ticket');
 let ticket;try{ticket=consumeDemoTicket({db:getDB(),token,audience:AUDIENCE,secret:config.DEMO_SSO_SECRET})}catch(_){throw E.unauthorized('This demo link is invalid, expired, or already used. Return to MMC and open MMC AI again.')}
 if(ticket.email!==ALLOWED_EMAIL)throw E.forbidden('Unauthorized demo identity');
 const db=getDB(),id='demo_ai_presenter_'+crypto.createHash('sha256').update(ALLOWED_EMAIL).digest('hex').slice(0,24);
 const user=db.transaction(()=>{
  const byId=db.prepare('SELECT id,email,role FROM users WHERE id=?').get(id),byEmail=db.prepare('SELECT id FROM users WHERE lower(email)=lower(?)').get(ALLOWED_EMAIL);
  if((byId&&(String(byId.email).toLowerCase()!==ALLOWED_EMAIL||byId.role!=='contractor'))||(byEmail&&byEmail.id!==id))throw E.conflict('Demo identity conflicts with an existing account');
  if(!byId)db.prepare("INSERT INTO users(id,email,password_hash,name,company,role,country,plan_key) VALUES(?,?,?,?,?,'contractor','JO','free')").run(id,ALLOWED_EMAIL,'!demo-sso-only:'+crypto.randomBytes(48).toString('hex'),'MMC Demo Presenter','MMC DEMO — Isolated MMC AI Workspace');
  db.prepare('UPDATE users SET last_login_at=unixepoch() WHERE id=?').run(id);return db.prepare('SELECT id,email FROM users WHERE id=?').get(id);
 }).immediate();
 A.setSessionCookie(res,A.signToken(user));res.setHeader('Cache-Control','no-store');res.json({ok:true,demo:true,redirect:DESTINATION});
}));
module.exports=router;
