const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const STATIC_DIR = path.join(__dirname, 'files');
const DATABASE_URL = process.env.DATABASE_URL || '';
const SYNC_DB_PATH = process.env.SYNC_DB_PATH || path.join(__dirname, 'data', 'studyforge.sqlite');
const SESSION_COOKIE = 'studyforge_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_REQUEST_BODY_BYTES = 8_000_000;

const dataStorePromise = initDataStore();

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      const dataStore = await dataStorePromise;
      return sendJson(res, 200, {
        ok: true,
        geminiConfigured: Boolean(GEMINI_API_KEY),
        model: GEMINI_MODEL,
        syncBackend: dataStore.backend,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      return handleGenerate(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      return handleSession(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      return handleRegister(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      return handleLogin(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/profile') {
      return handleProfileUpdate(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      return handleLogout(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/pull') {
      return handleSyncPull(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/api/sync/push') {
      return handleSyncPush(req, res);
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(url.pathname, res, req.method === 'HEAD');
    }

    sendJson(res, 404, { error: { message: 'Not found' } });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: { message: 'Internal server error' } });
  }
});

server.listen(PORT, () => {
  console.log(`StudyForge running on http://localhost:${PORT}`);
});

async function handleGenerate(req, res) {
  if (!GEMINI_API_KEY) {
    return sendJson(res, 500, {
      error: {
        message: 'Server is missing GEMINI_API_KEY.',
      },
    });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
  }

  const text = String(body.text || '').trim();
  const pages = normalizePages(body.pages, text);
  const fcCount = clampInteger(body.fcCount, 5, 60);
  const qqCount = clampInteger(body.qqCount, 5, 40);
  const choiceCount = clampInteger(body.choiceCount, 2, 5);
  const qTypes = ['mixed', 'mcq', 'fill'].includes(body.qTypes) ? body.qTypes : 'mixed';

  if (!text) {
    return sendJson(res, 400, { error: { message: 'PDF text is required.' } });
  }

  const pagePlan = allocateFlashcardsByPage(pages, fcCount);
  const prompt = buildPrompt(text, pages, pagePlan, fcCount, qqCount, choiceCount, qTypes);
  const schema = buildResponseSchema();

  const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: 'application/json',
        responseJsonSchema: schema,
      },
    }),
  });

  const geminiData = await geminiResponse.json().catch(() => ({}));
  if (!geminiResponse.ok) {
    return sendJson(res, geminiResponse.status, {
      error: {
        message: geminiData.error?.message || `Gemini API error ${geminiResponse.status}`,
      },
    });
  }

  const raw = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!raw) {
    return sendJson(res, 502, { error: { message: 'Gemini returned an empty response.' } });
  }

  let parsed;
  try {
    const cleaned = raw
      .replace(/^```json\s*/, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '');
    parsed = JSON.parse(cleaned);
  } catch {
    return sendJson(res, 502, { error: { message: 'Gemini returned invalid JSON.' } });
  }

  if (!Array.isArray(parsed.flashcards) || !Array.isArray(parsed.quiz)) {
    return sendJson(res, 502, { error: { message: 'Gemini response is missing flashcards or quiz.' } });
  }

  sendJson(res, 200, {
    flashcards: parsed.flashcards,
    quiz: parsed.quiz,
  });
}

async function handleSyncPull(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
  }

  const dataStore = await dataStorePromise;
  const session = await requireOptionalSession(req);
  let row = null;

  if (session?.user) {
    row = await dataStore.getUserDecks(getUserId(session.user));
  } else {
    const syncKey = String(body.syncKey || '').trim();
    if (!syncKey) {
      return sendJson(res, 400, { error: { message: 'Sync key is required.' } });
    }
    const syncHash = hashSyncKey(syncKey);
    row = await dataStore.getSyncProfile(syncHash);
  }

  if (!row || !hasRemoteDeckData(row)) {
    return sendJson(res, 200, { hasData: false, decks: {}, updatedAt: null });
  }

  let decks = {};
  try {
    decks = JSON.parse(row.decks_json);
  } catch {
    decks = {};
  }

  sendJson(res, 200, {
    hasData: true,
    decks,
    updatedAt: row.updated_at,
  });
}

async function handleSyncPush(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
  }

  const baseUpdatedAt = normalizeUpdatedAt(body.baseUpdatedAt);
  const decks = sanitizeDecksPayload(body.decks);
  const decksJson = JSON.stringify(decks);
  if (decksJson.length > 4_000_000) {
    return sendJson(res, 413, { error: { message: 'Synced deck data is too large.' } });
  }

  const updatedAt = Date.now();
  const dataStore = await dataStorePromise;
  const session = await requireOptionalSession(req);
  let current = null;

  if (session?.user) {
    current = await dataStore.getUserDecks(getUserId(session.user));
  } else {
    const syncKey = String(body.syncKey || '').trim();
    if (!syncKey) {
      return sendJson(res, 400, { error: { message: 'Sync key is required.' } });
    }
    const syncHash = hashSyncKey(syncKey);
    current = await dataStore.getSyncProfile(syncHash);
    if (current) {
      if (baseUpdatedAt === null || current.updated_at > baseUpdatedAt) {
        return sendJson(res, 409, {
          error: {
            message: 'Remote decks changed on another device. Pull the latest decks before syncing again.',
          },
          updatedAt: current.updated_at,
        });
      }
    }
    await dataStore.putSyncProfile(syncHash, decksJson, updatedAt);
    return sendJson(res, 200, {
      ok: true,
      updatedAt,
    });
  }

  if (current && hasRemoteDeckData(current)) {
    if (baseUpdatedAt === null || current.updated_at > baseUpdatedAt) {
      return sendJson(res, 409, {
        error: {
          message: 'Remote decks changed on another device. Pull the latest decks before syncing again.',
        },
        updatedAt: current.updated_at,
      });
    }
  }

  await dataStore.putUserDecks(getUserId(session.user), decksJson, updatedAt);

  sendJson(res, 200, {
    ok: true,
    updatedAt,
  });
}

async function handleSession(req, res) {
  const session = await requireOptionalSession(req);
  if (!session?.user) {
    return sendJson(res, 200, { authenticated: false, user: null });
  }
  sendJson(res, 200, {
    authenticated: true,
    user: buildPublicUser(session.user),
  });
}

async function handleRegister(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
  }

  const profile = normalizeUserPayload(body);
  if (!profile.ok) {
    return sendJson(res, 400, { error: { message: profile.message } });
  }

  const dataStore = await dataStorePromise;
  const existing = await dataStore.findUserByUsername(profile.username);
  if (existing) {
    return sendJson(res, 409, { error: { message: 'That username is already taken.' } });
  }

  const user = {
    userId: randomId('usr'),
    username: profile.username,
    firstName: profile.firstName,
    lastName: profile.lastName,
    nickname: profile.nickname,
    avatar: profile.avatar,
    passwordHash: hashPassword(profile.password),
    decksJson: '{}',
    decksUpdatedAt: 0,
    createdAt: Date.now(),
  };
  await dataStore.createUser(user);

  const session = await createSessionForUser(dataStore, user.userId);
  sendJson(res, 201, {
    authenticated: true,
    user: buildPublicUser(user),
  }, {
    'Set-Cookie': buildSessionCookie(session.sessionToken, session.expiresAt),
  });
}

async function handleLogin(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
  }

  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  if (!username || !password) {
    return sendJson(res, 400, { error: { message: 'Username and password are required.' } });
  }

  const dataStore = await dataStorePromise;
  const user = await dataStore.findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash || user.passwordHash)) {
    return sendJson(res, 401, { error: { message: 'Invalid username or password.' } });
  }

  const session = await createSessionForUser(dataStore, user.user_id || user.userId);
  sendJson(res, 200, {
    authenticated: true,
    user: buildPublicUser(user),
  }, {
    'Set-Cookie': buildSessionCookie(session.sessionToken, session.expiresAt),
  });
}

async function handleLogout(req, res) {
  const dataStore = await dataStorePromise;
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (token) {
    await dataStore.deleteSession(token);
  }
  sendJson(res, 200, { ok: true }, {
    'Set-Cookie': clearSessionCookie(),
  });
}

async function handleProfileUpdate(req, res) {
  const session = await requireOptionalSession(req);
  if (!session?.user) {
    return sendJson(res, 401, { error: { message: 'Sign in required.' } });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: 'Invalid JSON body.' } });
  }

  const update = normalizeProfileUpdatePayload(body);
  if (!update.ok) {
    return sendJson(res, 400, { error: { message: update.message } });
  }

  if (update.newPassword) {
    const currentHash = session.user.password_hash || session.user.passwordHash;
    if (!verifyPassword(update.currentPassword, currentHash)) {
      return sendJson(res, 401, { error: { message: 'Current password is incorrect.' } });
    }
  }

  const dataStore = await dataStorePromise;
  const userId = getUserId(session.user);
  await dataStore.updateUserProfile(
    userId,
    update.nickname,
    update.avatar
  );

  if (update.newPassword) {
    await dataStore.updateUserPassword(userId, hashPassword(update.newPassword));
  }

  const updatedUser = await dataStore.getUserById(userId);
  sendJson(res, 200, {
    ok: true,
    user: buildPublicUser(updatedUser || {
      ...session.user,
      nickname: update.nickname,
      avatar: update.avatar,
    }),
  });
}

function buildResponseSchema() {
  return {
    type: 'OBJECT',
    properties: {
      flashcards: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            term: { type: 'STRING' },
            definition: { type: 'STRING' },
            definitionTr: { type: 'STRING' },
            page: { type: 'NUMBER' },
          },
          required: ['term', 'definition', 'definitionTr', 'page'],
        },
      },
      quiz: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            type: { type: 'STRING' },
            question: { type: 'STRING' },
            choices: {
              type: 'ARRAY',
              items: { type: 'STRING' },
            },
            answer: { type: 'STRING' },
            explanation: { type: 'STRING' },
          },
          required: ['type', 'question', 'answer', 'explanation'],
        },
      },
    },
    required: ['flashcards', 'quiz'],
  };
}

function buildPrompt(text, pages, pagePlan, fcCount, qqCount, choiceCount, qTypes) {
  const quizExcerpt = text.slice(0, 24000);
  const selectedPages = pagePlan
    .filter(item => item.count > 0)
    .map(item => ({
      pageNumber: item.pageNumber,
      count: item.count,
      text: pages.find(page => page.pageNumber === item.pageNumber)?.text || '',
    }));
  const pageBudget = Math.max(400, Math.floor(42000 / Math.max(selectedPages.length, 1)));
  const pagePlanText = selectedPages
    .map(page => `- Page ${page.pageNumber}: ${page.count} flashcard${page.count === 1 ? '' : 's'}`)
    .join('\n');
  const pageText = selectedPages
    .map(page => `[Page ${page.pageNumber} | ${page.count} flashcard${page.count === 1 ? '' : 's'}]\n${page.text.slice(0, pageBudget)}`)
    .join('\n\n');

  let qTypeInstructions = '';
  if (qTypes === 'mcq') {
    qTypeInstructions = `All questions must be type "mcq" with exactly ${choiceCount} choices.`;
  } else if (qTypes === 'fill') {
    qTypeInstructions = 'All questions must be type "fill" (fill-in-the-blank). No choices needed.';
  } else {
    qTypeInstructions = `Mix question types: about 70% "mcq" with exactly ${choiceCount} choices, and 30% "fill" (fill-in-the-blank, no choices needed).`;
  }
  return `You are a study tool. Analyze the following educational text and generate study materials.

Return ONLY valid JSON with no markdown, no explanation, no backticks.

Format:
{
  "flashcards": [
    { "term": "...", "definition": "...", "definitionTr": "...", "page": 12 }
  ],
  "quiz": [
    { "type": "mcq", "question": "...", "choices": ["A","B","C","D"], "answer": "A", "explanation": "..." },
    { "type": "fill", "question": "The capital of France is ___.", "answer": "Paris", "explanation": "..." }
  ]
}

Rules:
- Generate exactly ${fcCount} flashcards.
- Flashcards must follow the PAGE PLAN exactly.
- Each flashcard must be grounded in the text of its own page only.
- Use quality mode: if a page has weak or low-information text, it is acceptable for that page to have 0 flashcards unless it appears in the PAGE PLAN.
- Each flashcard must include a numeric "page" field matching the source page.
- Each flashcard must include:
  - "definition": a clear English explanation
  - "definitionTr": a natural Turkish explanation of the same concept
- Terms should be key concepts. Definitions should be clear and useful.
- Generate exactly ${qqCount} quiz questions.
- ${qTypeInstructions}
- For MCQ: "answer" field must match one of the choices exactly.
- For fill: the answer should be a short word or phrase.
- Questions should test genuine understanding, not just recall.
- Explanations should be 1-2 sentences explaining why the answer is correct.

PAGE PLAN:
${pagePlanText}

PAGE EXCERPTS FOR FLASHCARDS:
${pageText}

DOCUMENT EXCERPT FOR QUIZ:
${quizExcerpt}`;
}

function normalizePages(rawPages, fallbackText) {
  if (!Array.isArray(rawPages) || !rawPages.length) {
    return [{
      pageNumber: 1,
      text: String(fallbackText || '').trim(),
    }];
  }

  return rawPages
    .map((page, index) => ({
      pageNumber: clampInteger(page?.pageNumber ?? index + 1, 1, 100000),
      text: String(page?.text || '').trim(),
    }))
    .filter(page => page.text);
}

function allocateFlashcardsByPage(pages, fcCount) {
  const scoredPages = pages
    .map(page => ({
      pageNumber: page.pageNumber,
      score: scorePage(page.text),
    }))
    .filter(page => page.score > 0);

  const candidates = scoredPages.length ? scoredPages : pages.map(page => ({
    pageNumber: page.pageNumber,
    score: Math.max(1, Math.ceil(page.text.length / 200)),
  }));

  candidates.sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber);

  const counts = new Map();
  const baseSlots = Math.min(fcCount, candidates.length);
  for (let i = 0; i < baseSlots; i++) {
    counts.set(candidates[i].pageNumber, 1);
  }

  let remaining = fcCount - baseSlots;
  while (remaining > 0 && candidates.length) {
    let best = candidates[0];
    let bestPriority = -Infinity;

    for (const candidate of candidates) {
      const currentCount = counts.get(candidate.pageNumber) || 0;
      const priority = candidate.score / (currentCount + 1);
      if (priority > bestPriority) {
        bestPriority = priority;
        best = candidate;
      }
    }

    counts.set(best.pageNumber, (counts.get(best.pageNumber) || 0) + 1);
    remaining--;
  }

  return Array.from(counts.entries())
    .map(([pageNumber, count]) => ({ pageNumber, count }))
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

function scorePage(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 20) return 0;

  const importantWords = words.filter(word => word.length >= 4 && !STOP_WORDS.has(word));
  const uniqueWords = new Set(importantWords);
  return uniqueWords.size + Math.min(importantWords.length, 250) / 10;
}

function serveStatic(requestPath, res, headOnly) {
  const safePath = requestPath === '/' ? '/index.html' : requestPath;
  const resolvedPath = path.normalize(path.join(STATIC_DIR, safePath));
  if (!resolvedPath.startsWith(STATIC_DIR)) {
    return sendText(res, 403, 'Forbidden');
  }

  fs.readFile(resolvedPath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        return sendText(res, 404, 'Not found');
      }
      return sendText(res, 500, 'Internal server error');
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    });

    if (headOnly) {
      return res.end();
    }

    res.end(content);
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_REQUEST_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function clampInteger(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'between',
  'both', 'could', 'does', 'each', 'from', 'have', 'into', 'more', 'most', 'other',
  'over', 'same', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there',
  'these', 'they', 'this', 'those', 'through', 'under', 'very', 'what', 'when',
  'where', 'which', 'while', 'with', 'would', 'your',
]);

function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const file = fs.readFileSync(envPath, 'utf8');
  for (const line of file.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function initDataStore() {
  if (DATABASE_URL) {
    return initPostgresStore();
  }
  return initSqliteStore();
}

async function initSqliteStore() {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(SYNC_DB_PATH), { recursive: true });
  const database = new DatabaseSync(SYNC_DB_PATH);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS deck_sync_profiles (
      sync_hash TEXT PRIMARY KEY,
      decks_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      nickname TEXT,
      avatar TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      decks_json TEXT NOT NULL DEFAULT '{}',
      decks_updated_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  return {
    backend: 'sqlite',
    async getSyncProfile(syncHash) {
      const row = database.prepare('SELECT decks_json, updated_at FROM deck_sync_profiles WHERE sync_hash = ?').get(syncHash);
      return row ? { ...row, updated_at: Number(row.updated_at) } : null;
    },
    async putSyncProfile(syncHash, decksJson, updatedAt) {
      database.prepare(`
        INSERT INTO deck_sync_profiles (sync_hash, decks_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(sync_hash) DO UPDATE SET
          decks_json = excluded.decks_json,
          updated_at = excluded.updated_at
      `).run(syncHash, decksJson, updatedAt);
    },
    async findUserByUsername(username) {
      return database.prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
    },
    async getUserById(userId) {
      return database.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) || null;
    },
    async createUser(user) {
      database.prepare(`
        INSERT INTO users (
          user_id, username, first_name, last_name, nickname, avatar,
          password_hash, decks_json, decks_updated_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.userId,
        user.username,
        user.firstName,
        user.lastName,
        user.nickname,
        user.avatar,
        user.passwordHash,
        user.decksJson,
        user.decksUpdatedAt,
        user.createdAt
      );
    },
    async createSession(sessionToken, userId, expiresAt) {
      database.prepare(`
        INSERT INTO user_sessions (session_token, user_id, expires_at)
        VALUES (?, ?, ?)
      `).run(sessionToken, userId, expiresAt);
    },
    async getSessionUser(sessionToken) {
      const row = database.prepare(`
        SELECT u.*
        FROM user_sessions s
        JOIN users u ON u.user_id = s.user_id
        WHERE s.session_token = ? AND s.expires_at > ?
      `).get(sessionToken, Date.now());
      return row || null;
    },
    async deleteSession(sessionToken) {
      database.prepare('DELETE FROM user_sessions WHERE session_token = ?').run(sessionToken);
    },
    async getUserDecks(userId) {
      const row = database.prepare('SELECT decks_json, decks_updated_at AS updated_at FROM users WHERE user_id = ?').get(userId);
      return row ? { ...row, updated_at: Number(row.updated_at) } : null;
    },
    async putUserDecks(userId, decksJson, updatedAt) {
      database.prepare(`
        UPDATE users
        SET decks_json = ?, decks_updated_at = ?
        WHERE user_id = ?
      `).run(decksJson, updatedAt, userId);
    },
    async updateUserProfile(userId, nickname, avatar) {
      database.prepare(`
        UPDATE users
        SET nickname = ?, avatar = ?
        WHERE user_id = ?
      `).run(nickname, avatar, userId);
    },
    async updateUserPassword(userId, passwordHash) {
      database.prepare(`
        UPDATE users
        SET password_hash = ?
        WHERE user_id = ?
      `).run(passwordHash, userId);
    },
  };
}

