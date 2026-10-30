import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();

test('source bank contains the expected question collections', async () => {
  const subjectCounts = {};
  for (const subject of ['申论题库', '综应题库']) {
    const files = await walk(path.join(root, subject));
    subjectCounts[subject] = files.filter((file) => file.endsWith('.md') && path.basename(file).toLowerCase() !== 'readme.md').length;
  }
  assert.equal(subjectCounts['申论题库'], 3852);
  assert.equal(subjectCounts['综应题库'], 1034);

  const xingceFiles = (await walk(path.join(root, '行测题库')))
    .filter((file) => file.endsWith('.md') && path.basename(file).toLowerCase() !== 'readme.md' && !file.endsWith('蒸馏方法参考.md'));
  assert.equal(xingceFiles.length, 2956);

  const gongjiFiles = (await fs.readdir(path.join(root, '公基题库', '真题')))
    .filter((file) => /^y\d+\.json$/i.test(file));
  assert.equal(gongjiFiles.length, 25);
});

test('generated manifest exposes portable summary data', async () => {
  const file = path.join(root, 'public', 'data', 'index.json');
  try {
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(manifest.version, 3);
    assert.equal(manifest.summaryFormat, 'subject-v1');
    assert.equal(Object.values(manifest.subjectCounts).reduce((sum, count) => sum + count, 0), manifest.total);
    const summaries = [];
    for (const subject of manifest.subjects) {
      const summary = JSON.parse(await fs.readFile(path.join(root, 'public', 'data', manifest.summaryFiles[subject]), 'utf8'));
      summaries.push(...summary.questions);
    }
    assert.equal(manifest.total, summaries.length);
    assert.ok(summaries.every((question) => question.id && question.title && question.path && question.detailChunk));
    assert.deepEqual(new Set(manifest.subjects), new Set(['申论', '综应', '行测', '公基']));
    assert.equal(summaries.filter((question) => question.subject === '行测').length, 58890);
    assert.equal(summaries.filter((question) => question.subject === '公基').length, 9588);

    const xingceCategories = new Set(summaries.filter((question) => question.subject === '行测').map((question) => question.category));
    assert.deepEqual(xingceCategories, new Set(['政治理论', '常识判断', '言语理解与表达', '数量关系', '判断推理', '资料分析']));
    const gongjiCategories = new Set(summaries.filter((question) => question.subject === '公基').map((question) => question.category));
    assert.deepEqual(gongjiCategories, new Set(['政治理论', '常识判断']));

    const xingceSummary = summaries.find((question) => question.subject === '行测' && question.mode === 'choice');
    const gongjiSummary = summaries.find((question) => question.subject === '公基' && question.mode === 'choice');
    for (const summary of [xingceSummary, gongjiSummary]) {
      const detailChunk = JSON.parse(await fs.readFile(path.join(root, 'public', 'data', summary.detailChunk), 'utf8'));
      const detail = detailChunk.questions[summary.id];
      assert.ok(detail.options.length >= 2);
      assert.ok(detail.correctAnswer);
      assert.ok(detail.explanation || detail.demo);
    }

    let imageDetail;
    for (const question of summaries.filter((item) => item.subject === '行测' && item.materialLength > 0).slice(0, 500)) {
      const chunk = JSON.parse(await fs.readFile(path.join(root, 'public', 'data', question.detailChunk), 'utf8'));
      const detail = chunk.questions[question.id];
      if (/\/data\/xingce-images\//.test(`${detail.stem}\n${detail.material}\n${detail.explanation}`)) {
        imageDetail = detail;
        break;
      }
    }
    assert.ok(imageDetail, 'at least one generated Xingce question should reference a local image');
  } catch (error) {
    assert.fail(`Run npm run build:data before this test: ${error.message}`);
  }
});

test('generated question text contains no unrecoverable encoding artifacts', async () => {
  const dataRoot = path.join(root, 'public', 'data');
  const manifest = JSON.parse(await fs.readFile(path.join(dataRoot, 'index.json'), 'utf8'));
  const detailCache = new Map();
  for (const subject of manifest.subjects) {
    const summary = JSON.parse(await fs.readFile(path.join(dataRoot, manifest.summaryFiles[subject]), 'utf8'));
    for (const item of summary.questions) {
      let chunk = detailCache.get(item.detailChunk);
      if (!chunk) {
        chunk = JSON.parse(await fs.readFile(path.join(dataRoot, item.detailChunk), 'utf8'));
        detailCache.set(item.detailChunk, chunk);
      }
      const question = chunk.questions[item.id];
      const text = JSON.stringify(question);
      assert.doesNotMatch(text, /\bcid:\d+\b/i, `${item.id} still contains a cid marker`);
      assert.doesNotMatch(text, /\ufffd/, `${item.id} still contains a replacement character`);
      assert.doesNotMatch(text, /<img\b[^>]*\bsrc=["'](?!\/data\/xingce-images\/)/i, `${item.id} contains an unsafe image URL`);
    }
  }
});

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}
