'use strict';

/**
 * MMC AI — Deterministic layer → discipline classifier (expanded + bug-fixed).
 *
 * Maps CAD / DXF / IFC layer names to a discipline and element category.
 * Priority order (highest first):
 *   1. Explicit user layerMap (never overridden)
 *   2. AIA / US-NCS / ISO style prefixes (A-, S-, E-, M-, P-, FP-, C-, L-, H-…)
 *   3. Keyword tables (English + Arabic + common Gulf/Jordan abbreviations)
 *   4. Fallback → unclassified
 *
 * Nothing is guessed. Unmatched layers stay unclassified so the engineer
 * can map them by hand. All quantities remain draft until human review.
 *
 * Bug fixes applied (see CHANGELOG-FIXES.md):
 *   - BACKFILL / EARTH-FILL no longer misclassified as annotation (was hitting FILL substring)
 *   - Bare Arabic "ري" removed — was matching inside طريق / مجاري / خريطة / مريض
 *   - HYDR added to fire_protection keyword (was missing — hydrants w/o FP- prefix fell to unclassified)
 *   - PUMP (English) added to mechanical keyword (was missing — only Arabic مضخة was listed)
 *   - جدران (plural) added to walls + architectural (was missing — only singular جدار)
 *   - مجاري added to plumbing keyword (was missing — caused مجاري to fall through to landscape)
 *   - طريق (singular) added to civil keyword (was missing — only plural طرق was listed)
 *   - Word boundaries on FILL / SOLID / MARK in annotation regex
 */

const DISCIPLINES = Object.freeze([
  'architectural',
  'structural',
  'electrical',
  'mechanical',
  'plumbing',
  'fire_protection',
  'civil',
  'landscape',
  'unclassified'
]);

/** Short discipline labels for UI (ar / en). */
const DISCIPLINE_LABELS = Object.freeze({
  architectural:   { ar: 'معماري',          en: 'Architectural' },
  structural:      { ar: 'إنشائي',          en: 'Structural' },
  electrical:      { ar: 'كهرباء',          en: 'Electrical' },
  mechanical:      { ar: 'ميكانيك / تكييف', en: 'Mechanical / HVAC' },
  plumbing:        { ar: 'صحي / سباكة',     en: 'Plumbing' },
  fire_protection: { ar: 'إطفاء وحريق',     en: 'Fire Protection' },
  civil:           { ar: 'مدني / موقع',     en: 'Civil / Site' },
  landscape:       { ar: 'تنسيق مواقع',     en: 'Landscape' },
  unclassified:    { ar: 'غير مصنف',        en: 'Unclassified' }
});

/**
 * Prefix → discipline (AIA / US-NCS / common CAD conventions).
 * Longer prefixes are checked first.
 */
const PREFIX_DISCIPLINE = Object.freeze([
  ['FP', 'fire_protection'],
  ['FS', 'fire_protection'],
  ['EL', 'electrical'],
  ['ME', 'mechanical'],
  ['PL', 'plumbing'],
  ['ST', 'structural'],
  ['AR', 'architectural'],
  ['LA', 'landscape'],
  ['LD', 'landscape'],
  ['A',  'architectural'],
  ['I',  'architectural'],   // Interior
  ['S',  'structural'],
  ['E',  'electrical'],
  ['M',  'mechanical'],
  ['H',  'mechanical'],      // HVAC
  ['P',  'plumbing'],
  ['F',  'fire_protection'],
  ['C',  'civil'],
  ['L',  'landscape'],
  ['G',  'civil']            // General / grading
]);

/**
 * Category rules: [regex (tested on UPPER layer name), category, quantity basis]
 * Order matters — first match wins. More specific patterns should come first.
 */
