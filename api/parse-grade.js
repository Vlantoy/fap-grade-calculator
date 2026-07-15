/**
 * Vercel Serverless — POST /api/parse-grade
 * Body: { imageBase64, mimeType? }
 *
 * Env:
 *   GEMINI_API_KEY   — one key
 *   GEMINI_API_KEYS  — optional comma/newline-separated keys (rotation)
 *   GEMINI_MODEL     — default gemini-2.5-flash (free tier still works)
 */

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PROMPT = `You extract FPT University My FAP "Mark Details" grade table from this screenshot.
Return ONLY a JSON array (no markdown). Each element:
{"item":"string","weight":number,"value":number|null,"isTotal":boolean}
Rules:
- item = Grade item name (Assignment 1, Progress test 1, Final Exam, Total, ...)
- weight = percent number without % sign
- value = score 0-10 if Value cell has a number, else null
- isTotal true only for Total rows
- Skip headers and Course total / Average / Status / Studying
- Keep names as shown (English or Vietnamese)
- Include every grade component row with a weight %`;

const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;
let keyCursor = 0;

function getApiKeys() {
  const multi = process.env.GEMINI_API_KEYS || '';
  const single = process.env.GEMINI_API_KEY || '';
  const fromMulti = multi
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromMulti.length) return fromMulti;
  if (single) return [single];
  return [];
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.headers['x-real-ip'] || 'unknown';
}

function rateLimit(ip) {
  const now = Date.now();
  let bucket = hits.get(ip);
  if (!bucket || now - bucket.start > WINDOW_MS) {
    bucket = { start: now, count: 0 };
    hits.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= MAX_PER_WINDOW;
}

function stripDataUrl(b64) {
  if (!b64) return '';
  const s = String(b64);
  const i = s.indexOf('base64,');
  if (i >= 0) return s.slice(i + 7);
  if (s.startsWith('data:')) {
    const j = s.indexOf(',');
    return j >= 0 ? s.slice(j + 1) : s;
  }
  return s;
}

function normalizeRows(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    let item = String(o.item || o.gradeItem || o.name || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!item || item.length < 2) continue;
    if (/^grade\s*(category|item)$/i.test(item)) continue;
    if (/^(weight|value|comment)$/i.test(item)) continue;
    if (/course\s*total|status|studying|^average$/i.test(item)) continue;

    const weight = Number(o.weight != null ? o.weight : o.Weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) continue;

    const isTotal = !!(o.isTotal || /^total$/i.test(item) || /^tổng$/i.test(item));
    if (isTotal) item = 'Total';

    let value = null;
    if (!isTotal && o.value != null && o.value !== '' && String(o.value).toLowerCase() !== 'null') {
      const vv = Number(String(o.value).replace(',', '.'));
      if (Number.isFinite(vv) && vv >= 0 && vv <= 10) {
        value = Math.round(vv * 10) / 10;
      }
    }

    const key = item.toLowerCase() + '|' + weight;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ item, weight, value, isTotal });
  }
  return out;
}

function parseModelJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return normalizeRows(JSON.parse(t));
}

async function callGemini(imageBase64, mimeType, apiKey, model) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) +
    ':generateContent?key=' +
    encodeURIComponent(apiKey);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: PROMPT },
          {
            inline_data: {
              mime_type: mimeType || 'image/jpeg',
              data: imageBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  if (!text) {
    const block =
      data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(block ? `Model blocked: ${block}` : 'Empty model response');
  }
  return parseModelJson(text);
}

async function callWithRotation(imageBase64, mimeType) {
  const keys = getApiKeys();
  if (!keys.length) {
    const err = new Error(
      'Missing GEMINI_API_KEY on Vercel. Settings → Environment Variables → add key → Redeploy.'
    );
    err.status = 500;
    throw err;
  }

  const models = [DEFAULT_MODEL, 'gemini-2.5-flash', 'gemini-2.0-flash'].filter(
    (v, i, a) => a.indexOf(v) === i
  );

  let lastErr = null;
  const maxTries = Math.min(keys.length * models.length, 10);
  for (let t = 0; t < maxTries; t++) {
    const key = keys[keyCursor % keys.length];
    keyCursor += 1;
    const model = models[Math.floor(t / keys.length) % models.length];
    try {
      const rows = await callGemini(imageBase64, mimeType, key, model);
      return { rows, model, keyIndex: (keyCursor - 1) % keys.length };
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || '');
      const retryable =
        e.status === 429 ||
        e.status === 403 ||
        /quota|rate|limit|exceeded|RESOURCE_EXHAUSTED/i.test(msg);
      if (!retryable && e.status !== 500) break;
    }
  }
  throw lastErr || new Error('All Gemini keys/models failed');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    const keys = getApiKeys();
    return res.status(200).json({
      ok: true,
      service: 'parse-grade',
      hasKey: keys.length > 0,
      keyCount: keys.length,
      model: DEFAULT_MODEL,
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!rateLimit(clientIp(req))) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    body = body || {};

    const b64 = stripDataUrl(body.imageBase64 || body.image || '');
    if (!b64 || b64.length < 80) {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    if (b64.length > 6_000_000) {
      return res.status(413).json({ error: 'Image too large (max ~4MB)' });
    }

    const result = await callWithRotation(b64, body.mimeType || 'image/jpeg');
    if (!result.rows.length) {
      return res.status(422).json({
        error: 'Could not parse grade table from image',
        rows: [],
      });
    }
    return res.status(200).json({
      ok: true,
      rows: result.rows,
      model: result.model,
    });
  } catch (e) {
    console.error('[parse-grade]', e);
    const status = e.status >= 400 && e.status < 600 ? e.status : 502;
    return res.status(status).json({
      error: e.message || 'Gemini request failed',
    });
  }
};

module.exports.config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '5mb',
    },
  },
};
