# Lumen — AI Coding Workspace

**Clarity for every line.**

Modern flat minimalist AI-powered IDE on [Cloudflare Workers](https://workers.cloudflare.com/), with Workers AI, GitHub OAuth, and a VS Code–like editor.

Live example: `https://lumen.studiocode.workers.dev/`

---

## Changelog

### 2026-09-05

- Added VS Code-like save workflow: local **Save**, split-screen **Diff**, and commit only saved changes.
- Added multi-file commit support with AI-generated commit messages.
- Added repository search by name, full name, or description.
- Added a dedicated **Reviews** sidebar tab beside Refresh.
- Added public webapp reviews with 1–5 star ratings and comments for anonymous and GitHub users.
- Added review editing with ownership checks and a pencil button for the review owner.
- Added Cloudflare KV persistence through the `REVIEWS` binding.
- Added verified PayPal Pro subscriptions with unlimited app-level neuron access.

---

## Features

| Area | Detail |
|------|--------|
| **Streaming AI** | SSE from Workers AI (`@cf/qwen/qwen2.5-coder-32b-instruct`) — review, fix, create, chat |
| **Editor** | Monaco (VS Code engine), multi-tab, dirty indicator, apply AI output |
| **GitHub** | OAuth **Connect GitHub**, or manual PAT; list repos, file tree, open/edit, commit |
| **GitHub App** | Optional JWT (RS256) + installation token for server-side auth |
| **Git workflow** | Save locally, compare with split-screen diff, commit saved changes, AI commit messages |
| **Codebase RAG (Pro)** | Pro-only repository indexing in Cloudflare Vectorize and semantic context for AI prompts |
| **Multi-file patches** | Commit several saved files atomically through the Git Trees API |
| **AI Terminal** | Translate natural-language Git/CLI requests into reviewable commands without executing them |
| **Repository search** | Search repositories by name, full name, or description |
| **Reviews** | Separate review tab with star ratings, comments, anonymous/GitHub authors, and owner editing |
| **Lumen Pro** | PayPal subscription checkout linked to a GitHub account; bypasses the app quota gate |
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

## Lumen Pro / PayPal

Pro subscriptions are linked to the authenticated GitHub login. The Worker verifies the
PayPal subscription server-side before bypassing the app neuron gate; changing browser
storage or the UI cannot unlock Pro.

Create a PayPal subscription product and plan, then configure the Worker:

```bash
npx wrangler secret put PAYPAL_CLIENT_ID
npx wrangler secret put PAYPAL_CLIENT_SECRET
npx wrangler secret put PAYPAL_PLAN_ID
npx wrangler secret put PAYPAL_MODE       # `sandbox` or `live`; defaults to sandbox
```

`USAGE` KV is required for Pro ownership and subscription state. The Cloudflare account
running Workers AI must also have enough Workers AI capacity: a PayPal subscription
cannot bypass Cloudflare's own account-level free allocation.

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
| `POST` | `/api/multi-commit` | Atomically commit several files in one Git commit |
| `POST` | `/api/repo/index` | Pro-only embedding and indexing of the current repository in Vectorize |
| `POST` | `/api/repo/search` | Pro-only semantic search over indexed repository code |
| `POST` | `/api/create-repo` | Create repository |
| `GET` | `/api/reviews` | List reviews and rating summary |
| `POST` | `/api/reviews` | Create an anonymous or GitHub-authenticated review |
| `PUT` | `/api/reviews/:id` | Edit an owned review |
| `POST` | `/api/pro/subscribe` | Create a PayPal subscription approval URL |
| `POST` | `/api/pro/activate` | Verify and activate an approved subscription |
| `GET` | `/api/pro/status` | Return the current GitHub user's Pro status |
| `POST` | `/api/pro/cancel` | Cancel the authenticated user's PayPal Pro subscription |

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
- **Terminal Command** — produce a reviewable CLI/Git command; the Worker never executes it

### Codebase RAG setup

Create the Vectorize index once, then deploy the Worker:

```bash
npx wrangler vectorize create lumen-codebase --dimensions=768 --metric=cosine
npx wrangler deploy
```

Select a repository and click the database icon in the AI panel to index it. This feature requires an active Lumen Pro subscription. Subsequent AI prompts automatically retrieve relevant indexed chunks for Pro users. Without the `VECTORIZE` binding, normal AI features continue to work.

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
| `PAYPAL_CLIENT_ID` | PayPal REST app client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal REST app secret |
| `PAYPAL_PLAN_ID` | PayPal subscription plan ID |
| `PAYPAL_MODE` | `sandbox` or `live` |

Bindings (wrangler.toml):

- `AI` — Workers AI  
- `ASSETS` — static files from `./public`  
- `REVIEWS` — Cloudflare KV namespace for webapp reviews
- `SESSIONS` — session KV namespace
- `USAGE` — neuron usage and quota KV namespace
- `VECTORIZE` — `lumen-codebase` semantic code index

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
