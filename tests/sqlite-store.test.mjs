import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSqliteStore } from '../server/sqlite-store.mjs';

test('sqlite store persists practice state in normalized tables', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mojuan-'));
  const file = path.join(directory, 'practice.sqlite');
  const store = await openSqliteStore(file);
  const saved = store.write({
    completed: { q1: { at: 100, score: 100 } },
    favorites: { q2: { at: 110 } },
    mistakes: { q3: { at: 120, score: 0 } },
    answers: { q1: { at: 100, choice: 'A' }, q4: { at: 130, text: '答案草稿' } },
    sessions: [{ date: '2026/10/30', id: 'q1', mode: 'choice' }],
  });
  assert.equal(saved.completed.q1.score, 100);
  assert.equal(saved.favorites.q2.at, 110);
  assert.equal(saved.mistakes.q3.score, 0);
  assert.equal(saved.answers.q1.choice, 'A');
  assert.equal(saved.answers.q4.text, '答案草稿');
  assert.equal(saved.sessions[0].id, 'q1');
  assert.ok(saved.updatedAt);
  store.close();

  const reopened = await openSqliteStore(file);
  assert.deepEqual(reopened.read().completed, saved.completed);
  assert.deepEqual(reopened.read().answers, saved.answers);
  reopened.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test('sqlite store isolates users and supports administrator lifecycle', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mojuan-users-'));
  const file = path.join(directory, 'users.sqlite');
  const store = await openSqliteStore(file, {
    admin: { username: 'root', password: 'root-password-123', displayName: 'Root' },
    sessionTtlMs: 60_000,
  });

  const admin = store.authenticate('root', 'root-password-123');
  assert.equal(admin.role, 'admin');
  const user = store.createUser({ username: 'student', password: 'student-password-123', displayName: '练习者' });
  assert.equal(store.authenticate('student', 'student-password-123').id, user.id);
  assert.equal(store.authenticate('student', 'wrong-password'), null);

  store.write(admin.id, { favorites: { adminQuestion: { at: 1 } } });
  store.write(user.id, { favorites: { userQuestion: { at: 2 } } });
  assert.deepEqual(Object.keys(store.read(admin.id).favorites), ['adminQuestion']);
  assert.deepEqual(Object.keys(store.read(user.id).favorites), ['userQuestion']);

  const token = store.createSession(user.id);
  assert.equal(store.getUserBySession(token).username, 'student');
  store.setUserActive(user.id, false);
  assert.equal(store.getUserBySession(token), null);
  store.close();
  await fs.rm(directory, { recursive: true, force: true });
});
