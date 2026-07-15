/**
 * Vercel Serverless — proxy Gemini Vision (key chỉ ở env server).
 * POST { imageBase64, mimeType? } → { rows: [...] }
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

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

// Simple in-memory rate limit (best-effort per instance)
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
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
  const i = s.indexOf(',');
  if (s.startsWith('data:') && i >= 0) return s.slice(i + 1);
  return s;
}

function normalizeRows(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    let item = String(o.item || o.gradeItem || o.name || '').replace(/\s+/g, ' ').trim();
    if (!item || item.length < 2) continue;
    if (/^grade\s*(category|item)$/i.test(item)) continue;
    if (/^(weight|value|comment)$/i.test(item)) continue;
    if (/course\s*total|status|studying|^average$/i.test(item)) continue;

    let weight = Number(o.weight != null ? o.weight : o.Weight);
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

async function callGemini(imageBase64, mimeType, apiKey) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) +
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
    headers: { 'Content-Type': 'application/json' },
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
  if (!text) throw new Error('Empty model response');
  return parseModelJson(text);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ip = clientIp(req);
  if (!rateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server missing GEMINI_API_KEY' });
  }

  try {
    const { imageBase64, mimeType } = req.body || {};
    const b64 = stripDataUrl(imageBase64);
    if (!b64 || b64.length < 100) {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    // rough size guard (~4MB base64)
    if (b64.length > 5_500_000) {
      return res.status(413).json({ error: 'Image too large' });
    }

    const rows = await callGemini(b64, mimeType || 'image/jpeg', apiKey);
    if (!rows.length) {
      return res.status(422).json({ error: 'Could not parse grade table from image', rows: [] });
    }
    return res.status(200).json({ rows, model: GEMINI_MODEL });
  } catch (e) {
    console.error('[parse-grade]', e);
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    return res.status(status).json({
      error: e.message || 'Gemini request failed',
    });
  }
};
