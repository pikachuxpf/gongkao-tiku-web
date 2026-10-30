import path from 'node:path';

function booleanEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function numberEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const port = numberEnv(env.PORT || env.MOJUAN_PORT, 5173);
  const host = env.MOJUAN_HOST || (production ? '0.0.0.0' : '127.0.0.1');
  const adminPassword = env.MOJUAN_ADMIN_PASSWORD || (!production ? '123456' : '');
  if (production && !adminPassword) throw new Error('生产环境必须设置 MOJUAN_ADMIN_PASSWORD');

  return {
    production,
    host,
    port,
    dbPath: env.MOJUAN_DB || path.join(cwd, 'storage', 'mojuan.sqlite'),
    sessionTtlMs: numberEnv(env.MOJUAN_SESSION_TTL_DAYS, 30) * 24 * 60 * 60 * 1000,
    allowRegistration: booleanEnv(env.MOJUAN_ALLOW_REGISTRATION, !production),
    cookieSecure: booleanEnv(env.MOJUAN_COOKIE_SECURE, production),
    admin: {
      username: env.MOJUAN_ADMIN_USERNAME || 'fpx',
      password: adminPassword,
      displayName: env.MOJUAN_ADMIN_NAME || '系统管理员',
    },
    ai: {
      endpoint: (env.MOJUAN_AI_ENDPOINT || 'https://api.openai.com/v1').replace(/\/$/, ''),
      model: env.MOJUAN_AI_MODEL || 'gpt-4o-mini',
      apiKey: env.MOJUAN_AI_API_KEY || '',
    },
  };
}
