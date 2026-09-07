/**
 * AI IDE - Cloudflare Worker
 * Streaming Workers AI + full GitHub App JWT + Contents API
 */

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  VECTORIZE?: VectorizeIndex;
  /** Optional KV for daily neuron usage counters */
  USAGE?: KVNamespace;
  GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  /** OAuth App / GitHub App client credentials for "Connect GitHub" */
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  /** Daily free neuron budget (default 10000) */
  NEURON_DAILY_LIMIT?: string;
  /** Soft lock threshold (default 9500) — AI blocked when used >= this */
  NEURON_SOFT_LIMIT?: string;
  /** Dedicated KV for public webapp reviews; falls back to SESSIONS when unset. */
  REVIEWS?: KVNamespace;
  SESSIONS?: KVNamespace;
  /** PayPal REST credentials and the subscription plan to sell. */
  PAYPAL_CLIENT_ID?: string;
  PAYPAL_CLIENT_SECRET?: string;
  PAYPAL_PLAN_ID?: string;
  PAYPAL_MODE?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GitHub-Token, X-Review-Token",
};

// Heavy model for panel AI (review / fix / create / chat)
// Qwen2.5-Coder-32B: 32k context, LoRA yes. Pricing ~$0.66/M in, $1/M out
const CODE_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";
// Light model for inline ghost-text (neuron-friendly)
const COMPLETE_MODEL = "@cf/meta/llama-3.2-1b-instruct";

// Simple in-memory cache for installation tokens (per isolate)
let cachedInstallToken: { token: string; expiresAt: number } | null = null;

// In-memory neuron day counter (per isolate fallback when KV missing)
let memNeuronDay = "";
let memNeuronUsed = 0;
let memQuotaExhaustedUntil = 0; // unix ms

const DEFAULT_NEURON_LIMIT = 10000;
const DEFAULT_NEURON_SOFT = 9500;

type ProSubscription = {
  id: string;
  login: string;
  status: string;
  checkedAt: number;
  expiresAt?: string;
};

/** Rough neuron cost estimates per action (Cloudflare does not expose live remaining quota via simple API) */
const NEURON_COST: Record<string, number> = {
  complete: 60,
  chat: 450,
  review: 550,
  fix: 550,
  create: 550,
  terminal: 450,
};

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

type RepoFileChange = { path: string; content: string; sha?: string };

function isVectorizeConfigured(env: Env): env is Env & { VECTORIZE: VectorizeIndex } {
  return Boolean(env.VECTORIZE);
}

async function embedText(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run(EMBEDDING_MODEL as any, { text: [text.slice(0, 8000)] });
  const data = (result as { data?: number[][] }).data;
  if (!data?.[0]) throw new Error("Embedding model returned no vector");
  return data[0];
}

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

