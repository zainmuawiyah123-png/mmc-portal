/* MMC AI engines — browser bundle (auto-generated, bug-fixed v2).
 * Source: server/src/lib/mmc-ai/*.js (pure JS, no Node APIs).
 * Bundled for standalone demo mode. Exposed as window.MmcAi.
 * Also injects neubuild.ai-style images into page placeholders.
 */
(function() {
  'use strict';
  const __mods = {};
  function require(p) { return __mods[p] || {}; }

  // ===== discipline-measurement-kernels.js =====
  (function() {
    const module = { exports: {} };
    const exports = module.exports;
/**
 * Further deterministic measurement kernels for architectural and MEP work.
 * Inputs must already be interpreted and classified from approved project
 * evidence. Fittings, bends, supports and accessories require schedules or
 * explicit geometry; these functions never invent them.
 */
const round = value => Number(value.toFixed(6));
const positive = (value, label) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(label + ' must be a finite number greater than zero');
};
const nonNegative = (value, label) => {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(label + ' must be a finite non-negative number');
};

function calculateMasonryWall({ walls } = {}) {
  if (!Array.isArray(walls) || walls.length === 0) throw new TypeError('at least one classified wall is required');
  let grossAreaM2 = 0, openingsAreaM2 = 0, netAreaM2 = 0, netVolumeM3 = 0;
  const rows = walls.map((wall, index) => {
    if (!wall) throw new TypeError('wall ' + index + ' is required');
    positive(wall.lengthM, 'wall lengthM');
    positive(wall.heightM, 'wall heightM');
    positive(wall.thicknessMm, 'wall thicknessMm');
    const gross = wall.lengthM * wall.heightM;
    const openings = Array.isArray(wall.openings) ? wall.openings : [];
    const openingArea = openings.reduce((sum, opening, openingIndex) => {
      if (!opening) throw new TypeError('opening ' + openingIndex + ' is required');
      positive(opening.widthM, 'opening widthM');
      positive(opening.heightM, 'opening heightM');
      return sum + opening.widthM * opening.heightM;
    }, 0);
    if (openingArea > gross + 1e-9) throw new RangeError('opening area cannot exceed wall gross area');
    const net = gross - openingArea;
    const volume = net * wall.thicknessMm / 1000;
    grossAreaM2 += gross; openingsAreaM2 += openingArea; netAreaM2 += net; netVolumeM3 += volume;
    return { wallId: wall.wallId || null, grossAreaM2: round(gross), openingDeductionsM2: round(openingArea), netAreaM2: round(net), thicknessMm: wall.thicknessMm, netVolumeM3: round(volume), openingCount: openings.length };
  });
  return {
    method: 'classified_wall_area_with_opening_deductions',
    ruleId: 'MASONRY-NET-WALL-AREA-VOLUME',
    ruleVersion: '1.0',
    formula: 'Net wall area = Σ(length × height − measured openings); volume = net area × thickness',
    grossAreaM2: round(grossAreaM2),
    openingDeductionsM2: round(openingsAreaM2),
    netAreaM2: round(netAreaM2),
    netVolumeM3: round(netVolumeM3),
    rows,
    limitations: ['Opening deduction policy and minimum deduction thresholds must follow the contract measurement standard.', 'Lintels, jambs, sills, reinforcement and wall ties are separate measured items.']
  };
}

function calculateRectangularDuctwork(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('duct segments are required');
  let totalLengthM = 0, totalSurfaceAreaM2 = 0;
  const rows = segments.map((segment, index) => {
    if (!segment) throw new TypeError('duct segment ' + index + ' is required');
    positive(segment.lengthM, 'duct lengthM');
    positive(segment.widthMm, 'duct widthMm');
    positive(segment.heightMm, 'duct heightMm');
    const widthM = segment.widthMm / 1000, heightM = segment.heightMm / 1000;
    const perimeterM = 2 * (widthM + heightM);
    const areaM2 = perimeterM * segment.lengthM;
    totalLengthM += segment.lengthM; totalSurfaceAreaM2 += areaM2;
    return { segmentId: segment.segmentId || null, lengthM: round(segment.lengthM), widthMm: segment.widthMm, heightMm: segment.heightMm, externalSurfaceAreaM2: round(areaM2), material: segment.material || null, pressureClass: segment.pressureClass || null };
  });
  return {
    method: 'straight_rectangular_duct_external_surface',
    ruleId: 'HVAC-RECTANGULAR-DUCT-SURFACE',
    ruleVersion: '1.0',
    formula: 'External surface area = Σ[2 × (width + height) × straight length], dimensions converted to metres',
    totalLengthM: round(totalLengthM),
    externalSurfaceAreaM2: round(totalSurfaceAreaM2),
    rows,
    limitations: ['Fittings, transitions, elbows, branches, dampers, flanges, stiffeners, supports and insulation are not inferred; measure from coordinated details or schedules.', 'This is external surface area for straight rectangular duct segments, not a complete duct fabrication takeoff.']
  };
}

function calculateRoutedServices(segments, { serviceType, explicitAllowancePercent = 0 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) throw new TypeError('routed service segments are required');
  if (!['pipe', 'cable', 'conduit'].includes(serviceType)) throw new TypeError('serviceType must be pipe, cable or conduit');
  nonNegative(explicitAllowancePercent, 'explicitAllowancePercent');
  if (explicitAllowancePercent > 100) throw new RangeError('explicit allowance cannot exceed 100 percent');
  let baseLengthM = 0;
  const rows = segments.map((segment, index) => {
    if (!segment) throw new TypeError('segment ' + index + ' is required');
    positive(segment.lengthM, 'segment lengthM');
    const parallelRuns = segment.parallelRuns === undefined ? 1 : segment.parallelRuns;
    if (!Number.isInteger(parallelRuns) || parallelRuns <= 0) throw new TypeError('parallelRuns must be a positive integer');
    const measured = segment.lengthM * parallelRuns;
    baseLengthM += measured;
    return { routeId: segment.routeId || null, segmentLengthM: segment.lengthM, parallelRuns, measuredLengthM: round(measured), size: segment.size || null, material: segment.material || null, circuitOrSystem: segment.circuitOrSystem || null };
  });
  const allowanceM = baseLengthM * explicitAllowancePercent / 100;
  return {
    method: 'measured_route_segments_with_explicit_allowance',
    ruleId: serviceType.toUpperCase() + '-ROUTE-LENGTH',
    ruleVersion: '1.0',
    formula: 'Measured length = Σ(segment length × parallel runs); allowance added only when explicitly specified',
    serviceType,
    baseLengthM: round(baseLengthM),
    explicitAllowancePercent,
    allowanceM: round(allowanceM),
    totalLengthM: round(baseLengthM + allowanceM),
    rows,
    limitations: ['Route geometry and segment lengths must come from coordinated layouts, risers, schematics or model data.', 'Fittings, joints, terminations, valves, cable glands, supports and accessories are separate schedule/detail takeoffs.', 'No default slack, waste or routing allowance is assumed.']
  };
}

module.exports = { calculateMasonryWall, calculateRectangularDuctwork, calculateRoutedServices };

    __mods['./discipline-measurement-kernels'] = module.exports;
  })();

  // ===== discipline-layer-classifier.js =====
  (function() {
    const module = { exports: {} };
    const exports = module.exports;
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

    __mods['./discipline-layer-classifier'] = module.exports;
  })();

  // ===== discipline-quantity-rules.js =====
  (function() {
    const module = { exports: {} };
    const exports = module.exports;
/**
 * MMC AI — Discipline quantity rules (proposed / needs_review).
 *
 * Converts classified CAD takeoff rows into *proposed* engineering quantities
 * using explicit, documented rules. Raw linework is NEVER treated as a net BOQ
 * quantity without stated assumptions.
 *
 * Design principles:
 *  - Every output carries formula, assumptions, limitations, and reviewState.
 *  - Missing height / thickness / diameter → quantity stays "incomplete", not guessed.
 *  - Openings, fittings, waste, laps are only applied when explicitly provided.
 *  - Double-line walls, centre-line vs face-of-wall, and hatch fills are flagged.
 */

const { classifyLayer } = require('./discipline-layer-classifier');
const {
  calculateMasonryWall,
  calculateRectangularDuctwork,
  calculateRoutedServices
} = require('./discipline-measurement-kernels');

const round = (v, d = 3) => Number(Number(v).toFixed(d));

/** Default engineering assumptions (explicit, overridable per project). */
const DEFAULTS = Object.freeze({
  wallHeightM: null,          // must be provided — never invent storey height
  wallThicknessMm: null,      // must be provided
  wallIsCentreLine: true,     // CAD wall often drawn on centre line
  ductWidthMm: null,
  ductHeightMm: null,
  pipeNominalDiaMm: null,
  cableParallelRuns: 1,
  explicitWastePercent: 0,    // never apply default waste
  openingAreaM2: 0,
  /** Openings smaller than this area (m²) are NOT deducted (measurement standard threshold). */
  minOpeningDeductionM2: 0.5
});

/**
 * Rule catalogue: category → how to propose a quantity from CAD evidence.
 * basis from classifier: linework_length | closed_area | count | weight | excluded
 */
const RULES = Object.freeze({
  // ── Architectural ──────────────────────────────────────────────────────
  walls: {
    discipline: 'architectural',
    name: { ar: 'جدران', en: 'Walls' },
    required: ['heightM', 'thicknessMm'],
    propose(rows, opts) {
      const heightM = num(opts.heightM ?? opts.wallHeightM);
      const thicknessMm = num(opts.thicknessMm ?? opts.wallThicknessMm);
      if (!heightM || !thicknessMm) {
        return incomplete('walls', rows, 'heightM and thicknessMm required (storey height + wall thickness). CAD length alone is not net wall area.');
      }
      const totalLength = sumLength(rows);

      // Build openings list: explicit list wins; else derive from linked door/window evidence.
      const openings = buildWallOpenings(opts);
      const skippedOpenings = openings._skippedBelowThreshold || [];
      const minThreshold = openings._minOpeningDeductionM2 != null ? openings._minOpeningDeductionM2 : (num(opts.minOpeningDeductionM2) ?? 0.5);
      const walls = [{
        wallId: 'CAD-AGG',
        lengthM: totalLength,
        heightM,
        thicknessMm,
        openings
      }];
      try {
        const r = calculateMasonryWall({ walls });
        const openingSource = openings.length
          ? (opts.openings && opts.openings.length
            ? 'explicit openings list'
            : 'derived from door/window counts × typical sizes')
          : 'none — gross area only';
        return pack('walls', r, rows, {
          assumptions: [
            'Wall length taken from summed CAD linework on wall layers',
            opts.wallIsCentreLine !== false
              ? 'CAD likely centre-line; face-of-wall length may differ — verify'
              : 'Length treated as face-of-wall as stated by user',
            `Height = ${heightM} m (user/project input)`,
            `Thickness = ${thicknessMm} mm (user/project input)`,
            `Openings source: ${openingSource}`,
            openings.length ? `${openings.length} opening(s) deducted · total ${r.openingDeductionsM2} m²` : 'No openings deducted',
            `Minimum opening threshold = ${minThreshold} m² — smaller openings not deducted`,
            skippedOpenings.length ? `${skippedOpenings.length} opening(s) skipped (below threshold)` : 'No openings skipped for threshold'
          ],
          proposed: [
            { key: 'grossAreaM2', label: { ar: 'المساحة الإجمالية', en: 'Gross wall area' }, value: r.grossAreaM2, unit: 'm2' },
            { key: 'openingDeductionsM2', label: { ar: 'خصم الفتحات', en: 'Opening deductions' }, value: r.openingDeductionsM2, unit: 'm2' },
            { key: 'netAreaM2', label: { ar: 'صافي مساحة الجدران', en: 'Net wall area' }, value: r.netAreaM2, unit: 'm2' },
            { key: 'netVolumeM3', label: { ar: 'صافي حجم البناء', en: 'Net masonry volume' }, value: r.netVolumeM3, unit: 'm3' },
            { key: 'openingCount', label: { ar: 'عدد الفتحات المخصومة', en: 'Openings deducted' }, value: openings.length, unit: 'nr' },
            { key: 'skippedOpeningCount', label: { ar: 'فتحات دون الحد الأدنى', en: 'Openings below threshold' }, value: skippedOpenings.length, unit: 'nr' },
            { key: 'minOpeningDeductionM2', label: { ar: 'حد الخصم الأدنى', en: 'Min opening threshold' }, value: minThreshold, unit: 'm2' }
          ],
          extra: {
            openingsDetail: openings.map((o, i) => ({
              index: i + 1,
              widthM: o.widthM,
              heightM: o.heightM,
              areaM2: round(o.widthM * o.heightM),
              source: o.source || 'explicit',
              label: o.label || null,
              deducted: true
            })),
            skippedOpeningsDetail: skippedOpenings.map((o, i) => ({
              index: i + 1,
              widthM: o.widthM,
              heightM: o.heightM,
              areaM2: o.areaM2 != null ? o.areaM2 : round(o.widthM * o.heightM),
              source: o.source || 'explicit',
              label: o.label || null,
              deducted: false,
              reason: o.reason || 'below_min_opening_threshold'
            })),
            policy: {
              ar: `الخصم = مجموع (عرض × ارتفاع) لكل فتحة ≥ ${minThreshold} m². الفتحات الأصغر لا تُخصم (حد أدنى حسب سياسة القياس). لا يُخصم أقل من صفر ولا يتجاوز المساحة الإجمالية. العتبات والأفاريز والوزرات بنود منفصلة.`,
              en: `Deduction = Σ(width × height) for each opening ≥ ${minThreshold} m². Smaller openings are not deducted (measurement-standard minimum). Never negative; never exceeds gross area. Lintels, jambs and sills are separate items.`
            }
          }
        });
      } catch (err) {
        return incomplete('walls', rows, err.message);
      }
    }
  },

  doors: {
    discipline: 'architectural',
    name: { ar: 'أبواب', en: 'Doors' },
    required: [],
    propose(rows) {
      const count = rows.length || sumCount(rows);
      return pack('doors', { method: 'entity_count', ruleId: 'DOOR-COUNT', formula: 'Count of door entities / blocks on door layers' }, rows, {
        assumptions: ['Each CAD entity/block on door layers counted once', 'Leaf size, frame and ironmongery not inferred'],
        proposed: [{ key: 'count', label: { ar: 'عدد الأبواب', en: 'Door count' }, value: count, unit: 'nr' }]
      });
    }
  },

  glazing: {
    discipline: 'architectural',
    name: { ar: 'زجاج / نوافذ', en: 'Glazing / Windows' },
    required: ['heightM'],
    propose(rows, opts) {
      const heightM = num(opts.heightM);
      const length = sumLength(rows);
      if (!heightM) return incomplete('glazing', rows, 'heightM required to convert sill line length to glazed area.');
      const area = round(length * heightM);
      return pack('glazing', { method: 'line_length_x_height', ruleId: 'GLAZING-LENGTH-HEIGHT', formula: 'Area ≈ Σ(line length × height)' }, rows, {
        assumptions: [`Height = ${heightM} m`, 'Mullions, frames and openable sashes not deducted unless scheduled'],
        proposed: [
          { key: 'lengthM', label: { ar: 'طول الخط', en: 'Line length' }, value: round(length), unit: 'm' },
          { key: 'areaM2', label: { ar: 'مساحة تقريبية', en: 'Approx. area' }, value: area, unit: 'm2' }
        ]
      });
    }
  },

  floors: {
    discipline: 'architectural',
    name: { ar: 'أرضيات', en: 'Floors' },
    required: [],
    propose(rows) {
      const area = sumArea(rows);
      if (area <= 0) return incomplete('floors', rows, 'No closed-area geometry on floor layers. Hatch/fill is not used as quantity.');
      return pack('floors', { method: 'closed_polyline_area', ruleId: 'FLOOR-CLOSED-AREA', formula: 'Σ closed polyline areas on floor layers' }, rows, {
        assumptions: ['Only closed CAD shapes contribute', 'Overlaps and room annotations not auto-deducted'],
        proposed: [{ key: 'areaM2', label: { ar: 'مساحة الأرضيات', en: 'Floor area' }, value: round(area), unit: 'm2' }]
      });
    }
  },

  ceilings: {
    discipline: 'architectural',
    name: { ar: 'أسقف مستعارة', en: 'Ceilings' },
    required: [],
    propose(rows) {
      const area = sumArea(rows);
      if (area <= 0) return incomplete('ceilings', rows, 'No closed-area geometry on ceiling layers.');
      return pack('ceilings', { method: 'closed_polyline_area', ruleId: 'CEILING-CLOSED-AREA', formula: 'Σ closed areas on ceiling layers' }, rows, {
        assumptions: ['Services openings not deducted unless provided'],
        proposed: [{ key: 'areaM2', label: { ar: 'مساحة الأسقف', en: 'Ceiling area' }, value: round(area), unit: 'm2' }]
      });
    }
  },

  // ── Structural ─────────────────────────────────────────────────────────
  columns: {
    discipline: 'structural',
    name: { ar: 'أعمدة', en: 'Columns' },
    required: ['heightM'],
    propose(rows, opts) {
      const heightM = num(opts.heightM);
      const count = rows.length;
      const area = sumArea(rows);
      if (!heightM) return incomplete('columns', rows, 'heightM (storey/column height) required for volume.');
      const volume = area > 0 ? round(area * heightM) : null;
      return pack('columns', { method: 'section_area_x_height', ruleId: 'COLUMN-AREA-HEIGHT', formula: 'V = Σ(section area × height); or count if no area' }, rows, {
        assumptions: [`Height = ${heightM} m`, 'Section area from closed CAD shapes when present'],
        proposed: [
          { key: 'count', label: { ar: 'عدد الأعمدة', en: 'Column count' }, value: count, unit: 'nr' },
          ...(volume != null ? [{ key: 'volumeM3', label: { ar: 'حجم تقريبي', en: 'Approx. volume' }, value: volume, unit: 'm3' }] : []),
          ...(area > 0 ? [{ key: 'sectionAreaM2', label: { ar: 'مساحة المقطع', en: 'Section area' }, value: round(area), unit: 'm2' }] : [])
        ]
      });
    }
  },

  beams: {
    discipline: 'structural',
    name: { ar: 'كمرات / جسور', en: 'Beams' },
    required: ['widthMm', 'depthMm'],
    propose(rows, opts) {
      const length = sumLength(rows);
      const w = num(opts.widthMm), d = num(opts.depthMm);
      if (!w || !d) return incomplete('beams', rows, 'widthMm and depthMm required for beam volume from centre-line length.');
      const volume = round(length * (w / 1000) * (d / 1000));
      return pack('beams', { method: 'length_x_section', ruleId: 'BEAM-LENGTH-SECTION', formula: 'V = Σ length × (width × depth)' }, rows, {
        assumptions: [`Section ${w}×${d} mm applied to all beam linework`, 'Haunches, drops and openings not included'],
        proposed: [
          { key: 'lengthM', label: { ar: 'طول الكمرات', en: 'Beam length' }, value: round(length), unit: 'm' },
          { key: 'volumeM3', label: { ar: 'حجم الخرسانة', en: 'Concrete volume' }, value: volume, unit: 'm3' }
        ]
      });
    }
  },

  slabs: {
    discipline: 'structural',
    name: { ar: 'بلاطات', en: 'Slabs' },
    required: ['thicknessMm'],
    propose(rows, opts) {
      const area = sumArea(rows);
      const t = num(opts.thicknessMm);
      if (area <= 0) return incomplete('slabs', rows, 'No closed-area geometry on slab layers.');
      if (!t) return incomplete('slabs', rows, 'thicknessMm required for slab volume.');
      return pack('slabs', { method: 'area_x_thickness', ruleId: 'SLAB-AREA-THICKNESS', formula: 'V = Σ area × thickness' }, rows, {
        assumptions: [`Thickness = ${t} mm`, 'Openings deducted only when provided as voids'],
        proposed: [
          { key: 'areaM2', label: { ar: 'مساحة البلاطة', en: 'Slab area' }, value: round(area), unit: 'm2' },
          { key: 'volumeM3', label: { ar: 'حجم الخرسانة', en: 'Concrete volume' }, value: round(area * t / 1000), unit: 'm3' }
        ]
      });
    }
  },

  foundations: {
    discipline: 'structural',
    name: { ar: 'أساسات / قواعد', en: 'Foundations' },
    required: ['thicknessMm'],
    propose(rows, opts) {
      const area = sumArea(rows);
      const t = num(opts.thicknessMm);
      if (area <= 0) return incomplete('foundations', rows, 'No closed-area geometry on foundation layers.');
      if (!t) return incomplete('foundations', rows, 'thicknessMm (footing depth) required.');
      return pack('foundations', { method: 'area_x_depth', ruleId: 'FOUNDATION-AREA-DEPTH', formula: 'V = Σ plan area × depth' }, rows, {
        assumptions: [`Depth = ${t} mm`, 'Blinding, excavation and backfill are separate rules'],
        proposed: [
          { key: 'planAreaM2', label: { ar: 'مساحة المسقط', en: 'Plan area' }, value: round(area), unit: 'm2' },
          { key: 'volumeM3', label: { ar: 'حجم الخرسانة', en: 'Concrete volume' }, value: round(area * t / 1000), unit: 'm3' }
        ]
      });
    }
  },

  // ── Electrical ─────────────────────────────────────────────────────────
  cables_conduits: {
    discipline: 'electrical',
    name: { ar: 'كابلات / مواسير', en: 'Cables / Conduits' },
    required: [],
    propose(rows, opts) {
      const segments = rows.filter(r => unitOf(r) === 'm').map((r, i) => ({
        routeId: r.layer || ('SEG-' + i),
        lengthM: quantityOf(r),
        parallelRuns: Math.max(1, parseInt(opts.parallelRuns || opts.cableParallelRuns || 1, 10) || 1)
      }));
      if (!segments.length) return incomplete('cables_conduits', rows, 'No length measurements on cable/conduit layers.');
      try {
        const r = calculateRoutedServices(segments, {
          serviceType: 'cable',
          explicitAllowancePercent: num(opts.explicitWastePercent) || 0
        });
        return pack('cables_conduits', r, rows, {
          assumptions: [
            'Length from CAD route linework',
            `Parallel runs = ${segments[0].parallelRuns}`,
            'Glands, terminations and trays counted separately'
          ],
          proposed: [
            { key: 'baseLengthM', label: { ar: 'الطول الأساسي', en: 'Base length' }, value: r.baseLengthM, unit: 'm' },
            { key: 'totalLengthM', label: { ar: 'الطول مع السماح', en: 'Total with allowance' }, value: r.totalLengthM, unit: 'm' }
          ]
        });
      } catch (err) {
        return incomplete('cables_conduits', rows, err.message);
      }
    }
  },

  lighting: {
    discipline: 'electrical',
    name: { ar: 'إنارة', en: 'Lighting' },
    required: [],
    propose(rows) {
      const count = rows.length;
      return pack('lighting', { method: 'entity_count', ruleId: 'LIGHT-COUNT', formula: 'Count of lighting symbols / blocks' }, rows, {
        assumptions: ['Each entity counted once', 'Luminaire type from schedule, not layer name'],
        proposed: [{ key: 'count', label: { ar: 'عدد نقاط الإنارة', en: 'Light points' }, value: count, unit: 'nr' }]
      });
    }
  },

  power_devices: {
    discipline: 'electrical',
    name: { ar: 'مآخذ / أجهزة قدرة', en: 'Power devices' },
    required: [],
    propose(rows) {
      return pack('power_devices', { method: 'entity_count', ruleId: 'POWER-DEVICE-COUNT', formula: 'Count of power device symbols' }, rows, {
        assumptions: ['Type (socket, isolator…) from schedule'],
        proposed: [{ key: 'count', label: { ar: 'العدد', en: 'Count' }, value: rows.length, unit: 'nr' }]
      });
    }
  },

  panels: {
    discipline: 'electrical',
    name: { ar: 'لوحات توزيع', en: 'Panels' },
    required: [],
    propose(rows) {
      return pack('panels', { method: 'entity_count', ruleId: 'PANEL-COUNT', formula: 'Count of panel symbols' }, rows, {
        assumptions: ['Board size and ways from single-line diagram / schedule'],
        proposed: [{ key: 'count', label: { ar: 'عدد اللوحات', en: 'Panel count' }, value: rows.length, unit: 'nr' }]
      });
    }
  },

  // ── Mechanical ─────────────────────────────────────────────────────────
  ducts: {
    discipline: 'mechanical',
    name: { ar: 'مجاري هواء', en: 'Ducts' },
    required: ['widthMm', 'heightMm'],
    propose(rows, opts) {
      const widthMm = num(opts.widthMm ?? opts.ductWidthMm);
      const heightMm = num(opts.heightMm ?? opts.ductHeightMm);
      const length = sumLength(rows);
      if (!widthMm || !heightMm) {
        return incomplete('ducts', rows, 'widthMm and heightMm required for duct surface/weight rules. CAD length alone is not a fabrication quantity.');
      }
      if (length <= 0) return incomplete('ducts', rows, 'No duct centre-line length measured.');
      try {
        const r = calculateRectangularDuctwork([{ lengthM: length, widthMm, heightMm }]);
        return pack('ducts', r, rows, {
          assumptions: [
            `Section ${widthMm}×${heightMm} mm applied to all duct linework`,
            'Fittings, transitions, dampers and supports NOT included',
            'External surface area for straight runs only'
          ],
          proposed: [
            { key: 'lengthM', label: { ar: 'طول المجاري', en: 'Duct length' }, value: round(length), unit: 'm' },
            { key: 'externalAreaM2', label: { ar: 'المساحة الخارجية', en: 'External area' }, value: r.externalSurfaceAreaM2, unit: 'm2' }
          ]
        });
      } catch (err) {
        return incomplete('ducts', rows, err.message);
      }
    }
  },

  ahu_fcu: {
    discipline: 'mechanical',
    name: { ar: 'وحدات مناولة / FCU', en: 'AHU / FCU' },
    required: [],
    propose(rows) {
      return pack('ahu_fcu', { method: 'entity_count', ruleId: 'AHU-FCU-COUNT', formula: 'Count of equipment symbols' }, rows, {
        assumptions: ['Capacity and type from equipment schedule'],
        proposed: [{ key: 'count', label: { ar: 'العدد', en: 'Count' }, value: rows.length, unit: 'nr' }]
      });
    }
  },

  // ── Plumbing ───────────────────────────────────────────────────────────
  pipes: {
    discipline: 'plumbing',
    name: { ar: 'مواسير عامة', en: 'Pipes (general)' },
    required: [],
    propose(rows, opts) {
      return routePipeLike(rows, opts, 'pipe', 'pipes');
    }
  },
  drainage: {
    discipline: 'plumbing',
    name: { ar: 'صرف', en: 'Drainage' },
    required: [],
    propose(rows, opts) {
      return routePipeLike(rows, opts, 'pipe', 'drainage');
    }
  },
  water_supply: {
    discipline: 'plumbing',
    name: { ar: 'تغذية مياه', en: 'Water supply' },
    required: [],
    propose(rows, opts) {
      return routePipeLike(rows, opts, 'pipe', 'water_supply');
    }
  },
  sanitary_fixtures: {
    discipline: 'plumbing',
    name: { ar: 'أدوات صحية', en: 'Sanitary fixtures' },
    required: [],
    propose(rows) {
      return pack('sanitary_fixtures', { method: 'entity_count', ruleId: 'SANITARY-COUNT', formula: 'Count of fixture symbols' }, rows, {
        assumptions: ['Fixture type from schedule'],
        proposed: [{ key: 'count', label: { ar: 'العدد', en: 'Count' }, value: rows.length, unit: 'nr' }]
      });
    }
  },

  // ── Fire ───────────────────────────────────────────────────────────────
  sprinklers: {
    discipline: 'fire_protection',
    name: { ar: 'رشاشات', en: 'Sprinklers' },
    required: [],
    propose(rows) {
      return pack('sprinklers', { method: 'entity_count', ruleId: 'SPRINKLER-COUNT', formula: 'Count of sprinkler heads' }, rows, {
        assumptions: ['Coverage and type from fire layout / schedule'],
        proposed: [{ key: 'count', label: { ar: 'عدد الرشاشات', en: 'Sprinkler count' }, value: rows.length, unit: 'nr' }]
      });
    }
  },
  hydrants: {
    discipline: 'fire_protection',
    name: { ar: 'صنابير حريق', en: 'Hydrants' },
    required: [],
    propose(rows) {
      return pack('hydrants', { method: 'entity_count', ruleId: 'HYDRANT-COUNT', formula: 'Count of hydrant symbols' }, rows, {
        assumptions: [],
        proposed: [{ key: 'count', label: { ar: 'العدد', en: 'Count' }, value: rows.length, unit: 'nr' }]
      });
    }
  },

  // ── Civil ──────────────────────────────────────────────────────────────
  roads: {
    discipline: 'civil',
    name: { ar: 'طرق', en: 'Roads' },
    required: ['widthM'],
    propose(rows, opts) {
      const length = sumLength(rows);
      const widthM = num(opts.widthM);
      if (!widthM) return incomplete('roads', rows, 'widthM required to convert centre-line length to pavement area.');
      return pack('roads', { method: 'length_x_width', ruleId: 'ROAD-LENGTH-WIDTH', formula: 'Area = Σ length × width' }, rows, {
        assumptions: [`Width = ${widthM} m`, 'Layers (base, binder, wearing) measured separately'],
        proposed: [
          { key: 'lengthM', label: { ar: 'طول المحور', en: 'Centre-line length' }, value: round(length), unit: 'm' },
          { key: 'areaM2', label: { ar: 'مساحة الرصف', en: 'Pavement area' }, value: round(length * widthM), unit: 'm2' }
        ]
      });
    }
  },
  excavation: {
    discipline: 'civil',
    name: { ar: 'حفر', en: 'Excavation' },
    required: ['depthM'],
    propose(rows, opts) {
      const area = sumArea(rows);
      const depthM = num(opts.depthM);
      if (area <= 0) return incomplete('excavation', rows, 'Plan area from closed shapes required.');
      if (!depthM) return incomplete('excavation', rows, 'depthM required for excavation volume.');
      return pack('excavation', { method: 'area_x_depth', ruleId: 'EXCAVATION-AREA-DEPTH', formula: 'V = plan area × depth (average)' }, rows, {
        assumptions: [`Depth = ${depthM} m (uniform average — verify sections)`, 'Batter, working space and heave not included'],
        proposed: [
          { key: 'planAreaM2', label: { ar: 'مساحة المسقط', en: 'Plan area' }, value: round(area), unit: 'm2' },
          { key: 'volumeM3', label: { ar: 'حجم الحفر', en: 'Excavation volume' }, value: round(area * depthM), unit: 'm3' }
        ]
      });
    }
  },

  // ── Landscape ──────────────────────────────────────────────────────────
  trees: {
    discipline: 'landscape',
    name: { ar: 'أشجار', en: 'Trees' },
    required: [],
    propose(rows) {
      return pack('trees', { method: 'entity_count', ruleId: 'TREE-COUNT', formula: 'Count of tree symbols' }, rows, {
        assumptions: ['Species and size from planting schedule'],
        proposed: [{ key: 'count', label: { ar: 'العدد', en: 'Count' }, value: rows.length, unit: 'nr' }]
      });
    }
  },
  irrigation: {
    discipline: 'landscape',
    name: { ar: 'ري', en: 'Irrigation' },
    required: [],
    propose(rows, opts) {
      return routePipeLike(rows, opts, 'pipe', 'irrigation');
    }
  }
});

function routePipeLike(rows, opts, serviceType, category) {
  const segments = rows.filter(r => unitOf(r) === 'm').map((r, i) => ({
    routeId: r.layer || ('SEG-' + i),
    lengthM: quantityOf(r),
    parallelRuns: 1,
    size: opts.nominalDiaMm ? String(opts.nominalDiaMm) : null
  }));
  if (!segments.length) return incomplete(category, rows, 'No length measurements on route layers.');
  try {
    const r = calculateRoutedServices(segments, {
      serviceType,
      explicitAllowancePercent: num(opts.explicitWastePercent) || 0
    });
    return pack(category, r, rows, {
      assumptions: [
        'Length from CAD route linework',
        opts.nominalDiaMm ? `Nominal size hint = ${opts.nominalDiaMm} mm (not verified from geometry)` : 'Diameter from schedule / tags, not CAD',
        'Fittings, valves and supports are separate takeoffs'
      ],
      proposed: [
        { key: 'baseLengthM', label: { ar: 'الطول الأساسي', en: 'Base length' }, value: r.baseLengthM, unit: 'm' },
        { key: 'totalLengthM', label: { ar: 'الطول الإجمالي', en: 'Total length' }, value: r.totalLengthM, unit: 'm' }
      ]
    });
  } catch (err) {
    return incomplete(category, rows, err.message);
  }
}

/** Apply rules to classified takeoff rows grouped by category. */
function proposeDisciplineQuantities(rows, options = {}) {
  const layerMap = options.layerMap || {};
  const projectDefaults = { ...DEFAULTS, ...(options.defaults || {}) };

  // Ensure classification on each row
  const classified = rows.map(row => {
    const layer = row.layer ?? row.layer_name ?? '0';
    const c = row.discipline && row.disciplineCategory
      ? { discipline: row.discipline, category: row.disciplineCategory, basis: row.disciplineBasis, source: row.disciplineSource || 'row' }
      : classifyLayer(layer, layerMap);
    return { ...row, layer, _c: c };
  });

  // Group by category (skip excluded)
  const byCat = new Map();
  for (const row of classified) {
    if (row._c.basis === 'excluded' || row._c.category === 'annotation_or_pattern') continue;
    const key = row._c.category;
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(row);
  }

  const results = [];
  const doorRows = byCat.get('doors') || [];
  const glazingRows = byCat.get('glazing') || [];

  for (const [category, catRows] of byCat) {
    const rule = RULES[category];
    if (!rule) {
      results.push(incomplete(category, catRows, `No measurement rule registered for category "${category}". Raw CAD only.`));
      continue;
    }
    const opts = {
      ...projectDefaults,
      ...(options.byCategory && options.byCategory[category]) || {},
      ...(options.byDiscipline && options.byDiscipline[rule.discipline]) || {}
    };
    // Auto-link door/window evidence into wall opening deductions when measuring walls
    if (category === 'walls') {
      if (!opts.linkedDoorRows) opts.linkedDoorRows = doorRows;
      if (!opts.linkedGlazingRows) opts.linkedGlazingRows = glazingRows;
      // If user did not pass doorCount but we have door entities, expose the count for transparency
      if (opts.doorCount == null && doorRows.length) opts.doorCount = doorRows.length;
      if (opts.windowCount == null && glazingRows.length) opts.windowCount = glazingRows.length;
    }
    results.push(rule.propose(catRows, opts));
  }

  // Sort: complete proposals first, then incomplete
  results.sort((a, b) => Number(b.status === 'proposed') - Number(a.status === 'proposed'));

  return {
    engine: 'mmc-discipline-quantity-rules-1.0',
    reviewState: 'needs_review',
    notice: {
      ar: 'كل الكميات مقترحة وتحتاج مراجعة مهندس. الأطوال الخام ليست كميات صافية.',
      en: 'All quantities are proposals requiring engineer review. Raw CAD lengths are not net BOQ quantities.'
    },
    defaultsUsed: projectDefaults,
    results,
    summary: {
      categories: results.length,
      proposed: results.filter(r => r.status === 'proposed').length,
      incomplete: results.filter(r => r.status === 'incomplete').length
    }
  };
}

// ── helpers ──────────────────────────────────────────────────────────────
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function quantityOf(row) {
  return Number(row.quantity ?? row.length_m ?? 0) || 0;
}
function unitOf(row) {
  return row.unit || (row.length_m != null ? 'm' : row.area_m2 != null ? 'm2' : null);
}
function sumLength(rows) {
  return rows.reduce((s, r) => s + (unitOf(r) === 'm' ? quantityOf(r) : Number(r.length_m) || 0), 0);
}
function sumArea(rows) {
  return rows.reduce((s, r) => {
    const detail = r.detail || (r.detail_json ? safeJson(r.detail_json) : r);
    return s + (Number(r.area_m2) || Number(detail.area_m2) || (unitOf(r) === 'm2' ? quantityOf(r) : 0) || 0);
  }, 0);
}
function sumCount(rows) {
  return rows.length;
}
function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function pack(category, kernelResult, rows, { assumptions, proposed, extra }) {
  const rule = RULES[category] || { discipline: 'unclassified', name: { ar: category, en: category } };
  return {
    status: 'proposed',
    category,
    discipline: rule.discipline,
    name: rule.name,
    ruleId: kernelResult.ruleId || kernelResult.method,
    formula: kernelResult.formula || null,
    method: kernelResult.method || null,
    sourceEntityCount: rows.length,
    sourceLayers: [...new Set(rows.map(r => r.layer || r.layer_name || '0'))].sort(),
    assumptions,
    limitations: kernelResult.limitations || [
      'Requires engineer review before contractual use',
      'CAD geometry may include duplicates, centre-lines or annotations'
    ],
    proposed,
    ...(extra || {}),
    reviewState: 'needs_review',
    approvalEligible: false
  };
}

/**
 * Build wall openings from:
 *  1) opts.openings = [{ widthM, heightM, label? }]  (highest priority)
 *  2) opts.doorCount / windowCount × typical sizes
 *  3) opts.linkedOpenings from other classified categories (doors/glazing rows)
 *
 * Typical sizes are NEVER assumed — must be provided by the user/project.
 */
function buildWallOpenings(opts = {}) {
  if (Array.isArray(opts.openings) && opts.openings.length) {
    return opts.openings.map((o, i) => {
      const widthM = num(o.widthM ?? o.width);
      const heightM = num(o.heightM ?? o.height);
      if (!widthM || !heightM) throw new TypeError('opening ' + i + ' requires widthM and heightM');
      return { widthM, heightM, source: o.source || 'explicit', label: o.label || o.id || null };
    });
  }

  const list = [];

  // From explicit counts × typical sizes
  const doorCount = Math.max(0, parseInt(opts.doorCount ?? 0, 10) || 0);
  const windowCount = Math.max(0, parseInt(opts.windowCount ?? 0, 10) || 0);
  const doorW = num(opts.typicalDoorWidthM);
  const doorH = num(opts.typicalDoorHeightM);
  const winW = num(opts.typicalWindowWidthM);
  const winH = num(opts.typicalWindowHeightM);

  if (doorCount > 0) {
    if (!doorW || !doorH) {
      // Cannot invent door size — caller should see incomplete via a note in assumptions
    } else {
      for (let i = 0; i < doorCount; i++) {
        list.push({ widthM: doorW, heightM: doorH, source: 'typical_door', label: 'DOOR' });
      }
    }
  }
  if (windowCount > 0) {
    if (winW && winH) {
      for (let i = 0; i < windowCount; i++) {
        list.push({ widthM: winW, heightM: winH, source: 'typical_window', label: 'WINDOW' });
      }
    }
  }

  // From linked classified rows (doors / glazing) when counts not given
  if (!doorCount && Array.isArray(opts.linkedDoorRows) && opts.linkedDoorRows.length && doorW && doorH) {
    for (let i = 0; i < opts.linkedDoorRows.length; i++) {
      list.push({ widthM: doorW, heightM: doorH, source: 'linked_door_entity', label: opts.linkedDoorRows[i].layer || 'DOOR' });
    }
  }
  if (!windowCount && Array.isArray(opts.linkedGlazingRows) && opts.linkedGlazingRows.length && winW && winH) {
    // Prefer area from glazing if height given on those rows; else typical window
    for (const row of opts.linkedGlazingRows) {
      const len = unitOf(row) === 'm' ? quantityOf(row) : 0;
      if (len > 0 && num(opts.glazingHeightM)) {
        list.push({ widthM: len, heightM: num(opts.glazingHeightM), source: 'linked_glazing_line', label: row.layer || 'GLAZING' });
      } else {
        list.push({ widthM: winW, heightM: winH, source: 'linked_glazing_entity', label: row.layer || 'WINDOW' });
      }
    }
  }

  // Minimum opening deduction threshold (measurement standard).
  // Openings below the threshold are excluded from the deduction list and reported as skipped.
  const minM2 = Number(opts.minOpeningDeductionM2);
  const threshold = Number.isFinite(minM2) && minM2 >= 0 ? minM2 : 0.5;
  const kept = [];
  const skipped = [];
  for (const o of list) {
    const area = o.widthM * o.heightM;
    if (area + 1e-12 < threshold) {
      skipped.push({ ...o, areaM2: round(area), reason: 'below_min_opening_threshold' });
    } else {
      kept.push(o);
    }
  }
  // Attach skipped on the array for the caller (non-enumerable-ish via property)
  kept._skippedBelowThreshold = skipped;
  kept._minOpeningDeductionM2 = threshold;
  return kept;
}

function incomplete(category, rows, reason) {
  const rule = RULES[category] || { discipline: 'unclassified', name: { ar: category, en: category }, required: [] };
  return {
    status: 'incomplete',
    category,
    discipline: rule.discipline || 'unclassified',
    name: rule.name || { ar: category, en: category },
    ruleId: null,
    formula: null,
    sourceEntityCount: rows.length,
    sourceLayers: [...new Set(rows.map(r => r.layer || r.layer_name || '0'))].sort(),
    reason,
    requiredInputs: rule.required || [],
    raw: {
      totalLengthM: round(sumLength(rows)),
      totalAreaM2: round(sumArea(rows)),
      entityCount: rows.length
    },
    proposed: [],
    reviewState: 'needs_inputs',
    approvalEligible: false
  };
}

function listRules() {
  return Object.entries(RULES).map(([category, r]) => ({
    category,
    discipline: r.discipline,
    name: r.name,
    requiredInputs: r.required || []
  }));
}

module.exports = {
  proposeDisciplineQuantities,
  listRules,
  RULES,
  DEFAULTS
};

    __mods['./discipline-quantity-rules'] = module.exports;
  })();

  // ===== dxf-takeoff.js =====
  (function() {
    const module = { exports: {} };
    const exports = module.exports;
/**
 * MMC AI — deterministic DXF geometry takeoff (first engineering kernel).
 *
 * Supports ASCII DXF ENTITIES: LINE, 2D POLYLINE/LWPOLYLINE, CIRCLE, ARC.
 * Quantities are calculated from CAD coordinates and the drawing's $INSUNITS.
 * This module deliberately does not use an LLM to invent geometry or scale.
 *
 * Limitations: no xrefs, SPLINE, HATCH, 3D solids, paper-space viewport
 * transforms, raster drawings, nested/array INSERTs, or automatic BOQ classification. Unsupported
 * entities are counted and reported, never silently converted to quantities.
 */
const { classifyLayer, summarizeByDiscipline } = require('./discipline-layer-classifier');

const UNIT_TO_METRE = {
  0: null, 1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001,
  5: 0.01, 6: 1, 7: 1000, 8: 2.54e-8, 9: 2.54e-5,
  10: 0.9144, 11: 1e-10, 12: 1e-9, 13: 1e-6, 14: 0.1,
  15: 10, 16: 100, 17: 1e9, 18: 149597870700, 19: 9.460730472e15,
  20: 3.085677581e16, 21: 0.0003048, 22: 1e-7
};

function parsePairs(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('DXF content is empty.');
  const lines = text.replace(/^\uFEFF/, '').trimEnd().split(/\r?\n/);
  if (lines.length % 2 !== 0) throw new Error('Malformed DXF: incomplete group-code pair.');
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new Error('Malformed DXF group code at line ' + (i + 1));
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

function readHeaderUnits(pairs) {
  let inHeader = false, variable = '';
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    if (p.code === 0 && p.value === 'SECTION') {
      inHeader = pairs[i + 1]?.code === 2 && pairs[i + 1].value === 'HEADER';
    } else if (p.code === 0 && p.value === 'ENDSEC') inHeader = false;
    else if (inHeader && p.code === 9) variable = p.value;
    else if (inHeader && variable === '$INSUNITS' && p.code === 70) return Number(p.value);
  }
  return 0;
}

function entitiesFrom(pairs) {
  let section = '', inEntities = false, current = null;
  const entities = [];
  for (const p of pairs) {
    if (p.code === 0 && p.value === 'SECTION') { section = ''; inEntities = false; current = null; continue; }
    if (p.code === 2 && !section) { section = p.value; inEntities = section === 'ENTITIES'; continue; }
    if (p.code === 0 && p.value === 'ENDSEC') {
      if (current) entities.push(current);
      current = null; inEntities = false; section = ''; continue;
    }
    if (!inEntities) continue;
    if (p.code === 0) {
      if (current) entities.push(current);
      current = { type: p.value, pairs: [] };
    } else if (current) current.pairs.push(p);
  }
  if (current) entities.push(current);
  return entities;
}


/**
 * Reassembles legacy POLYLINE -> VERTEX... -> SEQEND sequences.
 * Only planar 2D polylines with explicit vertex coordinates are converted.
 * 3D, mesh, polyface and fitted/spline vertices remain unsupported.
 */
function normalizeClassicPolylines(entities) {
  const normalized = [], unsupported = {};
  const mark = (name) => { unsupported[name] = (unsupported[name] || 0) + 1; };
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity.type !== 'POLYLINE') {
      if (entity.type === 'VERTEX' || entity.type === 'SEQEND') {
        mark('ORPHAN_' + entity.type);
      } else normalized.push(entity);
      continue;
    }

    const flags = first(entity, 70, 0);
    const vertices = [];
    let foundEnd = false, malformed = false;
    while (i + 1 < entities.length) {
      const next = entities[i + 1];
      if (next.type === 'SEQEND') { i++; foundEnd = true; break; }
      if (next.type !== 'VERTEX') break;
      i++;
      const vertexFlags = first(next, 70, 0);
      if ((vertexFlags & (1 | 8 | 16 | 32 | 64 | 128)) !== 0) malformed = true;
      const x = first(next, 10, NaN), y = first(next, 20, NaN), bulge = first(next, 42, 0);
      if (![x, y, bulge].every(Number.isFinite)) malformed = true;
      vertices.push({ x, y, bulge });
    }

    const unsupportedMode = (flags & (2 | 4 | 8 | 16 | 32 | 64)) !== 0;
    if (unsupportedMode || malformed || !foundEnd || vertices.length < 2) {
      mark(unsupportedMode ? 'POLYLINE_3D_MESH_OR_FITTED_UNSUPPORTED' : 'POLYLINE_INVALID_OR_INCOMPLETE');
      continue;
    }
    const pairs = [];
    const layer = entity.pairs.find(p => p.code === 8);
    if (layer) pairs.push({ code: 8, value: layer.value });
    pairs.push({ code: 70, value: String(flags & 1) });
    for (const vertex of vertices) {
      pairs.push({ code: 10, value: String(vertex.x) }, { code: 20, value: String(vertex.y) });
      if (vertex.bulge !== 0) pairs.push({ code: 42, value: String(vertex.bulge) });
    }
    normalized.push({ type: 'LWPOLYLINE', pairs, legacyType: 'POLYLINE' });
  }
  return { entities: normalized, unsupported };
}

function requireCodes(e, codes, label) {
  for (const code of codes) {
    if (!e.pairs.some(p => p.code === code)) {
      throw new Error('Missing required DXF group code ' + code + ' in ' + label + '.');
    }
  }
}
function first(e, code, fallback = 0) {
  const p = e.pairs.find(x => x.code === code);
  return p ? Number(p.value) : fallback;
}
function all(e, code) { return e.pairs.filter(x => x.code === code).map(x => Number(x.value)); }
function layerOf(e) { return e.pairs.find(x => x.code === 8)?.value || '0'; }
function assertFinite(values, label) {
  if (values.some(value => !Number.isFinite(value))) {
    throw new Error('Invalid non-numeric geometry in ' + label + '.');
  }
}
function pointDistance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

function polylineVertices(e) {
  const out = [];
  let current = null;
  for (const p of e.pairs) {
    if (p.code === 10) {
      if (current) {
        if (!current.hasY) throw new Error('Missing Y coordinate in LWPOLYLINE vertex.');
        out.push({ x: current.x, y: current.y, bulge: current.bulge });
      }
      current = { x: Number(p.value), y: null, hasY: false, bulge: 0 };
    } else if (p.code === 20 && current) {
      if (current.hasY) throw new Error('Duplicate Y coordinate in LWPOLYLINE vertex.');
      current.y = Number(p.value); current.hasY = true;
    } else if (p.code === 42 && current) current.bulge = Number(p.value);
  }
  if (current) {
    if (!current.hasY) throw new Error('Missing Y coordinate in LWPOLYLINE vertex.');
    out.push({ x: current.x, y: current.y, bulge: current.bulge });
  }
  return out;
}

function polylineMetrics(vertices, closed) {
  let perimeter = 0, area2 = 0, curvedArea = 0;
  const count = vertices.length;
  const edges = closed ? count : Math.max(0, count - 1);
  for (let i = 0; i < edges; i++) {
    const a = vertices[i], b = vertices[(i + 1) % count];
    const chord = pointDistance(a, b);
    perimeter += chord;
    area2 += a.x * b.y - b.x * a.y;
    const bulge = a.bulge || 0;
    if (Math.abs(bulge) > 1e-12 && chord > 0) {
      const theta = 4 * Math.atan(bulge);
      const radius = chord * (1 + bulge * bulge) / (4 * Math.abs(bulge));
      perimeter += radius * Math.abs(theta) - chord;
      curvedArea += radius * radius * (theta - Math.sin(theta)) / 2;
    }
  }
  return { perimeter, area: closed ? Math.abs(area2 / 2 + curvedArea) : null };
}


function blocksFrom(pairs) {
  const blocks = new Map();
  let section = '', block = null, entity = null, readingHeader = false;
  const flushEntity = () => { if (block && entity) block.entities.push(entity); entity = null; };
  for (const p of pairs) {
    if (p.code === 0 && p.value === 'SECTION') { flushEntity(); section = ''; continue; }
    if (p.code === 2 && !section) { section = p.value; continue; }
    if (section !== 'BLOCKS') continue;
    if (p.code === 0 && p.value === 'ENDSEC') {
      flushEntity();
      if (block) blocks.set(block.name, block);
      block = null; section = ''; continue;
    }
    if (p.code === 0 && p.value === 'BLOCK') {
      flushEntity();
      if (block) blocks.set(block.name, block);
      block = { name: '', baseX: 0, baseY: 0, entities: [] };
      readingHeader = true; continue;
    }
    if (p.code === 0 && p.value === 'ENDBLK') {
      flushEntity();
      if (block?.name) blocks.set(block.name, block);
      block = null; readingHeader = false; continue;
    }
    if (!block) continue;
    if (p.code === 0) {
      flushEntity();
      entity = { type: p.value, pairs: [] };
      readingHeader = false;
    } else if (readingHeader && p.code === 2) block.name = p.value;
    else if (readingHeader && p.code === 10) block.baseX = Number(p.value);
    else if (readingHeader && p.code === 20) block.baseY = Number(p.value);
    else if (entity) entity.pairs.push(p);
  }
  flushEntity();
  if (block?.name) blocks.set(block.name, block);
  return blocks;
}

function transformBlockEntity(entity, block, insert, scale, rotation) {
  const radians = rotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  const ix = first(insert, 10), iy = first(insert, 20);
  const layer = layerOf(insert);
  const transform = (x, y) => {
    const dx = (x - block.baseX) * scale, dy = (y - block.baseY) * scale;
    return { x: ix + dx * cos - dy * sin, y: iy + dx * sin + dy * cos };
  };
  const pairs = entity.pairs.map(p => ({ ...p }));
  const set = (code, value) => {
    const p = pairs.find(x => x.code === code);
    if (p) p.value = String(value);
  };
  if (entity.type === 'LINE') {
    requireCodes(entity, [10,20,11,21], 'block LINE');
    const a = transform(first(entity,10), first(entity,20));
    const b = transform(first(entity,11), first(entity,21));
    set(10,a.x); set(20,a.y); set(11,b.x); set(21,b.y);
  } else if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
    requireCodes(entity, entity.type === 'ARC' ? [10,20,40,50,51] : [10,20,40], 'block ' + entity.type);
    const sourceCenter = [first(entity,10), first(entity,20)];
    assertFinite(sourceCenter, 'block ' + entity.type + ' center');
    const c = transform(sourceCenter[0], sourceCenter[1]);
    set(10,c.x); set(20,c.y); set(40,first(entity,40)*scale);
    if (entity.type === 'ARC') {
      set(50,first(entity,50)+rotation); set(51,first(entity,51)+rotation);
    }
  } else if (entity.type === 'LWPOLYLINE') {
    const vertices = polylineVertices(entity);
    let vertexIndex = 0;
    for (const p of pairs) {
      if (p.code === 10) {
        const point = transform(vertices[vertexIndex].x, vertices[vertexIndex].y);
        p.value = String(point.x);
      } else if (p.code === 20) {
        const point = transform(vertices[vertexIndex].x, vertices[vertexIndex].y);
        p.value = String(point.y); vertexIndex++;
      }
    }
  }
  const childLayer = entity.pairs.find(p => p.code === 8)?.value || '0';
  if (childLayer === '0') {
    const layerPair = pairs.find(p => p.code === 8);
    if (layerPair) layerPair.value = layer;
    else pairs.unshift({ code: 8, value: layer });
  }
  return { type: entity.type, pairs, blockName: block.name };
}

