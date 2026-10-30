import { createIcons, icons } from 'lucide';
import { sortQuestions } from './question-order.mjs';
import './styles.css';

const STORAGE_KEY = 'mojuan.practice.v1';
const SETTINGS_KEY = 'mojuan.settings.v1';
const DEFAULT_SETTINGS = {
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: '',
  aiEnabled: true,
};

const app = document.querySelector('#app');
const state = {
  manifest: null,
  question: null,
  questionLoading: false,
  questionRequest: 0,
  summaryLoading: false,
  detailChunks: new Map(),
  summaries: new Map(),
  summaryPromises: new Map(),
  view: location.hash.replace('#', '') || 'desk',
  filters: { subject: '全部', category: '全部', mode: '全部', search: '' },
  queue: [],
  queueIndex: 0,
  loadedAnswer: false,
  submitted: false,
  aiLoading: false,
  aiResult: null,
  toast: '',
  practiceText: '',
  storage: 'browser',
  user: null,
  config: { registration: false, ai: { configured: false, model: DEFAULT_SETTINGS.model } },
  authError: '',
  authMode: 'login',
  adminUsers: [],
  adminStats: null,
  sharedAi: { endpoint: DEFAULT_SETTINGS.endpoint, model: DEFAULT_SETTINGS.model, configured: false },
};

const store = loadJson(STORAGE_KEY, {
  completed: {},
  favorites: {},
  mistakes: {},
  answers: {},
  sessions: [],
});
let settings = { ...DEFAULT_SETTINGS, ...loadJson(SETTINGS_KEY, {}) };
let storageSyncTimer = null;
let storageSyncInFlight = false;
let storageSyncPending = false;

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function persist() {
  localStorage.setItem(`${STORAGE_KEY}.${state.user?.id || 'legacy'}`, JSON.stringify(store));
  if (state.storage === 'sqlite') scheduleStorageSync();
}

async function apiJson(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

async function initAuth() {
  try {
    const configPayload = await apiJson('/api/config', { cache: 'no-store' });
    state.config = configPayload;
    const me = await apiJson('/api/me', { cache: 'no-store' });
    if (!me.user) {
      state.user = null;
      state.authError = '';
      return;
    }
    state.user = me.user;
    settings = { ...DEFAULT_SETTINGS, ...loadJson(`${SETTINGS_KEY}.${state.user.id}`, loadJson(SETTINGS_KEY, {})) };
    state.authError = '';
  } catch (error) {
    if (error.message === '未登录') {
      state.user = null;
      state.authError = '';
      return;
    }
    state.authError = '无法连接到账号服务，请确认已通过 npm run dev 启动后端。';
  }
}

function loadUserStorage() {
  const scoped = loadJson(`${STORAGE_KEY}.${state.user?.id || 'legacy'}`, null);
  const legacy = state.user?.id === 1 ? loadJson(STORAGE_KEY, null) : null;
  applyStorageState(mergeStorageState(scoped || {}, legacy || {}));
}

function snapshotHasData(snapshot) {
  return ['completed', 'favorites', 'mistakes', 'answers', 'sessions']
    .some((key) => Object.keys(snapshot?.[key] || {}).length || (snapshot?.[key] || []).length);
}

function mergeStorageState(localState, remoteState) {
  const merged = {
    completed: { ...(remoteState?.completed || {}) },
    favorites: { ...(remoteState?.favorites || {}) },
    mistakes: { ...(remoteState?.mistakes || {}) },
    answers: { ...(remoteState?.answers || {}) },
    sessions: [...(remoteState?.sessions || [])],
  };
  for (const key of ['completed', 'favorites', 'mistakes', 'answers']) {
    for (const [id, value] of Object.entries(localState?.[key] || {})) {
      const current = merged[key][id];
      if (!current || Number(value?.at || 0) >= Number(current?.at || 0)) merged[key][id] = value;
    }
  }
  const sessions = [...merged.sessions, ...(localState?.sessions || [])];
  merged.sessions = [...new Map(sessions.map((item) => [`${item.date}|${item.id}|${item.mode}`, item])).values()]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 1000);
  return merged;
}

function applyStorageState(nextState) {
  for (const key of ['completed', 'favorites', 'mistakes', 'answers', 'sessions']) {
    if (key === 'sessions') store[key] = Array.isArray(nextState?.[key]) ? nextState[key] : [];
    else {
      store[key] = nextState?.[key] && typeof nextState[key] === 'object' ? nextState[key] : {};
    }
  }
  localStorage.setItem(`${STORAGE_KEY}.${state.user?.id || 'legacy'}`, JSON.stringify(store));
}

function scheduleStorageSync() {
  storageSyncPending = true;
  window.clearTimeout(storageSyncTimer);
  storageSyncTimer = window.setTimeout(syncStorage, 250);
}

async function syncStorage() {
  if (state.storage !== 'sqlite' || storageSyncInFlight || !storageSyncPending) return;
  storageSyncInFlight = true;
  storageSyncPending = false;
  try {
    const response = await fetch('/api/state', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(store),
    });
    if (!response.ok) throw new Error('SQLite 状态保存失败');
  } catch {
    state.storage = 'browser';
    showToast('后端暂时不可用，已切换到浏览器保存');
  } finally {
    storageSyncInFlight = false;
    if (storageSyncPending) scheduleStorageSync();
  }
}

async function initPersistence() {
  try {
    loadUserStorage();
    const response = await fetch('/api/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('SQLite 状态读取失败');
    const payload = await response.json();
    const remoteState = payload.state || {};
    const localState = JSON.parse(JSON.stringify(store));
    if (snapshotHasData(remoteState)) {
      applyStorageState(mergeStorageState(localState, remoteState));
      scheduleStorageSync();
    }
    else if (snapshotHasData(localState)) {
      state.storage = 'sqlite';
      scheduleStorageSync();
      return;
    } else applyStorageState(remoteState);
    state.storage = 'sqlite';
  } catch {
    state.storage = 'browser';
  }
}

function persistSettings() {
  localStorage.setItem(`${SETTINGS_KEY}.${state.user?.id || 'legacy'}`, JSON.stringify(settings));
}

function authCardLegacy() {
  const register = state.authMode === 'register';
  return `<main class="auth-page"><section class="auth-paper"><div class="auth-mark">墨</div><p class="eyebrow">墨卷 / 账号入口</p><h1>${register ? '一起开始，<br><span>留下你的笔迹。</span>' : '欢迎回来，<br><span>继续今天的练习。</span>'}</h1><p class="auth-intro">${register ? '创建账号后，刷题进度、收藏、错题和答案草稿会跟着账号走。' : '登录后即可在不同设备继续刷题，学习记录按账号独立保存。'}</p><form data-form="auth" class="auth-form"><label>用户名<input name="username" autocomplete="username" required minlength="2" maxlength="32" placeholder="例如：xiaoming" /></label>${register ? '<label>显示名称<input name="displayName" maxlength="40" placeholder="你的称呼" /></label>' : ''}<label>密码<input name="password" type="password" autocomplete="current-password" required minlength="6" placeholder="至少 6 位" /></label>${register ? '<label>确认密码<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="6" placeholder="再输入一次" /></label>' : ''}<button class="submit-button" type="submit">${icon(register ? 'user-plus' : 'log-in')} ${register ? '创建账号' : '登录墨卷'}</button></form>${state.authError ? `<p class="auth-error">${icon('triangle-alert')}${escapeHtml(state.authError)}</p>` : ''}<button class="auth-switch" data-action="toggle-auth">${register ? '已有账号？返回登录' : state.config.registration ? '还没有账号？注册一个' : '注册功能未开放'}</button><div class="auth-note"><span>当前模式</span><strong>${state.config.registration ? '开放注册' : '仅管理员创建账号'}</strong><small>账号数据存储在服务端 SQLite，每个账号相互隔离。</small></div></section></main>`;
}

async function submitAuthLegacy(form) {
  const data = new FormData(form);
  const register = state.authMode === 'register';
  const password = String(data.get('password') || '');
  if (register && password !== String(data.get('confirmPassword') || '')) {
    state.authError = '两次输入的密码不一致';
    render();
    return;
  }
  state.authError = '';
  try {
    const payload = await apiJson(register ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: data.get('username'), password, displayName: data.get('displayName') }),
    });
    state.user = payload.user;
    settings = { ...DEFAULT_SETTINGS, ...loadJson(`${SETTINGS_KEY}.${state.user.id}`, loadJson(SETTINGS_KEY, {})) };
    loadUserStorage();
    await loadManifest();
    await initPersistence();
    render();
  } catch (error) {
    state.authError = error.message || '账号操作失败';
    render();
  }
}

