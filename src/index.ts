/**
 * AI IDE - Cloudflare Worker
 * Streaming Workers AI + full GitHub App JWT + Contents API
 */

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  /** Optional KV for daily neuron usage counters */
  USAGE?: KVNamespace;
  GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  /** OAuth App / GitHub App client */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** Daily free neuron budget (default 10000) */
  NEURON_DAILY_LIMIT?: string;
  /** Soft lock threshold (default 9800) — AI blocked when used >= this */
  NEURON_SOFT_LIMIT?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "https://lumen.backendku.workers.dev/",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GitHub-Token",
};

// Heavy model for panel AI (review / fix / create / chat)
// Qwen2.5-Coder-32B: 32k context, LoRA yes. Pricing ~$0.66/M in, $1/M out
const CODE_MODEL = "@cf/openai/gpt-oss-20b";
// Light model for inline ghost-text (neuron-friendly)
const COMPLETE_MODEL = "@cf/mistral/mistral-7b-instruct-v0.2-lora";

// Simple in-memory cache for installation tokens (per isolate)
let cachedInstallToken: { token: string; expiresAt: number } | null = null;

// In-memory neuron day counter (per isolate fallback when KV missing)
let memNeuronDay = "";
let memNeuronUsed = 0;
let memQuotaExhaustedUntil = 0; // unix ms

const DEFAULT_NEURON_LIMIT = 10000;
const DEFAULT_NEURON_SOFT = 9800;

/** Rough neuron cost estimates per action (Cloudflare does not expose live remaining quota via simple API) */
const NEURON_COST: Record<string, number> = {
  complete: 60,
  chat: 450,
  review: 550,
  fix: 550,
  create: 550,
};

function utcDayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

function nextUtcMidnightMs(from = new Date()): number {
  const n = new Date(from);
  n.setUTCDate(n.getUTCDate() + 1);
  n.setUTCHours(0, 0, 0, 0);
  return n.getTime();
}

function neuronLimits(env: Env) {
  const limit = Math.max(1, parseInt(env.NEURON_DAILY_LIMIT || "", 10) || DEFAULT_NEURON_LIMIT);
  const soft = Math.max(1, parseInt(env.NEURON_SOFT_LIMIT || "", 10) || DEFAULT_NEURON_SOFT);
  return { limit, soft: Math.min(soft, limit) };
}

async function getNeuronUsage(env: Env): Promise<{ used: number; day: string }> {
  const day = utcDayKey();
  if (env.USAGE) {
    const raw = await env.USAGE.get(`neurons:${day}`);
    return { used: raw ? parseInt(raw, 10) || 0 : 0, day };
  }
  if (memNeuronDay !== day) {
    memNeuronDay = day;
    memNeuronUsed = 0;
  }
  return { used: memNeuronUsed, day };
}

async function addNeuronUsage(env: Env, amount: number): Promise<number> {
  const day = utcDayKey();
  const add = Math.max(0, Math.round(amount));
  if (env.USAGE) {
    const key = `neurons:${day}`;
    const prev = parseInt((await env.USAGE.get(key)) || "0", 10) || 0;
    const next = prev + add;
    // Expire a bit after next UTC day
    const ttl = Math.ceil((nextUtcMidnightMs() - Date.now()) / 1000) + 3600;
    await env.USAGE.put(key, String(next), { expirationTtl: Math.max(ttl, 3600) });
    return next;
  }
  if (memNeuronDay !== day) {
    memNeuronDay = day;
    memNeuronUsed = 0;
  }
  memNeuronUsed += add;
  return memNeuronUsed;
}

async function markQuotaExhausted(env: Env): Promise<void> {
  const until = nextUtcMidnightMs();
  memQuotaExhaustedUntil = until;
  if (env.USAGE) {
    const ttl = Math.ceil((until - Date.now()) / 1000) + 60;
    await env.USAGE.put("quota_exhausted_until", String(until), {
      expirationTtl: Math.max(ttl, 60),
    });
  }
}

async function isQuotaExhausted(env: Env): Promise<{ exhausted: boolean; until: number }> {
  const now = Date.now();
  if (memQuotaExhaustedUntil > now) {
    return { exhausted: true, until: memQuotaExhaustedUntil };
  }
  if (env.USAGE) {
    const raw = await env.USAGE.get("quota_exhausted_until");
    const until = raw ? parseInt(raw, 10) || 0 : 0;
    if (until > now) {
      memQuotaExhaustedUntil = until;
      return { exhausted: true, until };
    }
  }
  return { exhausted: false, until: nextUtcMidnightMs() };
}

