import test from 'node:test';
import assert from 'node:assert/strict';
import { sortQuestions } from '../src/question-order.mjs';

test('questions are grouped by subject and category, then ordered by newest year and source number', () => {
  const questions = [
    { id: 'hash-a', subject: '行测', category: '常识判断', year: '2022', number: 10, path: '行测题库/02/题10.md' },
    { id: 'hash-b', subject: '行测', category: '言语理解与表达', year: '2024', number: 1, path: '行测题库/03/题1.md' },
    { id: 'hash-c', subject: '行测', category: '常识判断', year: '2024', number: 2, path: '行测题库/02/题2.md' },
    { id: 'hash-d', subject: '行测', category: '常识判断', year: '2024', number: 1, path: '行测题库/02/题1.md' },
    { id: 'hash-e', subject: '申论', category: '综合题', year: '', number: 0, path: '申论题库/综合题/10.md' },
  ];

  assert.deepEqual(sortQuestions(questions).map((item) => item.id), [
    'hash-e', 'hash-d', 'hash-c', 'hash-a', 'hash-b',
  ]);
  assert.deepEqual(questions.map((item) => item.id), ['hash-a', 'hash-b', 'hash-c', 'hash-d', 'hash-e']);
});
