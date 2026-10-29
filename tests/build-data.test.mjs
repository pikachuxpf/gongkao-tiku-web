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
});

test('generated manifest exposes portable summary data', async () => {
  const file = path.join(root, 'public', 'data', 'index.json');
  try {
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(manifest.total, manifest.questions.length);
    assert.ok(manifest.questions.every((question) => question.id && question.title && question.path));
  } catch (error) {
    assert.fail(`Run npm run build:data before this test: ${error.message}`);
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