function isCfQuotaError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || "").toLowerCase();
  return (
    msg.includes("10,000 neurons") ||
    msg.includes("10000 neurons") ||
    msg.includes("daily free allocation") ||
    msg.includes("used up your daily") ||
    msg.includes("quota") && msg.includes("neuron") ||
    msg.includes("3036") ||
    msg.includes("4006")
  );
}

async function buildQuotaStatus(env: Env) {
  const { limit, soft } = neuronLimits(env);
  const { used, day } = await getNeuronUsage(env);
  const flag = await isQuotaExhausted(env);
  const remaining = Math.max(0, limit - used);
  const blocked = flag.exhausted || used >= soft;
  const resetAt = flag.exhausted ? flag.until : nextUtcMidnightMs();
  return {
    day,
    used,
    limit,
    softLimit: soft,
    remaining,
    blocked,
    reason: flag.exhausted
      ? "cloudflare_quota"
      : used >= soft
        ? "soft_limit"
        : null,
    resetAt, // unix ms UTC midnight (or exhausted-until)
    resetAtISO: new Date(resetAt).toISOString(),
    tracking: env.USAGE ? "kv" : "memory",
  };
}

function quotaBlockedResponse(status: Awaited<ReturnType<typeof buildQuotaStatus>>) {
  return json(
    {
      error: "AI quota exhausted for today. Service resumes at next UTC midnight.",
      code: "NEURON_QUOTA",
      quota: status,
    },
    429
  );
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function error(message: string, status = 400) {
  return json({ error: message }, status);
}

// ---------- GitHub App JWT (Web Crypto RS256) ----------

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64UrlEncode(data: ArrayBuffer | string): string {
  let str: string;
  if (typeof data === "string") {
    str = btoa(data);
  } else {
    const bytes = new Uint8Array(data);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    str = btoa(binary);
  }
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60, // max 10 min
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;

  const keyData = pemToArrayBuffer(privateKeyPem);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  return `${unsigned}.${base64UrlEncode(signature)}`;
}

async function getInstallationToken(env: Env): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_PRIVATE_KEY || !env.GITHUB_INSTALLATION_ID) {
    return null;
  }

  if (cachedInstallToken && cachedInstallToken.expiresAt > Date.now() + 60_000) {
    return cachedInstallToken.token;
  }

  const jwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);

  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "LUMEN-AI-IDE-Cloudflare-Worker",
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App token exchange failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  cachedInstallToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  return data.token;
}

async function getGitHubToken(env: Env, request: Request): Promise<string | null> {
  const headerToken =
    request.headers.get("X-GitHub-Token") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (headerToken) return headerToken;

  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;

  try {
    return await getInstallationToken(env);
  } catch {
    return null;
  }
}

async function githubFetch(path: string, token: string, options: RequestInit = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "AI-IDE-Cloudflare-Worker",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status}: ${body}`);
  }
  return res;
}

// ---------- AI ----------

function extractAIText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    const text = String(r.response ?? r.content ?? r.result ?? "");
    if (text) return text;
    if (r.reasoning) return String(r.reasoning);
  }
  return String(result ?? "");
}

function cleanCompletion(raw: string): string {
  let t = raw.trim();
  // Strip accidental markdown fences
  const fence = t.match(/^```(?:\w*)\n?([\s\S]*?)```/);
  if (fence) t = fence[1].trimEnd();
  // Model sometimes echoes prompt labels
  t = t.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
  return t;
}

async function handleAI(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    action: "review" | "fix" | "create" | "chat" | "complete";
    code?: string;
    language?: string;
    prompt?: string;
    filename?: string;
    context?: string;
    prefix?: string;
    suffix?: string;
    stream?: boolean;
  };

  // Soft / hard neuron gate (estimate + Cloudflare exhausted flag)
  const quota = await buildQuotaStatus(env);
  if (quota.blocked) {
    return quotaBlockedResponse(quota);
  }

  const cost = NEURON_COST[body.action] || NEURON_COST.chat;

  // ----- Inline completion (light model, non-streaming) -----
  if (body.action === "complete") {
    const language = body.language || "plaintext";
    const prefix = body.prefix ?? body.code ?? "";
    const suffix = body.suffix ?? "";
    const filename = body.filename || "file";

    const messages = [
      {
        role: "system",
        content: `You are a code completion engine inside an IDE.