const CATEGORY_RULES = Object.freeze([
  // ── Earthwork backfill — MUST be before annotation (BACKFILL contains "FILL") ──
  [/BACKFILL|EARTH.?FILL|FILL.?DIRT|ردميات|ردم\b/,                       'backfill',       'closed_area'],

  // ── Annotation / non-quantity (always first after earthwork) ──────────
  // Word boundaries on FILL/SOLID/MARK so BACKFILL / SOLIDIFY / LANDMARK etc. don't match here.
  [/PATT|HATCH|\bFILL\b|\bSOLID\b|TEXT|ANNO|DIMS?\b|DIM-|IDEN|TTLB|TITLE|GRID|SYMB|NPLT|DEFPOINTS|VIEWPORT|XREF|LEGEND|NOTE|REVS?\b|REV\b|CLOUD|\bMARK\b|TAG\b/,
    'annotation_or_pattern', 'excluded'],

  // ── High-specificity equipment (before generic walls/roofs/pipes) ──────
  [/AHU|FCU|VAV|وحدة مناولة|وحدة تكييف/,           'ahu_fcu',        'count'],
  [/CHILL|مبرد/,                                    'chillers',       'count'],
  [/BOILER|غلاية|سخان/,                             'boilers',        'count'],
  [/PUMP|مضخة|مضخات/,                               'pumps',          'count'],
  [/FAN|مروحة|مراوح/,                               'fans',           'count'],
  [/PANEL|DB\b|MSB|لوح|لوحة توزيع|لوحة كهرب/,       'panels',         'count'],
  [/UPS|مولد|GENERATOR|GEN\b/,                      'generators_ups', 'count'],
  [/SPRK|SPRINK|رشاش|رشاشات/,                       'sprinklers',     'count'],
  [/HYDR|صنبور حريق|مأخذ حريق/,                     'hydrants',       'count'],
  [/FIRE.?ALARM|إنذار حريق|كاشف/,                   'fire_alarm',     'count'],
  [/HOSE|خرطوم حريق/,                               'hose_reels',     'count'],
  [/EXTING|طفاية|طفايات/,                           'extinguishers',  'count'],
  [/FIRE.?DOOR|باب حريق/,                           'fire_doors',     'count'],
  [/CCTV|كاميرا|مراقبة/,                            'cctv',           'count'],
  [/ACCESS|تحكم دخول|قارئ/,                         'access_control', 'count'],
  [/SWITCH|مفتاح|مفاتيح/,                           'switches',       'count'],
  [/EQPM|EQUIP|معدة|معدات|جهاز|أجهزة/,              'equipment',      'count'],
  [/TANK|خزان|صهريج/,                               'tanks',          'count'],
  [/MANHOLE|غرفة تفتيش|منهل/,                       'manholes',       'count'],
  [/VALVE|صمام|محبس/,                               'valves',         'count'],
  [/FIXT|SANITARY|أدوات صحية|مغسلة|مرحاض|دش/,       'sanitary_fixtures','count'],
  [/DIFF|GRILL|DIFFUSER|فتحة هواء|شبكة هواء/,       'diffusers',      'count'],
  [/TOIL|TOILET|WC\b|حمام|دورة مياه/,               'toilets',        'count'],
  [/FURN|FURNITURE|أثاث|موبيليا/,                   'furniture',      'count'],
  [/TREE|شجرة|أشجار|نخيل/,                          'trees',          'count'],
  [/GATE|بوابة|بوابات/,                             'gates',          'count'],

  // ── Structural elements ────────────────────────────────────────────────
  [/COLS?\b|COLM|COLUMN|أعمدة|عمود|COL-/,           'columns',        'closed_area'],
  [/BEAM|BEAMS|كمرات|كمرة|جائز|جائزات/,             'beams',          'linework_length'],
  [/FNDN|FOOT|FOUND|FOUNDATION|قواعد|أساسات|أساس/,  'foundations',    'closed_area'],
  [/SLAB|بلاطة|بلاطات|سقف خرساني|FLOR-SLAB/,        'slabs',          'closed_area'],
  [/REBAR|REINF|حديد|تسليح|STEEL.?BAR/,             'reinforcement',  'weight'],
  [/SHEAR.?WALL|جدار قص|حائط قص/,                   'shear_walls',    'closed_area'],
  [/CORE|نواة|نوى/,                                 'cores',          'closed_area'],
  [/PILE|خوازيق|خازوق/,                             'piles',          'count'],
  [/RETAIN|حائط ساند|جدار ساند/,                    'retaining_walls','linework_length'],

  // ── Architectural elements ─────────────────────────────────────────────
  [/WALL|جدار|جدران|حائط|قواطع|PARTITION|PTN\b/,      'walls',          'linework_length'],
  [/DOOR|باب|أبواب|DR\b/,                           'doors',          'count'],
  [/GLAZ|WIND|WINDOW|CURT|CURTAIN|زجاج|نافذة|نوافذ/, 'glazing',        'linework_length'],
  [/STAIR|STRS|درج|سلالم/,                          'stairs',         'linework_length'],
  [/HRAL|HANDRAIL|RAIL|درابزين|حاجز/,               'handrails',      'linework_length'],
  [/FLOR|FLOOR|أرضية|أرضيات|بلاط أرض/,              'floors',         'closed_area'],
  [/CLNG|CEIL|سقف مستعار|سقف معلق|سقوف/,            'ceilings',       'closed_area'],
  [/(?:^|[-_\s])ROOF(?:$|[-_\s])|سطح|أسطح/,          'roof',           'closed_area'],
  [/CASE|CASEWORK|خزائن|كابينة/,                    'casework',       'linework_length'],
  [/FINISH|تشطيب|لياسة|دهان|طلاء|بلاط حائط/,        'finishes',       'closed_area'],

  // ── Linear MEP ─────────────────────────────────────────────────────────
  [/CABL|WIRE|CNDT|CONDUIT|كابل|أسلاك|مواسير كهرب/, 'cables_conduits','linework_length'],
  [/TRAY|LADR|حامل كابلات|صينية/,                   'cable_trays',    'linework_length'],
  [/LITE|LIGHT|LGHT|إنارة|إضاءة|لمبة|كشاف/,         'lighting',       'count'],
  [/POWR|POWER|RECP|SOCK|مقبس|مآخذ|طاقة/,           'power_devices',  'count'],
  [/EARTH|تأريض|أرضي/,                              'earthing',       'linework_length'],
  [/DATA|VOICE|COMM|اتصالات|بيانات|شبكة/,           'data_comms',     'linework_length'],
  [/DUCT|مجرى هواء|مجرى|هواء/,                       'ducts',          'linework_length'],
  [/CHW|مياه مبردة/,                                'chilled_water',  'linework_length'],
  [/HHW|HOT.?WATER|مياه ساخنة/,                     'hot_water',      'linework_length'],
  [/EXHAUST|شفاط|عادم/,                             'exhaust',        'linework_length'],
  [/INSUL|عزل|عوازل/,                               'insulation',     'linework_length'],
  [/SANR|SANI|SEWR|SEWER|\bDRAN\b|\bDRAIN\b|\bWAST\b|\bVENT\b|صرف|مجاري|تهوية صرف|مواسير صرف/, 'drainage', 'linework_length'],
  [/DOMW|HOTW|COLD|WATR|WATER|مياه|تغذية|مواسير مياه|مواسير تغذية/, 'water_supply', 'linework_length'],
  [/PIPE|PIPING|مواسير|أنابيب/,                     'pipes',          'linework_length'],

  // ── Civil / Site ───────────────────────────────────────────────────────
  [/ROAD|طريق|طرق|شارع/,                           'roads',          'linework_length'],
  [/PAVE|رصف|بلاط خارجي/,                           'paving',         'closed_area'],
  [/CURB|رصيف|حافة/,                                'curbs',          'linework_length'],
  [/GRAD|LEVEL|منسوب|تسوية/,                        'grading',        'closed_area'],
  [/FENCE|سور|سياج/,                                'fencing',        'linework_length'],
  [/PARK|موقف|مواقف/,                               'parking',        'closed_area'],
  [/EXCAV|حفر|حفريات/,                              'excavation',     'closed_area'],
  [/BACKFILL|ردم|ردميات/,                           'backfill',       'closed_area'],

  // ── Landscape ──────────────────────────────────────────────────────────
  [/PLANT|نبات|نباتات|شجيرات/,                      'planting',       'closed_area'],
  [/IRRIG|شبكة ري/,                                 'irrigation',     'linework_length'],
  [/LAWN|عشب|مسطح أخضر/,                            'lawn',           'closed_area']
]);

