'use strict';

/**
 * Conservative first-stage scope coverage classifier.
 * This discovers evidence in document metadata/text; it does NOT calculate
 * quantities or prove that a discipline is absent from a project.
 */
const DISCIPLINES = Object.freeze({
  general: ['general notes', 'site plan', 'specification', 'scope of work', 'ملاحظات عامة', 'مخطط الموقع', 'المواصفات'],
  earthworks: ['earthwork', 'earth works', 'grading', 'excavation', 'backfill', 'cut and fill', 'contour', 'profile', 'حفر', 'ردم', 'تسوية', 'مناسيب', 'قطاعات'],
  structural: ['structural', 'foundation', 'reinforcement', 'rebar', 'bar bending', 'concrete', 'steel framing', 'إنشائي', 'تسليح', 'خرسانة', 'قواعد', 'أعمدة'],
  architectural: ['architectural', 'floor finish', 'door schedule', 'window schedule', 'elevation', 'partition', 'ceiling', 'finishes', 'معماري', 'أبواب', 'شبابيك', 'تشطيبات', 'بلاط', 'قصارة'],
  electrical: ['electrical', 'single line', 'panel schedule', 'lighting', 'power layout', 'cable tray', 'earthing', 'كهرباء', 'إنارة', 'لوحة توزيع', 'كابلات', 'تأريض'],
  mechanical_hvac: ['hvac', 'mechanical', 'ductwork', 'air conditioning', 'ventilation', 'ahu', 'chiller', 'تكييف', 'تهوية', 'مجاري هواء'],
  plumbing_drainage: ['plumbing', 'sanitary', 'drainage', 'stormwater', 'water supply', 'soil pipe', 'sewer', 'صحي', 'صرف صحي', 'مياه', 'تصريف', 'مناهل'],
  fire_protection: ['fire protection', 'firefighting', 'sprinkler', 'fire alarm', 'hose reel', 'مكافحة الحريق', 'رشاشات', 'إنذار حريق'],
  low_current: ['low current', 'telecom', 'data network', 'cctv', 'access control', 'public address', 'تيار خفيف', 'اتصالات', 'كاميرات', 'تحكم بالدخول'],
  infrastructure: ['road', 'highway', 'pavement', 'culvert', 'bridge', 'retaining wall', 'utility corridor', 'طريق', 'جسر', 'عبارة', 'جدار استنادي', 'بنية تحتية'],
  specialist: ['equipment schedule', 'process piping', 'instrumentation', 'lift', 'elevator', 'irrigation', 'landscape', 'معدات', 'أنابيب صناعية', 'أجهزة قياس', 'مصاعد', 'ري', 'تنسيق موقع']
});

function normalize(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\u064B-\u065F\u0670]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function discoverProjectScope(documents = []) {
  if (!Array.isArray(documents)) throw new TypeError('documents must be an array');
  const evidence = Object.fromEntries(Object.keys(DISCIPLINES).map(key => [key, []]));
  for (const doc of documents) {
    if (!doc || typeof doc !== 'object') continue;
    const fields = ['fileName', 'title', 'discipline', 'sheetNumber', 'drawingNumber', 'description', 'extractedText'];
    const sourceText = normalize(fields.map(field => doc[field] || '').join(' '));
    if (!sourceText) continue;
    for (const [discipline, terms] of Object.entries(DISCIPLINES)) {
      const matches = terms.filter(term => sourceText.includes(normalize(term)));
      if (matches.length) evidence[discipline].push({
        documentId: doc.id || null,
        fileName: doc.fileName || null,
        matchedTerms: matches
      });
    }
  }
  const coverage = Object.entries(evidence).map(([discipline, sources]) => ({
    discipline,
    status: sources.length ? 'evidence_detected' : 'not_evidenced',
    evidenceCount: sources.length,
    sources
  }));
  return {
    status: 'discovery_preliminary',
    documentCount: documents.length,
    disciplines: coverage,
    limitations: [
      'التصنيف مبني على بيانات المستندات والنصوص المتاحة فقط، ولا يمثل فهماً هندسياً كاملاً للمخططات.',
      'عدم ظهور دليل لا يعني أن التخصص غير مطلوب أو غير موجود في المشروع.',
      'يلزم تحليل الرسومات والجداول والمواصفات وربطها قبل اعتماد نطاق الأعمال أو حساب الكميات.'
    ]
  };
}

module.exports = { DISCIPLINES, discoverProjectScope };