async function logoutLegacy() {
  try { await apiJson('/api/auth/logout', { method: 'POST' }); } catch { /* Session may already be expired. */ }
  state.user = null;
  state.storage = 'browser';
  state.question = null;
  state.aiResult = null;
  render();
}

async function loadAdminDataLegacy() {
  if (state.user?.role !== 'admin') return;
  try {
    const [users, stats] = await Promise.all([apiJson('/api/admin/users'), apiJson('/api/admin/stats')]);
    state.adminUsers = users.users || [];
    state.adminStats = stats.stats || null;
  } catch (error) {
    showToast(error.message || '管理员数据加载失败');
  }
}

function authCard() {
  const register = state.authMode === 'register';
  return `<main class="auth-page"><section class="auth-paper"><div class="auth-mark">墨</div><p class="eyebrow">墨卷 / 账号入口</p><h1>${register ? '一起开始，<br><span>留下你的笔迹。</span>' : '欢迎回来，<br><span>继续今天的练习。</span>'}</h1><p class="auth-intro">${register ? '创建账号后，刷题进度、收藏、错题和答案草稿会跟着账号走。' : '登录后即可在不同设备继续刷题，学习记录按账号独立保存。'}</p><form data-form="auth" class="auth-form"><label>用户名<input name="username" autocomplete="username" required minlength="2" maxlength="32" placeholder="例如：xiaoming" /></label>${register ? '<label>显示名称<input name="displayName" maxlength="40" placeholder="你的称呼" /></label>' : ''}<label>密码<input name="password" type="password" autocomplete="current-password" required minlength="6" placeholder="至少 6 位" /></label>${register ? '<label>确认密码<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="6" placeholder="再输入一次" /></label>' : ''}<button class="submit-button" type="submit">${icon(register ? 'user-plus' : 'log-in')} ${register ? '创建账号' : '登录墨卷'}</button></form>${state.authError ? `<p class="auth-error">${icon('triangle-alert')}${escapeHtml(state.authError)}</p>` : ''}<button class="auth-switch" data-action="toggle-auth">${register ? '已有账号？返回登录' : state.config.registration ? '还没有账号？注册一个' : '注册功能未开放'}</button><div class="auth-note"><span>当前模式</span><strong>${state.config.registration ? '开放注册' : '仅管理员创建账号'}</strong><small>账号数据存储在服务端 SQLite，每个账号相互隔离。</small></div></section></main>`;
}

async function submitAuth(form) {
  const data = new FormData(form);
  const register = state.authMode === 'register';
  const password = String(data.get('password') || '');
  if (register && password !== String(data.get('confirmPassword') || '')) {
    state.authError = '两次输入的密码不一致';
    render();
    return;
  }
  state.authError = '';
  try {
    const payload = await apiJson(register ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: data.get('username'), password, displayName: data.get('displayName') }),
    });
    state.user = payload.user;
    settings = { ...DEFAULT_SETTINGS, ...loadJson(`${SETTINGS_KEY}.${state.user.id}`, loadJson(SETTINGS_KEY, {})) };
    loadUserStorage();
    await loadManifest();
    await initPersistence();
    render();
  } catch (error) {
    state.authError = error.message || '账号操作失败';
    render();
  }
}

async function logout() {
  try { await apiJson('/api/auth/logout', { method: 'POST' }); } catch { /* The session may already be expired. */ }
  state.user = null;
  state.storage = 'browser';
  state.question = null;
  state.aiResult = null;
  render();
}

async function loadAdminData() {
  if (state.user?.role !== 'admin') return;
  try {
    const [users, stats] = await Promise.all([apiJson('/api/admin/users'), apiJson('/api/admin/stats')]);
    state.adminUsers = users.users || [];
    state.adminStats = stats.stats || null;
  } catch (error) {
    showToast(error.message || '管理员数据加载失败');
  }
}

async function loadSharedAiConfig() {
  if (state.user?.role !== 'admin') return;
  try {
    const payload = await apiJson('/api/admin/ai-config', { cache: 'no-store' });
    state.sharedAi = payload.ai;
  } catch (error) {
    showToast(error.message || '共享模型配置读取失败');
  }
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatText(value = '') {
  const normalized = value.replace(/\r/g, '').trim();
  if (!normalized) return '<p class="muted">暂无内容。</p>';
  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => {
      const text = paragraph.trim();
      if (/^\d+[.、]/.test(text) || /^[一二三四五六七八九十]+、/.test(text)) {
        return `<p>${escapeHtml(text).replace(/([0-9一二三四五六七八九十]+[.、])/g, '<strong>$1</strong>')}</p>`;
      }
      return `<p>${escapeHtml(text).replaceAll('\n', '<br>')}</p>`;
    })
    .join('');
}

function formatRichText(value = '') {
  const normalized = String(value).replace(/\r/g, '').trim();
  if (!normalized) return '<p class="muted">暂无内容。</p>';

  const images = [];
  const tokenized = normalized
    .replace(/<img\b([^>]*)>/gi, (_, attributes) => {
      const src = attributes.match(/\bsrc=["']([^"']+)["']/i)?.[1] || '';
      if (!src.startsWith('/data/xingce-images/') || src.includes('..')) return '';
      const token = `__MOJUAN_IMAGE_${images.length}__`;
      images.push(`<img class="question-image" src="${escapeHtml(src)}" alt="题目图片" loading="lazy">`);
      return `\n${token}\n`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ');

  return tokenized
    .split(/\n{2,}/)
    .map((paragraph) => {
      const content = paragraph.trim();
      if (!content) return '';
      return `<p>${escapeHtml(content).replace(/__MOJUAN_IMAGE_(\d+)__/g, (_, index) => images[Number(index)] || '')}</p>`;
    })
    .filter(Boolean)
    .join('');
}

function renderMarkdownPreview(value = '') {
  return value
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('### ')) return `<h4>${escapeHtml(trimmed.slice(4))}</h4>`;
      if (trimmed.startsWith('## ')) return `<h3>${escapeHtml(trimmed.slice(3))}</h3>`;
      if (trimmed.startsWith('# ')) return `<h2>${escapeHtml(trimmed.slice(2))}</h2>`;
      if (trimmed.startsWith('- ')) return `<li>${escapeHtml(trimmed.slice(2))}</li>`;
      return `<p>${escapeHtml(trimmed)}</p>`;
    })
    .join('');
}

function icon(name, label = '') {
  return `<i data-lucide="${name}"${label ? ` aria-label="${escapeHtml(label)}"` : ''}></i>`;
}

function hydrateIcons() {
  createIcons({ icons, attrs: { 'stroke-width': 1.8 } });
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    state.toast = '';
    render();
  }, 2600);
}

function categories() {
  const subject = state.filters.subject;
  const subjectCounts = state.manifest?.categoryCounts || {};
  const counts = subject === '全部'
    ? Object.values(subjectCounts).reduce((all, items) => {
      for (const [category, count] of Object.entries(items)) all[category] = (all[category] || 0) + count;
      return all;
    }, {})
    : subjectCounts[subject] || {};
  const available = Object.keys(counts);
  return available.sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b, 'zh-CN'));
}

function categoryCounts() {
  const subjectCounts = state.manifest?.categoryCounts || {};
  if (state.filters.subject !== '全部') return subjectCounts[state.filters.subject] || {};
  return Object.values(subjectCounts).reduce((all, items) => {
    for (const [category, count] of Object.entries(items)) all[category] = (all[category] || 0) + count;
    return all;
  }, {});
}