/**
 * Keyword → discipline (fallback when no prefix matches).
 * Tested against the upper-cased layer name. Arabic + English + Gulf abbreviations.
 */
const KEYWORD_DISCIPLINE = Object.freeze([
  // Electrical
  [/ELEC|كهرب|POWER|LIGHT|CABLE|كابل|إنارة|لوحة|مقبس|مآخذ|تأريض|مولد|UPS|CCTV|كاميرا|اتصالات|بيانات|شبكة|SWITCH|PANEL|DB\b|MSB/,
    'electrical'],
  // Mechanical / HVAC — includes English PUMP (was missing, only مضخة was listed)
  [/HVAC|DUCT|MECH|AIR|PUMP|ميكانيك|تكييف|مجرى|تهوية|AHU|FCU|VAV|CHILL|شفاط|مروحة|غلاية|مضخة|عزل|DIFFUSER|فتحة هواء/,
    'mechanical'],
  // Plumbing — added مجاري (was missing — caused مجاري to fall through to landscape via "ري")
  [/PLUMB|SANIT|SEWER|DRAIN|WATER|صرف|مجاري|سباك|صحي|مياه|مواسير|أنابيب|مغسلة|مرحاض|صمام|خزان|غرفة تفتيش|تهوية صرف/,
    'plumbing'],
  // Fire protection — added HYDR (was missing — hydrant layers without FP- prefix or "fire" word fell to unclassified)
  [/FIRE|SPRINK|HYDR|حريق|اطفاء|إطفاء|رشاش|صنبور حريق|إنذار حريق|طفاية|باب حريق|خرطوم/,
    'fire_protection'],
  // Structural
  [/STRUC|COLUMN|BEAM|SLAB|FOOT|إنشائ|انشائ|خرسان|حديد|قواعد|أعمدة|بلاطة|كمرة|تسليح|خوازيق|حائط ساند|نواة|REBAR|REINF/,
    'structural'],
  // Architectural — added جدران (plural, was missing)
  [/ARCH|WALL|DOOR|WINDOW|معمار|جدار|جدران|باب|نافذة|تشطيب|لياسة|دهان|سقف مستعار|درابزين|أثاث|خزائن|قواطع|PARTITION/,
    'architectural'],
  // Civil / Site — added طريق (singular, was missing — only طرق plural was listed)
  [/CIVIL|ROAD|SITE|موقع|طريق|طرق|مدني|حفر|ردم|رصف|رصيف|سور|بوابة|موقف|تسوية|GRAD|EXCAV|PAVE|FENCE/,
    'civil'],
  // Landscape — removed bare "ري" (was matching inside طريق / مجاري / خريطة / مريض etc.)
  [/LANDSC|TREE|PLANT|IRRIG|LAWN|شجرة|نبات|شبكة ري|عشب|تنسيق|نخيل|مسطح أخضر/,
    'landscape']
]);

