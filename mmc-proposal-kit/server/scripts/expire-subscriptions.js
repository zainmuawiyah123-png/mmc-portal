'use strict';
// تشغيل يدوي أو من Windows Task Scheduler / Linux cron عند الحاجة.
const { migrate } = require('../src/migrate');
const config = require('../src/config');
const { runSubscriptionExpiryJob } = require('../src/lib/scheduler');

migrate(config.DB_PATH);
const result = runSubscriptionExpiryJob();
console.log(JSON.stringify(result));
try { require('../src/db').closeDB(); } catch (_) {}
if (!result.ok) process.exitCode = 1;
