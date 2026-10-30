import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const schema = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'admin')) DEFAULT 'user',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS users_active_idx ON users(active);

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
  CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS practice_completed (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    score REAL,
    PRIMARY KEY (user_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS practice_favorites (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS practice_mistakes (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    marked_at INTEGER NOT NULL,
    score REAL,
    PRIMARY KEY (user_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS practice_answers (
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    question_id TEXT NOT NULL,
    answered_at INTEGER NOT NULL,
    score REAL,
    text TEXT,
    choice TEXT,
    PRIMARY KEY (user_id, question_id)
  );
  CREATE TABLE IF NOT EXISTS practice_sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    session_date TEXT NOT NULL,
    question_id TEXT NOT NULL,
    mode TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS practice_sessions_user_date_idx
    ON practice_sessions(user_id, session_date);

  CREATE TABLE IF NOT EXISTS metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const LEGACY_TABLES = ['completed', 'favorites', 'mistakes', 'answers', 'sessions'];

function numeric(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function text(value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value);
}

function validateUsername(username) {
  const value = text(username).trim();
  if (value.length < 2 || value.length > 32 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('用户名长度需为 2-32 个字符，且不能包含空白字符');
  }
  return value;
}

function validatePassword(password) {
  const value = text(password);
  if (value.length < 6 || value.length > 128) throw new Error('密码长度需为 6-128 个字符');
  return value;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, encoded) {
  const [, saltHex, hashHex] = String(encoded || '').split('$');
  if (!saltHex || !hashHex) return false;
  try {
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 1 });
    const expected = Buffer.from(hashHex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
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

function publicUser(row) {
  if (!row) return null;
  return {
    id: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: Boolean(row.active),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

export async function openSqliteStore(filePath, options = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec(schema);
  const store = new SqliteStore(db, options);
  store.ensureBootstrapAdmin(options.admin);
  store.migrateLegacyState();
  return store;
}

export class SqliteStore {
  constructor(db, options = {}) {
    this.db = db;
    this.sessionTtlMs = options.sessionTtlMs || 30 * 24 * 60 * 60 * 1000;
    this.defaultUserId = null;
  }

  ensureBootstrapAdmin({ username = 'fpx', password = '123456', displayName = '系统管理员' } = {}) {
    const existing = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existing) {
      this.defaultUserId = Number(existing.user_id);
      return publicUser(existing);
    }
    const now = Date.now();
    const result = this.db.prepare(
      "INSERT INTO users(username, password_hash, display_name, role, active, created_at) VALUES (?, ?, ?, 'admin', 1, ?)",
    ).run(validateUsername(username), hashPassword(validatePassword(password)), text(displayName, username), now);
    this.defaultUserId = Number(result.lastInsertRowid);
    return this.getUser(this.defaultUserId);
  }

  migrateLegacyState() {
    const migrated = this.db.prepare("SELECT value FROM metadata WHERE key = 'legacyMigrated'").get();
    if (migrated || !this.defaultUserId) return;
    const available = LEGACY_TABLES.filter((name) => this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    if (!available.length) {
      this.db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('legacyMigrated', String(Date.now()));
      return;
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (available.includes('completed')) this.db.prepare('INSERT OR IGNORE INTO practice_completed(user_id, question_id, completed_at, score) SELECT ?, question_id, completed_at, score FROM completed').run(this.defaultUserId);
      if (available.includes('favorites')) this.db.prepare('INSERT OR IGNORE INTO practice_favorites(user_id, question_id, created_at) SELECT ?, question_id, created_at FROM favorites').run(this.defaultUserId);
      if (available.includes('mistakes')) this.db.prepare('INSERT OR IGNORE INTO practice_mistakes(user_id, question_id, marked_at, score) SELECT ?, question_id, marked_at, score FROM mistakes').run(this.defaultUserId);
      if (available.includes('answers')) this.db.prepare('INSERT OR IGNORE INTO practice_answers(user_id, question_id, answered_at, score, text, choice) SELECT ?, question_id, answered_at, score, text, choice FROM answers').run(this.defaultUserId);
      if (available.includes('sessions')) this.db.prepare('INSERT INTO practice_sessions(user_id, session_date, question_id, mode) SELECT ?, session_date, question_id, mode FROM sessions').run(this.defaultUserId);
      this.db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)').run('legacyMigrated', String(Date.now()));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getUser(userId) {
    return publicUser(this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(Number(userId)));
  }

  getUserByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(text(username).trim()) || null;
  }

  authenticate(username, password) {
    const row = this.getUserByUsername(username);
    if (!row || !row.active || !verifyPassword(text(password), row.password_hash)) return null;
    const now = Date.now();
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE user_id = ?').run(now, row.user_id);
    return this.getUser(row.user_id);
  }

  createSession(userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('INSERT INTO auth_sessions(token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(this.hashToken(token), Number(userId), now, now, now + this.sessionTtlMs);
    return token;
  }

  getUserBySession(token) {
    if (!token) return null;
    const tokenHash = this.hashToken(token);
    const row = this.db.prepare(`SELECT u.*, s.expires_at FROM auth_sessions s JOIN users u ON u.user_id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(tokenHash, Date.now());
    if (!row) return null;
    this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(Date.now(), tokenHash);
    return publicUser(row);
  }

  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(this.hashToken(token));
  }

  cleanExpiredSessions() {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
  }

  hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  read(userId = this.defaultUserId) {
    const id = Number(userId);
    const completed = {};
    for (const row of this.db.prepare('SELECT question_id, completed_at, score FROM practice_completed WHERE user_id = ?').all(id)) completed[row.question_id] = { at: row.completed_at, score: row.score };
    const favorites = {};
    for (const row of this.db.prepare('SELECT question_id, created_at FROM practice_favorites WHERE user_id = ?').all(id)) favorites[row.question_id] = { at: row.created_at };
    const mistakes = {};
    for (const row of this.db.prepare('SELECT question_id, marked_at, score FROM practice_mistakes WHERE user_id = ?').all(id)) mistakes[row.question_id] = { at: row.marked_at, score: row.score };
    const answers = {};
    for (const row of this.db.prepare('SELECT question_id, answered_at, score, text, choice FROM practice_answers WHERE user_id = ?').all(id)) answers[row.question_id] = { ...(row.text !== null ? { text: row.text } : {}), ...(row.choice !== null ? { choice: row.choice } : {}), at: row.answered_at, score: row.score };
    const sessions = this.db.prepare('SELECT session_date AS date, question_id AS id, mode FROM practice_sessions WHERE user_id = ? ORDER BY session_id DESC LIMIT 1000').all(id);
    const updatedAt = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(`updatedAt:${id}`)?.value || null;
    return { completed, favorites, mistakes, answers, sessions, updatedAt };
  }

  write(userIdOrSnapshot, maybeSnapshot) {
    const userId = maybeSnapshot === undefined ? this.defaultUserId : Number(userIdOrSnapshot);
    const value = normalizeSnapshot(maybeSnapshot === undefined ? userIdOrSnapshot : maybeSnapshot);
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of ['practice_completed', 'practice_favorites', 'practice_mistakes', 'practice_answers', 'practice_sessions']) this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
      const completed = this.db.prepare('INSERT INTO practice_completed(user_id, question_id, completed_at, score) VALUES (?, ?, ?, ?)');
      for (const [questionId, item] of Object.entries(value.completed)) completed.run(userId, questionId, numeric(item?.at, now), numeric(item?.score));
      const favorites = this.db.prepare('INSERT INTO practice_favorites(user_id, question_id, created_at) VALUES (?, ?, ?)');
      for (const [questionId, item] of Object.entries(value.favorites)) favorites.run(userId, questionId, numeric(item?.at, now));
      const mistakes = this.db.prepare('INSERT INTO practice_mistakes(user_id, question_id, marked_at, score) VALUES (?, ?, ?, ?)');
      for (const [questionId, item] of Object.entries(value.mistakes)) mistakes.run(userId, questionId, numeric(item?.at, now), numeric(item?.score));
      const answers = this.db.prepare('INSERT INTO practice_answers(user_id, question_id, answered_at, score, text, choice) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [questionId, item] of Object.entries(value.answers)) answers.run(userId, questionId, numeric(item?.at, now), numeric(item?.score), item?.text ?? null, item?.choice ?? null);
      const sessions = this.db.prepare('INSERT INTO practice_sessions(user_id, session_date, question_id, mode) VALUES (?, ?, ?, ?)');
      for (const item of value.sessions) if (item?.id) sessions.run(userId, text(item.date), text(item.id), text(item.mode));
      this.db.prepare('INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`updatedAt:${userId}`, String(now));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.read(userId);
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(publicUser);
  }

  createUser({ username, password, displayName, role = 'user' }) {
    const cleanUsername = validateUsername(username);
    const cleanPassword = validatePassword(password);
    if (!['user', 'admin'].includes(role)) throw new Error('无效的用户角色');
    try {
      const result = this.db.prepare('INSERT INTO users(username, password_hash, display_name, role, active, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(cleanUsername, hashPassword(cleanPassword), text(displayName, cleanUsername).trim() || cleanUsername, role, Date.now());
      return this.getUser(result.lastInsertRowid);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('用户名已存在');
      throw error;
    }
  }

  setUserActive(userId, active) {
    const row = this.db.prepare('SELECT * FROM users WHERE user_id = ?').get(Number(userId));
    if (!row) throw new Error('用户不存在');
    if (!active && row.role === 'admin') {
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1").get().count;
      if (count <= 1) throw new Error('至少需要保留一个启用中的管理员');
    }
    this.db.prepare('UPDATE users SET active = ? WHERE user_id = ?').run(active ? 1 : 0, Number(userId));
    if (!active) this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(Number(userId));
    return this.getUser(userId);
  }

  resetPassword(userId, password) {
    validatePassword(password);
    const row = this.db.prepare('SELECT user_id FROM users WHERE user_id = ?').get(Number(userId));
    if (!row) throw new Error('用户不存在');
    this.db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?').run(hashPassword(password), Number(userId));
    this.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(Number(userId));
  }

  stats() {
    return {
      users: this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
      activeUsers: this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE active = 1').get().count,
      completed: this.db.prepare('SELECT COUNT(*) AS count FROM practice_completed').get().count,
      sessions: this.db.prepare('SELECT COUNT(*) AS count FROM practice_sessions').get().count,
    };
  }

  close() {
    this.db.close();
  }
}
