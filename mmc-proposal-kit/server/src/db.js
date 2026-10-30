'use strict';
/**
 * طبقة قاعدة البيانات — فتح الاتصال، ومساعدات موحّدة.
 */
const Database = require('better-sqlite3');
const config = require('./config');

let _db = null;

function getDB() {
  if (_db) return _db;
  _db = new Database(config.DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  return _db;
}

/** يقفل الوصول — للاختبارات */
function closeDB() {
  if (_db) { _db.close(); _db = null; }
}

function uid(prefix = '') {
  const { randomUUID } = require('crypto');
  return prefix + randomUUID();
}

/** -1 يعني غير محدود في جدول الباقات */
const unlimited = (n) => n === -1 || n === null || n === undefined;

module.exports = { getDB, closeDB, uid, unlimited };
