import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const sourceRoots = ['申论题库', '综应题库'];
const xingceRootName = '行测题库';
const gongjiRootName = '公基题库';
const gongjiTruthRoot = path.join(root, gongjiRootName, '真题');
const outputRoot = path.join(root, 'public', 'data');
const questionsRoot = path.join(outputRoot, 'questions');
const indexPath = path.join(outputRoot, 'index.json');
const knowledgeIndexPath = path.join(root, '智能系统', '知识库索引', 'questions_index.jsonl');
const xingceImageRoot = path.join(root, xingceRootName, '90-图片');
const xingceImageOutput = path.join(outputRoot, 'xingce-images');

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

function stableId(prefix, ...parts) {
  return `${prefix}-${crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16)}`;
}

function parseNumber(value, fallback = 0) {
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : fallback;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return { data: {}, body: text };
  const data = {};
  for (const line of match[1].split('\n')) {
    const item = line.match(/^([^:：]+)\s*[:：]\s*["“]?(.+?)["”]?\s*$/);
    if (item) data[item[1].trim()] = item[2].trim();
  }
  return { data, body: text.slice(match[0].length) };
}

function htmlToText(value = '') {
  return normalize(value)
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeAssetPath(value) {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function rewriteXingceAssets(value, relativePath) {
  const sourcePath = relativePath.replaceAll('\\', '/');
  const sourceDirectory = path.posix.dirname(sourcePath);
  const imagePrefix = `${xingceRootName}/90-图片/`;
  const toUrl = (assetPath) => {
    if (!assetPath || /^(?:https?:|data:|\/)/i.test(assetPath)) return assetPath;
    const resolved = path.posix.normalize(path.posix.join(sourceDirectory, assetPath));
    if (!resolved.startsWith(imagePrefix)) return assetPath;
    return `/data/xingce-images/${encodeAssetPath(resolved.slice(imagePrefix.length))}`;
  };
  return value
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'])/gi, (_, prefix, assetPath, suffix) => `${prefix}${toUrl(assetPath)}${suffix}`)
    .replace(/(!\[[^\]]*\]\()([^\)]+)(\))/g, (_, prefix, assetPath, suffix) => `${prefix}${toUrl(assetPath)}${suffix}`);
}

function parseXingceOptions(value) {
  const options = [];
  for (const line of value.split('\n')) {
    const match = line.trim().match(/^-\s*\*\*([A-H])\*\*[.、)）]\s*([\s\S]*?)(?:\s*✅)?$/);
    if (!match) continue;
    options.push({ key: match[1], text: match[2].trim() });
  }
  return options;
}

