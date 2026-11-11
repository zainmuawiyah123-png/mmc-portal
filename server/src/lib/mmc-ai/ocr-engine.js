'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_DPI = 200;

function parseTesseractTsv(tsv) {
  const lines = String(tsv || '').split(/\r?\n/);
  const words = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const confidence = Number(cols[10]);
    const text = cols.slice(11).join('\t').trim();
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    words.push({
      text,
      confidence: Math.round(confidence * 100) / 100,
      box: {
        left: Number(cols[6]) || 0,
        top: Number(cols[7]) || 0,
        width: Number(cols[8]) || 0,
        height: Number(cols[9]) || 0
      },
      block: Number(cols[2]) || 0,
      paragraph: Number(cols[3]) || 0,
      line: Number(cols[4]) || 0
    });
  }
  const grouped = new Map();
  for (const word of words) {
    const key = [word.block, word.paragraph, word.line].join(':');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(word);
  }
  const text = [...grouped.values()].map(group => group.map(word => word.text).join(' ')).join('\n');
  const averageConfidence = words.length
    ? Math.round(words.reduce((sum, word) => sum + word.confidence, 0) / words.length * 100) / 100
    : null;
  return { text, words, wordCount: words.length, averageConfidence };
}

async function commandAvailable(command, args = ['--version']) {
  try {
    await run(command, args, { timeout: 5000, maxBuffer: 1024 * 1024 });
    return true;
  } catch (error) {
    return error && error.code !== 'ENOENT';
  }
}

async function inspectOcrRuntime() {
  const [renderer, tesseract] = await Promise.all([
    commandAvailable('pdftoppm', ['-v']),
    commandAvailable('tesseract', ['--version'])
  ]);
  if (!renderer || !tesseract) {
    return {
      available: false,
      engine: 'tesseract-pdftoppm',
      missing: [!renderer ? 'pdftoppm' : null, !tesseract ? 'tesseract' : null].filter(Boolean)
    };
  }
  try {
    const result = await run('tesseract', ['--list-langs'], { timeout: 10000, maxBuffer: 1024 * 1024 });
    const languages = result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(1);
    return {
      available: languages.includes('eng') && languages.includes('ara'),
      engine: 'tesseract-pdftoppm',
      languages,
      missing: ['eng', 'ara'].filter(language => !languages.includes(language))
    };
  } catch {
    return { available: false, engine: 'tesseract-pdftoppm', missing: ['language-list'] };
  }
}

async function ocrPdf(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw Object.assign(new Error('Invalid PDF header'), { code: 'OCR_PDF_INVALID' });
  }
  if (bytes.length > MAX_PDF_BYTES) {
    throw Object.assign(new Error('PDF exceeds OCR size limit'), { code: 'OCR_PDF_TOO_LARGE' });
  }
  const maxPages = Math.min(50, Math.max(1, Number(options.maxPages) || DEFAULT_MAX_PAGES));
  const dpi = Math.min(300, Math.max(120, Number(options.dpi) || DEFAULT_DPI));
  const runtime = await inspectOcrRuntime();
  if (!runtime.available) {
    throw Object.assign(
      new Error('OCR runtime unavailable; install Poppler, Tesseract, and eng/ara language data.'),
      { code: 'OCR_RUNTIME_UNAVAILABLE', details: runtime }
    );
  }

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mmc-ai-ocr-'));
  const pdfPath = path.join(directory, 'source.pdf');
  const prefix = path.join(directory, 'page');
  try {
    await fs.writeFile(pdfPath, bytes, { flag: 'wx', mode: 0o600 });
    await run('pdftoppm', [
      '-f', '1', '-l', String(maxPages), '-r', String(dpi), '-png', pdfPath, prefix
    ], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });

    const names = (await fs.readdir(directory))
      .filter(name => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    if (!names.length) {
      throw Object.assign(new Error('PDF renderer produced no page images.'), { code: 'OCR_RENDER_EMPTY' });
    }

    const pages = [];
    for (let index = 0; index < names.length; index++) {
      const imagePath = path.join(directory, names[index]);
      const result = await run('tesseract', [
        imagePath, 'stdout', '-l', 'eng+ara', '--psm', '11', 'tsv'
      ], { timeout: 90000, maxBuffer: 12 * 1024 * 1024 });
      const parsed = parseTesseractTsv(result.stdout);
      pages.push({
        page: index + 1,
        text: parsed.text,
        wordCount: parsed.wordCount,
        averageConfidence: parsed.averageConfidence,
        words: parsed.words
      });
    }
    return {
      engine: 'tesseract-pdftoppm-v1',
      status: pages.some(page => page.wordCount) ? 'ocr_text_extracted' : 'ocr_no_text_found',
      languageModel: 'eng+ara',
      dpi,
      pageLimit: maxPages,
      pagesProcessed: pages.length,
      truncatedAtPageLimit: pages.length === maxPages,
      characterCount: pages.reduce((sum, page) => sum + page.text.length, 0),
      pages,
      limitations: [
        'OCR is visual text recognition, not engineering interpretation or quantity takeoff.',
        'Dimensions, symbols, linework, and schedules still require semantic and geometric analysis.',
        'Recognition confidence is indicative and all engineering-critical values require verification.'
      ]
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { ocrPdf, parseTesseractTsv, inspectOcrRuntime };