function subjectCount(subject) {
  return state.manifest?.subjectCounts?.[subject] || 0;
}

function loadedQuestions() {
  return [...state.summaries.values()].flatMap((summary) => summary.questions || []);
}

async function loadSummaries(subject = '全部') {
  if (!state.manifest?.summaryFiles) return;
  const subjects = subject === '全部' ? state.manifest.subjects : [subject];
  const pending = subjects.filter((item) => !state.summaries.has(item));
  if (!pending.length) return;
  const promises = pending.map((item) => {
    let promise = state.summaryPromises.get(item);
    if (!promise) {
      promise = fetch(`/data/${state.manifest.summaryFiles[item]}`)
        .then((response) => {
          if (!response.ok) throw new Error(`题库摘要加载失败（${response.status}）`);
          return response.json();
        })
        .then((summary) => state.summaries.set(item, summary))
        .finally(() => state.summaryPromises.delete(item));
      state.summaryPromises.set(item, promise);
    }
    return promise;
  });
  state.summaryLoading = true;
  render();
  try {
    await Promise.all(promises);
  } catch (error) {
    showToast(error.message || '题库摘要加载失败');
  } finally {
    state.summaryLoading = state.summaryPromises.size > 0;
    if (!state.summaryLoading) render();
  }
}

function filteredQuestions() {
  const search = state.filters.search.trim().toLowerCase();
  return sortQuestions(loadedQuestions().filter((item) => {
    const categoryMatch = state.filters.category === '全部' || item.category === state.filters.category;
    const subjectMatch = state.filters.subject === '全部' || item.subject === state.filters.subject;
    const modeMatch = state.filters.mode === '全部' || item.mode === state.filters.mode;
    const searchMatch = !search || `${item.title} ${item.detailType} ${item.themes?.join(' ')}`.toLowerCase().includes(search);
    return categoryMatch && subjectMatch && modeMatch && searchMatch;
  }));
}

function invalidateQuestionLoad() {
  state.questionRequest += 1;
  state.questionLoading = false;
}

function resetQuestionState() {
  invalidateQuestionLoad();
  state.question = null;
  state.submitted = false;
  state.loadedAnswer = false;
  state.aiResult = null;
  state.practiceText = '';
}

async function applyPracticeFilters({ subjectChanged = false } = {}) {
  const requestId = ++state.questionRequest;
  state.questionLoading = true;
  state.question = null;
  state.submitted = false;
  state.loadedAnswer = false;
  state.aiResult = null;
  state.practiceText = '';
  state.view = 'practice';
  location.hash = 'practice';
  state.queue = [];
  state.queueIndex = 0;
  render();

  await loadSummaries(state.filters.subject);
  if (requestId !== state.questionRequest) return;
  state.queue = filteredQuestions();
  state.queueIndex = 0;
  if (state.queue.length) {
    await loadQuestion(state.queue[0].id);
  } else {
    state.questionLoading = false;
    render();
    if (subjectChanged) showToast('这个题库暂时没有可用题目');
  }
}

function counts() {
  return {
    total: state.manifest?.total || 0,
    completed: Object.keys(store.completed).length,
    favorites: Object.keys(store.favorites).length,
    mistakes: Object.keys(store.mistakes).length,
    today: store.sessions.filter((item) => item.date === today()).length,
  };
}

function today() {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function progressPercent() {
  const total = counts().total || 1;
  const completed = counts().completed;
  return completed ? Math.max(1, Math.round((completed / total) * 100)) : 0;
}

async function loadManifest() {
  try {
    const response = await fetch('/data/index.json');
    if (!response.ok) throw new Error('题库索引尚未生成');
    state.manifest = await response.json();
  } catch (error) {
    app.innerHTML = `<main class="boot-error"><div class="paper-note"><p class="eyebrow">墨卷 / 数据层</p><h1>还差一步，题库正在整理</h1><p>${escapeHtml(error.message)}。请运行 <code>npm run dev</code> 或先运行 <code>npm run build:data</code>。</p></div></main>`;
    throw error;
  }
}

async function loadQuestion(id) {
  if (!id) return;
  const requestId = ++state.questionRequest;
  state.questionLoading = true;
  render();
  try {
    const summary = loadedQuestions().find((item) => item.id === id);
    if (!summary?.detailChunk) throw new Error('题目详情索引缺失');
    let chunk = state.detailChunks.get(summary.detailChunk);
    if (!chunk) {
      const response = await fetch(`/data/${summary.detailChunk}`);
      if (!response.ok) throw new Error(`题目详情加载失败（${response.status}）`);
      chunk = await response.json();
      state.detailChunks.set(summary.detailChunk, chunk);
    }
    const question = chunk.questions?.[id];
    if (!question) throw new Error('题目详情不存在，请重新构建题库');
    if (requestId !== state.questionRequest) return;
    state.question = question;
    state.loadedAnswer = false;
    state.submitted = Boolean(store.completed[id]);
    state.aiResult = null;
    state.practiceText = store.answers[id]?.text || '';
  } catch (error) {
    if (requestId === state.questionRequest) showToast(error.message || '题目详情加载失败');
  } finally {
    if (requestId === state.questionRequest) {
      state.questionLoading = false;
      render();
    }
  }
}

function selectQuestion(id) {
  state.view = 'practice';
  location.hash = 'practice';
  loadQuestion(id);
}

function selectFromQueue() {
  if (!state.queue.length) {
    showToast('没有符合当前筛选条件的题目');
    return;
  }
  state.queueIndex = Math.min(state.queueIndex, state.queue.length - 1);
  selectQuestion(state.queue[state.queueIndex].id);
}

function prepareQueue(items = filteredQuestions()) {
  state.queue = items;
  state.queueIndex = Math.max(0, items.findIndex((item) => item.id === state.question?.id));
}

function toggleFavorite(id) {
  if (store.favorites[id]) delete store.favorites[id];
  else store.favorites[id] = { at: Date.now() };
  persist();
  render();
}

function markSubmitted(question, text, result) {
  const id = question.id;
  store.completed[id] = { at: Date.now(), score: result?.score ?? null };
  const previous = store.answers[id] || {};
  store.answers[id] = question.mode === 'choice'
    ? { ...previous, at: Date.now(), score: result?.score ?? null }
    : { text, at: Date.now(), score: result?.score ?? null };
  if (result && result.score < 60) store.mistakes[id] = { at: Date.now(), score: result.score };
  else delete store.mistakes[id];
  store.sessions.unshift({ date: today(), id, mode: question.mode });
  store.sessions = store.sessions.slice(0, 1000);
  persist();
}

function selectedChoice(question) {
  return String(store.answers[question.id]?.choice || '').replace(/[^A-H]/gi, '').toUpperCase().split('').sort().join('');
}

function choiceResult(question) {
  const selected = selectedChoice(question);
  const correct = String(question.correctAnswer || question.answer || '').replace(/[^A-H]/gi, '').toUpperCase().split('').sort().join('');
  return { selected, correct, isCorrect: Boolean(selected && correct && selected === correct), score: selected === correct ? 100 : 0 };
}

function extractLimit(stem = '') {
  const match = stem.match(/不超过\s*(\d+)\s*字|([0-9]+)\s*字/);
  return Number(match?.[1] || match?.[2] || 0);
}

function localGrade(question, answer) {
  const text = answer.trim();
  const reference = question.answer || '';
  const referencePoints = reference
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /^\d+[.、]|^[一二三四五六七八九十]+、/.test(line));
  const chunks = referencePoints.length ? referencePoints : reference.split(/[。；]/).filter((item) => item.trim().length > 8).slice(0, 8);
  const matched = chunks.filter((chunk) => {
    const keywords = [...new Set(chunk.match(/[\u4e00-\u9fff]{2,4}/g) || [])].filter((word) => word.length >= 2);
    return keywords.filter((word) => text.includes(word)).length >= Math.max(1, Math.ceil(keywords.length * 0.18));
  }).length;
  const coverage = chunks.length ? matched / chunks.length : Math.min(1, text.length / 120);
  const hasStructure = /\n|\d+[.、]|[一二三四五六七八九十]+、/.test(text);
  const limit = extractLimit(question.stem);
  const wordScore = !limit || text.length <= limit ? 1 : Math.max(0, 1 - (text.length - limit) / limit);
  const score = Math.round(Math.max(0, Math.min(100, coverage * 65 + (hasStructure ? 15 : 5) + wordScore * 20)));
  const missing = chunks.filter((chunk) => !text.includes(chunk.slice(0, 8))).slice(0, 3);
  return {
    score,
    coverage: Math.round(coverage * 100),
    words: text.length,
    limit,
    missing,
    suggestions: [
      coverage < 0.7 ? '先按参考答案的总括词拆成 3—5 条，避免只写感受或背景。' : '要点覆盖不错，可继续压缩同义表达，让每条更像评分点。',
      !hasStructure ? '建议使用序号或分段呈现，阅卷时更容易识别要点。' : '条理已经清楚，检查各条是否互不交叉。',
      limit && text.length > limit ? `当前约 ${text.length} 字，超过题目要求 ${limit} 字，需要删减。` : '完成后再对照材料核对主体、对象和逻辑关系。',
    ],
  };
}