async function buildQuotaStatus(env: Env, request?: Request) {
  const { limit, soft } = neuronLimits(env);
  const { used, day } = await getNeuronUsage(env);
  const flag = await isQuotaExhausted(env);
  const pro = request ? await getProStatus(request, env) : { active: false };
  const remaining = Math.max(0, limit - used);
  const blocked = flag.exhausted || used >= soft;
  const resetAt = flag.exhausted ? flag.until : nextUtcMidnightMs();
  return {
    day,
    used,
    limit,
    softLimit: soft,
    remaining,
    blocked: pro.active ? false : blocked,
    pro: pro.active,
    proLogin: pro.login,
    subscriptionId: pro.subscription?.id,
    reason: flag.exhausted
      ? "cloudflare_quota"
      : used >= soft
        ? "soft_limit"
        : null,
    resetAt, // unix ms UTC midnight (or exhausted-until)
    resetAtISO: new Date(resetAt).toISOString(),
    tracking: env.USAGE ? "KV" : "memory",
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

function paypalBaseUrl(env: Env): string {
  return (env.PAYPAL_MODE || "sandbox").toLowerCase() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

function paypalMode(env: Env): "sandbox" | "live" {
  return (env.PAYPAL_MODE || "sandbox").toLowerCase() === "live" ? "live" : "sandbox";
}

function paypalPlanId(env: Env): string {
  return String(env.PAYPAL_PLAN_ID || "").trim();
}

function paypalConfigured(env: Env): boolean {
  return Boolean(env.PAYPAL_CLIENT_ID?.trim() && env.PAYPAL_CLIENT_SECRET?.trim() && paypalPlanId(env));
}

async function getPayPalAccessToken(env: Env): Promise<string> {
  if (!paypalConfigured(env)) throw new Error("PayPal Pro is not configured");
  const credentials = btoa(`${env.PAYPAL_CLIENT_ID?.trim()}:${env.PAYPAL_CLIENT_SECRET?.trim()}`);
  const res = await fetch(`${paypalBaseUrl(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status}`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("PayPal did not return an access token");
  return data.access_token;
}

async function paypalFetch(env: Env, path: string, options: RequestInit = {}) {
  const token = await getPayPalAccessToken(env);
  const res = await fetch(`${paypalBaseUrl(env)}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PayPal API ${res.status}: ${body}`);
  }
  return res;
}

async function getExplicitGitHubLogin(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get("X-GitHub-Token");
  if (!token) return null;
  try {
    const res = await githubFetch("/user", token);
    const user = (await res.json()) as { login?: string };
    return user.login || null;
  } catch {
    return null;
  }
}

async function getProStatus(request: Request, env: Env): Promise<{ active: boolean; login?: string; subscription?: ProSubscription }> {
  const login = await getExplicitGitHubLogin(request, env);
  if (!login || !env.USAGE || !paypalConfigured(env)) return { active: false, login: login || undefined };

  const key = `pro:subscription:${login}`;
  const stored = (await env.USAGE.get(key, "json")) as ProSubscription | null;
  if (!stored || stored.status !== "ACTIVE") return { active: false, login };

  // Refresh PayPal status periodically so cancelled subscriptions lose access.
  if (Date.now() - stored.checkedAt < 5 * 60 * 1000) {
    return { active: true, login, subscription: stored };
  }

  try {
    const res = await paypalFetch(env, `/v1/billing/subscriptions/${encodeURIComponent(stored.id)}`);
    const current = (await res.json()) as { status?: string; billing_info?: { next_billing_time?: string } };
    const next: ProSubscription = {
      ...stored,
      status: current.status || "UNKNOWN",
      checkedAt: Date.now(),
      expiresAt: current.billing_info?.next_billing_time,
    };
    await env.USAGE.put(key, JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 370 });
    return { active: next.status === "ACTIVE", login, subscription: next };
  } catch {
    return { active: false, login };
  }
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

function decodeBase64Utf8(value: string): string {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
        "User-Agent": "AI-IDE-Cloudflare-Worker",
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

function repoVectorId(owner: string, repo: string, path: string, chunk: number): string {
  return `${owner}/${repo}:${path}:${chunk}`.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 512);
}

function isIndexablePath(path: string): boolean {
  return !/(^|\/)(node_modules|\.git|dist|build|coverage)(\/|$)/i.test(path) &&
    !/\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|mp[34]|wasm)$/i.test(path);
}

async function handleRepoIndex(request: Request, env: Env): Promise<Response> {
  const pro = await getProStatus(request, env);
  if (!pro.active) return json({ error: "Codebase RAG is available for Lumen Pro users.", code: "PRO_REQUIRED" }, 403);
  if (!isVectorizeConfigured(env)) return error("Vectorize is not configured. Add a VECTORIZE binding.", 503);
  const token = await getGitHubToken(env, request);
  if (!token) return error("GitHub token required", 401);
  const body = (await request.json()) as { owner: string; repo: string; branch?: string };
  if (!body.owner || !body.repo) return error("Missing owner and repo");
  const branch = body.branch || "main";

  try {
    const treeRes = await githubFetch(
      `/repos/${body.owner}/${body.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token
    );
    const tree = (await treeRes.json()) as { tree?: Array<{ path: string; type: string; size?: number }> };
    const files = (tree.tree || []).filter((entry) => entry.type === "blob" && isIndexablePath(entry.path) && (entry.size || 0) <= 100000).slice(0, 300);
    let chunks = 0;
    for (const file of files) {
      const fileRes = await githubFetch(`/repos/${body.owner}/${body.repo}/contents/${file.path}?ref=${encodeURIComponent(branch)}`, token);
      const data = (await fileRes.json()) as { content?: string; encoding?: string };
      if (!data.content || data.encoding !== "base64") continue;
      const content = decodeBase64Utf8(data.content);
      const parts = content.match(/[\s\S]{1,5000}/g) || [];
      const vectors = [];
      for (let index = 0; index < parts.length; index += 1) {
        const text = `Repository: ${body.owner}/${body.repo}\nFile: ${file.path}\nChunk: ${index + 1}\n${parts[index]}`;
        vectors.push({ id: repoVectorId(body.owner, body.repo, file.path, index), values: await embedText(env, text), metadata: { owner: body.owner, repo: body.repo, branch, path: file.path, chunk: index, text: parts[index] } });
      }
      if (vectors.length) {
        await env.VECTORIZE.upsert(vectors as any);
        chunks += vectors.length;
      }
    }
    return json({ indexedFiles: files.length, indexedChunks: chunks, owner: body.owner, repo: body.repo, branch });
  } catch (e: any) {
    return error(`Repository indexing error: ${e.message}`, 500);
  }
}

async function handleRepoSearch(request: Request, env: Env): Promise<Response> {
  const pro = await getProStatus(request, env);
  if (!pro.active) return json({ error: "Codebase RAG is available for Lumen Pro users.", code: "PRO_REQUIRED" }, 403);
  if (!isVectorizeConfigured(env)) return error("Vectorize is not configured. Add a VECTORIZE binding.", 503);
  const body = (await request.json()) as { owner: string; repo: string; query: string; topK?: number };
  if (!body.owner || !body.repo || !body.query) return error("Missing owner, repo, or query");
  try {
    const vector = await embedText(env, body.query);
    const result = await env.VECTORIZE.query(vector, { topK: Math.min(Math.max(body.topK || 6, 1), 20), returnMetadata: "all", filter: { owner: body.owner, repo: body.repo } } as any);
    const matches = (result.matches || []).filter((match: any) => match.metadata?.owner === body.owner && match.metadata?.repo === body.repo).map((match: any) => ({ score: match.score, ...match.metadata }));
    return json({ matches });
  } catch (e: any) {
    return error(`Repository search error: ${e.message}`, 500);
  }
}

async function handleMultiCommit(request: Request, env: Env): Promise<Response> {
  const token = await getGitHubToken(env, request);
  if (!token) return error("GitHub token required", 401);
  const body = (await request.json()) as { owner: string; repo: string; branch?: string; message: string; files: RepoFileChange[] };
  if (!body.owner || !body.repo || !body.message || !Array.isArray(body.files) || !body.files.length) return error("Missing repository, message, or files");
  const branch = body.branch || "main";
  try {
    const ref = (await (await githubFetch(`/repos/${body.owner}/${body.repo}/git/ref/heads/${encodeURIComponent(branch)}`, token)).json()) as any;
    const parentSha = ref.object?.sha;
    if (!parentSha) throw new Error("Branch head not found");
    const parent = (await (await githubFetch(`/repos/${body.owner}/${body.repo}/git/commits/${parentSha}`, token)).json()) as any;
    const treeEntries = [];
    for (const file of body.files) {
      const blob = (await (await githubFetch(`/repos/${body.owner}/${body.repo}/git/blobs`, token, { method: "POST", body: JSON.stringify({ content: btoa(unescape(encodeURIComponent(file.content))), encoding: "base64" }) })).json()) as any;
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const tree = (await (await githubFetch(`/repos/${body.owner}/${body.repo}/git/trees`, token, { method: "POST", body: JSON.stringify({ base_tree: parent.tree?.sha, tree: treeEntries }) })).json()) as any;
    const commit = (await (await githubFetch(`/repos/${body.owner}/${body.repo}/git/commits`, token, { method: "POST", body: JSON.stringify({ message: body.message, tree: tree.sha, parents: [parentSha], author: { name: "Lumen AI-IDE", email: "lumen@users.noreply.github.com" }, committer: { name: "Lumen AI-IDE", email: "lumen@users.noreply.github.com" } }) })).json()) as any;
    await githubFetch(`/repos/${body.owner}/${body.repo}/git/refs/heads/${encodeURIComponent(branch)}`, token, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
    return json({ commit: commit.sha, files: body.files.map((file) => file.path), message: body.message });
  } catch (e: any) {
    return error(`Multi-file commit error: ${e.message}`, 500);
  }
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
    action: "review" | "fix" | "create" | "chat" | "complete" | "terminal";
    code?: string;
    language?: string;
    prompt?: string;
    filename?: string;
    context?: string;
    prefix?: string;
    suffix?: string;
    stream?: boolean;
    repo?: { owner: string; name: string; branch?: string };
  };

  // Soft / hard neuron gate (estimate + Cloudflare exhausted flag)
  const quota = await buildQuotaStatus(env, request);
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
      return json({ result: text, model: COMPLETE_MODEL, quota: await buildQuotaStatus(env, request) });
    } catch (e: any) {
      if (isCfQuotaError(e)) {
        await markQuotaExhausted(env);
        return quotaBlockedResponse(await buildQuotaStatus(env, request));
      }
      return error(`AI complete error: ${e.message}`, 500);
    }
  }

  // ----- Panel AI (heavy model) -----
  const languagePolicy = `Language policy:
- Default to Bahasa Indonesia for explanations, reviews, summaries, and conversational text.
- Detect the dominant language of the user's latest request and answer in that language when it is clearly not Indonesian.
- Do not translate source code, identifiers, file paths, CLI commands, JSON keys, markdown syntax, or API names.
- Keep technical terms in English when that is the standard term, and preserve the requested output format.`;

  const systemPrompts: Record<string, string> = {
    terminal: `You are a careful developer terminal assistant. Translate the user's request into one safe, copy-pasteable CLI command or a short ordered command list. Never execute it. Return valid JSON only with keys command, explanation, risk. Prefer reversible commands, show a dry-run flag when available, and explain destructive steps. For Git commands, assume the user wants local changes only unless they explicitly ask to push.`,
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
- Do not wrap the answer in extra commentary outside the code block unless the user asked for an explanation.
- Treat PROJECT CONTEXT as the source of truth. Use exact paths and code from it; do not invent files, APIs, or repository structure.
- For a new file, label the code block with \`FILE: path/to/file.ext\` on its first line so the IDE can synchronize it with the project.
- Preserve every numeric literal exactly (0, 0px, 100%, rgba(0,0,0,.2) — never drop zeros).`,
    create: `You are Lumen, an expert programmer inside an IDE.
Write production-quality code for the user's request.
Rules:
- Prefer clear structure, correct APIs, and minimal dependencies.
- Include necessary imports and brief comments only where helpful.
- Return the main deliverable in a markdown fenced code block with a language tag.
- If multiple files are needed, use separate fenced blocks and label each with a filename comment on the first line.
- Treat PROJECT CONTEXT as the source of truth. Use exact paths and code from it; do not invent repository structure.
- Label every generated file with \`FILE: path/to/file.ext\` so the IDE can synchronize it with the project.
- Preserve every numeric literal exactly (0, 0px, 100%, rgba(0,0,0,.2) — never drop zeros).`,
    chat: `You are Lumen, an expert AI coding assistant embedded in an IDE (Qwen2.5-Coder-32B).
Help with coding, debugging, refactors, explanations, and architecture.
When you output code, use markdown fenced blocks with language tags.
Be accurate, concise, and practical.
- Treat PROJECT CONTEXT as the source of truth for the active repository and open files. Never claim to have inspected files that are not included.
- When suggesting file changes, use exact paths from context; label new files with \`FILE: path/to/file.ext\`.
Preserve every numeric literal in code exactly (do not drop zeros).`,
  };

  const system = `${systemPrompts[body.action] || systemPrompts.chat}\n\n${languagePolicy}`;

  let userContent = body.prompt || "";
  if (body.code) {
    userContent += `\n\n\`\`\`${body.language || ""}\n${body.code}\n\`\`\``;
  }
  if (body.filename) userContent = `File: ${body.filename}\n\n` + userContent;
  if (body.context) userContent += `\n\nAdditional context:\n${body.context}`;

  if (body.repo && isVectorizeConfigured(env) && body.prompt) {
    try {
      const pro = await getProStatus(request, env);
      if (pro.active) {
        const vector = await embedText(env, body.prompt);
        const search = await env.VECTORIZE.query(vector, { topK: 8, returnMetadata: "all", filter: { owner: body.repo.owner, repo: body.repo.name } } as any);
        const matches = (search.matches || []).filter((match: any) => match.metadata?.owner === body.repo?.owner && match.metadata?.repo === body.repo?.name);
        if (matches.length) {
          userContent += "\n\nRelevant repository context from semantic search:\n" + matches.map((match: any) => `FILE: ${match.metadata.path}\n${match.metadata.text}`).join("\n\n").slice(0, 30000);
        }
      }
    } catch {
      // RAG is an optional enhancement; the normal AI request remains available.
    }
  }

  const messages = [
    { role: "system", content: system },
    { role: "user", content: userContent },
  ];

  const wantStream = body.action !== "terminal" && body.stream !== false;

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

    const rawResult = extractAIText(result);
    if (body.action === "terminal") {
      const fenced = rawResult.match(/\{[\s\S]*\}/);
      try {
        return json({ result: JSON.parse(fenced?.[0] || rawResult), model: CODE_MODEL, quota: await buildQuotaStatus(env, request) });
      } catch {
        return json({ result: { command: cleanCompletion(rawResult), explanation: "Review this command before running it.", risk: "unknown" }, model: CODE_MODEL, quota: await buildQuotaStatus(env, request) });
      }
    }
    return json({
      result: rawResult,
      model: CODE_MODEL,
      quota: await buildQuotaStatus(env, request),
    });
  } catch (e: any) {
    if (isCfQuotaError(e)) {
      await markQuotaExhausted(env);
      return quotaBlockedResponse(await buildQuotaStatus(env, request));
    }
    return error(`AI error: ${e.message}`, 500);
  }
}

// ---------- GitHub routes ----------

async function handleProSubscribe(request: Request, env: Env): Promise<Response> {
  if (!paypalConfigured(env) || !env.USAGE) {
    return error("Pro subscription is not configured", 503);
  }
  const login = await getExplicitGitHubLogin(request, env);
  if (!login) return error("Sign in with GitHub before starting Pro", 401);

  try {
    const url = new URL(request.url);
    const res = await paypalFetch(env, "/v1/billing/subscriptions", {
      method: "POST",
      headers: { "PayPal-Request-Id": crypto.randomUUID() },
      body: JSON.stringify({
        plan_id: paypalPlanId(env),
        application_context: {
          brand_name: "Lumen",
          locale: "en-US",
          user_action: "SUBSCRIBE_NOW",
          return_url: `${url.origin}/?paypal=success`,
          cancel_url: `${url.origin}/?paypal=cancelled`,
        },
      }),
    });
    const data = (await res.json()) as {
      id?: string;
      links?: Array<{ rel?: string; href?: string }>;
    };
    if (!data.id) return error("PayPal did not return a subscription id", 502);
    const approvalUrl = data.links?.find((link) => link.rel === "approve")?.href;
    if (!approvalUrl) return error("PayPal did not return an approval URL", 502);

    await env.USAGE.put(`pro:pending:${data.id}`, login, { expirationTtl: 60 * 30 });
    return json({ approvalUrl, subscriptionId: data.id });
  } catch (e: any) {
    if (/PayPal API 404:.*(RESOURCE_NOT_FOUND|INVALID_RESOURCE_ID)/i.test(e.message || "")) {
      return error(
        `PayPal ${paypalMode(env)} plan not found. PAYPAL_PLAN_ID must be a subscription plan created in the same PayPal ${paypalMode(env)} account as PAYPAL_CLIENT_ID.`,
        502
      );
    }
    return error(`Could not start Pro checkout: ${e.message}`, 502);
  }
}

async function handleProActivate(request: Request, env: Env): Promise<Response> {
  if (!paypalConfigured(env) || !env.USAGE) return error("Pro subscription is not configured", 503);
  const login = await getExplicitGitHubLogin(request, env);
  if (!login) return error("Sign in with GitHub before activating Pro", 401);

  try {
    const body = (await request.json()) as { subscriptionId?: string };
    const subscriptionId = String(body.subscriptionId || "").trim();
    if (!subscriptionId) return error("PayPal subscription id is required");
    const pendingLogin = await env.USAGE.get(`pro:pending:${subscriptionId}`);
    if (pendingLogin !== login) return error("This subscription checkout does not belong to this account", 403);

    const res = await paypalFetch(env, `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const data = (await res.json()) as {
      status?: string;
      billing_info?: { next_billing_time?: string };
    };
    if (data.status !== "ACTIVE") return error(`PayPal subscription is ${data.status || "not active"}`, 402);

    const subscription: ProSubscription = {
      id: subscriptionId,
      login,
      status: data.status,
      checkedAt: Date.now(),
      expiresAt: data.billing_info?.next_billing_time,
    };
    await env.USAGE.put(`pro:subscription:${login}`, JSON.stringify(subscription), {
      expirationTtl: 60 * 60 * 24 * 370,
    });
    await env.USAGE.delete(`pro:pending:${subscriptionId}`);
    return json({ pro: true, subscription });
  } catch (e: any) {
    return error(`Could not verify Pro subscription: ${e.message}`, 502);
  }
}

async function handleProStatus(request: Request, env: Env): Promise<Response> {
  const pro = await getProStatus(request, env);
  return json({ pro: pro.active, login: pro.login, subscription: pro.subscription });
}

async function handleProCancel(request: Request, env: Env): Promise<Response> {
  const login = await getExplicitGitHubLogin(request, env);
  if (!login || !env.USAGE) return error("Connect GitHub before cancelling Pro", 401);
  const key = `pro:subscription:${login}`;
  const subscription = (await env.USAGE.get(key, "json")) as ProSubscription | null;
  if (!subscription?.id) return error("No active Pro subscription found", 404);

  try {
    await paypalFetch(env, `/v1/billing/subscriptions/${encodeURIComponent(subscription.id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: "Cancelled by subscriber in Lumen" }),
    });
    const cancelled: ProSubscription = { ...subscription, status: "CANCELLED", checkedAt: Date.now() };
    await env.USAGE.put(key, JSON.stringify(cancelled), { expirationTtl: 60 * 60 * 24 * 370 });
    return json({ pro: false, subscription: cancelled });
  } catch (e: any) {
    return error(`Could not cancel Pro subscription: ${e.message}`, 502);
  }
}

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
      data.decoded = decodeBase64Utf8(data.content);
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
    name: "Lumen AI-IDE",
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

type WebappReview = {
  id: string;
  rating: number;
  comment: string;
  author: string;
  authenticated: boolean;
  ownerKey: string;
  editToken?: string;
  createdAt: string;
};

function reviewStore(env: Env): KVNamespace | undefined {
  return env.REVIEWS || env.SESSIONS;
}

async function reviewAuthor(request: Request, env: Env): Promise<{ name: string; authenticated: boolean; ownerKey: string }> {
  // Only an explicitly supplied user token identifies a reviewer. Server-side
  // installation/PAT bindings must never turn anonymous visitors into one account.
  const token = request.headers.get("X-GitHub-Token");
  if (!token) return { name: "Anonymous", authenticated: false, ownerKey: "" };
  try {
    const res = await githubFetch("/user", token);
    const user = (await res.json()) as { login?: string; name?: string };
    return {
      name: user.login || user.name || "GitHub user",
      authenticated: true,
      ownerKey: `github:${user.login || user.name || "user"}`,
    };
  } catch {
    return { name: "Anonymous", authenticated: false, ownerKey: "" };
  }
}

function reviewCanEdit(review: WebappReview, request: Request, author: Awaited<ReturnType<typeof reviewAuthor>>): boolean {
  if (review.authenticated && author.authenticated) return review.ownerKey === author.ownerKey;
  return Boolean(review.editToken && request.headers.get("X-Review-Token") === review.editToken);
}

async function publicReview(review: WebappReview, request: Request, env: Env) {
  const author = await reviewAuthor(request, env);
  return {
    id: review.id,
    rating: review.rating,
    comment: review.comment,
    author: review.author,
    authenticated: review.authenticated,
    createdAt: review.createdAt,
    canEdit: reviewCanEdit(review, request, author),
  };
}

async function handleReviews(request: Request, env: Env, reviewId?: string): Promise<Response> {
  const store = reviewStore(env);
  if (!store) return error("Reviews KV is not configured", 503);

  try {
    if (request.method === "GET") {
      const index = JSON.parse((await store.get("reviews:index")) || "[]") as string[];
      const reviews = (await Promise.all(index.map((id) => store.get(`review:${id}`, "json"))))
        .filter(Boolean) as WebappReview[];
      reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const total = reviews.reduce((sum, review) => sum + review.rating, 0);
      return json({
        reviews: await Promise.all(reviews.map((review) => publicReview(review, request, env))),
        count: reviews.length,
        average: reviews.length ? Math.round((total / reviews.length) * 10) / 10 : 0,
      });
    }

    const body = (await request.json()) as { rating?: number; comment?: string };
    const rating = Number(body.rating);
    const comment = String(body.comment || "").trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return error("Rating must be an integer from 1 to 5");
    }
    if (comment.length < 3 || comment.length > 1000) {
      return error("Comment must be between 3 and 1000 characters");
    }

    if (request.method === "PUT") {
      if (!reviewId) return error("Review id is required");
      const review = (await store.get(`review:${reviewId}`, "json")) as WebappReview | null;
      if (!review) return error("Review not found", 404);
      const author = await reviewAuthor(request, env);
      if (!reviewCanEdit(review, request, author)) return error("You can only edit your own review", 403);
      review.rating = rating;
      review.comment = comment;
      review.createdAt = new Date().toISOString();
      await store.put(`review:${review.id}`, JSON.stringify(review));
      return json({ review: await publicReview(review, request, env) });
    }

    const author = await reviewAuthor(request, env);
    const editToken = author.authenticated ? undefined : crypto.randomUUID();
    const review: WebappReview = {
      id: crypto.randomUUID(),
      rating,
      comment,
      author: author.name,
      authenticated: author.authenticated,
      ownerKey: author.ownerKey,
      editToken,
      createdAt: new Date().toISOString(),
    };
    const index = JSON.parse((await store.get("reviews:index")) || "[]") as string[];
    const nextIndex = [review.id, ...index.filter((id) => id !== review.id)].slice(0, 200);
    await store.put(`review:${review.id}`, JSON.stringify(review));
    await store.put("reviews:index", JSON.stringify(nextIndex));
    return json({ review: await publicReview(review, request, env), editToken }, 201);
  } catch (e: any) {
    return error(`Reviews error: ${e.message}`, 500);
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
      if (path === "/api/pro/subscribe" && request.method === "POST") {
        return handleProSubscribe(request, env);
      }
      if (path === "/api/pro/activate" && request.method === "POST") {
        return handleProActivate(request, env);
      }
      if (path === "/api/pro/status" && request.method === "GET") {
        return handleProStatus(request, env);
      }
      if (path === "/api/pro/cancel" && request.method === "POST") {
        return handleProCancel(request, env);
      }
      if (path === "/api/repos" && request.method === "GET") {
        return handleRepos(request, env);
      }
      if (path === "/api/commit" && request.method === "POST") {
        return handleCommit(request, env);
      }
      if (path === "/api/multi-commit" && request.method === "POST") {
        return handleMultiCommit(request, env);
      }
      if (path === "/api/repo/index" && request.method === "POST") {
        return handleRepoIndex(request, env);
      }
      if (path === "/api/repo/search" && request.method === "POST") {
        return handleRepoSearch(request, env);
      }
      if (path === "/api/create-repo" && request.method === "POST") {
        return handleCreateRepo(request, env);
      }
      if (path === "/api/reviews" && (request.method === "GET" || request.method === "POST")) {
        return handleReviews(request, env);
      }
      const reviewMatch = path.match(/^\/api\/reviews\/([^/]+)$/);
      if (reviewMatch && request.method === "PUT") {
        return handleReviews(request, env, reviewMatch[1]);
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
          name: "Lumen AI-IDE",
          version: "2026.09.07-pro",
          features: [
            "streaming-ai",
            "multi-tab",
            "github-app-jwt",
            "github-oauth",
            "ui-dialogs",
            "collapsible-panels",
            "inline-complete",
            "neuron-quota-gate",
            "paypal-pro-subscriptions",
            "vectorize-codebase-rag",
            "multi-file-atomic-commits",
            "ai-terminal-interpreter",
          ],
          oauthConfigured: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        });
      }

      if (path === "/api/quota" && request.method === "GET") {
        return json(await buildQuotaStatus(env, request));
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
