'use strict';
/**
 * بيانات اختبار للنسخ الاحتياطي والاستعادة.
 * تُنشئ مستخدمين وعطاءات وملفات وطلبات بكميات معروفة للمقارنة.
 */
process.chdir('/workspace/portal-server-v5');
const path = require('path');
const { getDB } = require(path.resolve(__dirname, '..', 'src', 'db'));
const db = getDB();
const now = Math.floor(Date.now() / 1000);

const users = ['usr_b1', 'usr_b2', 'usr_b3'];
const tenders = [];
const files = [];
const reqs = [];

for (const uid of users) {
  db.prepare('INSERT OR IGNORE INTO users (id,email,password_hash,name,company,plan_key,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(uid, uid + '@test.com', '$2b$10$abcdefghijklmnopqrstuv', 'مستخدم ' + uid, 'شركة ' + uid, 'free', now);
}

for (let i = 0; i < 6; i++) {
  const tid = 'tnd_b' + i;
  tenders.push(tid);
  db.prepare('INSERT OR REPLACE INTO tenders (id,user_id,name,authority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(tid, users[i % 3], 'عطاء رقم ' + i, 'جهة ' + i, i % 2 ? 'ready' : 'new', now, now);
}

for (let i = 0; i < 14; i++) {
  const fid = 'fil_b' + i;
  files.push(fid);
  db.prepare(`INSERT OR REPLACE INTO files
    (id,tender_id,user_id,name,stored_name,rel_path,storage_key,storage_driver,checksum_sha256,category,size,mime,uploaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(fid, tenders[i % 6], users[i % 3], 'file' + i + '.pdf', 's' + i + '.pdf',
      'users/' + users[i % 3] + '/tenders/' + tenders[i % 6] + '/s' + i + '.pdf',
      'users/' + users[i % 3] + '/tenders/' + tenders[i % 6] + '/s' + i + '.pdf',
      'local', 'sum' + i, 'arch', 1000 + i, 'application/pdf', now);
}

for (let i = 0; i < 5; i++) {
  const rid = 'req_b' + i;
  reqs.push(rid);
  db.prepare('INSERT OR REPLACE INTO requests (id,tender_id,user_id,kind,text,status,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(rid, tenders[i % 6], users[i % 3], 'note', 'طلب رقم ' + i, 'open', now);
}

const counts = {};
for (const t of ['users', 'tenders', 'files', 'requests', 'plans', 'audit_log']) {
  counts[t] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;
}
console.log('SEEDED:', JSON.stringify(counts));