function submitAnswer() {
  const question = state.question;
  if (!question) return;
  if (question.mode === 'choice') {
    const selected = selectedChoice(question);
    if (!selected) {
      showToast('先选择一个答案，再交卷');
      return;
    }
    const result = choiceResult(question);
    state.submitted = true;
    markSubmitted(question, '', result);
    render();
    return;
  }
  if (!state.practiceText.trim()) {
    showToast('先写下你的答案，再交卷');
    document.querySelector('#answer-box')?.focus();
    return;
  }
  const result = localGrade(question, state.practiceText);
  state.submitted = true;
  markSubmitted(question, state.practiceText, result);
  render();
}

function resetAnswer() {
  if (!state.question) return;
  state.practiceText = '';
  delete store.answers[state.question.id];
  delete store.completed[state.question.id];
  delete store.mistakes[state.question.id];
  state.submitted = false;
  state.aiResult = null;
  persist();
  render();
}

function nextQuestion() {
  if (!state.queue.length) prepareQueue();
  if (state.queueIndex < state.queue.length - 1) {
    state.queueIndex += 1;
    selectQuestion(state.queue[state.queueIndex].id);
  } else {
    showToast('这一轮已完成，可以换一组筛选继续');
  }
}

function previousQuestion() {
  if (state.queueIndex > 0) {
    state.queueIndex -= 1;
    selectQuestion(state.queue[state.queueIndex].id);
  }
}

function buildPrompt(question, userAnswer, kind = 'score') {
  const task = kind === 'explain'
    ? '请解释这道选择题的正确答案，逐项说明选项为什么对或错。'
    : '请像一名严格但建设性的申论阅卷老师一样评分，并给出可以直接执行的修改建议。';
  const selected = question.mode === 'choice' ? selectedChoice(question) : userAnswer;
  return `${task}\n\n只根据题目材料和参考答案判断，不要编造材料中没有的事实。\n请使用中文，返回 JSON，不要 Markdown 代码围栏。\nJSON 字段：score(number, 0-100), summary(string), dimensions(array of {name, score, note}), missing(array of string), suggestions(array of string), rewrite(string)。\n\n题型：${question.questionType}\n题目：${question.stem}\n给定材料：${question.material}\n参考答案：${question.answer}\n官方解析：${question.explanation || question.demo || ''}\n学生作答：${selected || '（未选择）'}`;
}

async function askModel(kind = 'score') {
  if (!settings.aiEnabled) {
    showToast('请先在设置中打开大模型辅助');
    return;
  }
  if (!state.config.ai?.configured) {
    showToast('请先在设置中填写 OpenAI 兼容 API Key，或等待管理员配置统一模型');
    state.view = 'settings';
    location.hash = 'settings';
    render();
    return;
  }
  state.aiLoading = true;
  state.aiResult = null;
  render();
  try {
    const response = await fetch('/api/ai/chat/completions', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.config.ai.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是公考题库的阅卷与学习教练。输出准确、克制、可执行。' },
          { role: 'user', content: buildPrompt(state.question, state.practiceText, kind) },
        ],
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || payload.error || `请求失败（${response.status}）`);
    const content = payload.choices?.[0]?.message?.content || '';
    state.aiResult = JSON.parse(content.replace(/^```json\s*|\s*```$/g, ''));
  } catch (error) {
    state.aiResult = { error: error.message || '模型请求失败，请检查地址、模型和 Key。' };
  } finally {
    state.aiLoading = false;
    render();
  }
}

function navItem(view, label, iconName, count = '') {
  const active = state.view === view ? 'active' : '';
  return `<button class="nav-item ${active}" data-action="navigate" data-view="${view}">${icon(iconName)}<span>${label}</span>${count ? `<b>${count}</b>` : ''}</button>`;
}

