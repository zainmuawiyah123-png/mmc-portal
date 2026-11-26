'use strict';
/**
 * جدولة المهام داخل الخادم (node-cron).
 * تُفعّل بـ SCHEDULER_ENABLED=true.
 */
const cron = require('node-cron');
const path = require('path');
const config = require('../config');

let _jobs = [];
let _jobNames = [];
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

async function downloadR2Object(key) {
  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const required = ['BACKUP_S3_ENDPOINT','BACKUP_S3_BUCKET','BACKUP_S3_ACCESS_KEY_ID','BACKUP_S3_SECRET_ACCESS_KEY'];
  const missing = required.filter((k) => !config[k]);
  if (missing.length) throw new Error('إعدادات تنزيل نسخة R2 ناقصة: ' + missing.join(', '));
  const client = new S3Client({
    region: config.BACKUP_S3_REGION || 'auto',
    endpoint: config.BACKUP_S3_ENDPOINT,
    forcePathStyle: config.BACKUP_S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: config.BACKUP_S3_ACCESS_KEY_ID, secretAccessKey: config.BACKUP_S3_SECRET_ACCESS_KEY }
  });
  const response = await client.send(new GetObjectCommand({ Bucket: config.BACKUP_S3_BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
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
    const m = stdout.match(/portal-\d{8}-\d{6}\.db\.gz/);
    if (!m) throw new Error('Backup script did not report a completed archive.');

    // When R2 is enabled, test restore from the object downloaded from R2 itself.
    const cloudMatch = stdout.match(/رُفعت إلى R2:\s+(\S+)/);
    const useR2 = config.BACKUP_S3_ENABLED && config.BACKUP_UPLOAD;
    let restoreFile = m[0];
    let r2TempFile = null;
    if (useR2) {
      if (!cloudMatch) throw new Error('Backup was expected in R2, but the upload key was not reported.');
      const key = cloudMatch[1];
      const [archive, manifest] = await Promise.all([
        downloadR2Object(key),
        downloadR2Object(key + '.json')
      ]);
      r2TempFile = path.join(config.BACKUP_DIR, '.r2-restore-test-' + Date.now() + '-' + m[0]);
      require('fs').writeFileSync(r2TempFile, archive);
      require('fs').writeFileSync(r2TempFile + '.json', manifest);
      restoreFile = r2TempFile;
    }

    // Restore into a separate temporary database; never replace the live DB.
    const restoreScript = path.resolve(root, 'scripts', 'restore.js');
    const testPath = path.join(config.BACKUP_DIR, '.restore-test-' + Date.now() + '.db');
    try {
      const { stdout: restoreOut } = await run(process.execPath,
        [restoreScript, '--file=' + restoreFile, '--to=' + testPath],
        { cwd: root, timeout: 10 * 60 * 1000, env: process.env });
      if (!/الاستعادة ناجحة والبيانات سليمة/.test(restoreOut)) {
        throw new Error('Restore verification did not report a healthy restored database.');
      }
    } finally {
      const fs = require('fs');
      for (const file of [testPath, testPath + '-wal', testPath + '-shm',
        r2TempFile, r2TempFile && r2TempFile + '.json']) {
        if (file) { try { fs.unlinkSync(file); } catch (_) {} }
      }
    }

    const ms = Date.now() - started;
    record({ at: new Date().toISOString(), job: 'backup', ok: true, ms,
      message: m[0] + (useR2 ? ' | downloaded from R2 | SHA-256 and table counts verified | restore test passed' : ' | local archive | restore test passed') });
    return { ok: true, name: m[0], restoreTest: true, restoreSource: useR2 ? 'r2' : 'local', ms };
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
    console.log('[scheduler] بدء المصدر '+name);
    try { results[name]={ok:true,...await fn()}; }
    catch(err) { results[name]={ok:false,error:(err.message||String(err)).slice(0,300)}; }
    persistOpportunitySync(name,sourceStarted,results[name]);
    console.log('[scheduler] انتهاء المصدر '+name+' '+(results[name].ok?'OK':'ERROR')+' '+JSON.stringify(results[name])+' '+(Date.now()-sourceStarted)+'ms');
  };
  await runSource('gam',()=>require('./jordan-public-sources-sync').syncGAM());
  await runSource('austender',()=>require('./austender-sync').syncAusTender());
  // VendorPanel is a separate Australian public marketplace feed; keep it alongside AusTender.
  await runSource('vendorpanel-australia',()=>require('./vendorpanel-australia-sync').syncVendorPanelAustralia());
  await runSource('joneps',()=>require('./joneps-sync').syncJONEPS());
  await runSource('apc',()=>require('./apc-sync').syncAPC());
  await runSource('jprc',()=>require('./jprc-sync').syncJPRC());
  await runSource('nepco',()=>require('./nepco-sync').syncNEPCO());
  await runSource('jpmc',()=>require('./jpmc-curated-sync').syncJPMCCurated());
  await runSource('worldbank',()=>require('./opportunity-sync').syncWorldBank({rows:100,offset:0,pages:5}));
  if(config.UNGM_ACCESS_TOKEN) await runSource('ungm',()=>require('./ungm-sync').syncUNGM({accessToken:config.UNGM_ACCESS_TOKEN,rows:100,pages:5}));
  else { results.ungm={ok:false,skipped:true,error:'UNGM_ACCESS_TOKEN is not configured'}; persistOpportunitySync('ungm',Date.now(),results.ungm); }
  const ms=Date.now()-started;
  const failed=Object.entries(results).filter(([,v])=>!v.ok&&!v.skipped).map(([k])=>k);
  const summary=Object.entries(results).map(([k,v])=>k+': '+(v.ok?('+'+v.added+' / ~'+v.updated):v.skipped?'skipped':('ERROR '+v.error))).join(' | ');
  record({at:new Date().toISOString(),job:'opportunity-sync',ok:failed.length===0,ms,message:summary});
  return {ok:failed.length===0,partial:failed.length>0,failed,results,ms};
}

async function runUKOpportunitySyncJob() {
  const started=Date.now(), results={};
  const runSource=async(name,fn)=>{
    const sourceStarted=Date.now();
    console.log('[scheduler] بدء مصدر بريطانيا '+name);
    try { results[name]={ok:true,...await fn()}; }
    catch(err) { results[name]={ok:false,error:(err.message||String(err)).slice(0,300)}; }
    persistOpportunitySync(name,sourceStarted,results[name]);
    console.log('[scheduler] نتيجة بريطانيا '+name+' '+(results[name].ok?'OK':'ERROR')+' '+JSON.stringify(results[name])+' '+(Date.now()-sourceStarted)+'ms');
  };
  await runSource('findatender',()=>require('./uk-public-procurement-sync').syncFindATender({days:45,maxPages:20}));
  await runSource('contractsfinder',()=>require('./uk-public-procurement-sync').syncContractsFinder({days:30,maxPages:5}));
  await runSource('pcs',()=>require('./uk-public-procurement-sync').syncPublicContractsScotland({months:2}));
  await runSource('sell2wales',()=>require('./uk-public-procurement-sync').syncSell2Wales({months:2}));
  const failed=Object.entries(results).filter(([,v])=>!v.ok).map(([k])=>k);
  const summary=Object.entries(results).map(([k,v])=>k+': '+(v.ok?('+'+v.added+' / ~'+v.updated):('ERROR '+v.error))).join(' | ');
  record({at:new Date().toISOString(),job:'uk-opportunity-sync',ok:failed.length===0,ms:Date.now()-started,message:summary});
  return {ok:failed.length===0,partial:failed.length>0,failed,results,ms:Date.now()-started};
}

// Run both tender-source groups as one serialized cycle. This prevents the UK and
// general feeds from competing for the same SQLite database at the same cron tick.
let opportunityCycleRunning = false;
async function runOpportunitySyncCycle() {
  if (opportunityCycleRunning) {
    console.log('[scheduler] تخطي دورة المزامنة: توجد دورة أخرى قيد التنفيذ.');
    return { ok: false, skipped: true, reason: 'already-running' };
  }
  opportunityCycleRunning = true;
  try {
    const uk = await runUKOpportunitySyncJob();
    const general = await runOpportunitySyncJob();
    const failed = [...(uk.failed || []).map((x) => 'uk:' + x), ...(general.failed || [])];
    return { ok: failed.length === 0, partial: failed.length > 0, failed, uk, general };
  } finally {
    opportunityCycleRunning = false;
  }
}

function startScheduler() {
  const backupEnabled = config.BACKUP_SCHEDULER_ENABLED || config.SCHEDULER_ENABLED;
  if (!backupEnabled && !config.SCHEDULER_ENABLED && !config.OPPORTUNITY_SYNC_ENABLED) {
    console.log('[scheduler] معطّل (لا توجد مهام مجدولة مفعّلة)');
    return { enabled: false, opportunitySyncEnabled: false, backupEnabled: false, jobs: [] };
  }
  if ((backupEnabled && !cron.validate(config.BACKUP_CRON)) ||
      (config.SCHEDULER_ENABLED && !cron.validate(config.SUBSCRIPTION_EXPIRY_CRON)) ||
      (config.OPPORTUNITY_SYNC_ENABLED && !cron.validate(config.OPPORTUNITY_SYNC_CRON))) {
    console.error('[scheduler] تعبير cron غير صالح — لم تُجدول المهام');
    return { enabled: false, jobs: [], error: 'invalid cron' };
  }
  const jobs=[];
  const addJob=(name,expression,callback)=>{
    _jobs.push(cron.schedule(expression,callback,{timezone:config.BACKUP_TZ,name}));
    _jobNames.push(name);jobs.push(name);
  };
  if (backupEnabled) {
    addJob('db-backup',config.BACKUP_CRON,()=>{
      console.log('[scheduler] بدء النسخة الاحتياطية المجدولة...');
      runBackupJob().catch((e)=>console.error('[scheduler] خطأ النسخ:',e.message));
    });
    console.log('[scheduler] ✓ النسخة الاحتياطية مجدولة: "' + config.BACKUP_CRON + '" (' + config.BACKUP_TZ + ')');
    if (config.BACKUP_RUN_ON_START) {
      setTimeout(()=>runBackupJob().catch((e)=>console.error('[scheduler] نسخة الإقلاع:',e.message)),15000).unref();
      console.log('[scheduler] ✓ نسخة تحقق واحدة بعد الإقلاع مفعّلة');
    }
  }
  if (config.SCHEDULER_ENABLED) {
    addJob('subscription-expiry',config.SUBSCRIPTION_EXPIRY_CRON,()=>{
      console.log('[scheduler] فحص الاشتراكات المنتهية...');
      runSubscriptionExpiryJob();
    });
    if (require('./jofotara').enabled()) {
      addJob('jofotara-retry','*/15 * * * *',()=>{require('./jofotara').processPending().catch((e)=>console.error('[scheduler] الفوترة الوطنية:',e.message));});
      const miss=require('./jofotara').missingConfig();
      console.log('[scheduler] ✓ إرسال الفوترة الوطنية مفعّل'+(miss.length?' — إعدادات ناقصة: '+miss.join('، '):''));
    }
    if (require('./mailer').enabled()) {
      addJob('mail-outbox','*/10 * * * *',()=>{require('./mailer').flush().catch((e)=>console.error('[scheduler] البريد:',e.message));});
      console.log('[scheduler] ✓ إعادة إرسال البريد المعلّق كل 10 دقائق');
    }
    console.log('[scheduler] ✓ انتهاء الاشتراكات مجدول: "' + config.SUBSCRIPTION_EXPIRY_CRON + '" (' + config.BACKUP_TZ + ')');
  }
  if (config.OPPORTUNITY_SYNC_ENABLED) {
    addJob('opportunity-sync',config.OPPORTUNITY_SYNC_CRON,()=>{
      console.log('[scheduler] بدء دورة مزامنة العطاءات (بريطانيا ثم بقية المصادر)...');
      runOpportunitySyncCycle().catch(e=>console.error('[scheduler] دورة مزامنة العطاءات:',e.message));
    });
    setTimeout(()=>runOpportunitySyncCycle().catch(e=>console.error('[scheduler] دورة المزامنة الأولية:',e.message)),25000).unref();
    console.log('[scheduler] ✓ دورة مزامنة العطاءات مجدولة: "'+config.OPPORTUNITY_SYNC_CRON+'" ('+config.BACKUP_TZ+')');
  }
  _jobNames = jobs;
  return { enabled: true, jobs, cron: config.BACKUP_CRON,
    backupEnabled, subscriptionExpiryEnabled: config.SCHEDULER_ENABLED,
    subscriptionExpiryCron: config.SUBSCRIPTION_EXPIRY_CRON,
    opportunitySyncEnabled: config.OPPORTUNITY_SYNC_ENABLED,
    opportunitySyncCron: config.OPPORTUNITY_SYNC_CRON, tz: config.BACKUP_TZ };
}

function stopScheduler() {
  _jobs.forEach((j) => { try { j.stop(); } catch (_) {} });
  _jobs = [];
  _jobNames = [];
  console.log('[scheduler] أُوقفت كل المهام.');
}

function schedulerStatus() {
  return { enabled: config.SCHEDULER_ENABLED, backupEnabled: config.BACKUP_SCHEDULER_ENABLED || config.SCHEDULER_ENABLED, cron: config.BACKUP_CRON,
    subscriptionExpiryCron: config.SUBSCRIPTION_EXPIRY_CRON, timezone: config.BACKUP_TZ,
    opportunitySyncEnabled: config.OPPORTUNITY_SYNC_ENABLED, jobs: _jobNames.slice(),
    active: _jobs.length > 0, running: _jobs.length, lastRun: _lastRun };
}

module.exports = { startScheduler, stopScheduler, schedulerStatus, runBackupJob, runSubscriptionExpiryJob, runOpportunitySyncJob, runUKOpportunitySyncJob, runOpportunitySyncCycle, persistOpportunitySync };