async function initPostgresStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 5,
    ssl: shouldUseDatabaseSsl() ? { rejectUnauthorized: false } : false,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS deck_sync_profiles (
      sync_hash TEXT PRIMARY KEY,
      decks_json TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      nickname TEXT,
      avatar TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      decks_json TEXT NOT NULL DEFAULT '{}',
      decks_updated_at BIGINT NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      session_token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL
    )
  `);

  return {
    backend: 'postgres',
    async getSyncProfile(syncHash) {
      const result = await pool.query(
        'SELECT decks_json, updated_at FROM deck_sync_profiles WHERE sync_hash = $1',
        [syncHash]
      );
      const row = result.rows[0];
      return row ? { ...row, updated_at: Number(row.updated_at) } : null;
    },
    async putSyncProfile(syncHash, decksJson, updatedAt) {
      await pool.query(`
        INSERT INTO deck_sync_profiles (sync_hash, decks_json, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT(sync_hash) DO UPDATE SET
          decks_json = excluded.decks_json,
          updated_at = excluded.updated_at
      `, [syncHash, decksJson, updatedAt]);
    },
    async findUserByUsername(username) {
      const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      return result.rows[0] || null;
    },
    async getUserById(userId) {
      const result = await pool.query('SELECT * FROM users WHERE user_id = $1', [userId]);
      return result.rows[0] || null;
    },
    async createUser(user) {
      await pool.query(`
        INSERT INTO users (
          user_id, username, first_name, last_name, nickname, avatar,
          password_hash, decks_json, decks_updated_at, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        user.userId,
        user.username,
        user.firstName,
        user.lastName,
        user.nickname,
        user.avatar,
        user.passwordHash,
        user.decksJson,
        user.decksUpdatedAt,
        user.createdAt,
      ]);
    },
    async createSession(sessionToken, userId, expiresAt) {
      await pool.query(`
        INSERT INTO user_sessions (session_token, user_id, expires_at)
        VALUES ($1, $2, $3)
      `, [sessionToken, userId, expiresAt]);
    },
    async getSessionUser(sessionToken) {
      const result = await pool.query(`
        SELECT u.*
        FROM user_sessions s
        JOIN users u ON u.user_id = s.user_id
        WHERE s.session_token = $1 AND s.expires_at > $2
      `, [sessionToken, Date.now()]);
      return result.rows[0] || null;
    },
    async deleteSession(sessionToken) {
      await pool.query('DELETE FROM user_sessions WHERE session_token = $1', [sessionToken]);
    },
    async getUserDecks(userId) {
      const result = await pool.query(
        'SELECT decks_json, decks_updated_at AS updated_at FROM users WHERE user_id = $1',
        [userId]
      );
      const row = result.rows[0];
      return row ? { ...row, updated_at: Number(row.updated_at) } : null;
    },
    async putUserDecks(userId, decksJson, updatedAt) {
      await pool.query(`
        UPDATE users
        SET decks_json = $1, decks_updated_at = $2
        WHERE user_id = $3
      `, [decksJson, updatedAt, userId]);
    },
    async updateUserProfile(userId, nickname, avatar) {
      await pool.query(`
        UPDATE users
        SET nickname = $1, avatar = $2
        WHERE user_id = $3
      `, [nickname, avatar, userId]);
    },
    async updateUserPassword(userId, passwordHash) {
      await pool.query(`
        UPDATE users
        SET password_hash = $1
        WHERE user_id = $2
      `, [passwordHash, userId]);
    },
  };
}