function renderShell(content) {
  const c = counts();
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" aria-label="主导航">
        <div class="brand-lockup"><div class="brand-mark">墨</div><div><strong>墨卷</strong><span>公考练习工作台</span></div></div>
        <div class="sidebar-rule"></div>
        <p class="nav-label">我的书桌</p>
        <nav>
          ${navItem('desk', '今日书桌', 'notebook-pen')}
          ${navItem('practice', '开始刷题', 'play-circle')}
          ${navItem('mistakes', '错题回看', 'rotate-ccw', c.mistakes)}
          ${navItem('favorites', '我的收藏', 'bookmark', c.favorites)}
        </nav>
        <p class="nav-label library-label">题库切换</p>
        <div class="subject-switcher">
          <button class="subject-tab ${state.filters.subject === '申论' ? 'selected' : ''}" data-action="subject" data-subject="申论"><span class="ink-dot red"></span>申论题库<em>${subjectCount('申论').toLocaleString()}</em></button>
          <button class="subject-tab ${state.filters.subject === '综应' ? 'selected' : ''}" data-action="subject" data-subject="综应"><span class="ink-dot blue"></span>综应题库<em>${subjectCount('综应').toLocaleString()}</em></button>
          <button class="subject-tab ${state.filters.subject === '行测' ? 'selected' : ''}" data-action="subject" data-subject="行测"><span class="ink-dot yellow"></span>行测题库<em>${subjectCount('行测').toLocaleString()}</em></button>
          <button class="subject-tab ${state.filters.subject === '公基' ? 'selected' : ''}" data-action="subject" data-subject="公基"><span class="ink-dot green"></span>公基题库<em>${subjectCount('公基').toLocaleString()}</em></button>
        </div>
        <div class="sidebar-bottom"><div class="progress-stamp"><span>已完成</span><strong>${progressPercent()}%</strong><div class="progress-line"><i style="width:${progressPercent()}%"></i></div></div>${navItem('settings', '设置与模型', 'sliders-horizontal')}${state.user?.role === 'admin' ? navItem('admin', '管理员', 'shield-check') : ''}</div>
      </aside>
      <main class="main-area">
        <header class="topbar"><div class="mobile-brand"><span class="brand-mark">墨</span><strong>墨卷</strong></div><div class="topbar-note"><span class="tiny-pencil">✎</span> 今天也写一题，进步就有形状</div><div class="top-actions"><span class="user-chip">${escapeHtml(state.user?.displayName || state.user?.username || '')}</span><button class="icon-button" data-action="navigate" data-view="settings" title="设置">${icon('settings-2')}</button><button class="avatar-button" data-action="logout" title="退出登录">${escapeHtml((state.user?.displayName || state.user?.username || '墨').slice(0, 1))}</button></div></header>
        <div class="page-content">${content}</div>
      </main>
    </div>
    ${state.toast ? `<div class="toast" role="status">${icon('check-circle-2')}${escapeHtml(state.toast)}</div>` : ''}
  `;
  hydrateIcons();
}

function renderDesk() {
  const c = counts();
  const loaded = loadedQuestions();
  const recommendations = loaded.filter((q) => !store.completed[q.id]).slice(0, 3);
  const recent = Object.entries(store.answers).sort((a, b) => b[1].at - a[1].at).slice(0, 3).map(([id]) => loaded.find((q) => q.id === id)).filter(Boolean);
  return `
    <section class="desk-intro reveal"><div><p class="eyebrow">${today()} / 学习记录</p><h1>把今天的答案，<br><span>写在纸上。</span></h1><p class="intro-copy">这是你的公考练习桌。先做一题，再看解析；把不熟的地方标出来，下一次就知道从哪里开始。</p></div><div class="desk-sketch" aria-hidden="true"><div class="sketch-circle"></div><div class="sketch-pencil">✎</div><span>今天的<br>一小步</span></div></section>
    <section class="stat-strip reveal delay-1"><div class="stat-cell"><span>题库总量</span><strong>${c.total.toLocaleString()}</strong><small>道真题</small></div><div class="stat-cell"><span>今日完成</span><strong>${c.today}</strong><small>道练习</small></div><div class="stat-cell"><span>已收藏</span><strong>${c.favorites}</strong><small>道重点</small></div><div class="stat-cell accent"><span>完成进度</span><strong>${progressPercent()}<i>%</i></strong><small>持续积累中</small></div></section>
    <section class="desk-grid reveal delay-2"><div class="section-heading"><div><p class="eyebrow">练习入口</p><h2>今天从哪里开始？</h2></div><button class="text-button" data-action="navigate" data-view="practice">浏览全部 ${icon('arrow-up-right')}</button></div><div class="launch-grid"><button class="launch-card red-card" data-action="quick-start" data-subject="申论"><span class="card-ink">01</span><span class="launch-icon">${icon('pen-line')}</span><strong>申论题库</strong><small>材料阅读 · 要点提炼 · 文章写作</small><i class="launch-arrow">${icon('arrow-up-right')}</i></button><button class="launch-card blue-card" data-action="quick-start" data-subject="综应"><span class="card-ink">02</span><span class="launch-icon">${icon('layers-3')}</span><strong>综应题库</strong><small>案例分析 · 公文处理 · 科技实务</small><i class="launch-arrow">${icon('arrow-up-right')}</i></button><button class="launch-card yellow-card" data-action="quick-start" data-subject="行测"><span class="card-ink">03</span><span class="launch-icon">${icon('scan-search')}</span><strong>行测题库</strong><small>六大模块 · 真题解析 · 图题支持</small><i class="launch-arrow">${icon('arrow-up-right')}</i></button><button class="launch-card green-card" data-action="quick-start" data-subject="公基"><span class="card-ink">04</span><span class="launch-icon">${icon('landmark')}</span><strong>事业编公基</strong><small>政治理论 · 常识判断 · 逐题解析</small><i class="launch-arrow">${icon('arrow-up-right')}</i></button><button class="launch-card pale-card" data-action="quick-start" data-mode="subjective"><span class="card-ink">05</span><span class="launch-icon">${icon('message-square-more')}</span><strong>主观题专场</strong><small>写完即评 · 看见自己的进步</small><i class="launch-arrow">${icon('arrow-up-right')}</i></button></div></section>
    <section class="desk-lower reveal delay-3"><div class="recommendation"><div class="section-heading"><div><p class="eyebrow">为你挑选</p><h2>下一题</h2></div><span class="hand-note">不重复已完成</span></div>${recommendations.length ? recommendations.map((q, i) => questionRow(q, i)).join('') : `<div class="empty-state">${icon('book-open')}<p>从上面的题库入口选择一门，马上开始。</p><button class="outline-button" data-action="quick-start" data-subject="公基">开始刷题</button></div>`}</div><div class="recent-note"><div class="section-heading"><div><p class="eyebrow">最近落笔</p><h2>练习痕迹</h2></div></div>${recent.length ? recent.map((q) => `<button class="recent-row" data-action="open-question" data-id="${q.id}"><span>${escapeHtml(q.subject)} · ${escapeHtml(q.category)}</span><strong>${escapeHtml(q.title.replace(/^请根据[““]?给定资料[””]?[,，]?/, '').slice(0, 34))}</strong><i>${icon('chevron-right')}</i></button>`).join('') : '<p class="muted empty-copy">完成第一道题后，这里会留下你的练习痕迹。</p>'}</div></section>
  `;
}

function questionRow(question, index = 0) {
  return `<button class="question-row" data-action="open-question" data-id="${question.id}"><span class="row-number">${String(index + 1).padStart(2, '0')}</span><span class="row-main"><small>${escapeHtml(question.subject)} / ${escapeHtml(question.category)}</small><strong>${escapeHtml(question.title.slice(0, 58))}</strong></span><span class="row-meta">${question.difficulty ? '难度 ' + '●'.repeat(question.difficulty) : '未标注'} ${icon('arrow-up-right')}</span></button>`;
}

function filterBar() {
  const subjectCounts = categoryCounts();
  const categoryOptions = categories();
  return `<div class="filter-bar"><label class="search-field">${icon('search')}<input data-input="search" value="${escapeHtml(state.filters.search)}" placeholder="搜题干、题型或主题" /></label><select data-input="subject"><option>全部</option><option ${state.filters.subject === '申论' ? 'selected' : ''}>申论</option><option ${state.filters.subject === '综应' ? 'selected' : ''}>综应</option><option ${state.filters.subject === '行测' ? 'selected' : ''}>行测</option><option ${state.filters.subject === '公基' ? 'selected' : ''}>公基</option></select><select data-input="category"><option value="全部" ${state.filters.category === '全部' ? 'selected' : ''}>全部类别</option>${categoryOptions.map((category) => `<option value="${escapeHtml(category)}" ${state.filters.category === category ? 'selected' : ''}>${escapeHtml(category)} · ${(subjectCounts[category] || 0).toLocaleString()}</option>`).join('')}</select><select data-input="mode"><option value="全部" ${state.filters.mode === '全部' ? 'selected' : ''}>全部形式</option><option value="subjective" ${state.filters.mode === 'subjective' ? 'selected' : ''}>主观题</option><option value="choice" ${state.filters.mode === 'choice' ? 'selected' : ''}>选择题</option></select></div>${categoryOptions.length ? `<nav class="category-picker" aria-label="题目类别"><button class="category-chip ${state.filters.category === '全部' ? 'selected' : ''}" data-action="category" data-category="全部">全部类别 <span>${(state.filters.subject === '全部' ? state.manifest?.total : subjectCount(state.filters.subject))?.toLocaleString() || 0}</span></button>${categoryOptions.map((category) => `<button class="category-chip ${state.filters.category === category ? 'selected' : ''}" data-action="category" data-category="${escapeHtml(category)}">${escapeHtml(category)} <span>${(subjectCounts[category] || 0).toLocaleString()}</span></button>`).join('')}</nav>` : ''}`;
}

function renderPractice() {
  const list = filteredQuestions();
  const needsAllSummaries = state.filters.subject === '全部'
    ? state.manifest?.subjects.some((subject) => !state.summaries.has(subject))
    : !state.summaries.has(state.filters.subject);
  if (needsAllSummaries && !state.summaryLoading) {
    queueMicrotask(() => loadSummaries(state.filters.subject));
  }
  if (!state.question && !state.questionLoading && list.length) {
    prepareQueue(list);
    queueMicrotask(() => loadQuestion(list[0].id));
  }
  const question = state.question;
  const result = question && state.submitted && question.mode === 'subjective' ? localGrade(question, state.practiceText) : null;
  const content = state.summaryLoading && !list.length
    ? loadingCard()
    : state.questionLoading || !question
      ? (list.length ? loadingCard() : selectionCard())
      : practiceCard(question, result);
  return `<section class="practice-layout reveal"><div class="practice-main"><div class="practice-heading"><div><p class="eyebrow">练习模式 / ${list.length.toLocaleString()} 道匹配题</p><h1>落笔，才算真正读懂。</h1></div><button class="outline-button" data-action="navigate" data-view="desk">${icon('arrow-left')} 回到书桌</button></div>${filterBar()}${content}</div><aside class="practice-aside"><div class="aside-sticky"><div class="aside-title"><span class="page-corner"></span><div><p class="eyebrow">本轮进度</p><h3>${state.queueIndex + 1} <small>/ ${state.queue.length || list.length || 0}</small></h3></div></div><div class="vertical-progress"><i style="height:${state.queue.length ? ((state.queueIndex + 1) / state.queue.length) * 100 : 0}%"></i></div><p class="aside-caption">每一道题都算数。<br>完成后会自动留下记录。</p><div class="aside-list">${state.queue.slice(Math.max(0, state.queueIndex - 1), state.queueIndex + 3).map((item, i) => `<button class="aside-question ${item.id === question?.id ? 'current' : ''}" data-action="open-question" data-id="${item.id}"><span>${String(state.queue.indexOf(item) + 1).padStart(2, '0')}</span><strong>${escapeHtml(item.title.slice(0, 24))}</strong></button>`).join('')}</div></div></aside></section>`;
}

function loadingCard() {
  return `<div class="loading-card"><div class="scribble-loader">${icon('loader-circle')}</div><p>正在翻开这一页...</p></div>`;
}

function selectionCard() {
  if (state.filters.search || state.filters.category !== '全部' || state.filters.mode !== '全部') {
    return `<div class="loading-card"><div class="scribble-loader">${icon('search-x')}</div><p>没有找到符合条件的题目，试试调整筛选。</p></div>`;
  }
  return `<div class="loading-card"><div class="scribble-loader">${icon('book-open')}</div><p>先在上方选择一个题库，再开始刷题。</p></div>`;
}

function practiceCard(question, result) {
  const isFavorite = Boolean(store.favorites[question.id]);
  const options = question.options || [];
  const context = [question.paper, question.year && `${question.year}年`].filter(Boolean).join(' · ');
  return `<article class="question-paper"><div class="paper-topline"><span>${escapeHtml(question.subject)} / ${escapeHtml(question.category)}${context ? ` · ${escapeHtml(context)}` : ''}</span><div><span class="paper-id">#${escapeHtml(question.id)}</span><button class="icon-button small ${isFavorite ? 'is-favorite' : ''}" data-action="favorite" title="${isFavorite ? '取消收藏' : '收藏'}">${icon('bookmark')}</button></div></div><div class="question-title-row"><div class="question-number">${String(state.queueIndex + 1).padStart(2, '0')}</div><div><h2>${escapeHtml(question.title)}</h2><div class="question-tags">${question.detailType ? `<span>${escapeHtml(question.detailType)}</span>` : ''}${question.themes?.slice(0, 2).map((theme) => `<span>${escapeHtml(theme)}</span>`).join('') || ''}</div></div></div><div class="material-section"><div class="section-label"><span>${question.material ? '给定材料' : '题目'}</span><i></i><small>${question.material ? `${question.material.length.toLocaleString()} 字` : '题干阅读'}</small></div><div class="material-copy">${formatRichText(question.material || question.stem)}</div></div><div class="answer-section"><div class="section-label"><span>你的作答</span><i></i><small>${question.mode === 'choice' ? '选择一个答案' : `${extractLimit(question.stem) ? `限 ${extractLimit(question.stem)} 字` : '不限字数'}`}</small></div>${options.length ? choiceInput(question, options) : `<textarea id="answer-box" data-input="answer" ${state.submitted ? 'readonly' : ''} placeholder="从材料中提炼要点，写下你的答案...">${escapeHtml(state.practiceText)}</textarea><div class="answer-tools"><span>${state.practiceText.length} 字</span><button class="ghost-button" data-action="clear-answer" ${state.submitted ? 'disabled' : ''}>清空</button></div>`}</div>${state.submitted ? resultPanel(question, result) : ''}<div class="paper-actions"><button class="secondary-button" data-action="previous" ${state.queueIndex <= 0 ? 'disabled' : ''}>${icon('arrow-left')} 上一题</button><div class="primary-actions">${question.mode === 'choice' && settings.aiEnabled ? `<button class="ai-button" data-action="ask-ai-explain" ${state.aiLoading ? 'disabled' : ''}>${icon('sparkles')} ${state.aiLoading ? '解析中...' : '大模型解析'}</button>` : ''}<button class="submit-button" data-action="submit" ${state.submitted ? 'disabled' : ''}>${state.submitted ? icon('check') + ' 已完成' : '交卷并查看解析'}</button></div><button class="secondary-button" data-action="next">下一题 ${icon('arrow-right')}</button></div></article>`;
}