Continue the code at the cursor. Output ONLY the completion text to insert — no markdown fences, no explanations, no quotes.
Match indentation and style of the existing code. Keep the completion short (1–12 lines) unless a longer block is clearly needed.
Language: ${language}. File: ${filename}.`,
      },
      {
        role: "user",
        content: `PREFIX (code before cursor):\n\`\`\`${language}\n${prefix.slice(-4000)}\n\`\`\`\n\nSUFFIX (code after cursor):\n\`\`\`${language}\n${suffix.slice(0, 1500)}\n\`\`\`\n\nWrite only the code that should be inserted at the cursor.`,
      },
    ];

    try {
      const result = await env.AI.run(COMPLETE_MODEL as any, {
        messages,
        stream: false,
        max_tokens: 256,
        temperature: 0.2,
      });
      await addNeuronUsage(env, cost);
      const text = cleanCompletion(extractAIText(result));
      return json({ result: text, model: COMPLETE_MODEL, quota: await buildQuotaStatus(env) });
    } catch (e: any) {
      if (isCfQuotaError(e)) {
        await markQuotaExhausted(env);
        return quotaBlockedResponse(await buildQuotaStatus(env));
      }
      return error(`AI complete error: ${e.message}`, 500);
    }
  }

  // ----- Panel AI (heavy model) -----
  const systemPrompts: Record<string, string> = {
    review: `You are Lumen, an expert code reviewer inside an IDE.
Review the code for correctness, bugs, security issues, performance, edge cases, and maintainability.
Structure the response as:
1) Summary
2) Issues (severity: critical/major/minor)
3) Suggested fixes (with code snippets in fenced blocks)
Be precise and actionable. Use markdown.`,
    fix: `You are Lumen, an expert programmer inside an IDE.
Apply the user's requested changes or fix obvious bugs in the provided code.
Rules:
- Return the COMPLETE updated file/code in ONE markdown fenced code block with the correct language tag.
- Preserve style and unrelated code unless a change is required.
- Do not wrap the answer in extra commentary outside the code block unless the user asked for an explanation.`,
    create: `You are Lumen, an expert programmer inside an IDE.
Write production-quality code for the user's request.
Rules:
- Prefer clear structure, correct APIs, and minimal dependencies.
- Include necessary imports and brief comments only where helpful.
- Return the main deliverable in a markdown fenced code block with a language tag.
- If multiple files are needed, use separate fenced blocks and label each with a filename comment on the first line.`,
    chat: `You are Lumen, an expert AI coding assistant embedded in an IDE (Qwen2.5-Coder-32B).
Help with coding, debugging, refactors, explanations, and architecture.
When you output code, use markdown fenced blocks with language tags.
Be accurate, concise, and practical.`,
  };

  const system = systemPrompts[body.action] || systemPrompts.chat;

  let userContent = body.prompt || "";
  if (body.code) {
    userContent += `\n\n\`\`\`${body.language || ""}\n${body.code}\n\`\`\``;
  }
  if (body.filename) userContent = `File: ${body.filename}\n\n` + userContent;
  if (body.context) userContent += `\n\nAdditional context:\n${body.context}`;

  const messages = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];

  const wantStream = body.stream !== false;

  const inferenceInput: Record<string, unknown> = {
    messages,
    max_tokens: 8192,
  };

  try {
    if (wantStream) {
      const stream = await env.AI.run(CODE_MODEL as any, {
        ...inferenceInput,
        stream: true,
      });
      await addNeuronUsage(env, cost);

      return new Response(stream as ReadableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Neuron-Cost": String(cost),
          ...CORS_HEADERS,
        },
      });
    }

    const result = await env.AI.run(CODE_MODEL as any, {
      ...inferenceInput,
      stream: false,
    });
    await addNeuronUsage(env, cost);

    return json({
      result: extractAIText(result),
      model: CODE_MODEL,
      quota: await buildQuotaStatus(env),
    });
  } catch (e: any) {
    if (isCfQuotaError(e)) {
      await markQuotaExhausted(env);
      return quotaBlockedResponse(await buildQuotaStatus(env));
    }
    return error(`AI error: ${e.message}`, 500);
  }
}

// ---------- GitHub routes ----------

async function handleRepos(request: Request, env: Env): Promise<Response> {
  const token = await getGitHubToken(env, request);
  if (!token) {
    return error(
      "GitHub token required. Pass X-GitHub-Token header, set GITHUB_TOKEN secret, or configure GitHub App secrets.",
      401
    );
  }

  try {
    const res = await githubFetch("/user/repos?per_page=100&sort=updated", token);
    const repos = await res.json();
    return json(repos);
  } catch (e: any) {
    return error(e.message, 500);
  }
}

