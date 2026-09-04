# OGG to Text - Free AI Transcription

A free, private OGG audio transcription tool powered by OpenAI Whisper running entirely in the browser. No API keys, no server, no data upload.

## Features

- Drag & drop OGG file upload
- Whisper AI runs in-browser via WebAssembly (no data leaves your device)
- 100% free, no signup, no API key
- Copy or download transcript as .txt
- Model cached after first download

## Deploy to Vercel

### Option 1 - Vercel CLI
```bash
npm i -g vercel
cd ogg-to-text
vercel
```

### Option 2 - Vercel Dashboard
1. Go to [vercel.com](https://vercel.com) and log in
2. Click **Add New > Project**
3. Drag the `ogg-to-text` folder into the import area
4. Click **Deploy**

The `vercel.json` sets the required COOP/COEP headers for SharedArrayBuffer (needed by WebAssembly).

## Tech Stack

- Plain HTML + Tailwind CSS (CDN)
- [@xenova/transformers](https://github.com/xenova/transformers.js) - Whisper in the browser
- Model: `Xenova/whisper-small.en` (~100MB, cached after first use)

## Notes

- First transcription downloads the model (~100MB). Subsequent runs use the browser cache.
- Works best with clear English speech.
- For large files (>10 min), transcription may take a few minutes depending on device speed.
