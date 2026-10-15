/**
 * POST /api/transcribe
 * Body  : raw audio binary
 * Header: Content-Type: audio/ogg (or audio/mpeg etc.)
 *
 * Strategy:
 *  1. Hugging Face Inference API (Whisper large-v3)
 *  2. AssemblyAI fallback
 *
 * Env vars:
 *  HF_TOKEN       — Hugging Face token (free at huggingface.co/settings/tokens)
 *  ASSEMBLYAI_KEY — AssemblyAI API key (free at assemblyai.com)
 */

const MAX_BYTES    = 25 * 1024 * 1024;
const TOTAL_BUDGET = 55_000; // ms — stay inside Vercel's 60 s limit

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

// ── Hugging Face ──────────────────────────────────────────────────────────────
async function hfTranscribe(buf, contentType, token, deadline) {
  const remaining = () => Math.max(0, deadline - Date.now());

  const attempt = () => fetch(
    'https://api-inference.huggingface.co/models/openai/whisper-large-v3',
    {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body:    buf,
      signal:  AbortSignal.timeout(Math.min(remaining(), 20_000)),
    }
  );

  let res = await attempt();

  if (res.status === 503) {
    const meta = await res.json().catch(() => ({}));
    const wait = Math.min((meta.estimated_time || 15) * 1000, 10_000, remaining() - 5_000);
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
async function aaiTranscribe(buf, key, deadline) {
  const up = await fetch('https://api.assemblyai.com/v2/upload', {
    method:  'POST',
    headers: { authorization: key, 'content-type': 'application/octet-stream' },
    body:    buf,
    signal:  AbortSignal.timeout(15_000),
  });
  if (!up.ok) throw new Error(`AAI upload failed: ${up.status}`);
  const { upload_url } = await up.json();

  const tx = await fetch('https://api.assemblyai.com/v2/transcript', {
    method:  'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body:    JSON.stringify({ audio_url: upload_url }),
    signal:  AbortSignal.timeout(10_000),
  });
  if (!tx.ok) throw new Error(`AAI transcript request failed: ${tx.status}`);
  const { id } = await tx.json();

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2_000));
    if (Date.now() >= deadline) break;
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: key },
      signal:  AbortSignal.timeout(8_000),
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
  try { buf = await readBody(req); }
  catch (err) { return res.status(413).json({ error: err.message }); }

  if (!buf.length) return res.status(400).json({ error: 'Empty file' });

  const contentType = req.headers['content-type'] || 'audio/ogg';
  const hfToken = process.env.HF_TOKEN;
  const aaiKey  = process.env.ASSEMBLYAI_KEY;
  const deadline = Date.now() + TOTAL_BUDGET;

  // 1. HF — capped at 25 s so AAI always has room
  if (hfToken) {
    const hfDeadline = Math.min(deadline, Date.now() + 25_000);
    try {
      const text = await hfTranscribe(buf, contentType, hfToken, hfDeadline);
      return res.json({ text, provider: 'huggingface' });
    } catch (err) {
      console.error('[HF] failed, falling back to AssemblyAI:', err.message);
    }
  }

  // 2. AssemblyAI
  if (aaiKey) {
    try {
      const text = await aaiTranscribe(buf, aaiKey, deadline);
      return res.json({ text, provider: 'assemblyai' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(500).json({
    error: 'No API keys configured. Add HF_TOKEN and/or ASSEMBLYAI_KEY in Vercel → Settings → Environment Variables.',
  });
};

module.exports.config = {
  api: { bodyParser: false, responseLimit: '10mb' },
};
