/**
 * POST /api/transcribe
 * Body  : raw audio binary
 * Header: Content-Type: audio/ogg (or audio/mpeg etc.)
 *
 * Strategy (first key that succeeds wins):
 *  1. Groq   — fastest, handles Hindi/English code-switching correctly
 *  2. HF     — Hugging Face Inference API (Whisper large-v3-turbo)
 *  3. AAI    — AssemblyAI fallback
 *
 * Env vars (set in Vercel dashboard → Settings → Environment Variables):
 *  GROQ_TOKEN     — Groq API key (free at console.groq.com)
 *  HF_TOKEN       — Hugging Face token (free at huggingface.co/settings/tokens)
 *  ASSEMBLYAI_KEY — AssemblyAI API key (free at assemblyai.com)
 */

const MAX_BYTES    = 25 * 1024 * 1024; // 25 MB
const TOTAL_BUDGET = 55_000;           // ms — stay inside the 60 s Vercel limit

// Read raw request body as a Buffer
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_BYTES) { req.destroy(); return reject(new Error('File exceeds 25 MB')); }
      chunks.push(chunk);
    });
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Groq Whisper API ──────────────────────────────────────────────────────────
// Groq runs Whisper with correct Hindi/English code-switching (keeps each word
// in its original script). Sub-2s for short clips on their free tier.
async function groqTranscribe(buf, contentType, token) {
  const ext = contentType.split('/')[1]?.split(';')[0] || 'ogg';
  const filename = `audio.${ext}`;

  // Groq requires multipart/form-data
  const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
  const CRLF = '\r\n';
  const header =
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${contentType}${CRLF}${CRLF}`;
  const middle =
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
    `whisper-large-v3` +
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
    `json` +
    `${CRLF}--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="task"${CRLF}${CRLF}` +
    `transcribe` +
    `${CRLF}--${boundary}--${CRLF}`;

  const body = Buffer.concat([
    Buffer.from(header, 'utf8'),
    buf,
    Buffer.from(middle, 'utf8'),
  ]);

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
    signal: AbortSignal.timeout(25_000),
  });

  if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (!data.text) throw new Error('Groq returned empty transcript');
  return data.text.trim();
}

// ── Hugging Face Inference API ────────────────────────────────────────────────
// deadline: absolute ms timestamp — we must return (or throw) before then
async function hfTranscribe(buf, contentType, token, deadline) {
  const remaining = () => Math.max(0, deadline - Date.now());

  const attempt = () => fetch(
    'https://api-inference.huggingface.co/models/openai/whisper-large-v3',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: buf,
      signal: AbortSignal.timeout(Math.min(remaining(), 20_000)),
    }
  );

  let res = await attempt();

  // Model cold-start: wait a capped time then retry once
  if (res.status === 503) {
    const meta = await res.json().catch(() => ({}));
    const want = (meta.estimated_time || 15) * 1000;
    const wait = Math.min(want, 10_000, remaining() - 5_000);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (remaining() < 3_000) throw new Error('HF cold-start exhausted time budget');
    res = await attempt();
  }

  if (!res.ok) throw new Error(`HF ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (!data.text) throw new Error('HF returned empty transcript');
  return data.text.trim();
}

// ── AssemblyAI ────────────────────────────────────────────────────────────────
// deadline: absolute ms timestamp shared with the handler
async function aaiTranscribe(buf, key, deadline) {
  // 1. Upload audio
  const up = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/octet-stream' },
    body: buf,
    signal: AbortSignal.timeout(15_000),
  });
  if (!up.ok) throw new Error(`AAI upload failed: ${up.status}`);
  const { upload_url } = await up.json();

  // 2. Request transcript
  const tx = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!tx.ok) throw new Error(`AAI transcript request failed: ${tx.status}`);
  const { id } = await tx.json();

  // 3. Poll until done — respect the shared deadline
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2_000));
    if (Date.now() >= deadline) break;
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: key },
      signal: AbortSignal.timeout(8_000),
    });
    const result = await poll.json();
    if (result.status === 'completed') return result.text.trim();
    if (result.status === 'error')     throw new Error(result.error || 'AAI transcription error');
  }
  throw new Error('Transcription timed out — try a shorter recording');
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let buf;
  try {
    buf = await readBody(req);
  } catch (err) {
    return res.status(413).json({ error: err.message });
  }

  if (!buf.length) return res.status(400).json({ error: 'Empty file' });

  const contentType = req.headers['content-type'] || 'audio/ogg';
  const groqToken = process.env.GROQ_TOKEN;
  const hfToken   = process.env.HF_TOKEN;
  const aaiKey    = process.env.ASSEMBLYAI_KEY;

  // Shared deadline: 55 s from now, leaving 5 s margin before Vercel's 60 s cut-off
  const deadline = Date.now() + TOTAL_BUDGET;

  // 1. Try Groq first — fastest, best code-switching support
  if (groqToken) {
    try {
      const text = await groqTranscribe(buf, contentType, groqToken);
      return res.json({ text, provider: 'groq' });
    } catch (err) {
      console.error('[Groq] failed, trying HF:', err.message);
    }
  }

  // 2. Try HF — give it at most 25 s so AAI always has a fair slice
  if (hfToken) {
    const hfDeadline = Math.min(deadline, Date.now() + 25_000);
    try {
      const text = await hfTranscribe(buf, contentType, hfToken, hfDeadline);
      return res.json({ text, provider: 'huggingface' });
    } catch (err) {
      console.error('[HF] failed, trying AssemblyAI:', err.message);
    }
  }

  // 3. Fall back to AssemblyAI
  if (aaiKey) {
    try {
      const text = await aaiTranscribe(buf, aaiKey, deadline);
      return res.json({ text, provider: 'assemblyai' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(500).json({
    error: 'No API keys configured. Add GROQ_TOKEN, HF_TOKEN, or ASSEMBLYAI_KEY in Vercel → Settings → Environment Variables.',
  });
};

module.exports.config = {
  api: {
    bodyParser: false,   // we read the raw stream above
    responseLimit: '10mb',
  },
};
