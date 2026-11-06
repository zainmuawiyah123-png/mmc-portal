'use strict';
/**
 * جدولة المهام داخل الخادم (node-cron).
 * تُفعّل بـ SCHEDULER_ENABLED=true.
 */
const cron = require('node-cron');
const path = require('path');
const config = require('../config');

let _jobs = [];
let _lastRun = null;

function record(entry) {
  _lastRun = entry;
  const status = entry.ok ? 'OK  ' : 'FAIL';
  const line = '[' + entry.at + '] ' + status + ' ' + entry.job + '  ' + (entry.ms || 0) + 'ms  ' + entry.message + '\n';
  try {
    const fs = require('fs');
    fs.mkdirSync(config.BACKUP_DIR, { recursive: true });
    fs.appendFileSync(path.join(config.BACKUP_DIR, 'scheduler.log'), line);
  } catch (_) {}
  console.log('[scheduler] ' + line.trim());
}

async function runBackupJob() {
  const started = Date.now();
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const run = promisify(execFile);
    const root = path.resolve(__dirname, '..', '..');
    const scriptPath = path.resolve(root, 'scripts', 'backup.js');
    const { stdout } = await run(process.execPath, [scriptPath], {
      cwd: root, timeout: 10 * 60 * 1000, env: process.env
    });
    const ms = Date.now() - started;
    const m = stdout.match(/portal-\d{8}-\d{6}\.db\.gz/);
    record({ at: new Date().toISOString(), job: 'backup', ok: true, ms,
      message: m ? m[0] : 'done' });
    return { ok: true, name: m ? m[0] : null, ms };
  } catch (err) {
    const ms = Date.now() - started;
    record({ at: new Date().toISOString(), job: 'backup', ok: false, ms,
      message: (err.message || String(err)).slice(0, 300) });
    return { ok: false, error: err.message, ms };
  }
}

/** ينقل الاشتراكات المنتهية إلى expired ويعيد المستخدم للباقة المجانية */
function runSubscriptionExpiryJob() {
  const started = Date.now();
  try {
    const { getDB } = require('../db');
    const db = getDB();
    const now = Math.floor(Date.now() / 1000);
    const expired = db.prepare(`SELECT id, user_id, plan_key FROM subscriptions
      WHERE status = 'active' AND ends_at IS NOT NULL AND ends_at <= ?`).all(now);
    const tx = db.transaction(() => {
      for (const sub of expired) {
        db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ? AND status = 'active'").run(sub.id);
        db.prepare(`UPDATE users SET plan_key = 'free', plan_started_at = ?
          WHERE id = ? AND plan_key = ?
          AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = users.id AND s.status = 'active')`)
          .run(now, sub.user_id, sub.plan_key);
      }
    });
    tx();
    const ms = Date.now() - started;
    record({ at: new Date().toISOString(), job: 'subscription-expiry', ok: true, ms,
      message: 'expired=' + expired.length });
    return { ok: true, expired: expired.length, ms };
  } catch (err) {
    const ms = Date.now() - started;
    record({ at: new Date().toISOString(), job: 'subscription-expiry', ok: false, ms,
      message: (err.message || String(err)).slice(0, 300) });
    return { ok: false, error: err.message, ms };
  }
}


