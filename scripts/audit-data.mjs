import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dataRoot = path.join(root, 'public', 'data');
const sourceRoot = path.join(root, '行测题库');
const maxExamples = 20;

const issueNames = [
  'invalidJson', 'duplicateIds', 'missingDetail', 'orphanDetails', 'detailIdMismatch',
  'missingFields', 'suspiciousText', 'missingImages', 'brokenImages', 'unsupportedImageRefs',
  'invalidImageAssets', 'imageExtensionMismatches', 'sourceMissingImages', 'sourceSuspiciousText',
];
const issues = Object.fromEntries(issueNames.map((name) => [name, []]));
const issueTotals = Object.fromEntries(issueNames.map((name) => [name, 0]));
const counts = {
  summaries: 0, details: 0, questions: 0, choiceQuestions: 0, subjectiveQuestions: 0,
  imageReferences: 0, uniqueImageReferences: 0, markdownImageReferences: 0,
  htmlImageReferences: 0, imageAssets: 0, validImageAssets: 0, cidMarkers: 0,
  replacementCharacters: 0, controlCharacters: 0, sourceCidMarkers: 0, sourceReplacementCharacters: 0,
};
const seenIds = new Map();
const summaryIds = new Set();
const detailIds = new Set();
const imageRefs = new Set();
const imageStatusCache = new Map();

function record(name, value) {
  issueTotals[name] += 1;
  if (issues[name].length < maxExamples) issues[name].push(value);
}

function collectStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, output);
  return output;
}

function relative(filePath) {
  return path.relative(root, filePath).replaceAll('\\', '/');
}

function suspiciousPatterns(value) {
  const patterns = [];
  if (value.includes('\ufffd')) patterns.push('replacement-character');
  if (/\bcid:\d+\b/i.test(value)) patterns.push('cid-marker');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) patterns.push('control-character');
  if (/(?:Ã.|Â.|â.|ï¿)/.test(value)) patterns.push('mojibake');
  return patterns;
}

function extractImageRefs(value) {
  const refs = [];
  const html = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  const markdown = /!\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of value.matchAll(html)) refs.push({ ref: match[1], kind: 'html' });
  for (const match of value.matchAll(markdown)) refs.push({ ref: match[1].trim().replace(/^<|>$/g, ''), kind: 'markdown' });
  return refs;
}