function expandBlockInserts(entities, blocks) {
  const expanded = [], unsupported = {};
  const mark = name => { unsupported[name] = (unsupported[name] || 0) + 1; };
  for (const entity of entities) {
    if (entity.type !== 'INSERT') { expanded.push(entity); continue; }
    requireCodes(entity, [2, 10, 20], 'INSERT entity');
    const name = entity.pairs.find(p => p.code === 2)?.value;
    const block = blocks.get(name);
    if (!block) { mark('INSERT_MISSING_BLOCK'); continue; }
    const sx = first(entity,41,1), sy = first(entity,42,1), sz = first(entity,43,1);
    const columns = first(entity,70,1), rows = first(entity,71,1);
    const rotation = first(entity,50,0);
    if (columns !== 1 || rows !== 1) { mark('INSERT_ARRAY_UNSUPPORTED'); continue; }
    if (![sx,sy,sz,rotation].every(Number.isFinite) || sx <= 0 || sy <= 0 || sz <= 0 || Math.abs(sx-sy)>1e-9) {
      mark('INSERT_UNSUPPORTED_SCALE'); continue;
    }
    if (block.entities.some(e => e.type === 'INSERT')) { mark('INSERT_NESTED_BLOCK'); continue; }
    for (const child of block.entities) expanded.push(transformBlockEntity(child, block, entity, sx, rotation));
  }
  return { entities: expanded, unsupported };
}

