'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mmc-scheduler-'));
process.env.NODE_ENV = 'test';
process.env.BACKUP_DIR = path.join(TMP, 'backups');
process.env.SCHEDULER_ENABLED = 'false';
process.env.OPPORTUNITY_SYNC_ENABLED = 'true';
process.env.OPPORTUNITY_SYNC_CRON = '15 */6 * * *';
const scheduler = require('../src/lib/scheduler');

test('opportunity source sync can run without enabling backup or subscription schedules', () => {
  const started = scheduler.startScheduler();
  assert.equal(started.enabled, true);
  assert.deepEqual(started.jobs, ['opportunity-sync']);
  const active = scheduler.schedulerStatus();
  assert.equal(active.enabled, false);
  assert.equal(active.opportunitySyncEnabled, true);
  assert.equal(active.active, true);
  assert.deepEqual(active.jobs, ['opportunity-sync']);
  scheduler.stopScheduler();
  assert.equal(scheduler.schedulerStatus().active, false);
});
