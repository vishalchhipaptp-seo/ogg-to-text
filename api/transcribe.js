/**
 * POST /api/transcribe
 * Body  : raw audio binary
 * Header: Content-Type: audio/ogg (or audio/mpeg etc.)
 *
 * Strategy:
 *  1. Try Hugging Face Inference API (free, fast for short clips)
 *  2. Fall back to AssemblyAI (free 100 h/month, handles longer files)
 *
 * Env vars (set in Vercel dashboard → Settings → Environment Variables):
 *  HF_TOKEN       — Hugging Face token (free at huggingface.co/settings/tokens)
 *  ASSEMBLYAI_KEY — AssemblyAI API key (free at assemblyai.com)
 */

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

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

// ── Hugging Face Inference API ────────────────────────────────────────────────
async function hfTranscribe(buf, contentType, token) {
  const attempt = async () => fetch(
    'https://api-inference.huggingface.co/models/openai/whisper-large-v3',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: buf,
      signal: AbortSignal.timeout(30_000),
    }
  );

  let res = await attempt();

  // Model cold-start: wait the estimated time then retry once
  if (res.status === 503) {
    const meta = await res.json().catch(() => ({}));
    const wait = Math.min((meta.estimated_time || 20) * 1000, 25_000);
    await new Promise(r => setTimeout(r, wait));
    res = await attempt();
  }

  if (!res.ok) throw new Error(`HF ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  if (!data.text) throw new Error('HF returned empty transcript');
  return data.text.trim();
}

// ── AssemblyAI ────────────────────────────────────────────────────────────────
async function aaiTranscribe(buf, key) {
  // 1. Upload audio
  const up = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/octet-stream' },
    body: buf,
  });
  if (!up.ok) throw new Error(`AAI upload failed: ${up.status}`);
  const { upload_url } = await up.json();

  // 2. Request transcript
  const tx = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ audio_url: upload_url, language_code: 'en_us' }),
  });
  if (!tx.ok) throw new Error(`AAI transcript request failed: ${tx.status}`);
  const { id } = await tx.json();

  // 3. Poll until done (up to 55 s — stays within 60 s Vercel limit)
  const deadline = Date.now() + 55_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2_500));
    const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: key },
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
  const hfToken  = process.env.HF_TOKEN;
  const aaiKey   = process.env.ASSEMBLYAI_KEY;

  // Try HF first
  if (hfToken) {
    try {
      const text = await hfTranscribe(buf, contentType, hfToken);
      return res.json({ text, provider: 'huggingface' });
    } catch (err) {
      console.error('[HF] failed, falling back to AssemblyAI:', err.message);
    }
  }

  // Fall back to AssemblyAI
  if (aaiKey) {
    try {
      const text = await aaiTranscribe(buf, aaiKey);
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
  api: {
    bodyParser: false,   // we read the raw stream above
    responseLimit: '10mb',
  },
};