function shouldUseDatabaseSsl() {
  const value = String(process.env.DATABASE_SSL || '').toLowerCase();
  return value === 'true' || value === '1';
}

function hashSyncKey(syncKey) {
  return crypto.createHash('sha256').update(syncKey).digest('hex');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const attempted = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (attempted.length !== expected.length) return false;
  return crypto.timingSafeEqual(attempted, expected);
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeUserPayload(body) {
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const username = normalizeUsername(body.username);
  const nickname = String(body.nickname || '').trim();
  const avatar = normalizeAvatarValue(body.avatar);
  const password = String(body.password || '');

  if (!firstName || !lastName) return { ok: false, message: 'Name and surname are required.' };
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return { ok: false, message: 'Username must be 3-24 characters and use only lowercase letters, numbers, or underscores.' };
  if (nickname.length > 32) return { ok: false, message: 'Nickname must be 32 characters or fewer.' };
  if (password.length < 6) return { ok: false, message: 'Password must be at least 6 characters.' };
  if (!avatar) return { ok: false, message: 'Choose a profile icon.' };

  return {
    ok: true,
    firstName,
    lastName,
    username,
    nickname,
    avatar,
    password,
  };
}

function normalizeProfileUpdatePayload(body) {
  const nickname = String(body.nickname || '').trim();
  const avatar = normalizeAvatarValue(body.avatar);
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');

  if (nickname.length > 32) {
    return { ok: false, message: 'Nickname must be 32 characters or fewer.' };
  }
  if (!avatar) {
    return { ok: false, message: 'Choose a profile icon or photo.' };
  }
  if (newPassword) {
    if (!currentPassword) {
      return { ok: false, message: 'Current password is required to set a new password.' };
    }
    if (newPassword.length < 6) {
      return { ok: false, message: 'New password must be at least 6 characters.' };
    }
  }

  return {
    ok: true,
    nickname,
    avatar,
    currentPassword,
    newPassword,
  };
}

function normalizeAvatarValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (isSafeImageDataUrl(raw)) return raw;
  if (raw.length > 16) return '';
  return raw;
}