function persistOpportunitySync(source, startedAt, result) {
  try {
    const { getDB, uid } = require('../db');
    const db=getDB(), finishedAt=Math.floor(Date.now()/1000);
    db.prepare(`INSERT INTO opportunity_sync_runs
      (id,source_key,started_at,finished_at,status,received,added,updated,duration_ms,error)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      uid('sync_'), source, Math.floor(startedAt/1000), finishedAt,
      result.skipped?'skipped':result.ok?'success':'failed',
      Number(result.received)||0, Number(result.added)||0, Number(result.updated)||0,
      Math.max(0,Date.now()-startedAt), result.error?String(result.error).slice(0,500):null
    );
    db.prepare(`DELETE FROM opportunity_sync_runs WHERE source_key=? AND id NOT IN (SELECT id FROM opportunity_sync_runs WHERE source_key=? ORDER BY finished_at DESC LIMIT 1000)`).run(source,source);
  } catch(err) {
    console.error('[scheduler] تعذر حفظ سجل مزامنة '+source+':',err.message);
  }
}

async function runOpportunitySyncJob() {
  const started=Date.now(), results={};
  const runSource=async(name,fn)=>{
    const sourceStarted=Date.now();
    try { results[name]={ok:true,...await fn()}; }
    catch(err) { results[name]={ok:false,error:(err.message||String(err)).slice(0,300)}; }
    persistOpportunitySync(name,sourceStarted,results[name]);
  };
  await runSource('joneps',()=>require('./joneps-sync').syncJONEPS());
  await runSource('apc',()=>require('./apc-sync').syncAPC());
  await runSource('worldbank',()=>require('./opportunity-sync').syncWorldBank({rows:100,offset:0,pages:5}));
  if(config.UNGM_ACCESS_TOKEN) await runSource('ungm',()=>require('./ungm-sync').syncUNGM({accessToken:config.UNGM_ACCESS_TOKEN,rows:100,pages:5}));
  else { results.ungm={ok:false,skipped:true,error:'UNGM_ACCESS_TOKEN is not configured'}; persistOpportunitySync('ungm',Date.now(),results.ungm); }
  const ms=Date.now()-started;
  const failed=Object.entries(results).filter(([,v])=>!v.ok).map(([k])=>k);
  const summary=Object.entries(results).map(([k,v])=>k+': '+(v.ok?('+'+v.added+' / ~'+v.updated):v.skipped?'skipped':('ERROR '+v.error))).join(' | ');
  record({at:new Date().toISOString(),job:'opportunity-sync',ok:failed.length===0,ms,message:summary});
  return {ok:failed.length===0,partial:failed.length>0,failed,results,ms};
}

function startScheduler() {
  // The World Bank feed has its own switch so it can run without enabling
  // unrelated backup/subscription jobs.
  if (!config.SCHEDULER_ENABLED && !config.OPPORTUNITY_SYNC_ENABLED) {
    console.log('[scheduler] معطّل (لا توجد مهام مجدولة مفعّلة)');
    return { enabled: false, jobs: [] };
  }
  if ((config.SCHEDULER_ENABLED &&
       (!cron.validate(config.BACKUP_CRON) || !cron.validate(config.SUBSCRIPTION_EXPIRY_CRON))) ||
      (config.OPPORTUNITY_SYNC_ENABLED && !cron.validate(config.OPPORTUNITY_SYNC_CRON))) {
    console.error('[scheduler] تعبير cron غير صالح — لم تُجدول المهام');
    return { enabled: false, jobs: [], error: 'invalid cron' };
  }

  const jobs = [];
  if (config.SCHEDULER_ENABLED) {
    const backupJob = cron.schedule(config.BACKUP_CRON, () => {
      console.log('[scheduler] بدء النسخة الاحتياطية المجدولة...');
      runBackupJob().catch((e) => console.error('[scheduler] خطأ النسخ:', e.message));
    }, { timezone: config.BACKUP_TZ, name: 'db-backup' });
    const expiryJob = cron.schedule(config.SUBSCRIPTION_EXPIRY_CRON, () => {
      console.log('[scheduler] فحص الاشتراكات المنتهية...');
      runSubscriptionExpiryJob();
    }, { timezone: config.BACKUP_TZ, name: 'subscription-expiry' });
    _jobs.push(backupJob, expiryJob);
    jobs.push('db-backup', 'subscription-expiry');

    if (require('./jofotara').enabled()) {
      _jobs.push(cron.schedule('*/15 * * * *', () => {
        require('./jofotara').processPending().catch((e) => console.error('[scheduler] الفوترة الوطنية:', e.message));
      }, { timezone: config.BACKUP_TZ, name: 'jofotara-retry' }));
    }
    if (require('./mailer').enabled()) {
      _jobs.push(cron.schedule('*/10 * * * *', () => {
        require('./mailer').flush().catch((e) => console.error('[scheduler] البريد:', e.message));
      }, { timezone: config.BACKUP_TZ, name: 'mail-outbox' }));
    }
    console.log('[scheduler] ✓ النسخة الاحتياطية مجدولة: "' + config.BACKUP_CRON + '" (' + config.BACKUP_TZ + ')');
    console.log('[scheduler] ✓ انتهاء الاشتراكات مجدول: "' + config.SUBSCRIPTION_EXPIRY_CRON + '" (' + config.BACKUP_TZ + ')');
  }

  if (config.OPPORTUNITY_SYNC_ENABLED) {
    const worldBankJob = cron.schedule(config.OPPORTUNITY_SYNC_CRON, async () => {
      const started = Date.now();
      try {
        const result = await require('./opportunity-sync').syncWorldBank({ rows: 100, offset: 0, pages: 5 });
        persistOpportunitySync('worldbank', started, { ok: true, ...result });
        console.log('[scheduler] مزامنة البنك الدولي: received=' + result.received + ', added=' + result.added + ', updated=' + result.updated + ', total=' + result.total + ', open=' + result.open + ', closed=' + result.closed + ', cancelled=' + result.cancelled);
      } catch (err) {
        persistOpportunitySync('worldbank', started, { ok: false, error: err.message || String(err) });
        console.error('[scheduler] فشلت مزامنة البنك الدولي:', err.message);
      }
    }, { timezone: config.BACKUP_TZ, name: 'worldbank-opportunity-sync' });
    _jobs.push(worldBankJob);
    jobs.push('worldbank-opportunity-sync');

    // Initial import after boot; this does not enable unrelated scheduler tasks.
    setTimeout(async () => {
      const started = Date.now();
      try {
        const result = await require('./opportunity-sync').syncWorldBank({ rows: 100, offset: 0, pages: 5 });
        persistOpportunitySync('worldbank', started, { ok: true, ...result });
        console.log('[scheduler] المزامنة الأولية للبنك الدولي: received=' + result.received + ', added=' + result.added + ', updated=' + result.updated + ', total=' + result.total + ', open=' + result.open + ', closed=' + result.closed + ', cancelled=' + result.cancelled);
      } catch (err) {
        persistOpportunitySync('worldbank', started, { ok: false, error: err.message || String(err) });
        console.error('[scheduler] فشلت المزامنة الأولية للبنك الدولي:', err.message);
      }
    }, 20000).unref();
    console.log('[scheduler] ✓ مزامنة البنك الدولي مجدولة: "' + config.OPPORTUNITY_SYNC_CRON + '" (' + config.BACKUP_TZ + ')');
  }

  console.log('[scheduler] ✓ المهام المفعّلة: ' + jobs.join(', '));
  return { enabled: true, jobs,
    opportunitySyncEnabled: config.OPPORTUNITY_SYNC_ENABLED,
    opportunitySyncCron: config.OPPORTUNITY_SYNC_CRON, tz: config.BACKUP_TZ };
}

function stopScheduler() {
  _jobs.forEach((j) => { try { j.stop(); } catch (_) {} });
  _jobs = [];
  console.log('[scheduler] أُوقفت كل المهام.');
}

function schedulerStatus() {
  return { enabled: config.SCHEDULER_ENABLED, cron: config.BACKUP_CRON,
    subscriptionExpiryCron: config.SUBSCRIPTION_EXPIRY_CRON, timezone: config.BACKUP_TZ,
    running: _jobs.length, lastRun: _lastRun };
}

module.exports = { startScheduler, stopScheduler, schedulerStatus, runBackupJob, runSubscriptionExpiryJob, runOpportunitySyncJob, persistOpportunitySync };
