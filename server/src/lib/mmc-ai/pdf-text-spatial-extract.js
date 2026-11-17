'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_WORDS = 20000;

function decodeXml(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const key = entity.toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return "'";
    const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function parseBboxLayout(xhtml) {
  const pages = [];
  const pageRe = /<page\b([^>]*)>([\s\S]*?)<\/page>/gi;
  let pageMatch;
  while ((pageMatch = pageRe.exec(String(xhtml || '')))) {
    const attrs = pageMatch[1];
    const numberAttr = name => {
      const match = attrs.match(new RegExp('\\b' + name + '="([-+0-9.eE]+)"'));
      return match ? Number(match[1]) : null;
    };
    const words = [];
    const wordRe = /<word\b([^>]*)>([\s\S]*?)<\/word>/gi;
    let wordMatch;
    while ((wordMatch = wordRe.exec(pageMatch[2])) && words.length < MAX_WORDS) {
      const get = name => {
        const match = wordMatch[1].match(new RegExp('\\b' + name + '="([-+0-9.eE]+)"'));
        return match ? Number(match[1]) : null;
      };
      const box = { xMin: get('xMin'), yMin: get('yMin'), xMax: get('xMax'), yMax: get('yMax') };
      if (Object.values(box).every(Number.isFinite)) {
        words.push({ text: decodeXml(wordMatch[2].replace(/<[^>]+>/g, '').trim()), box });
      }
    }
    const lines = [];
    const lineRe = /<line\b[^>]*>([\s\S]*?)<\/line>/gi;
    let lineMatch;
    while ((lineMatch = lineRe.exec(pageMatch[2]))) {
      const lineWords = [...lineMatch[1].matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/gi)]
        .map(match => decodeXml(match[1].replace(/<[^>]+>/g, '').trim())).filter(Boolean);
      if (lineWords.length) lines.push(lineWords.join(' '));
    }
    pages.push({
      width: numberAttr('width'),
      height: numberAttr('height'),
      coordinateSystem: 'Poppler pdftotext bbox coordinates; origin at page top-left; PDF points',
      words,
      lines,
      wordCount: words.length,
      truncated: words.length >= MAX_WORDS
    });
  }
  return pages;
}

function parseSvgPageFrame(svg) {
  const root = String(svg || '').match(/<svg\\b[^>]*>/i)?.[0];
  if (!root) return null;
  const attrs = {};
  const attrRe = /([a-zA-Z_:][\\w:.-]*)\\s*=\\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = attrRe.exec(root))) attrs[match[1]] = match[2] ?? match[3] ?? '';
  const parseLength = value => {
    const found = String(value || '').trim().match(/^([+-]?(?:\\d*\\.)?\\d+(?:[eE][+-]?\\d+)?)(?:pt|px|mm|cm|in)?$/i);
    return found ? Number(found[1]) : null;
  };
  const viewBox = attrs.viewBox ? attrs.viewBox.trim().split(/[\\s,]+/).map(Number) : [];
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) return null;
  return {
    width: viewBox[2], height: viewBox[3], viewBox,
    physicalWidth: parseLength(attrs.width), physicalHeight: parseLength(attrs.height),
    coordinateSystem: 'Poppler SVG page viewBox; top-left origin; page vector coordinates'
  };
}

async function extractPdfTextSpatial(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('Invalid PDF header'), { code: 'PDF_SPATIAL_TEXT_INVALID' });
  }
  if (bytes.length > MAX_PDF_BYTES) {
    throw Object.assign(new Error('PDF exceeds spatial text extraction size limit'), { code: 'PDF_SPATIAL_TEXT_TOO_LARGE' });
  }
  let directory;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mmc-ai-pdf-bbox-'));
    const pdfPath = path.join(directory, 'source.pdf');
    await fs.writeFile(pdfPath, bytes, { flag: 'wx', mode: 0o600 });
    const page = Math.max(1, Math.floor(Number(options.pageNumber) || 1));
    const result = await run('pdftotext', [
      '-f', String(page), '-l', String(page), '-bbox-layout', '-enc', 'UTF-8', pdfPath, '-'
    ], { timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
    const pages = parseBboxLayout(result.stdout);
    const current = pages[0] || null;
    let vectorFrame = null;
    try {
      const svgPrefix = path.join(directory, 'aligned-page');
      await run('pdftocairo', ['-f', String(page), '-l', String(page), '-svg', pdfPath, svgPrefix], {
        timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
      });
      const svg = await fs.readFile(svgPrefix, 'utf8');
      vectorFrame = parseSvgPageFrame(svg);
    } catch (_) {
      // Keep the raw Poppler text boxes available when SVG frame extraction is unavailable.
    }
    if (current && vectorFrame) {
      const [originX, originY] = vectorFrame.viewBox;
      const widthDelta = Math.abs(current.width - vectorFrame.width);
      const heightDelta = Math.abs(current.height - vectorFrame.height);
      const dimensionsMatch = widthDelta <= 1.5 && heightDelta <= 1.5;
      current.sourcePageSize = { width: current.width, height: current.height };
      if (dimensionsMatch) {
        current.words = current.words.map(word => ({
          ...word,
          box: {
            xMin: word.box.xMin - originX, yMin: word.box.yMin - originY,
            xMax: word.box.xMax - originX, yMax: word.box.yMax - originY
          }
        }));
        current.width = vectorFrame.width;
        current.height = vectorFrame.height;
        current.coordinateSystem = vectorFrame.coordinateSystem;
        current.frameAlignment = 'dimensions_verified_translation_only';
      } else {
        current.frameAlignment = 'not_aligned_page_dimensions_differ';
        current.frameAlignmentDiagnostics = {
          bboxPage: current.sourcePageSize,
          svgViewBox: { width: vectorFrame.width, height: vectorFrame.height },
          widthDelta, heightDelta
        };
      }
    }
    return {
      engine: 'poppler-pdftotext-bbox-layout+svg-frame-v3',
      status: current && current.wordCount ? 'spatial_text_extracted' : 'no_spatial_text_found',
      pageNumber: page,
      pageCountReturned: pages.length,
      vectorFrame,
      page: current,
      limitations: [
        'Text boxes use Poppler bbox positions aligned to the pdftocairo SVG viewBox when that frame is available.',
        'This frame alignment does not interpret dimensions, symbols, drawing scales, or engineering element types.',
        'Image-only text requires OCR and is not included in this native text result.',
        'All boxes remain page points, not calibrated real-world dimensions.'
      ]
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { engine: 'poppler-pdftotext-bbox-layout-v1', status: 'runtime_unavailable', pageNumber: options.pageNumber || 1, page: null, diagnostics: ['pdftotext executable is unavailable'] };
    }
    throw error;
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { decodeXml, parseBboxLayout, parseSvgPageFrame, extractPdfTextSpatial };
