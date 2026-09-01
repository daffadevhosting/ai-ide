# Lumen — AI Coding Workspace

**Clarity for every line.**

Modern flat minimalist AI-powered IDE on [Cloudflare Workers](https://workers.cloudflare.com/), with Workers AI, GitHub OAuth, and a VS Code–like editor.

Live example: `https://lumen.backendku.workers.dev/`

---

## Features

| Area | Detail |
|------|--------|
| **Streaming AI** | SSE from Workers AI (`@cf/meta/llama-3.1-8b-instruct`) — review, fix, create, chat |
| **Editor** | Monaco (VS Code engine), multi-tab, dirty indicator, apply AI output |
| **GitHub** | OAuth **Connect GitHub**, or manual PAT; list repos, file tree, open/edit, commit |
| **GitHub App** | Optional JWT (RS256) + installation token for server-side auth |
| **UI** | Dark/light theme, collapsible sidebar & AI panel, mobile drawers |
| **Dialogs** | Custom alert / confirm / prompt + custom select (no native browser dialogs) |
| **Icons** | Font Awesome 6 + Lumen SVG mark |
| **Commit identity** | Commits attributed to **Lumen** (`lumen@users.noreply.github.com`) |

---

## Brand

| | |
|--|--|
| **Name** | Lumen |
| **Tagline** | Clarity for every line |
| **Logo** | `public/assets/logo.svg` + `favicon.svg` |
| **Tone** | Calm, precise, developer-first |

---

## Project structure

```text
ai-ide/
├── public/
│   ├── index.html          # Shell UI
│   ├── css/styles.css      # Themes + layout
│   ├── js/app.js           # Frontend (Monaco, auth, AI stream)
│   └── assets/             # logo.svg, favicon.svg
├── src/index.ts            # Cloudflare Worker (API + assets)
├── wrangler.toml
├── package.json
└── tsconfig.json
```

---

## Quick start

```bash
cd ai-ide
npm install
npm run dev          # wrangler dev --remote (required for Workers AI)
```

Open the URL printed by Wrangler (usually `http://127.0.0.1:8787`).

---

## Deploy

```bash
npm run deploy
# or: npx wrangler deploy
```

Worker name: **`lumen`**  
Assets: `./public` via `[assets]` binding.

Verify deploy:

```bash
curl https://<your-worker>.workers.dev/api/version
```

---

## GitHub setup

### A. OAuth login (recommended — “Connect GitHub”)

1. Create a **GitHub OAuth App** or enable OAuth on a **GitHub App**.
2. Set:

| Field | Value |
|--------|--------|
| Homepage URL | `https://<your-worker>.workers.dev/` |
| **Authorization callback URL** | `https://<your-worker>.workers.dev/api/auth/github/callback` |

3. Scopes: `repo`, `read:user`
4. Secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

5. Redeploy, then use **Connect GitHub** in the UI.

### B. Personal Access Token (manual)

- UI → **Token** → paste PAT with `repo` scope  
- Stored only in browser `localStorage`  
- Sent as `X-GitHub-Token` on API calls  

### C. GitHub App installation token (server-side)

Optional fallback when no user token is present:

```bash
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_PRIVATE_KEY    # full PEM
npx wrangler secret put GITHUB_INSTALLATION_ID
```

**Token priority:** `X-GitHub-Token` header → `GITHUB_TOKEN` secret → App installation token.

---

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/version` | Build version + feature flags |
| `GET` | `/api/auth/github` | Start OAuth (redirect to GitHub) |
| `GET` | `/api/auth/github/callback` | OAuth callback |
| `GET` | `/api/auth/me` | Current GitHub user |
| `GET` | `/api/auth/status` | Whether OAuth secrets are configured |
| `POST` | `/api/ai` | AI actions (`review` \| `fix` \| `create` \| `chat`), supports `stream: true` |
| `GET` | `/api/repos` | List user repositories |
| `GET` | `/api/tree/:owner/:repo` | Directory listing (`?path=&branch=`) |
| `GET` | `/api/file/:owner/:repo/*` | File content |
| `POST` | `/api/commit` | Create/update file (commit) |
| `POST` | `/api/create-repo` | Create repository |

GitHub routes accept header:

```http
X-GitHub-Token: <token>
```

---

## AI usage

Panel modes:

- **Chat** — general coding help  
- **Review Code** — critique current file / selection  
- **Fix / Edit** — return fixed code in a fenced block  
- **Create Code** — generate new code  

Streaming uses Server-Sent Events (`text/event-stream`).  
**Apply to editor** pastes the first code block into the active tab.

> Workers AI needs `wrangler dev --remote` or a deployed Worker (no local GPU).

---

## Environment / secrets

| Secret | Purpose |
|--------|---------|
| `GITHUB_CLIENT_ID` | OAuth login |
| `GITHUB_CLIENT_SECRET` | OAuth login |
| `GITHUB_TOKEN` | Optional server PAT fallback |
| `GITHUB_APP_ID` | GitHub App JWT |
| `GITHUB_PRIVATE_KEY` | GitHub App private key (PEM) |
| `GITHUB_INSTALLATION_ID` | Installation for app token |

Bindings (wrangler.toml):

- `AI` — Workers AI  
- `ASSETS` — static files from `./public`  

---

## Scripts

```bash
npm run dev          # local + remote AI
npm run deploy       # production
npm run cf-typegen   # generate Env types (optional)
```

---

## License

MIT