/**
 * Classify a single layer name.
 * @param {string} layerName
 * @param {Object} [layerMap]  user overrides: { "A-WALL": { discipline, category?, basis? } }
 * @returns {{ layer, discipline, category, basis, source }}
 */
function classifyLayer(layerName, layerMap = {}) {
  const name = String(layerName ?? '0').trim() || '0';
  const upper = name.toUpperCase().replace(/[\u064B-\u0652\u0670\u0640]/g, ''); // strip Arabic diacritics

  // 1. Explicit user map always wins
  if (Object.prototype.hasOwnProperty.call(layerMap, name)) {
    const m = layerMap[name];
    const discipline = DISCIPLINES.includes(m?.discipline) ? m.discipline : 'unclassified';
    return {
      layer: name,
      discipline,
      category: m?.category || 'user_mapped',
      basis: m?.basis || 'linework_length',
      source: 'user_map'
    };
  }
  // also try exact upper-case key
  if (Object.prototype.hasOwnProperty.call(layerMap, upper)) {
    const m = layerMap[upper];
    const discipline = DISCIPLINES.includes(m?.discipline) ? m.discipline : 'unclassified';
    return {
      layer: name,
      discipline,
      category: m?.category || 'user_mapped',
      basis: m?.basis || 'linework_length',
      source: 'user_map'
    };
  }

  // 2. Category first (so annotation / patterns are caught even without discipline)
  let category = 'general';
  let basis = 'linework_length';
  for (const [re, c, b] of CATEGORY_RULES) {
    if (re.test(upper) || re.test(name)) {
      category = c;
      basis = b;
      break;
    }
  }

  // 3. Prefix (AIA / NCS style)
  let discipline = null;
  let source = 'none';
  for (const [prefix, disc] of PREFIX_DISCIPLINE) {
    const re = new RegExp('^' + prefix + '[-_\\.\\s]', 'i');
    if (re.test(upper) || upper === prefix) {
      discipline = disc;
      source = 'prefix';
      break;
    }
  }

  // 4. Keyword fallback
  if (!discipline) {
    for (const [re, disc] of KEYWORD_DISCIPLINE) {
      if (re.test(upper) || re.test(name)) {
        discipline = disc;
        source = 'keyword';
        break;
      }
    }
  }

  // Annotation layers with no discipline stay unclassified + excluded
  if (!discipline) {
    return {
      layer: name,
      discipline: 'unclassified',
      category: category === 'general' ? 'unclassified' : category,
      basis: (category === 'annotation_or_pattern' || category === 'unclassified') ? 'excluded' : basis,
      source: 'none'
    };
  }

  // Annotation / patterns never produce quantities — force excluded + unclassified
  if (category === 'annotation_or_pattern') {
    return { layer: name, discipline: 'unclassified', category, basis: 'excluded', source: source || 'annotation' };
  }

  return { layer: name, discipline, category, basis, source };
}