function resolveImageRef(ref) {
  if (!ref.startsWith('/data/xingce-images/')) return null;
  const encoded = ref.slice('/data/'.length).split(/[?#]/, 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(encoded); } catch { return { path: null, reason: 'invalid-url-encoding' }; }
  const target = path.resolve(dataRoot, decoded);
  const imageRoot = path.resolve(dataRoot, 'xingce-images');
  if (!target.startsWith(`${imageRoot}${path.sep}`)) return { path: null, reason: 'path-traversal' };
  return { path: target, reason: null };
}

function detectImage(buffer) {
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const valid = buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0;
    return { type: 'png', ok: valid, reason: valid ? null : 'invalid-png-header' };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const valid = buffer.length >= 6 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
    return { type: 'jpeg', ok: valid, reason: valid ? null : 'invalid-jpeg-marker' };
  }
  const gifSignature = buffer.toString('ascii', 0, 6);
  if (buffer.length >= 10 && (gifSignature === 'GIF87a' || gifSignature === 'GIF89a')) {
    const valid = buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0;
    return { type: 'gif', ok: valid, reason: valid ? null : 'invalid-gif-header' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { type: 'webp', ok: true, reason: null };
  }
  return { type: 'unknown', ok: false, reason: 'unknown-image-signature' };
}

function expectedTypes(extension) {
  const ext = extension.toLowerCase();
  if (ext === '.png') return ['png'];
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.jfif') return ['jpeg'];
  if (ext === '.gif') return ['gif'];
  if (ext === '.webp') return ['webp'];
  return [];
}

async function readJson(filePath) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { record('invalidJson', { file: relative(filePath), error: error.message }); return null; }
}

async function readAllFiles(directory) {
  const files = [];
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { record('invalidJson', { file: relative(directory), error: error.message }); return files; }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await readAllFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

async function inspectImage(filePath) {
  if (imageStatusCache.has(filePath)) return imageStatusCache.get(filePath);
  let status;
  try { status = detectImage(await fs.readFile(filePath)); }
  catch (error) { status = { type: 'missing', ok: false, reason: error.code === 'ENOENT' ? 'missing' : error.message }; }
  imageStatusCache.set(filePath, status);
  return status;
}

async function scanAssets() {
  const files = await readAllFiles(path.join(dataRoot, 'xingce-images'));
  counts.imageAssets = files.length;
  for (const filePath of files) {
    const status = await inspectImage(filePath);
    if (!status.ok) record('invalidImageAssets', { file: relative(filePath), reason: status.reason, type: status.type });
    else counts.validImageAssets += 1;
    if (status.ok && !expectedTypes(path.extname(filePath)).includes(status.type)) {
      record('imageExtensionMismatches', { file: relative(filePath), extension: path.extname(filePath), actualType: status.type });
    }
  }
}

function scanQuestionText(id, filePath, question) {
  for (const value of collectStrings(question)) {
    for (const pattern of suspiciousPatterns(value)) {
      if (pattern === 'cid-marker') counts.cidMarkers += 1;
      if (pattern === 'replacement-character') counts.replacementCharacters += 1;
      if (pattern === 'control-character') counts.controlCharacters += 1;
      record('suspiciousText', { id, file: relative(filePath), pattern, sample: value.slice(0, 180) });
    }
    for (const image of extractImageRefs(value)) {
      counts.imageReferences += 1;
      if (image.kind === 'html') counts.htmlImageReferences += 1;
      else counts.markdownImageReferences += 1;
      const resolved = resolveImageRef(image.ref);
      if (!resolved) { if (image.ref.startsWith('/')) record('unsupportedImageRefs', { id, ref: image.ref }); continue; }
      imageRefs.add(image.ref);
      if (!resolved.path) { record('unsupportedImageRefs', { id, ref: image.ref, reason: resolved.reason }); continue; }
      const status = imageStatusCache.get(resolved.path);
      if (!status || status.reason === 'missing') record('missingImages', { id, ref: image.ref, file: relative(resolved.path) });
      else if (!status.ok) record('brokenImages', { id, ref: image.ref, file: relative(resolved.path), reason: status.reason });
    }
  }
}

async function scanSourceFiles() {
  const files = (await readAllFiles(sourceRoot)).filter((file) => file.toLowerCase().endsWith('.md'));
  const missing = new Map();
  for (const filePath of files) {
    const text = await fs.readFile(filePath, 'utf8');
    for (const pattern of suspiciousPatterns(text)) {
      if (pattern === 'cid-marker') counts.sourceCidMarkers += 1;
      if (pattern === 'replacement-character') counts.sourceReplacementCharacters += 1;
      record('sourceSuspiciousText', { file: relative(filePath), pattern });
    }
    const sourcePath = relative(filePath);
    const sourceDirectory = path.posix.dirname(sourcePath);
    for (const image of extractImageRefs(text)) {
      if (/^(?:https?:|data:|\/)/i.test(image.ref)) continue;
      const resolved = path.posix.normalize(path.posix.join(sourceDirectory, image.ref));
      if (!resolved.startsWith('行测题库/90-图片/')) continue;
      try { await fs.access(path.join(root, resolved)); }
      catch { missing.set(resolved, { file: sourcePath, ref: image.ref, asset: resolved }); }
    }
  }
  for (const issue of missing.values()) record('sourceMissingImages', issue);
}

const manifest = await readJson(path.join(dataRoot, 'index.json'));
if (!manifest) process.exitCode = 1;
await scanAssets();
const summaries = [];
for (const subject of manifest?.subjects || []) {
  const payload = await readJson(path.join(dataRoot, manifest.summaryFiles[subject]));
  counts.summaries += 1;
  if (payload?.questions) summaries.push(...payload.questions);
}
const detailFiles = (await readAllFiles(path.join(dataRoot, 'details'))).filter((file) => file.endsWith('.json'));
for (const summary of summaries) {
  counts.questions += 1;
  if (summary.mode === 'choice') counts.choiceQuestions += 1; else counts.subjectiveQuestions += 1;
  summaryIds.add(summary.id);
  if (seenIds.has(summary.id)) record('duplicateIds', { id: summary.id, files: [seenIds.get(summary.id), summary.path] });
  else seenIds.set(summary.id, summary.path);
  if (!summary.id || !summary.title || !summary.path || !summary.detailChunk) record('missingFields', { id: summary.id, fields: ['id', 'title', 'path', 'detailChunk'].filter((key) => !summary[key]) });
  const detailPath = path.join(dataRoot, summary.detailChunk || 'missing-detail.json');
  try { await fs.access(detailPath); } catch { record('missingDetail', { id: summary.id, detailChunk: summary.detailChunk }); }
  scanQuestionText(summary.id, detailPath, summary);
}
for (const filePath of detailFiles) {
  const payload = await readJson(filePath);
  counts.details += 1;
  for (const [id, question] of Object.entries(payload?.questions || {})) {
    detailIds.add(id);
    if (id !== question.id) record('detailIdMismatch', { file: relative(filePath), key: id, id: question.id });
    if (!question.stem?.trim() || !question.title?.trim()) record('missingFields', { id, file: relative(filePath), fields: [!question.title?.trim() ? 'title' : '', !question.stem?.trim() ? 'stem' : ''].filter(Boolean) });
    scanQuestionText(id, filePath, question);
  }
}
for (const id of detailIds) if (!summaryIds.has(id)) record('orphanDetails', { id });
counts.uniqueImageReferences = imageRefs.size;
await scanSourceFiles();

const blockingNames = issueNames.filter((name) => !['sourceMissingImages', 'sourceSuspiciousText'].includes(name));
const result = {
  ok: blockingNames.every((name) => issueTotals[name] === 0),
  warnings: issueTotals.sourceMissingImages + issueTotals.sourceSuspiciousText,
  manifest: { total: manifest?.total || 0, subjects: manifest?.subjects || [] },
  counts,
  issueCounts: issueTotals,
  examples: issues,
};
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 2;
