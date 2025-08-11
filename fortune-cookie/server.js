// Minimal Node.js + Express backend (CommonJS)
// Adds AI endpoint with daily per-user limit based on user's local date
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const crypto = require('crypto');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a proxy (Render) so req.ip works consistently
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());

// ---------------- Deterministic endpoint (your original) ----------------
const fortunes = [
  "A small step today becomes a milestone tomorrow.",
  "Your curiosity is your superpower.",
  "Luck favors the prepared mind.",
  "A door closes; a better one slides open."
];

function hashString(s){
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}
function getTodayDate(tz){
  try{
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  }catch{
    return new Intl.DateTimeFormat('en-CA', { year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  }
}

app.get('/api/fortune', (req, res) => {
  const ua = req.get('user-agent') || '';
  const ip = req.ip || '';
  const tz = req.query.tz || 'UTC';

  const today = getTodayDate(tz);
  const seed = `${today}|${ip}|${ua}`;
  const idx = hashString(seed) % fortunes.length;

  let secondsUntilNext = 0;
  try{
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    const next = new Date(local); next.setHours(24,0,0,0);
    secondsUntilNext = Math.max(0, Math.floor((next - local)/1000));
  }catch{
    const now = new Date();
    const next = new Date(now); next.setHours(24,0,0,0);
    secondsUntilNext = Math.max(0, Math.floor((next - now)/1000));
  }

  res.json({ fortune: fortunes[idx], secondsUntilNext, source: 'classic' });
});

// ---------------- AI endpoint with daily cache & diagnostics ----------------
const aiCache = new Map(); // key -> { fortune, expiresAt }

function getOrSetUserId(req, res) {
  const name = 'fcid';
  if (req.cookies && req.cookies[name]) return req.cookies[name];
  const id = crypto.randomBytes(16).toString('hex');
  res.cookie(name, id, { httpOnly: true, sameSite: 'lax', maxAge: 365*24*3600*1000 });
  return id;
}

function formatFortune(text, lines = 2, maxPerLine = 140) {
  const cleaned = String(text || '').replace(/\r/g, '').trim();
  if (!cleaned) return '';
  return cleaned
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, lines)
    .map(s => (s.length > maxPerLine ? s.slice(0, maxPerLine - 1) + '…' : s))
    .join('\n');
}

async function generateWithOpenAI({ lang, lines }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const client = new OpenAI({ apiKey });

  const prompt =
    lang === 'tr'
      ? `İlişki odaklı KISA bir fal yaz. 1-2 satır. Konular: yakınlaşma, iletişim, onarma, ayrılık sonrası iyileşme.
Sıcak, modern, net. Emoji ve klişe yok.`
      : `Write a SHORT, relationship-focused fortune in ${lines} line(s).
Themes: closeness, communication, repair, healing after breakups.
Warm, modern, clear. No emojis. No clichés.`;

  const rsp = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.8,
    max_tokens: 80
  });

  const text = rsp.choices?.[0]?.message?.content || '';
  return text;
}

function ttlMsFromLocalDate(){ return 26 * 3600 * 1000; } // ~26h

app.post('/api/fortune-ai', async (req, res) => {
  const start = Date.now();
  try {
    let { lang = 'en', theme = 'relationship', lines = 2, localDate } = req.body || {};
    lang = (lang === 'tr' ? 'tr' : 'en');
    lines = Math.min(Math.max(parseInt(lines, 10) || 1, 1), 2);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate || '')) {
      console.warn('[AI] 400 missing/invalid localDate');
      return res.status(400).json({ error: 'localDate (YYYY-MM-DD) is required' });
    }

    const userId = getOrSetUserId(req, res);
    const key = `${userId}:${lang}:${theme}:${lines}:${localDate}`;

    const cached = aiCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      console.log(`[AI] cache hit user=${userId.slice(0,8)} lang=${lang} day=${localDate}`);
      return res.json({ fortune: cached.fortune, cached: true, source: 'cache' });
    }

    const raw = await generateWithOpenAI({ lang, lines });
    const fortune = formatFortune(raw, lines);
    if (!fortune) {
      console.error('[AI] Empty result from OpenAI');
      return res.status(502).json({ error: 'Empty AI result' });
    }

    aiCache.set(key, { fortune, expiresAt: Date.now() + ttlMsFromLocalDate(localDate) });
    console.log(`[AI] generated user=${userId.slice(0,8)} lang=${lang} day=${localDate} in ${Date.now()-start}ms`);
    return res.json({ fortune, source: 'openai' });
  } catch (err) {
    console.error('[/api/fortune-ai] error:', err.message);
    // Graceful fallback: return a simple local line, mark as fallback
    const fallback = (req.body?.lang === 'tr')
      ? 'Bugün açık konuşmak bağınızı onarabilir.'
      : 'Speak plainly today; repair begins there.';
    return res.json({ fortune: fallback, source: 'fallback' });
  }
});

// ---------------- Diagnostics route ----------------
app.get('/api/diag', (req, res) => {
  let openaiPkg = null;
  try { openaiPkg = require('openai/package.json').version; } catch {}
  res.json({
    hasKey: !!process.env.OPENAI_API_KEY,
    node: process.version,
    openaiPkg,
    uptimeSec: Math.round(process.uptime())
  });
});

// ---------------- Static files ----------------
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