function choiceInput(question, options) {
  const selected = store.answers[question.id]?.choice || '';
  const isMultiple = String(question.correctAnswer || question.answer || '').replace(/[^A-H]/gi, '').length > 1;
  return `<div class="choice-list ${isMultiple ? 'multiple-choice' : ''}">${options.map((option) => {
    const checked = selected.includes(option.key);
    return `<label class="choice-option ${checked ? 'selected' : ''}"><input type="${isMultiple ? 'checkbox' : 'radio'}" name="choice" value="${option.key}" ${checked ? 'checked' : ''} ${state.submitted ? 'disabled' : ''}/><span class="choice-key">${option.key}</span><span>${formatRichText(option.text)}</span></label>`;
  }).join('')}</div>`;
}

function resultPanel(question, result) {
  if (question.mode === 'choice') {
    const choice = choiceResult(question);
    const explanation = question.explanation || question.demo || '';
    return `<div class="result-panel choice-result"><div class="result-heading"><span class="result-badge">${choice.isCorrect ? '回答正确' : '需要订正'}</span><h3>${choice.selected ? `你的答案 ${escapeHtml(choice.selected)} · 正确答案 ${escapeHtml(choice.correct || '未标注')}` : `正确答案 ${escapeHtml(choice.correct || '未标注')}`}</h3></div><div class="reference-copy">${formatRichText(explanation || `正确答案：${question.answer || '暂无'}`)}</div><button class="ai-text-button" data-action="ask-ai-explain" ${state.aiLoading ? 'disabled' : ''}>${icon('sparkles')} ${state.aiLoading ? '正在请教模型...' : '让大模型补充一版解析'}</button>${aiResultPanel()}</div>`;
  }
  return `<div class="result-panel"><div class="score-head"><div><span class="result-badge">本次自评</span><strong>${result?.score ?? '--'}<small>/100</small></strong></div><div class="score-caption">${result?.coverage ?? 0}% 要点覆盖<br><span>${result?.words ?? 0}${result?.limit ? ` / ${result.limit}` : ''} 字</span></div></div><div class="score-bars">${scoreBar('要点覆盖', result?.coverage ?? 0, '#df6658')}${scoreBar('结构条理', result && /\n|\d+[.、]|[一二三四五六七八九十]+、/.test(state.practiceText) ? 88 : 48, '#527f95')}${scoreBar('字数控制', result?.limit && result.words > result.limit ? Math.max(10, Math.round((result.limit / result.words) * 100)) : 100, '#e6ad4d')}</div><div class="suggestion-block"><h4>落笔建议</h4><ul>${(result?.suggestions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div><div class="reference-fold"><button class="reference-toggle" data-action="toggle-reference">${state.loadedAnswer ? '收起参考答案与演示' : '展开参考答案与演示'} ${icon(state.loadedAnswer ? 'chevron-up' : 'chevron-down')}</button>${state.loadedAnswer ? `<div class="reference-copy"><h4>参考答案</h4>${formatText(question.answer)}<h4>答题演示</h4>${formatText(question.demo)}</div>` : ''}</div><div class="ai-coach-row"><span>${icon('sparkles')} 想要更细的语义反馈？</span><button class="ai-text-button" data-action="ask-ai-score" ${state.aiLoading ? 'disabled' : ''}>${state.aiLoading ? '正在请教模型...' : '请大模型点评'} ${icon('arrow-up-right')}</button></div>${aiResultPanel()}</div>`;
}