function isSafeImageDataUrl(value) {
  return /^data:image\/(?:png|jpeg|jpg|webp|gif|heif|heic);base64,[a-z0-9+/=]+$/i.test(value) && value.length <= 7500000;
}

function buildPublicUser(user) {
  const firstName = user.first_name || user.firstName;
  const lastName = user.last_name || user.lastName;
  const nickname = user.nickname || '';
  return {
    userId: getUserId(user),
    username: user.username,
    firstName,
    lastName,
    nickname,
    avatar: user.avatar,
    displayName: nickname || `${firstName} ${lastName}`.trim(),
  };
}

function getUserId(user) {
  return user?.user_id || user?.userId || '';
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

async function createSessionForUser(dataStore, userId) {
  const sessionToken = randomId('sess');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await dataStore.createSession(sessionToken, userId, expiresAt);
  return { sessionToken, expiresAt };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const [rawKey, ...rest] = part.trim().split('=');
    if (!rawKey) continue;
    cookies[rawKey] = decodeURIComponent(rest.join('=') || '');
  }
  return cookies;
}

async function requireOptionalSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const dataStore = await dataStorePromise;
  const user = await dataStore.getSessionUser(token);
  if (!user) return null;
  return { token, user };
}

function buildSessionCookie(sessionToken, expiresAt) {
  return `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function normalizeUpdatedAt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasRemoteDeckData(row) {
  return Number(row?.updated_at || 0) > 0;
}

function sanitizeDecksPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input;
}
