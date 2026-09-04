# OGG to Text — Free AI Transcription

A free, English-only OGG audio transcription tool. Upload your files and get a text transcript — no account, no signup, no credit card.

## How it works

1. You drop or select one or more OGG files (total under 25 MB).
2. The browser POSTs each file to a Vercel serverless function (`/api/transcribe`).
3. The function tries **Hugging Face Inference API** (Whisper large-v3) first, then falls back to **AssemblyAI** if HF fails.
4. The transcript appears in the panel — copy or download as `.txt`.

## Features

- Multi-file queue: select multiple OGG files at once (total under 25 MB)
- Per-file status badges (Queued / Processing / Done / Error)
- Persistent transcript panel with Copy and Download .txt buttons
- Dark mode support
- Free to host on Vercel's Hobby tier

## Deploy to Vercel

### Step 1 — Set environment variables in Vercel dashboard

Go to your project → **Settings** → **Environment Variables** and add:

| Name | Value | Where to get it |
|------|-------|-----------------|
| `HF_TOKEN` | Your HF token | [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens) (free account, read token) |
| `ASSEMBLYAI_KEY` | Your AAI key | [assemblyai.com](https://assemblyai.com) (free, 100 h/month) |

You only need one key to work. With both, HF is tried first and AAI is the fallback.

### Step 2 — Connect GitHub and deploy

1. Go to [vercel.com](https://vercel.com) and log in.
2. Click **Add New > Project** and import `ogg-to-text` from GitHub.
3. Leave all settings at defaults and click **Deploy**.

Every push to `main` auto-deploys.

### Option B — Vercel CLI

```bash
npm i -g vercel
cd ogg-to-text
vercel env add HF_TOKEN
vercel env add ASSEMBLYAI_KEY
vercel --prod
```

## Tech stack

- Plain HTML + vanilla JS (no build step)
- Vercel serverless function (`api/transcribe.js`, Node 18+)
- [Hugging Face Inference API](https://huggingface.co/openai/whisper-large-v3) — Whisper large-v3
- [AssemblyAI](https://assemblyai.com) — fallback, free tier 100 h/month
- Google Fonts: Syne + DM Sans + DM Mono

## Notes

- HF cold-start: the Whisper model can take ~20 s to wake up after a period of inactivity. Subsequent requests are fast.
- AssemblyAI uploads the audio to their servers for async transcription; results arrive in ~10-30 s depending on file length.
- The Vercel function timeout is set to 60 s (`vercel.json`). Very long recordings may need chunking.
- No data is stored by this tool. Audio is processed and discarded by HF/AAI after transcription.
