'use strict';

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
