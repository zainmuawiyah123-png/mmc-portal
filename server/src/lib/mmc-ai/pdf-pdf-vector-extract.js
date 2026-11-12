'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { measureSvgPathData } = require('./pdf-vector-geometry');

const round = value => Number(value.toFixed(6));

function readAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = re.exec(tag))) attrs[match[1]] = match[2];
  return attrs;
}

function parseSvgMatrix(value) {
  if (!value) return [1, 0, 0, 1, 0, 0];
  const match = String(value).match(/^matrix\(\s*([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)\s*\)$/);
  if (!match) throw new TypeError('Unsupported SVG transform; only a single affine matrix is supported');
  const matrix = match.slice(1).map(Number);
  if (!matrix.every(Number.isFinite)) throw new TypeError('SVG transform matrix contains invalid values');
  return matrix;
}

function transformGeometry(geometry, matrix) {
  const [a, b, c, d, e, f] = matrix;
  const paths = geometry.paths.map(path => {
    const points = path.points.map(point => ({
      x: a * point.x + c * point.y + e,
      y: b * point.x + d * point.y + f
    }));
    let length = 0;
    for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    let area2 = 0;
    if (path.closed && points.length >= 3) {
      const vertices = points[0].x === points.at(-1).x && points[0].y === points.at(-1).y ? points.slice(0, -1) : points;
      for (let i = 0; i < vertices.length; i++) {
        const p = vertices[i], q = vertices[(i + 1) % vertices.length];
        area2 += p.x * q.y - q.x * p.y;
      }
    }
    return {
      closed: path.closed,
      points: points.map(p => ({ x: round(p.x), y: round(p.y) })),
      lengthUnits: round(length),
      areaSquareUnits: path.closed ? round(Math.abs(area2) / 2) : null,
      vertexCount: path.vertexCount
    };
  }).filter(path => path.vertexCount >= 2);
  return { ...geometry, paths, pathCount: paths.length };
}

function parseSvgVectorPaths(svg) {
  if (typeof svg !== 'string' || !/<svg\b/i.test(svg)) throw new TypeError('Invalid SVG page output');
  const withoutDefs = svg.replace(/<defs\b[^>]*>[\s\S]*?<\/defs>/gi, '');
  const paths = [];
  const re = /<path\b([^>]*)\/?>/gi;
  let match, unsupported = 0;
  while ((match = re.exec(withoutDefs))) {
    const attrs = readAttributes(match[1]);
    if (!attrs.d) continue;
    try {
      const parsed = measureSvgPathData(attrs.d);
      const matrix = parseSvgMatrix(attrs.transform);
      const transformed = transformGeometry(parsed, matrix);
      for (const item of transformed.paths) {
        paths.push({
          ...item,
          source: 'pdftocairo_svg_path',
          transform: matrix
        });
      }
    } catch (error) {
      unsupported++;
    }
  }
  return {
    engine: 'mmc-pdf-poppler-svg-v1',
    pathCount: paths.length,
    paths,
    unsupportedPathCount: unsupported,
    limitations: [
      'Only SVG path straight segments M/L/H/V/Z are measured.',
      'Only a single SVG matrix transform per path is applied; nested group transforms and other transforms are not yet interpreted.',
      'Text glyph outlines in SVG definitions are excluded; curves, arcs, clipping and compound fill rules are not measured.',
      'Vector paths are not automatically classified as walls, slabs, footings or BOQ items.',
      'Scale is not inferred from paper size or printed scale notation; an explicit verified dimension is required.'
    ]
  };
}

async function inspectPdfVectorPage(input, { pageNumber = 1, knownDistanceMm = null, calibrationPointA = null, calibrationPointB = null } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('Invalid PDF header'), { code: 'PDF_VECTOR_INVALID' });
  }
  if (bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error('PDF exceeds 25 MB vector-analysis limit'), { code: 'PDF_VECTOR_TOO_LARGE' });
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new TypeError('pageNumber must be a positive integer');

  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmc-ai-pdf-vector-'));
    const pdfPath = path.join(dir, 'source.pdf');
    const outputPrefix = path.join(dir, 'page');
    await fs.writeFile(pdfPath, bytes, { flag: 'wx', mode: 0o600 });
    await run('pdftocairo', ['-f', String(pageNumber), '-l', String(pageNumber), '-svg', pdfPath, outputPrefix], {
      timeout: 30000, maxBuffer: 1024 * 1024
    });
    const files = await fs.readdir(dir);
    const svgName = files.find(name => /^page(?:-\d+)?\.svg$/.test(name));
    if (!svgName) throw Object.assign(new Error('Poppler did not produce an SVG page'), { code: 'PDF_VECTOR_SVG_MISSING' });
    const svg = await fs.readFile(path.join(dir, svgName), 'utf8');
    const geometry = parseSvgVectorPaths(svg);
    const dimensions = svg.match(/<svg\b[^>]*\bwidth="([^"]+)"[^>]*\bheight="([^"]+)"[^>]*\bviewBox="([^"]+)"/i);
    const viewBox = dimensions?.[3].trim().split(/[ ,]+/).map(Number) || null;
    let calibrated = null;
    if (knownDistanceMm !== null) {
      if (!calibrationPointA || !calibrationPointB) throw new TypeError('Two explicit calibration points are required with knownDistanceMm');
      const { calibrateSvgPage, applySvgCalibration } = require('./pdf-vector-geometry');
      const calibration = calibrateSvgPage({ pointA: calibrationPointA, pointB: calibrationPointB, knownDistanceMm });
      calibrated = { calibration, measurements: applySvgCalibration(geometry, calibration) };
    }
    return {
      engine: 'mmc-pdf-poppler-svg-vector-v1',
      pageNumber,
      svgViewBox: viewBox,
      geometry,
      calibrated,
      status: geometry.pathCount ? 'vector_geometry_extracted_requires_engineering_review' : 'no_supported_vector_paths_found',
      notice: 'تم استخراج مسارات متجهة من صفحة PDF. لا تُعد المسارات كميات تعاقدية قبل معايرة مؤكدة ومراجعة هندسية.',
      source: { converter: 'pdftocairo -svg', pageNumber },
      approvalEligible: false
    };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { readAttributes, parseSvgMatrix, transformGeometry, parseSvgVectorPaths, inspectPdfVectorPage };
