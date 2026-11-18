'use strict';

/**
 * MMC AI — illustrative demo project.
 * All figures are invented for demonstration. They are NOT reference prices,
 * productivity rates or real tender data, and the project says so in its description.
 */
const { parseBoqRows, parseCsv } = require('./boq-import');

const DEMO_MARKER = '[MMC_DEMO]';
const DEMO_NAME = 'مشروع تجريبي — مبنى إداري (بيانات توضيحية)';
const DEMO_DESCRIPTION = DEMO_MARKER + ' مشروع توضيحي لاستكشاف المنصة. جميع الكميات والأسعار والمدد والمخاطر مُختلقة للعرض فقط وليست مرجعاً للتسعير أو التخطيط.';

const BOQ_CSV = [
  'رقم البند;البيان;الوحدة;الكمية;سعر الوحدة',
  'أعمال الحفر والردم;;;;',
  '1.1;حفر عام للأساسات;م3;1250;4.5',
  '1.2;ردم ودمك بمواد مختارة;م3;420;7',
  'أعمال الخرسانة;;;;',
  '2.1;خرسانة عادية تحت القواعد;م3;85;68',
  '2.2;خرسانة مسلحة للقواعد والأعمدة;م3;310;92',
  '2.3;حديد تسليح;طن;38;640',
  'أعمال البناء والتشطيبات;;;;',
  '3.1;جدران بلوك سماكة 20 سم;م2;1850;14',
  '3.2;لياسة داخلية;م2;3600;6.5',
  '3.3;دهان داخلي;م2;3600;3.2',
  'الأعمال الكهربائية والميكانيكية;;;;',
  '4.1;مجرى هواء تكييف;م;420;28',
  '4.2;مواسير صرف صحي;م;260;11',
  '4.3;كابلات كهرباء رئيسية;م;900;9.5'
].join('\n');

// code, name, duration (working days), predecessor codes
const TASKS = [
  ['T01', 'تجهيز الموقع', 7, []],
  ['T02', 'الحفر العام', 10, ['T01']],
  ['T03', 'الخرسانة العادية', 4, ['T02']],
  ['T04', 'القواعد والأعمدة', 20, ['T03']],
  ['T05', 'البلاطات والسقف', 25, ['T04']],
  ['T06', 'بناء الجدران', 20, ['T05']],
  ['T07', 'أعمال الكهرباء الأولية', 18, ['T06']],
  ['T08', 'أعمال التكييف والصرف الأولية', 22, ['T06']],
  ['T09', 'اللياسة', 15, ['T07', 'T08']],
  ['T10', 'البلاط والدهان', 20, ['T09']],
  ['T11', 'الاختبارات والتسليم', 7, ['T10']]
];

// code, title, category, description, probability(1-5), impact(1-5), mitigation
const RISKS = [
  ['R01', 'تأخر توريد حديد التسليح', 'procurement', 'ارتفاع الطلب أو تقلب الأسعار قد يؤخر وصول الحديد قبل مرحلة القواعد.', 3, 4, 'حجز الكميات مبكراً مع مورّدين اثنين على الأقل وتحديد سعر ثابت.'],
  ['R02', 'ظروف تربة غير متوقعة', 'technical', 'قد يظهر صخر أو مياه جوفية أثناء الحفر مختلفاً عن تقرير التربة.', 2, 5, 'مراجعة تقرير التربة وتخصيص بند احتياطي للحفر في الصخر.'],
  ['R03', 'تعارض بين المخططات المعمارية والميكانيكية', 'design', 'قد تتعارض مسارات المجاري مع الجسور أو الارتفاعات.', 3, 3, 'تنسيق المخططات قبل التنفيذ وعقد اجتماع تنسيق تخصصات.'],
  ['R04', 'تأخر اعتماد المواد من الاستشاري', 'contract', 'تأخر الاعتماد يوقف أعمال التشطيب المرتبطة.', 4, 2, 'تقديم طلبات الاعتماد مبكراً وتتبعها أسبوعياً.']
];

function findExisting(db, userId) {
  return db.prepare(`SELECT p.id FROM ai_projects p JOIN ai_project_members m ON m.project_id=p.id
    WHERE m.user_id=? AND m.role='owner' AND p.description LIKE ? ORDER BY p.created_at LIMIT 1`).get(userId, DEMO_MARKER + '%');
}

/** Creates the demo project once per user; returns { projectId, reused }. */
function createDemoProject(db, userId, uid) {
  const existing = findExisting(db, userId);
  if (existing) return { projectId: existing.id, reused: true };
  const parsed = parseBoqRows(parseCsv(BOQ_CSV));
  if (!parsed.ok || parsed.rejected.length) throw new Error('Demo BOQ failed validation.');
  const projectId = uid('aip_');
  db.transaction(() => {
    db.prepare('INSERT INTO ai_projects(id,name,description,country,currency,created_by) VALUES(?,?,?,?,?,?)')
      .run(projectId, DEMO_NAME, DEMO_DESCRIPTION, 'JO', 'JOD', userId);
    db.prepare("INSERT INTO ai_project_members(project_id,user_id,role,invited_by) VALUES(?,?,'owner',?)").run(projectId, userId, userId);
    const addBoq = db.prepare('INSERT INTO ai_boq_items(id,project_id,item_code,description,unit,quantity,rate,created_by) VALUES(?,?,?,?,?,?,?,?)');
    for (const r of parsed.accepted) addBoq.run(uid('aiboq_'), projectId, r.itemCode, r.description, r.unit, r.quantity, r.rate, userId);
    const idByCode = new Map(TASKS.map(t => [t[0], uid('aisch_')]));
    const addTask = db.prepare('INSERT INTO ai_schedule_tasks(id,project_id,task_code,name,duration_days,predecessors_json,created_by) VALUES(?,?,?,?,?,?,?)');
    for (const [code, name, days, preds] of TASKS) addTask.run(idByCode.get(code), projectId, code, name, days, JSON.stringify(preds.map(c => idByCode.get(c))), userId);
    const addRisk = db.prepare('INSERT INTO ai_project_risks(id,project_id,risk_code,title,category,description,probability,impact,mitigation,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const [code, title, cat, desc, p, i, mit] of RISKS) addRisk.run(uid('airisk_'), projectId, code, title, cat, desc, p, i, mit, userId);
    db.prepare('INSERT INTO ai_audit_log(id,project_id,actor_user_id,action,entity_type,entity_id,detail_json) VALUES(?,?,?,?,?,?,?)')
      .run(uid('aial_'), projectId, userId, 'demo_project_created', 'project', projectId, JSON.stringify({boq: parsed.accepted.length, tasks: TASKS.length, risks: RISKS.length}));
  })();
  return { projectId, reused: false };
}

module.exports = { createDemoProject, DEMO_MARKER, DEMO_NAME, TASKS, RISKS, BOQ_CSV };
