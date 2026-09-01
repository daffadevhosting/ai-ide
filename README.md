# AI IDE — Cloudflare Workers AI + GitHub

Modern flat minimalist AI-powered IDE on Cloudflare Workers.

## Features

- **Streaming AI** — SSE streaming from Workers AI (`@cf/meta/llama-3.1-8b-instruct`)
- **Multi-tab editor** — Monaco (VS Code engine), dirty indicator, close tabs
- **Dark / Light theme** — toggle + persisted
- **GitHub App JWT** — full RS256 JWT + installation token exchange (Web Crypto)
- **Lucide icons** throughout the UI
- **Sidebar** — Repos list ↔ file tree of selected repo
- **Commit & push** via GitHub Contents API
- Responsive, flat minimal design

## Quick Start

```bash
cd ai-ide
npm install
npm run dev    # uses --remote for Workers AI
```

### Secrets

```bash
# Option A: PAT (simplest for personal use)
npx wrangler secret put GITHUB_TOKEN

# Option B: GitHub App (recommended for production)
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY   # full PEM including headers
npx wrangler secret put GITHUB_INSTALLATION_ID
```

Token from the UI (`X-GitHub-Token`) always takes priority over Worker secrets.

## API

| Method | Path | Notes |
|--------|------|--------|
| POST | `/api/ai` | `{ action, prompt, code?, stream?: true }` → SSE or JSON |
| GET  | `/api/repos` | List repos |
| GET  | `/api/tree/:owner/:repo` | File tree |
| GET  | `/api/file/:owner/:repo/*` | File content |
| POST | `/api/commit` | Create/update file |
| POST | `/api/create-repo` | New repo |

## Deploy

```bash
npm run deploy
```

## License

MIT