function takeoffDxf(text, options = {}) {
  const pairs = parsePairs(text);
  const unitCode = readHeaderUnits(pairs);
  const metresPerUnit = options.metresPerUnit ?? UNIT_TO_METRE[unitCode];
  if (!Number.isFinite(metresPerUnit) || metresPerUnit <= 0) {
    throw new Error('Drawing units are undefined. Set a verified metresPerUnit scale before measuring.');
  }
  const sourceEntities = entitiesFrom(pairs);
  const classic = normalizeClassicPolylines(sourceEntities);
  const blockExpansion = expandBlockInserts(classic.entities, blocksFrom(pairs));
  const entities = blockExpansion.entities;
  const rows = [];
  const unsupported = { ...classic.unsupported, ...blockExpansion.unsupported };
  const byLayer = {};
  for (let index = 0; index < entities.length; index++) {
    const e = entities[index], layer = layerOf(e);
    const row = { entity: e.type, entityIndex: index, layer };
    if (e.blockName) row.sourceBlock = e.blockName;
    let quantity = null, unit = null;
    if (e.type === 'LINE') {
      requireCodes(e, [10, 20, 11, 21], 'LINE entity ' + index);
      const a = { x: first(e, 10), y: first(e, 20) }, b = { x: first(e, 11), y: first(e, 21) };
      assertFinite([a.x, a.y, b.x, b.y], 'LINE entity ' + index);
      row.geometry = { type: 'LINE', start: a, end: b };
      quantity = pointDistance(a, b) * metresPerUnit; unit = 'm';
    } else if (e.type === 'LWPOLYLINE') {
      requireCodes(e, [10, 20], 'LWPOLYLINE entity ' + index);
      const vertices = polylineVertices(e), closed = (first(e, 70) & 1) === 1;
      assertFinite(vertices.flatMap(v => [v.x, v.y, v.bulge ?? 0]), 'LWPOLYLINE entity ' + index);
      if (vertices.length < 2) { unsupported[e.type] = (unsupported[e.type] || 0) + 1; continue; }
      const m = polylineMetrics(vertices, closed);
      row.geometry = { type: 'LWPOLYLINE', vertices: vertices.map(v => ({ x: v.x, y: v.y })), closed };
      row.closed = closed;
      row.length_m = m.perimeter * metresPerUnit;
      if (closed) row.area_m2 = m.area * metresPerUnit * metresPerUnit;
      quantity = row.length_m; unit = 'm';
    } else if (e.type === 'CIRCLE') {
      requireCodes(e, [10, 20, 40], 'CIRCLE entity ' + index);
      const center = [first(e, 10), first(e, 20)];
      const radius = first(e, 40);
      assertFinite([...center, radius], 'CIRCLE entity ' + index);
      if (radius < 0) throw new Error('Invalid negative circle radius at entity ' + index);
      row.radius_m = radius * metresPerUnit;
      row.geometry = { type: 'CIRCLE', center: { x: center[0], y: center[1] }, radius };
      row.circumference_m = 2 * Math.PI * row.radius_m;
      row.area_m2 = Math.PI * row.radius_m * row.radius_m;
      quantity = row.circumference_m; unit = 'm';
    } else if (e.type === 'ARC') {
      requireCodes(e, [10, 20, 40, 50, 51], 'ARC entity ' + index);
      const center = [first(e, 10), first(e, 20)];
      const radius = first(e, 40), start = first(e, 50), end = first(e, 51);
      assertFinite([...center, radius, start, end], 'ARC entity ' + index);
      if (radius < 0) throw new Error('Invalid negative arc radius at entity ' + index);
      let sweep = (end - start) % 360;
      if (sweep < 0) sweep += 360;
      row.radius_m = radius * metresPerUnit;
      row.geometry = { type: 'ARC', center: { x: center[0], y: center[1] }, radius, startDegrees: start, sweepDegrees: sweep };
      quantity = radius * sweep * Math.PI / 180 * metresPerUnit; unit = 'm';
      row.sweep_degrees = sweep;
    } else {
      unsupported[e.type] = (unsupported[e.type] || 0) + 1;
      continue;
    }
    row.quantity = quantity; row.unit = unit;
    rows.push(row);
    const agg = byLayer[layer] || (byLayer[layer] = { entities: 0, length_m: 0, area_m2: 0 });
    agg.entities++;
    if (unit === 'm') agg.length_m += quantity;
    if (row.area_m2) agg.area_m2 += row.area_m2;
  }
  // Attach deterministic discipline classification to every measured row.
  // Classification is advisory only — quantities remain needs_review.
  const layerMap = (options && options.layerMap) || {};
  for (const row of rows) {
    const c = classifyLayer(row.layer || '0', layerMap);
    row.discipline = c.discipline;
    row.disciplineCategory = c.category;
    row.disciplineBasis = c.basis;
    row.disciplineSource = c.source;
  }
  const byDiscipline = summarizeByDiscipline(rows, layerMap);

  return {
    engine: 'mmc-dxf-geometry-0.1',
    source: 'ASCII DXF ENTITIES',
    units: { insunits: unitCode, metresPerUnit },
    summary: {
      supportedEntities: rows.length,
      unsupportedEntities: Object.values(unsupported).reduce((a, b) => a + b, 0),
      totalLength_m: rows.reduce((s, r) => s + (r.quantity || 0), 0),
      totalClosedArea_m2: rows.reduce((s, r) => s + (r.area_m2 || 0), 0),
      disciplineCount: byDiscipline.length,
      classifiedLayers: byDiscipline.reduce((n, d) => n + d.layers.length, 0)
    },
    byLayer, byDiscipline, unsupported, rows,
    limitations: [
      'Nested blocks, xrefs and block arrays are not expanded',
      'No hatch or spline area extraction',
      'No automatic drawing-scale inference',
      'Discipline classification is deterministic from layer names only — not net BOQ quantities',
      'Requires engineer review before contractual use'
    ]
  };
}