function scoreBar(label, value, color) {
  return `<div class="score-bar"><div><span>${label}</span><strong>${value}%</strong></div><div class="bar-track"><i style="width:${value}%;background:${color}"></i></div></div>`;
}

function aiResultPanel() {
  if (!state.aiResult) return '';
  if (state.aiResult.error) return `<div class="ai-result error-result">${icon('triangle-alert')}<p>${escapeHtml(state.aiResult.error)}</p></div>`;
  return `<div class="ai-result"><div class="ai-result-title">${icon('sparkles')} 模型点评 <span>${state.aiResult.score ?? '--'} 分</span></div>${state.aiResult.summary ? `<p>${escapeHtml(state.aiResult.summary)}</p>` : ''}${state.aiResult.dimensions?.length ? `<div class="ai-dimensions">${state.aiResult.dimensions.map((item) => `<div><span>${escapeHtml(item.name)}</span><strong>${escapeHtml(item.score)}</strong><small>${escapeHtml(item.note)}</small></div>`).join('')}</div>` : ''}${state.aiResult.missing?.length ? `<div class="ai-list"><b>可能遗漏</b><ul>${state.aiResult.missing.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}${state.aiResult.suggestions?.length ? `<div class="ai-list"><b>优化建议</b><ul>${state.aiResult.suggestions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}${state.aiResult.rewrite ? `<div class="rewrite-box"><b>参考改写</b><p>${escapeHtml(state.aiResult.rewrite)}</p></div>` : ''}</div>`;
}

function renderLibrary(view) {
  const title = view === 'mistakes' ? '错题回看' : '我的收藏';
  const ids = Object.keys(view === 'mistakes' ? store.mistakes : store.favorites);
  const questions = ids.map((id) => loadedQuestions().find((q) => q.id === id)).filter(Boolean);
  if (ids.length && questions.length < ids.length && !state.summaryLoading) queueMicrotask(() => loadSummaries('全部'));
  return `<section class="library-page reveal"><div class="library-heading"><div><p class="eyebrow">${view === 'mistakes' ? '需要再看一眼' : '留给下次的标记'}</p><h1>${title}</h1><p>${questions.length ? `共 ${questions.length} 道，按最近标记排序。` : '这里还没有题目。'}</p></div><button class="outline-button" data-action="navigate" data-view="practice">${icon('plus')} 去刷一题</button></div><div class="library-list">${questions.length ? questions.map((q, i) => questionRow(q, i)).join('') : `<div class="empty-library"><div class="empty-mark">${view === 'mistakes' ? '再' : '藏'}</div><h3>${view === 'mistakes' ? '还没有错题记录' : '收藏夹是空的'}</h3><p>${view === 'mistakes' ? '完成练习后，低分题会自动出现在这里。' : '在题目右上角点一下书签，留下你想反复看的题。'}</p></div>`}</div></section>`;
}

function renderSettings() {
  const unified = state.config.ai?.configured;
  const admin = state.user?.role === 'admin';
  const aiSection = admin
    ? `<div class="form-section"><div class="form-section-heading"><span>01</span><div><h3>全站共享大模型</h3><p>所有账号的解析和点评共用此配置，密钥仅保存在服务器。</p></div></div><label>兼容接口地址<input name="sharedEndpoint" value="${escapeHtml(state.sharedAi.endpoint || DEFAULT_SETTINGS.endpoint)}" placeholder="https://api.openai.com/v1" /></label><label>模型名称<input name="sharedModel" value="${escapeHtml(state.sharedAi.model || DEFAULT_SETTINGS.model)}" placeholder="gpt-4o-mini" /></label><label>API Key<input name="sharedApiKey" type="password" value="" placeholder="${state.sharedAi.configured ? '已配置，留空保持不变' : '粘贴服务商 API Key'}" autocomplete="new-password" /></label><p class="ai-config-status">${state.sharedAi.configured ? `全站已接入 · ${escapeHtml(state.sharedAi.model)}` : '尚未配置共享模型'}</p><button class="submit-button save-settings" type="submit">${icon('save')} 保存全站模型</button>${state.sharedAi.configured ? `<button class="text-button" type="button" data-action="clear-shared-ai">清除服务器密钥</button>` : ''}</div>`
    : `<div class="form-section"><div class="form-section-heading"><span>01</span><div><h3>全站共享大模型</h3><p>${unified ? `已接入 ${escapeHtml(state.config.ai.model)}，可直接用于解析和点评。` : '管理员尚未完成共享模型配置。'}</p></div></div><p class="ai-config-status">${unified ? '服务可用配置已保存' : '当前不可用，请联系管理员配置'}</p></div>`;
  const sectionNumber = admin ? '02' : '02';
  return `<section class="settings-page reveal"><div class="settings-heading"><div><p class="eyebrow">工具箱 / ${state.storage === 'sqlite' ? '账号云端保存' : '浏览器保存'}</p><h1>让工具，<br>听你的。</h1><p>当前账号：${escapeHtml(state.user?.displayName || state.user?.username || '')}。学习记录保存到服务端 SQLite；大模型由管理员为全站统一配置。</p></div><div class="settings-doodle">${icon('key-round')}<span>${unified ? '统一<br>已接入' : '等待<br>配置'}</span></div></div><div class="settings-grid"><form class="settings-form" data-form="settings">${aiSection}<div class="form-section"><div class="form-section-heading"><span>${sectionNumber}</span><div><h3>练习偏好</h3><p>大模型评分和选择题解析使用全站共享服务。</p></div></div><label class="switch-line"><span><strong>启用大模型辅助</strong><small>主观题点评、选择题解析都会出现入口</small></span><input name="aiEnabled" type="checkbox" ${settings.aiEnabled ? 'checked' : ''}/><i class="toggle-ui"></i></label><button class="outline-button save-settings" type="submit">${icon('save')} 保存练习偏好</button></div><div class="form-section"><div class="form-section-heading"><span>03</span><div><h3>账号与数据</h3><p>这个账号的记录不会与其他用户混在一起。</p></div></div><button class="outline-button" type="button" data-action="logout">${icon('log-out')} 退出当前账号</button></div></form><aside class="settings-notes"><div class="note-paper"><span class="tape"></span><h3>模型状态</h3><p>全站账号统一使用管理员配置的兼容接口、模型和 API Key。</p><p>密钥不会回传至浏览器，留空保存可保留现有密钥。</p><p>API Key 更新只影响后续请求，不改动练习记录。</p></div><div class="data-note"><span>数据状态</span><strong>${state.manifest?.total.toLocaleString()} 道题已就绪</strong><small>由 Markdown 题库构建 · ${state.manifest?.generatedAt ? new Date(state.manifest.generatedAt).toLocaleDateString('zh-CN') : '本地'}</small></div></aside></div></section>`;
}

function renderAdmin() {
  const stats = state.adminStats || { users: 0, activeUsers: 0, completed: 0, sessions: 0 };
  return `<section class="admin-page reveal"><div class="library-heading"><div><p class="eyebrow">系统管理 / 账号与服务</p><h1>管理员台账</h1><p>统一管理账号状态，学习记录和题库正文不会在此页暴露。</p></div><button class="outline-button" data-action="load-admin">${icon('refresh-cw')} 刷新数据</button></div><div class="admin-stats"><div><span>账号总数</span><strong>${stats.users}</strong></div><div><span>启用账号</span><strong>${stats.activeUsers}</strong></div><div><span>完成记录</span><strong>${stats.completed}</strong></div><div><span>刷题会话</span><strong>${stats.sessions}</strong></div></div><div class="admin-grid"><form class="settings-form" data-form="new-user"><div class="form-section"><div class="form-section-heading"><span>01</span><div><h3>创建账号</h3><p>为团队成员创建普通用户或管理员。</p></div></div><label>用户名<input name="username" required minlength="2" maxlength="32" /></label><label>显示名称<input name="displayName" maxlength="40" /></label><label>初始密码<input name="password" type="password" required minlength="8" /></label><label>角色<select name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label><button class="submit-button" type="submit">${icon('user-plus')} 创建账号</button></div></form><div class="admin-users"><div class="section-heading"><div><p class="eyebrow">02 / 账号列表</p><h2>成员</h2></div></div>${state.adminUsers.map((user) => `<div class="admin-user-row"><div><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.username)} · ${user.role === 'admin' ? '管理员' : '普通用户'}</span></div><div class="admin-user-actions"><span class="status-dot ${user.active ? 'on' : ''}">${user.active ? '启用' : '停用'}</span>${user.id === state.user.id ? '<small>当前账号</small>' : `<button class="text-button" data-action="toggle-user" data-user-id="${user.id}" data-active="${user.active}">${user.active ? '停用' : '启用'}</button><button class="text-button" data-action="reset-user" data-user-id="${user.id}">重置密码</button>`}</div></div>`).join('')}</div></div></section>`;
}