/**
 * Group takeoff rows by discipline and category.
 * Lengths are raw CAD linework — never net quantities.
 * Every group carries a reviewNote so the engineer knows the status.
 */
function summarizeByDiscipline(rows, layerMap = {}) {
  const out = {};
  const classCache = new Map();

  for (const row of rows) {
    const layer = row.layer ?? row.layer_name ?? '0';
    if (!classCache.has(layer)) {
      classCache.set(layer, classifyLayer(layer, layerMap));
    }
    const c = classCache.get(layer);

    const d = out[c.discipline] || (out[c.discipline] = {
      discipline: c.discipline,
      label: DISCIPLINE_LABELS[c.discipline] || { ar: c.discipline, en: c.discipline },
      categories: {},
      layers: new Set()
    });
    d.layers.add(layer);

    const cat = d.categories[c.category] || (d.categories[c.category] = {
      category: c.category,
      basis: c.basis,
      entities: 0,
      linework_length_m: 0,
      closed_area_m2: 0,
      closed_shapes: 0,
      layers: new Set(),
      reviewNote: c.basis === 'excluded'
        ? 'مستبعد من الكميات (تعليقات / أنماط / غير مصنف). Excluded from quantities.'
        : 'أطوال CAD خام — ليست كمية صافية. تحتاج مراجعة مهندس وقاعدة قياس. Raw CAD linework — not a net quantity.'
    });
    cat.layers.add(layer);
    cat.entities++;

    const detail = row.detail || (row.detail_json ? safeJson(row.detail_json) : row);
    const unit = row.unit ?? detail.unit;
    const quantity = Number(row.quantity ?? detail.quantity ?? 0);

    if (unit === 'm' && Number.isFinite(quantity)) {
      cat.linework_length_m += quantity;
    }
    const area = Number(detail.area_m2 || detail.area || 0);
    if (area > 0) {
      cat.closed_area_m2 += area;
      cat.closed_shapes++;
    }
  }

  return Object.values(out)
    .map(d => ({
      discipline: d.discipline,
      label: d.label,
      layers: [...d.layers].sort(),
      categories: Object.values(d.categories)
        .map(c => ({
          ...c,
          layers: [...c.layers].sort(),
          linework_length_m: Math.round(c.linework_length_m * 1000) / 1000,
          closed_area_m2: Math.round(c.closed_area_m2 * 1000) / 1000
        }))
        .sort((a, b) => b.entities - a.entities)
    }))
    .sort((a, b) => DISCIPLINES.indexOf(a.discipline) - DISCIPLINES.indexOf(b.discipline));
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = {
  classifyLayer,
  summarizeByDiscipline,
  DISCIPLINES,
  DISCIPLINE_LABELS
};