module.exports = { takeoffDxf, parsePairs, readHeaderUnits, entitiesFrom, normalizeClassicPolylines, blocksFrom, expandBlockInserts, polylineMetrics, UNIT_TO_METRE };

    __mods['./dxf-takeoff'] = module.exports;
  })();

  // Expose the public API used by the page + demo backend
  const classifier = require('./discipline-layer-classifier');
  const quantities = require('./discipline-quantity-rules');
  const kernels    = require('./discipline-measurement-kernels');
  const dxf        = require('./dxf-takeoff');

  window.MmcAi = {
    // Classifier
    classifyLayer:        classifier.classifyLayer,
    summarizeByDiscipline:classifier.summarizeByDiscipline,
    DISCIPLINES:          classifier.DISCIPLINES,
    DISCIPLINE_LABELS:    classifier.DISCIPLINE_LABELS,
    // Quantity rules
    proposeDisciplineQuantities: quantities.proposeDisciplineQuantities,
    listRules:                  quantities.listRules,
    RULES:                      quantities.RULES,
    DEFAULTS:                   quantities.DEFAULTS,
    // Measurement kernels
    calculateMasonryWall:           kernels.calculateMasonryWall,
    calculateRectangularDuctwork:   kernels.calculateRectangularDuctwork,
    calculateRoutedServices:        kernels.calculateRoutedServices,
    // DXF takeoff
    takeoffDxf:    dxf.takeoffDxf,
    UNIT_TO_METRE: dxf.UNIT_TO_METRE,
    // Utility
    _require: require
  };

  // ===== neubuild.ai-style image injection =====
  // Replaces placeholder image sources on the page with curated construction-AI
  // images from /assets/. Runs on DOMContentLoaded so all DOM nodes exist.
  // Guarded with typeof document check so the bundle loads in Node for tests.
  if (typeof document !== 'undefined') {
  const IMAGE_MAP = {
    // CSS selector → image filename in /assets/
    '#projectCover': 'hero-construction-site-1.jpg',
    'img[alt*="Illustrative Site Gallery"]': 'hero-construction-site-1.jpg',
    '.activity-card img[src*="activity-takeoff"]': 'worker-ar-tech-3.jpg',
    '.activity-card img[src*="activity-schedule"]': 'dashboard-gantt-2.png',
    '.activity-card img[src*="activity-bim"]': 'bim-model-screen-1.jpg',
    '.activity-card img[src*="activity-contracts"]': 'hero-construction-site-2.jpg',
    '.cockpit-card .cockpit-icon img': 'bim-model-screen-2.jpg',
  };

  function applyImages() {
    if (!document || !document.querySelectorAll) return;
    for (const [selector, file] of Object.entries(IMAGE_MAP)) {
      try {
        const nodes = document.querySelectorAll(selector);
        nodes.forEach(node => {
          if (node.tagName === 'IMG') {
            if (!node.src || node.src.indexOf('assets/') === -1) {
              node.src = '/assets/' + file;
            }
          }
        });
      } catch (_) { /* selector might not exist on this page state */ }
    }
    // Also set the project showcase photo empty placeholder background
    const photo = document.getElementById('projectPhoto');
    if (photo && !photo.classList.contains('has-image')) {
      const cover = document.getElementById('projectCover');
      if (cover && !cover.src) {
        cover.src = '/assets/hero-construction-site-1.jpg';
        photo.classList.add('has-image');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyImages);
  } else {
    applyImages();
  }
  // Re-apply after a short delay in case the SPA renders late
  setTimeout(applyImages, 1500);
  } // end if (typeof document !== 'undefined')
})();