function render() {
  if (!state.user) {
    app.innerHTML = authCard();
    hydrateIcons();
    return;
  }
  if (!state.manifest) return;
  let content;
  if (state.view === 'practice') content = renderPractice();
  else if (state.view === 'mistakes' || state.view === 'favorites') content = renderLibrary(state.view);
  else if (state.view === 'settings') content = renderSettings();
  else if (state.view === 'admin' && state.user.role === 'admin') content = renderAdmin();
  else content = renderDesk();
  renderShell(content);
}

function handleAction(target) {
  const action = target.dataset.action;
  if (action === 'toggle-auth') {
    if (!state.config.registration && state.authMode === 'login') return;
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    state.authError = '';
    render();
  } else if (action === 'logout') {
    logout();
  } else if (action === 'load-admin') {
    Promise.all([loadAdminData(), loadSharedAiConfig()]).then(render);
  } else if (action === 'clear-shared-ai') {
    apiJson('/api/admin/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: state.sharedAi.endpoint, model: state.sharedAi.model, clearApiKey: true }),
    }).then((payload) => {
      state.sharedAi = payload.ai;
      state.config.ai = { configured: false, model: payload.ai.model };
      showToast('服务器模型密钥已清除');
      render();
    }).catch((error) => showToast(error.message));
  } else if (action === 'toggle-user') {
    apiJson(`/api/admin/users/${target.dataset.userId}/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: target.dataset.active !== 'true' }),
    }).then(() => loadAdminData()).then(render).catch((error) => showToast(error.message));
  } else if (action === 'reset-user') {
    const password = window.prompt('请输入新的初始密码（至少 6 位）');
    if (!password) return;
    apiJson(`/api/admin/users/${target.dataset.userId}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then(() => showToast('密码已重置')).catch((error) => showToast(error.message));
  } else if (action === 'navigate') {
    state.view = target.dataset.view;
    location.hash = state.view;
    if (state.view === 'practice') {
      prepareQueue(filteredQuestions());
      if (state.filters.subject !== '全部') loadSummaries(state.filters.subject);
    }
    if (state.view === 'mistakes' || state.view === 'favorites') loadSummaries('全部');
    if (state.view === 'admin') loadAdminData().then(render);
    if (state.view === 'settings' && state.user?.role === 'admin') loadSharedAiConfig().then(render);
    render();
  } else if (action === 'subject') {
    state.filters.subject = state.filters.subject === target.dataset.subject ? '全部' : target.dataset.subject;
    state.filters.category = '全部';
    state.filters.mode = '全部';
    state.filters.search = '';
    applyPracticeFilters({ subjectChanged: true });
  } else if (action === 'quick-start') {
    state.filters.subject = target.dataset.subject || '全部';
    state.filters.mode = target.dataset.mode || '全部';
    state.filters.category = '全部';
    state.filters.search = '';
    applyPracticeFilters({ subjectChanged: true });
  } else if (action === 'open-question') {
    const item = loadedQuestions().find((q) => q.id === target.dataset.id);
    state.queue = filteredQuestions();
    state.queueIndex = Math.max(0, state.queue.findIndex((q) => q.id === target.dataset.id));
    state.view = 'practice';
    location.hash = 'practice';
    loadQuestion(item?.id || target.dataset.id);
  } else if (action === 'category') {
    state.filters.category = target.dataset.category || '全部';
    applyPracticeFilters();
  } else if (action === 'favorite') toggleFavorite(state.question?.id);
  else if (action === 'submit') submitAnswer();
  else if (action === 'clear-answer') resetAnswer();
  else if (action === 'next') nextQuestion();
  else if (action === 'previous') previousQuestion();
  else if (action === 'toggle-reference') { state.loadedAnswer = !state.loadedAnswer; render(); }
  else if (action === 'ask-ai-score') askModel('score');
  else if (action === 'ask-ai-explain') askModel('explain');
}

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) handleAction(target);
});

app.addEventListener('input', (event) => {
  const input = event.target;
  if (input.dataset.input === 'answer') {
    state.practiceText = input.value;
    const counter = input.closest('.answer-section')?.querySelector('.answer-tools span');
    if (counter) counter.textContent = `${input.value.length} 字`;
  } else if (input.dataset.input === 'search') {
    state.filters.search = input.value;
    prepareQueue(filteredQuestions());
    if (!state.queue.some((item) => item.id === state.question?.id)) {
      resetQuestionState();
      if (state.queue.length) selectFromQueue();
      else render();
    } else {
      render();
    }
  }
});

app.addEventListener('change', (event) => {
  const input = event.target;
  if (input.dataset.input === 'subject' || input.dataset.input === 'category' || input.dataset.input === 'mode') {
    state.filters[input.dataset.input] = input.value;
    if (input.dataset.input === 'category' && input.value === '全部类别') {
      state.filters.category = '全部';
    }
    if (input.dataset.input === 'subject') {
      state.filters.category = '全部';
      state.filters.search = '';
    }
    applyPracticeFilters({ subjectChanged: input.dataset.input === 'subject' });
    return;
  }
  if (input.name === 'choice' && state.question) {
    const choiceList = input.closest('.choice-list');
    const choices = [...choiceList.querySelectorAll('input[name="choice"]:checked')]
      .map((item) => item.value)
      .sort()
      .join('');
    store.answers[state.question.id] = { ...(store.answers[state.question.id] || {}), choice: choices, at: Date.now() };
    persist();
    choiceList.querySelectorAll('.choice-option').forEach((item) => item.classList.toggle('selected', item.querySelector('input')?.checked));
  }
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const authForm = event.target.closest('[data-form="auth"]');
  if (authForm) {
    submitAuth(authForm);
    return;
  }
  const userForm = event.target.closest('[data-form="new-user"]');
  if (userForm) {
    const data = new FormData(userForm);
    apiJson('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: data.get('username'), password: data.get('password'), displayName: data.get('displayName'), role: data.get('role') }),
    }).then(() => { userForm.reset(); return loadAdminData(); }).then(render).catch((error) => showToast(error.message));
    return;
  }
  const form = event.target.closest('[data-form="settings"]');
  if (!form) return;
  const data = new FormData(form);
  settings.aiEnabled = data.get('aiEnabled') === 'on';
  persistSettings();
  if (state.user?.role === 'admin' && data.has('sharedEndpoint')) {
    apiJson('/api/admin/ai-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: String(data.get('sharedEndpoint') || '').trim(),
        model: String(data.get('sharedModel') || '').trim(),
        apiKey: String(data.get('sharedApiKey') || '').trim(),
      }),
    }).then((payload) => {
      state.sharedAi = payload.ai;
      state.config.ai = { configured: payload.ai.configured, model: payload.ai.model };
      showToast('全站共享模型已保存到服务器');
      render();
    }).catch((error) => showToast(error.message));
  } else {
    showToast('练习偏好已保存在本机');
  }
});

window.addEventListener('hashchange', () => {
  const view = location.hash.replace('#', '') || 'desk';
  state.view = view;
  render();
});

async function bootstrap() {
  await initAuth();
  if (!state.user) {
    render();
    return;
  }
  await loadManifest();
  await initPersistence();
  if (state.view === 'admin') await loadAdminData();
  if (state.view === 'settings' && state.user?.role === 'admin') await loadSharedAiConfig();
  render();
}

bootstrap();