function parseXingceQuestions(text, relativePath) {
  const { data, body } = parseFrontmatter(text);
  const module = data['模块'] || path.basename(path.dirname(relativePath)).replace(/^\d+-/, '');
  const paper = data['试卷'] || firstHeading(body);
  const questionHeaders = [...body.matchAll(/^#{2,3}\s+第\s*(\d+)\s*题[^\n]*$/gmu)];
  if (!questionHeaders.length) return [];
  const materialHeaders = [...body.matchAll(/^##\s+材料\s*(\d+)[^\n]*$/gmu)];
  const imageRoot = `${xingceRootName}/90-图片/`;
  const questionCount = parseNumber(data['题数'], questionHeaders.length);
  const questions = [];

  for (let index = 0; index < questionHeaders.length; index += 1) {
    const headerMatch = questionHeaders[index];
    const blockStart = headerMatch.index + headerMatch[0].length;
    const blockEnd = questionHeaders[index + 1]?.index ?? body.length;
    const block = body.slice(blockStart, blockEnd).trim();
    const qid = headerMatch[0].match(/qid\s+([^\s·>]+)/i)?.[1] || `${data['年份'] || 'unknown'}-${index + 1}`;
    const detailType = headerMatch[0].match(/·\s*([^<]+)<\/sub>/)?.[1]?.trim() || '';
    const answerMarker = /^\*\*答案\*\*\s*[：:]\s*(.+)$/mu.exec(block);
    const explanationMarker = /^\*\*官方解析\*\*\s*$/mu.exec(block);
    const questionPart = block.slice(0, answerMarker?.index ?? explanationMarker?.index ?? block.length).trim();
    const optionsStart = questionPart.search(/^-\s*\*\*[A-H]\*\*[.、)）]/mu);
    const stemRaw = optionsStart >= 0 ? questionPart.slice(0, optionsStart).trim() : questionPart;
    const optionRaw = optionsStart >= 0 ? questionPart.slice(optionsStart) : '';
    const answerValue = answerMarker?.[1]?.replace(/[^A-H]/gi, '').toUpperCase() || '';
    const explanationStart = explanationMarker ? explanationMarker.index + explanationMarker[0].length : -1;
    const explanation = explanationStart >= 0 ? block.slice(explanationStart).trim() : '';
    let material = '';
    const precedingMaterials = materialHeaders.filter((item) => item.index < headerMatch.index);
    const currentMaterial = precedingMaterials.at(-1);
    if (currentMaterial) {
      const firstQuestionAfterMaterial = questionHeaders.find((item) => item.index > currentMaterial.index);
      if (firstQuestionAfterMaterial?.index === headerMatch.index) {
        material = body.slice(currentMaterial.index + currentMaterial[0].length, headerMatch.index).trim();
      } else if (firstQuestionAfterMaterial) {
        material = body.slice(currentMaterial.index + currentMaterial[0].length, firstQuestionAfterMaterial.index).trim();
      }
    }
    const rewrittenStem = rewriteXingceAssets(stemRaw, relativePath);
    const rewrittenMaterial = rewriteXingceAssets(material, relativePath);
    const rewrittenExplanation = rewriteXingceAssets(explanation, relativePath);
    const options = parseXingceOptions(optionRaw).map((option) => ({
      ...option,
      text: rewriteXingceAssets(option.text, relativePath),
    }));
    const id = `xingce-${qid}`.replace(/[^\w-]/g, '-');
    questions.push({
      id,
      subject: '行测',
      category: module,
      module,
      questionType: detailType || module,
      detailType,
      title: htmlToText(stemRaw).slice(0, 120) || `${module} · 第 ${headerMatch[1]} 题`,
      stem: rewrittenStem,
      material: rewrittenMaterial,
      answer: answerValue,
      explanation: rewrittenExplanation,
      demo: rewrittenExplanation,
      source: data['来源'] || 'ERRRC/xingcezhenti',
      paper,
      region: data['地区'] || '',
      year: data['年份'] || '',
      number: Number(headerMatch[1]),
      score: 1,
      options,
      correctAnswer: answerValue,
      mode: options.length >= 2 ? 'choice' : 'subjective',
      themes: [module, detailType].filter(Boolean),
      elements: [],
      difficulty: 2,
      pointCount: 1,
      hasRubric: false,
      path: relativePath.replaceAll('\\', '/'),
      sourceQuestionCount: questionCount,
      imageRoot,
    });
  }
  return questions;
}

function parseGongjiQuestions(text, relativePath) {
  const year = path.basename(relativePath, '.json').replace(/^y/, '');
  const source = 'linfukai186-arch/gongkao-tiku';
  const books = JSON.parse(text);
  const questions = [];
  const optionKeys = 'ABCDEFGH';

  for (const [paper, items] of Object.entries(books)) {
    if (!Array.isArray(items)) continue;
    items.forEach((item, index) => {
      const stem = normalize(item.q || '');
      if (!stem) return;
      const options = Array.isArray(item.o)
        ? item.o.map((option, optionIndex) => ({ key: optionKeys[optionIndex] || String(optionIndex + 1), text: normalize(String(option)) }))
        : [];
      const category = normalize(item.t || '综合') || '综合';
      const detailType = normalize(item.s || '');
      const answer = normalize(String(item.a || '')).replace(/\s+/g, '');
      const explanation = normalize(item.e || '');
      const id = stableId('gongji', year, paper, index, stem);
      questions.push({
        id,
        subject: '公基',
        category,
        module: category,
        questionType: category,
        detailType,
        title: stem.slice(0, 120),
        stem,
        material: '',
        answer,
        explanation,
        demo: explanation,
        source,
        paper,
        region: '',
        year,
        number: index + 1,
        score: 1,
        options,
        correctAnswer: answer,
        mode: options.length >= 2 ? 'choice' : 'subjective',
        themes: [category, detailType].filter(Boolean),
        elements: [],
        difficulty: 2,
        pointCount: 1,
        hasRubric: false,
        path: relativePath.replaceAll('\\', '/'),
      });
    });
  }
  return questions;
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

const xingceFiles = await readFiles(path.join(root, xingceRootName));
for (const file of xingceFiles) {
  if (file.includes(`${path.sep}90-图片${path.sep}`)) continue;
  const relativePath = path.relative(root, file);
  const text = await fs.readFile(file, 'utf8');
  for (const question of parseXingceQuestions(text, relativePath)) {
    const fullPath = path.join(questionsRoot, `${question.id}.json`);
    const payload = { ...question, generatedAt: new Date().toISOString() };
    await fs.writeFile(fullPath, JSON.stringify(payload));
    const { material, answer, demo, explanation, ...summary } = question;
    summary.materialLength = material.length;
    summary.answerLength = answer.length;
    summary.demoLength = demo.length;
    summary.explanationLength = explanation.length;
    questions.push(summary);
  }
}

try {
  await fs.cp(xingceImageRoot, xingceImageOutput, { recursive: true });
} catch {
  // Text-only builds still work when the optional image directory is absent.
}

try {
  const gongjiFiles = (await fs.readdir(gongjiTruthRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^y\d+\.json$/i.test(entry.name))
    .map((entry) => path.join(gongjiTruthRoot, entry.name));
  for (const file of gongjiFiles) {
    const relativePath = path.relative(root, file);
    const text = await fs.readFile(file, 'utf8');
    for (const question of parseGongjiQuestions(text, relativePath)) {
      const fullPath = path.join(questionsRoot, `${question.id}.json`);
      const payload = { ...question, generatedAt: new Date().toISOString() };
      await fs.writeFile(fullPath, JSON.stringify(payload));
      const { material, answer, demo, explanation, ...summary } = question;
      summary.materialLength = material.length;
      summary.answerLength = answer.length;
      summary.demoLength = demo.length;
      summary.explanationLength = explanation.length;
      questions.push(summary);
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  // The optional public-bank directory may be absent in a minimal clone.
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