async function handleTree(
  request: Request,
  env: Env,
  owner: string,
  repo: string
): Promise<Response> {
  const token = await getGitHubToken(env, request);
  if (!token) return error("GitHub token required", 401);

  const url = new URL(request.url);
  const branch = url.searchParams.get("branch") || "main";
  const path = url.searchParams.get("path") || "";

  try {
    let ref = branch;
    if (branch === "main" || branch === "master") {
      try {
        const repoRes = await githubFetch(`/repos/${owner}/${repo}`, token);
        const repoData = (await repoRes.json()) as any;
        ref = repoData.default_branch || branch;
      } catch {
        /* keep branch */
      }
    }

    const apiPath = path
      ? `/repos/${owner}/${repo}/contents/${path}?ref=${ref}`
      : `/repos/${owner}/${repo}/contents?ref=${ref}`;

    const res = await githubFetch(apiPath, token);
    const data = await res.json();
    return json(data);
  } catch (e: any) {
    return error(e.message, 500);
  }
}

async function handleFile(
  request: Request,
  env: Env,
  owner: string,
  repo: string,
  path: string
): Promise<Response> {
  const token = await getGitHubToken(env, request);
  if (!token) return error("GitHub token required", 401);

  const url = new URL(request.url);
  const branch = url.searchParams.get("branch") || "main";

  try {
    const res = await githubFetch(
      `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      token
    );
    const data = (await res.json()) as any;
    if (data.content && data.encoding === "base64") {
      data.decoded = atob(data.content.replace(/\n/g, ""));
    }
    return json(data);
  } catch (e: any) {
    return error(e.message, 500);
  }
}

async function handleCommit(request: Request, env: Env): Promise<Response> {
  const token = await getGitHubToken(env, request);
  if (!token) return error("GitHub token required", 401);

  const body = (await request.json()) as {
    owner: string;
    repo: string;
    path: string;
    content: string;
    message: string;
    branch?: string;
    sha?: string;
    /** Optional author override (defaults to Lumen) */
    author?: { name?: string; email?: string };
  };

  if (!body.owner || !body.repo || !body.path || body.content === undefined || !body.message) {
    return error("Missing required fields: owner, repo, path, content, message");
  }

  const branch = body.branch || "main";

  // Always attribute commits to Lumen as committer
  const lumenIdentity = {
    name: "Lumen",
    email: "lumen@users.noreply.github.com",
  };

  try {
    const contentBase64 = btoa(unescape(encodeURIComponent(body.content)));
    const payload: any = {
      message: body.message,
      content: contentBase64,
      branch,
      committer: lumenIdentity,
      author: {
        name: body.author?.name || lumenIdentity.name,
        email: body.author?.email || lumenIdentity.email,
      },
    };
    if (body.sha) payload.sha = body.sha;

    const res = await githubFetch(
      `/repos/${body.owner}/${body.repo}/contents/${body.path}`,
      token,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      }
    );
    const data = await res.json();
    return json(data);
  } catch (e: any) {
    return error(e.message, 500);
  }
}

async function handleCreateRepo(request: Request, env: Env): Promise<Response> {
  const token = await getGitHubToken(env, request);
  if (!token) return error("GitHub token required", 401);

  const body = (await request.json()) as {
    name: string;
    description?: string;
    private?: boolean;
  };

  try {
    const res = await githubFetch("/user/repos", token, {
      method: "POST",
      body: JSON.stringify({
        name: body.name,
        description: body.description || "",
        private: body.private ?? false,
        auto_init: true,
      }),
    });
    const data = await res.json();
    return json(data);
  } catch (e: any) {
    return error(e.message, 500);
  }
}

// ---------- GitHub OAuth (user login) ----------

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function handleGitHubOAuthStart(request: Request, env: Env): Response {
  if (!env.GITHUB_CLIENT_ID) {
    return error(
      "GitHub OAuth belum dikonfigurasi. Set secret GITHUB_CLIENT_ID dan GITHUB_CLIENT_SECRET.",
      503
    );
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/api/auth/github/callback`;
  const state = randomState();

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "repo read:user");
  authorize.searchParams.set("state", state);

  const headers = new Headers({ Location: authorize.toString() });
  // Short-lived state cookie for CSRF check
  headers.set(
    "Set-Cookie",
    `gh_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  return new Response(null, { status: 302, headers });
}

async function handleGitHubOAuthCallback(request: Request, env: Env): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return error("GitHub OAuth belum dikonfigurasi.", 503);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const err = url.searchParams.get("error");

  if (err) {
    return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(err)}`, 302);
  }
  if (!code) return error("Missing OAuth code", 400);

  // Validate state cookie
  const cookieHeader = request.headers.get("Cookie") || "";
  const stateMatch = cookieHeader.match(/(?:^|;\s*)gh_oauth_state=([^;]+)/);
  const expectedState = stateMatch?.[1];
  if (!expectedState || !state || expectedState !== state) {
    return error("Invalid OAuth state. Coba login lagi.", 400);
  }

  const redirectUri = `${url.origin}/api/auth/github/callback`;

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    scope?: string;
  };

  if (!tokenData.access_token) {
    const msg = tokenData.error_description || tokenData.error || "Token exchange failed";
    return Response.redirect(`${url.origin}/?auth_error=${encodeURIComponent(msg)}`, 302);
  }

  // Fetch username for UI
  let login = "";
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${tokenData.access_token}`,
        "User-Agent": "Lumen-IDE",
      },
    });
    if (userRes.ok) {
      const user = (await userRes.json()) as { login?: string };
      login = user.login || "";
    }
  } catch {
    /* ignore */
  }

  const redirect = new URL(url.origin);
  redirect.searchParams.set("gh_token", tokenData.access_token);
  if (login) redirect.searchParams.set("gh_login", login);

  const headers = new Headers({ Location: redirect.toString() });
  headers.set(
    "Set-Cookie",
    "gh_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
  );
  return new Response(null, { status: 302, headers });
}

async function handleAuthMe(request: Request, env: Env): Promise<Response> {
  const token = await getGitHubToken(env, request);
  if (!token) return error("Not authenticated", 401);

  try {
    const res = await githubFetch("/user", token);
    const user = await res.json();
    return json(user);
  } catch (e: any) {
    return error(e.message, 500);
  }
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/ai" && request.method === "POST") {
        return handleAI(request, env);
      }
      if (path === "/api/repos" && request.method === "GET") {
        return handleRepos(request, env);
      }
      if (path === "/api/commit" && request.method === "POST") {
        return handleCommit(request, env);
      }
      if (path === "/api/create-repo" && request.method === "POST") {
        return handleCreateRepo(request, env);
      }

      const treeMatch = path.match(/^\/api\/tree\/([^/]+)\/([^/]+)$/);
      if (treeMatch && request.method === "GET") {
        return handleTree(request, env, treeMatch[1], treeMatch[2]);
      }

      const fileMatch = path.match(/^\/api\/file\/([^/]+)\/([^/]+)\/(.+)$/);
      if (fileMatch && request.method === "GET") {
        return handleFile(request, env, fileMatch[1], fileMatch[2], fileMatch[3]);
      }

      // Health / version — use this to verify the latest deploy is live
      if (path === "/api/version" && request.method === "GET") {
        return json({
          name: "Lumen",
          version: "2026.09.01-j",
          features: [
            "streaming-ai",
            "multi-tab",
            "github-app-jwt",
            "github-oauth",
            "ui-dialogs",
            "collapsible-panels",
            "inline-complete",
            "neuron-quota-gate",
          ],
          oauthConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        });
      }

      if (path === "/api/quota" && request.method === "GET") {
        return json(await buildQuotaStatus(env));
      }

      // ----- GitHub OAuth (Connect account) -----
      if (path === "/api/auth/github" && request.method === "GET") {
        return handleGitHubOAuthStart(request, env);
      }
      if (path === "/api/auth/github/callback" && request.method === "GET") {
        return handleGitHubOAuthCallback(request, env);
      }
      if (path === "/api/auth/me" && request.method === "GET") {
        return handleAuthMe(request, env);
      }
      if (path === "/api/auth/status" && request.method === "GET") {
        return json({
          oauthConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
          loginUrl: "/api/auth/github",
        });
      }

      if (env.ASSETS) {
        const assetRes = await env.ASSETS.fetch(request);
        // Prevent sticky HTML cache after deploys
        if (path === "/" || path.endsWith(".html")) {
          const headers = new Headers(assetRes.headers);
          headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
          headers.set("Pragma", "no-cache");
          return new Response(assetRes.body, {
            status: assetRes.status,
            statusText: assetRes.statusText,
            headers,
          });
        }
        return assetRes;
      }

      return error("Not found", 404);
    } catch (e: any) {
      return error(e.message || "Internal error", 500);
    }
  },
};
