import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const sourceRoots = ['申论题库', '综应题库'];
const outputRoot = path.join(root, 'public', 'data');
const questionsRoot = path.join(outputRoot, 'questions');
const indexPath = path.join(outputRoot, 'index.json');
const knowledgeIndexPath = path.join(root, '智能系统', '知识库索引', 'questions_index.jsonl');

const sectionNames = {
  title: ['题目'],
  material: ['给定材料', '材料'],
  answer: ['参考答案'],
  demo: ['答题演示'],
};

function normalize(value = '') {
  return value.replace(/\r\n/g, '\n').replace(/\u000d/g, '').trim();
}

function stripMarkdown(value = '') {
  return normalize(value)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1');
}

function sectionRange(text, names) {
  const heading = new RegExp(`^##\\s+[📌📖✅🎓]?\\s*(?:${names.join('|')})\\s*$`, 'mu');
  const match = heading.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const next = /^##\s+/gmu;
  next.lastIndex = start;
  const nextMatch = next.exec(text);
  return text.slice(start, nextMatch ? nextMatch.index : text.length).trim();
}

function metadata(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^>\s*\*\*(.+?)\*\*\s*[：:]\s*(.+)$/);
    if (match) result[match[1].trim()] = stripMarkdown(match[2]);
  }
  return result;
}

function firstHeading(text) {
  return text.match(/^#\s+(.+)$/mu)?.[1]?.trim() || '未命名题目';
}

function parseOptions(stem) {
  const options = [];
  const lines = stem.split('\n');
  for (const line of lines) {
    const match = line.trim().match(/^([A-H])[.、)）]\s*(.+)$/);
    if (match) options.push({ key: match[1], text: stripMarkdown(match[2]) });
  }
  return options.length >= 2 ? options : [];
}

function questionId(relativePath, meta, title) {
  if (meta['编号']) return meta['编号'].replace(/\s/g, '');
  return crypto.createHash('sha1').update(`${relativePath}\n${title}`).digest('hex').slice(0, 12);
}

function parseNumber(value, fallback = 0) {
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : fallback;
}

function makeQuestion(text, relativePath, enriched) {
  const meta = metadata(text);
  const title = firstHeading(text);
  const stem = stripMarkdown(sectionRange(text, sectionNames.title) || title);
  const material = stripMarkdown(sectionRange(text, sectionNames.material));
  const answer = stripMarkdown(sectionRange(text, sectionNames.answer));
  const demo = stripMarkdown(sectionRange(text, sectionNames.demo));
  const category = path.basename(path.dirname(relativePath));
  const subject = relativePath.startsWith('申论题库') ? '申论' : '综应';
  const id = questionId(relativePath, meta, title);
  const indexed = enriched.get(String(meta['编号'] || '')) || {};
  const typeValue = meta['类型'] || category;
  const questionType = typeValue.split('·')[0].trim() || category;
  const detailType = typeValue.split('·')[1]?.trim() || meta['考点'] || '';
  const options = parseOptions(stem);

  return {
    id,
    subject,
    category,
    questionType,
    detailType,
    title,
    stem,
    material,
    answer,
    demo,
    source: meta['来源'] || '',
    score: parseNumber(stem.match(/（(\d+)分）/)?.[1], 0),
    options,
    mode: options.length ? 'choice' : 'subjective',
    themes: indexed.themes || [],
    elements: indexed.elements || [],
    difficulty: indexed.difficulty || 2,
    pointCount: indexed.n_points || 0,
    hasRubric: Boolean(indexed.has_rubric),
    path: relativePath.replaceAll('\\', '/'),
  };
}

async function readFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await readFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') files.push(fullPath);
  }
  return files;
}

async function loadEnrichment() {
  const enriched = new Map();
  try {
    const lines = (await fs.readFile(knowledgeIndexPath, 'utf8')).split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      enriched.set(String(item.fenbi_id), item);
    }
  } catch {
    // The question bank remains usable when the optional derived index is absent.
  }
  return enriched;
}

await fs.rm(outputRoot, { recursive: true, force: true });
await fs.mkdir(questionsRoot, { recursive: true });
const enriched = await loadEnrichment();
const files = [];
for (const sourceRoot of sourceRoots) files.push(...await readFiles(path.join(root, sourceRoot)));

const questions = [];
for (const file of files) {
  const relativePath = path.relative(root, file);
  const text = await fs.readFile(file, 'utf8');
  const question = makeQuestion(text, relativePath, enriched);
  const fullPath = path.join(questionsRoot, `${question.id}.json`);
  const payload = { ...question, generatedAt: new Date().toISOString() };
  await fs.writeFile(fullPath, JSON.stringify(payload));
  const { material, answer, demo, ...summary } = question;
  summary.materialLength = material.length;
  summary.answerLength = answer.length;
  summary.demoLength = demo.length;
  questions.push(summary);
}

questions.sort((a, b) => a.subject.localeCompare(b.subject, 'zh-CN') || a.category.localeCompare(b.category, 'zh-CN') || a.id.localeCompare(b.id));
const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  total: questions.length,
  subjects: [...new Set(questions.map((item) => item.subject))],
  modes: [...new Set(questions.map((item) => item.mode))],
  questions,
};
await fs.writeFile(indexPath, JSON.stringify(manifest));
console.log(`Built ${questions.length} questions into ${path.relative(root, outputRoot)}`);
