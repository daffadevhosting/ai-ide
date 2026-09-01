/**
 * AI IDE - Cloudflare Worker
 * Streaming Workers AI + full GitHub App JWT + Contents API
 */

export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  GITHUB_INSTALLATION_ID?: string;
  ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GitHub-Token",
};

const CODE_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// Simple in-memory cache for installation tokens (per isolate)
let cachedInstallToken: { token: string; expiresAt: number } | null = null;

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

// ---------- AI ----------

async function handleAI(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    action: "review" | "fix" | "create" | "chat";
    code?: string;
    language?: string;
    prompt?: string;
    filename?: string;
    context?: string;
    stream?: boolean;
  };

  const systemPrompts: Record<string, string> = {
    review: `You are an expert code reviewer. Review the provided code carefully. Point out bugs, security issues, performance problems, style issues, and suggest improvements. Be concise but thorough. Use markdown.`,
    fix: `You are an expert programmer. Fix the provided code based on the user's request or any obvious bugs. Return ONLY the complete fixed code inside a single markdown code block. No explanations outside the code block unless asked.`,
    create: `You are an expert programmer. Create high-quality, production-ready code based on the user's request. Return the complete code inside a markdown code block. Include necessary imports and comments.`,
    chat: `You are an expert AI coding assistant embedded in an IDE. Help the user with coding tasks, explanations, debugging, and architecture. Be helpful, precise, and concise. When writing code, use markdown code blocks with language tags.`,
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

  try {
    if (wantStream) {
      const stream = await env.AI.run(CODE_MODEL as any, {
        messages,
        stream: true,
        max_tokens: 4096,
        temperature: 0.2,
      });

      return new Response(stream as ReadableStream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...CORS_HEADERS,
        },
      });
    }

    const result = await env.AI.run(CODE_MODEL as any, {
      messages,
      stream: false,
      max_tokens: 4096,
      temperature: 0.2,
    });

    const text =
      typeof result === "object" && result !== null && "response" in result
        ? (result as any).response
        : String(result);

    return json({ result: text, model: CODE_MODEL });
  } catch (e: any) {
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
  };

  if (!body.owner || !body.repo || !body.path || body.content === undefined || !body.message) {
    return error("Missing required fields: owner, repo, path, content, message");
  }

  const branch = body.branch || "main";

  try {
    const contentBase64 = btoa(unescape(encodeURIComponent(body.content)));
    const payload: any = {
      message: body.message,
      content: contentBase64,
      branch,
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

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return error("Not found", 404);
    } catch (e: any) {
      return error(e.message || "Internal error", 500);
    }
  },
};
