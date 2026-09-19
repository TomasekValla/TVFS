# TVFS — TomasekValla Filestream System

Self hosted, open source file distribution. No cloud, no compression, no surveillance, no corporation.

`files.tomasekvalla.cz`

[![Vibecoded with Claude](https://img.shields.io/badge/vibecoded%20with-Claude-D97757?style=flat-square)](https://claude.ai) [![Vibecoded with Antigravity](https://img.shields.io/badge/vibecoded%20with-Antigravity-4285F4?style=flat-square)](https://antigravity.google/)

## The idea

Every mainstream file sharing platform quietly recompresses, retranscodes, or reprocesses whatever you upload, and keeps it around long after you're done with it. TVFS does neither. It stores files exactly as uploaded, streams them at full quality, and deletes them on a schedule you choose. The server is hardware you own. The files are yours the whole way through.

Full philosophy and technical writeup: [`whitepaper.pdf`](https://github.com/TomasekValla/TVFS/blob/main/files_web/whitepaper.pdf)

## Features

- **No compression** — files are stored and served byte for byte as uploaded
- **Chunked, resumable uploads** — large files upload in parallel chunks, configurable size, auto resume after a dropped connection, weak connection mode for bad networks
- **Ephemeral by default** — twelve expiration presets from five minutes to fourteen days, auto deletion, nothing archived
- **Batch uploads** — group files into a named batch with a shareable landing page, per file and ZIP download
- **Delta sync** — recently uploaded files sync across your own devices without a full re upload
- **Thumbnails & readers** — AVIF/WebP/JPEG thumbnail pipeline, dedicated readers for text and Markdown with 20 self hosted fonts, lightweight audio player
- **TVFS Users Only sharing** — login gated private sharing mode
- **Tiered login** — hashed passwords, session tokens, per IP rate limiting
- **Cloudflare protected** — AI crawler blocking at the network edge
- **GDPR conscious logging** — monthly request logs, 4 month retention, per file anonymize toggle

## Stack

Node.js / Express backend, vanilla HTML/CSS/JS frontend, Docker deployment, nginx in front.

## Repo scope

This repo tracks the TVFS application itself (`files_backend/` + `files_web/`). Uploaded user data, runtime state, secrets, and unrelated personal projects that happen to live on the same server are intentionally excluded, see `.gitignore`.

## License

Open source. Fork it, self host it, do what you want with it.
