import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS completed (
    question_id TEXT PRIMARY KEY,
    completed_at INTEGER NOT NULL,
    score REAL
  );
  CREATE TABLE IF NOT EXISTS favorites (
    question_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mistakes (
    question_id TEXT PRIMARY KEY,
    marked_at INTEGER NOT NULL,
    score REAL
  );
  CREATE TABLE IF NOT EXISTS answers (
    question_id TEXT PRIMARY KEY,
    answered_at INTEGER NOT NULL,
    score REAL,
    text TEXT,
    choice TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_date TEXT NOT NULL,
    question_id TEXT NOT NULL,
    mode TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_date_idx ON sessions(session_date);
  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function numeric(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function normalizeSnapshot(snapshot = {}) {
  return {
    completed: snapshot.completed && typeof snapshot.completed === 'object' ? snapshot.completed : {},
    favorites: snapshot.favorites && typeof snapshot.favorites === 'object' ? snapshot.favorites : {},
    mistakes: snapshot.mistakes && typeof snapshot.mistakes === 'object' ? snapshot.mistakes : {},
    answers: snapshot.answers && typeof snapshot.answers === 'object' ? snapshot.answers : {},
    sessions: Array.isArray(snapshot.sessions) ? snapshot.sessions.slice(0, 1000) : [],
  };
}

export async function openSqliteStore(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(schema);
  return new SqliteStore(db);
}

export class SqliteStore {
  constructor(db) {
    this.db = db;
  }

  read() {
    const completed = {};
    for (const row of this.db.prepare('SELECT question_id, completed_at, score FROM completed').all()) {
      completed[row.question_id] = { at: row.completed_at, score: row.score };
    }
    const favorites = {};
    for (const row of this.db.prepare('SELECT question_id, created_at FROM favorites').all()) {
      favorites[row.question_id] = { at: row.created_at };
    }
    const mistakes = {};
    for (const row of this.db.prepare('SELECT question_id, marked_at, score FROM mistakes').all()) {
      mistakes[row.question_id] = { at: row.marked_at, score: row.score };
    }
    const answers = {};
    for (const row of this.db.prepare('SELECT question_id, answered_at, score, text, choice FROM answers').all()) {
      answers[row.question_id] = {
        ...(row.text !== null ? { text: row.text } : {}),
        ...(row.choice !== null ? { choice: row.choice } : {}),
        at: row.answered_at,
        score: row.score,
      };
    }
    const sessions = this.db.prepare(
      'SELECT session_date AS date, question_id AS id, mode FROM sessions ORDER BY session_id DESC LIMIT 1000',
    ).all();
    const updatedAt = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('updatedAt')?.value || null;
    return { completed, favorites, mistakes, answers, sessions, updatedAt };
  }

  write(snapshot) {
    const value = normalizeSnapshot(snapshot);
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM completed; DELETE FROM favorites; DELETE FROM mistakes; DELETE FROM answers; DELETE FROM sessions;');
      const completed = this.db.prepare('INSERT INTO completed(question_id, completed_at, score) VALUES (?, ?, ?)');
      for (const [questionId, item] of Object.entries(value.completed)) {
        completed.run(questionId, numeric(item?.at, now), numeric(item?.score));
      }
      const favorites = this.db.prepare('INSERT INTO favorites(question_id, created_at) VALUES (?, ?)');
      for (const [questionId, item] of Object.entries(value.favorites)) {
        favorites.run(questionId, numeric(item?.at, now));
      }
      const mistakes = this.db.prepare('INSERT INTO mistakes(question_id, marked_at, score) VALUES (?, ?, ?)');
      for (const [questionId, item] of Object.entries(value.mistakes)) {
        mistakes.run(questionId, numeric(item?.at, now), numeric(item?.score));
      }
      const answers = this.db.prepare('INSERT INTO answers(question_id, answered_at, score, text, choice) VALUES (?, ?, ?, ?, ?)');
      for (const [questionId, item] of Object.entries(value.answers)) {
        answers.run(questionId, numeric(item?.at, now), numeric(item?.score), item?.text ?? null, item?.choice ?? null);
      }
      const sessions = this.db.prepare('INSERT INTO sessions(session_date, question_id, mode) VALUES (?, ?, ?)');
      for (const item of value.sessions) {
        if (!item?.id) continue;
        sessions.run(text(item.date), text(item.id), text(item.mode));
      }
      this.db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('updatedAt', String(now));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.read();
  }

  close() {
    this.db.close();
  }
}
