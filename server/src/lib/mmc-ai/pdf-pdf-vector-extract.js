'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { measureSvgPathData } = require('./pdf-vector-geometry');

const round = value => Number(value.toFixed(6));
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

function readAttributes(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = re.exec(tag))) attrs[match[1]] = match[2] ?? match[3] ?? '';
  return attrs;
}

function multiplyMatrices(left, right) {
  const [a,b,c,d,e,f] = left, [g,h,i,j,k,l] = right;
  return [
    a*g+c*h, b*g+d*h,
    a*i+c*j, b*i+d*j,
    a*k+c*l+e, b*k+d*l+f
  ];
}

function parseSvgMatrix(value) {
  if (!value) return [...IDENTITY];
  const source = String(value).trim();
  const transformRe = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match, consumed = '', result = [...IDENTITY];
  const numberRe = /^[\s,]*[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?(?:[\s,]+[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?)*[\s,]*$/;
  while ((match = transformRe.exec(source))) {
    consumed += match[0];
    const name = match[1], raw = match[2].trim();
    if (!numberRe.test(raw)) throw new TypeError('Invalid SVG transform parameters');
    const values = raw.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!values.every(Number.isFinite)) throw new TypeError('SVG transform contains invalid values');
    let next;
    if (name === 'matrix' && values.length === 6) next = values;
    else if (name === 'translate' && (values.length === 1 || values.length === 2)) next = [1,0,0,1,values[0],values[1] || 0];
    else if (name === 'scale' && (values.length === 1 || values.length === 2)) next = [values[0],0,0,values.length === 2 ? values[1] : values[0],0,0];
    else if (name === 'rotate' && (values.length === 1 || values.length === 3)) {
      const angle = values[0] * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
      const rotation = [cos,sin,-sin,cos,0,0];
      next = values.length === 1 ? rotation : multiplyMatrices(
        multiplyMatrices([1,0,0,1,values[1],values[2]], rotation),
        [1,0,0,1,-values[1],-values[2]]
      );
    } else if (name === 'skewX' && values.length === 1) next = [1,0,Math.tan(values[0]*Math.PI/180),1,0,0];
    else if (name === 'skewY' && values.length === 1) next = [1,Math.tan(values[0]*Math.PI/180),0,1,0,0];
    else throw new TypeError('Unsupported SVG transform: ' + name);
    result = multiplyMatrices(result, next);
  }
  if (consumed.replace(/[\s,]/g, '') !== source.replace(/[\s,]/g, '')) {
    throw new TypeError('Unsupported or malformed SVG transform');
  }
  return result;
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
  const paths = [];
  const stack = [{ matrix: [...IDENTITY], tag: 'svg' }];
  const tokenRe = /<\/?(?:g|path|defs|svg)\b[^>]*>/gi;
  let match, unsupported = 0, groupCount = 0;
  while ((match = tokenRe.exec(svg))) {
    const tag = match[0];
    const closing = /^<\//.test(tag);
    const name = tag.match(/^<\/?([a-z]+)/i)?.[1]?.toLowerCase();
    if (closing) {
      if (name === 'g' && stack.length > 1) stack.pop();
      continue;
    }
    const attrs = readAttributes(tag);
    if (name === 'defs') continue;
    if (name === 'g') {
      try {
        const local = parseSvgMatrix(attrs.transform);
        stack.push({ tag: 'g', matrix: multiplyMatrices(stack.at(-1).matrix, local) });
        groupCount++;
        if (/\/\s*>$/.test(tag)) stack.pop();
      } catch (_) {
        unsupported++;
        stack.push({ tag: 'g', matrix: stack.at(-1).matrix, invalid: true });
      }
      continue;
    }
    if (name !== 'path' || !attrs.d) continue;
    try {
      if (stack.some(item => item.invalid)) throw new TypeError('Unsupported parent group transform');
      const local = parseSvgMatrix(attrs.transform);
      const matrix = multiplyMatrices(stack.at(-1).matrix, local);
      const parsed = measureSvgPathData(attrs.d);
      const transformed = transformGeometry(parsed, matrix);
      for (const item of transformed.paths) paths.push({ ...item, source: 'pdftocairo_svg_path', transform: matrix });
    } catch (_) {
      unsupported++;
    }
  }
  return {
    engine: 'mmc-pdf-poppler-svg-v2',
    pathCount: paths.length,
    paths,
    groupTransformCount: groupCount,
    unsupportedPathCount: unsupported,
    limitations: [
      'Straight SVG path segments M/L/H/V/Z are measured; curves and arcs remain unsupported and are reported.',
      'Nested group transforms and matrix, translate, scale, rotate, skewX and skewY transforms are applied.',
      'Text glyph outlines in SVG definitions, clipping, stroke widths and compound fill rules are not measured.',
      'Vector paths are geometric evidence only; no automatic wall, slab, footing or BOQ classification is claimed.',
      'Scale is not inferred from page size or printed notation; an explicit verified dimension is required.'
    ]
  };
}

async function inspectPdfVectorPage(input, { pageNumber = 1, knownDistanceMm = null, calibrationPointA = null, calibrationPointB = null } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw Object.assign(new Error('Invalid PDF header'), { code: 'PDF_VECTOR_INVALID' });
  if (bytes.length > 25 * 1024 * 1024) throw Object.assign(new Error('PDF exceeds 25 MB vector-analysis limit'), { code: 'PDF_VECTOR_TOO_LARGE' });
  if (!Number.isInteger(pageNumber) || pageNumber < 1) throw new TypeError('pageNumber must be a positive integer');
  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mmc-ai-pdf-vector-'));
    const pdfPath = path.join(dir, 'source.pdf'), outputPrefix = path.join(dir, 'page');
    await fs.writeFile(pdfPath, bytes, { flag: 'wx', mode: 0o600 });
    await run('pdftocairo', ['-f', String(pageNumber), '-l', String(pageNumber), '-svg', pdfPath, outputPrefix], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const files = await fs.readdir(dir);
    const svgName = files.find(name => name === 'page' || /^page(?:-\d+)?\.svg$/.test(name));
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
      engine: 'mmc-pdf-poppler-svg-vector-v2', pageNumber, svgViewBox: viewBox, geometry, calibrated,
      status: geometry.pathCount ? 'vector_geometry_extracted_requires_engineering_review' : 'no_supported_vector_paths_found',
      notice: 'تم استخراج مسارات متجهة. لا تُعد كميات تعاقدية قبل التحقق من المقياس والتصنيف والمراجعة الهندسية.',
      source: { converter: 'pdftocairo -svg', pageNumber }, approvalEligible: false
    };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { readAttributes, parseSvgMatrix, multiplyMatrices, transformGeometry, parseSvgVectorPaths, inspectPdfVectorPage };
