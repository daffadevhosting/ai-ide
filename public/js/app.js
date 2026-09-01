/* Lumen — AI coding workspace (multi-tab, streaming AI, theme, Lucide) */

const state = {
  token: localStorage.getItem("gh_token") || "",
  login: localStorage.getItem("gh_login") || "",
  theme: localStorage.getItem("theme") || "dark",
  repos: [],
  currentRepo: null,
  currentPath: "",
  tabs: [], // { id, path, sha, content, language, dirty, model? }
  activeTabId: null,
  editor: null,
  sidebarOpen: true,  // desktop default open; mobile starts closed via CSS
  aiOpen: false,
  streaming: false,
  // Inline ghost-text (default on; persisted)
  inlineSuggest: localStorage.getItem("inline_suggest") !== "0",
  inlineProviderDisposable: null,
};

// Latest quota snapshot from /api/quota or AI responses
let lastQuota = null;

function isMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fa(name) {
  return `<i class="fa-solid fa-${name}"></i>`;
}

// ---------- Custom dialogs (alert / confirm / prompt) ----------
const ui = {
  _resolve: null,

  _show({ title, message, mode, defaultValue }) {
    return new Promise((resolve) => {
      this._resolve = resolve;
      const dialog = $("#ui-dialog");
      const input = $("#ui-dialog-input");
      const cancel = $("#ui-dialog-cancel");
      const ok = $("#ui-dialog-ok");
      const iconEl = $("#ui-dialog-icon");

      $("#ui-dialog-title").textContent =
        title || (mode === "prompt" ? "Input" : mode === "confirm" ? "Confirm" : "Notice");
      $("#ui-dialog-message").textContent = message || "";

      if (iconEl) {
        if (mode === "confirm") iconEl.innerHTML = fa("circle-question");
        else if (mode === "prompt") iconEl.innerHTML = fa("pen-to-square");
        else iconEl.innerHTML = fa("circle-info");
      }

      if (mode === "prompt") {
        input.classList.remove("hidden");
        input.value = defaultValue || "";
        cancel.classList.remove("hidden");
        ok.textContent = "OK";
      } else if (mode === "confirm") {
        input.classList.add("hidden");
        cancel.classList.remove("hidden");
        ok.textContent = "OK";
      } else {
        input.classList.add("hidden");
        cancel.classList.add("hidden");
        ok.textContent = "OK";
      }

      dialog.classList.remove("hidden");
      setTimeout(() => {
        if (mode === "prompt") {
          input.focus();
          input.select();
        } else {
          ok.focus();
        }
      }, 30);
    });
  },

  _close(result) {
    $("#ui-dialog")?.classList.add("hidden");
    const r = this._resolve;
    this._resolve = null;
    if (r) r(result);
  },

  alert(message, title = "Lumen") {
    return this._show({ title, message, mode: "alert" });
  },
  confirm(message, title = "Confirm") {
    return this._show({ title, message, mode: "confirm" });
  },
  prompt(message, defaultValue = "", title = "Input") {
    return this._show({ title, message, mode: "prompt", defaultValue });
  },
};

// ---------- Theme ----------
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  const el = $("#theme-icon");
  if (el) {
    el.className = theme === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";
  }
  if (window.monaco && state.editor) {
    monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }
}

function toggleTheme() {
  applyTheme(state.theme === "dark" ? "light" : "dark");
}

// ---------- API ----------
async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.token) headers["X-GitHub-Token"] = state.token;

  const res = await fetch(path, { ...options, headers });
  if (options.stream) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function setStatus(msg, right) {
  $("#status-left").textContent = msg;
  if (right !== undefined) $("#status-right").textContent = right;
}

/** Format neuron usage for the status bar (right side) */
function formatNeuronStatus(q) {
  if (!q || typeof q.used !== "number") return "Lumen · Workers AI";
  const used = Math.round(q.used);
  const limit = q.limit || 10000;
  const rem = Math.max(0, limit - used);
  const limitLabel = limit >= 1000 ? `${Math.round(limit / 1000)}k` : String(limit);
  // Compact: "⚡ 380/10k" — show remaining when low
  if (q.blocked) return `⚡ ${used}/${limitLabel} · locked`;
  if (rem <= limit * 0.15) return `⚡ ${used}/${limitLabel} · low`;
  return `⚡ ${used}/${limitLabel}`;
}

function updateNeuronBar(q) {
  const el = $("#status-right");
  if (!el) return;
  if (q) lastQuota = q;
  const text = formatNeuronStatus(lastQuota);
  el.textContent = text;
  el.classList.toggle("neuron-warn", Boolean(lastQuota && (lastQuota.blocked || lastQuota.used >= (lastQuota.softLimit || lastQuota.limit) * 0.85)));
  el.title = lastQuota
    ? `Neurons used today: ~${Math.round(lastQuota.used)} / ${lastQuota.limit} (soft ${lastQuota.softLimit})\nResets ${new Date(lastQuota.resetAt).toISOString().replace("T", " ").slice(0, 19)} UTC\nTracking: ${lastQuota.tracking || "memory"}`
    : "Neuron usage";
}

// ---------- Auth / Token ----------
function updateAuthUI() {
  const label = $("#github-login-label");
  const btn = $("#btn-github-login");
  const welcomeBtn = $("#btn-github-login-welcome");
  const welcomeSteps = $("#welcome-steps");
  const welcomeConnectedMsg = $("#welcome-connected-msg");
  const connected = Boolean(state.token);
  const displayName = state.login || "Connected";

  if (connected) {
    if (label) label.textContent = displayName;
    btn?.classList.add("connected");
    if (btn) btn.title = "Connected — click to disconnect";

    // Hide onboarding steps when logged in
    if (welcomeSteps) welcomeSteps.style.display = "none";
    if (welcomeConnectedMsg) {
      welcomeConnectedMsg.style.display = "";
      welcomeConnectedMsg.textContent = state.login
        ? `Signed in as ${state.login}. Pilih repo di sidebar untuk mulai.`
        : "GitHub connected. Pilih repo di sidebar untuk mulai.";
    }

    if (welcomeBtn) {
      welcomeBtn.classList.add("connected");
      welcomeBtn.innerHTML = `<i class="fa-brands fa-github"></i> Disconnect${state.login ? ` (${state.login})` : ""}`;
      welcomeBtn.title = "Disconnect GitHub account";
      welcomeBtn.style.display = "";
    }
  } else {
    if (label) label.textContent = "Connect GitHub";
    btn?.classList.remove("connected");
    if (btn) btn.title = "Connect GitHub account";

    // Show onboarding steps when logged out
    if (welcomeSteps) welcomeSteps.style.display = "";
    if (welcomeConnectedMsg) {
      welcomeConnectedMsg.style.display = "none";
      welcomeConnectedMsg.textContent = "";
    }

    if (welcomeBtn) {
      welcomeBtn.classList.remove("connected");
      welcomeBtn.innerHTML = `<i class="fa-brands fa-github"></i> Connect GitHub`;
      welcomeBtn.title = "Connect GitHub account";
      welcomeBtn.style.display = "";
    }
  }
}

function connectGitHub() {
  if (state.token) {
    // Already connected → disconnect
    ui.confirm("Disconnect GitHub account from Lumen?", "Disconnect").then((ok) => {
      if (!ok) return;
      state.token = "";
      state.login = "";
      localStorage.removeItem("gh_token");
      localStorage.removeItem("gh_login");
      state.repos = [];
      renderRepos();
      updateAuthUI();
      setStatus("Disconnected from GitHub");
    });
    return;
  }
  // Start OAuth
  window.location.href = "/api/auth/github";
}

function handleOAuthReturn() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("gh_token");
  const login = params.get("gh_login");
  const authError = params.get("auth_error");

  if (authError) {
    ui.alert("GitHub login gagal: " + authError, "Auth error");
    history.replaceState({}, "", "/");
    return;
  }

  if (token) {
    state.token = token;
    state.login = login || "";
    localStorage.setItem("gh_token", state.token);
    if (state.login) localStorage.setItem("gh_login", state.login);
    history.replaceState({}, "", "/");
    updateAuthUI();
    setStatus(state.login ? `Connected as ${state.login}` : "GitHub connected");
    loadRepos();
    // Refresh login name if missing
    if (!state.login) {
      api("/api/auth/me")
        .then((user) => {
          if (user?.login) {
            state.login = user.login;
            localStorage.setItem("gh_login", state.login);
            updateAuthUI();
          }
        })
        .catch(() => {});
    }
  }
}

function openTokenModal() {
  $("#token-input").value = state.token;
  $("#token-modal").classList.remove("hidden");
  $("#token-input").focus();
}
function closeTokenModal() {
  $("#token-modal").classList.add("hidden");
}
function saveToken() {
  state.token = $("#token-input").value.trim();
  localStorage.setItem("gh_token", state.token);
  if (!state.token) {
    state.login = "";
    localStorage.removeItem("gh_login");
  }
  closeTokenModal();
  updateAuthUI();
  if (state.token) {
    loadRepos();
    api("/api/auth/me")
      .then((user) => {
        if (user?.login) {
          state.login = user.login;
          localStorage.setItem("gh_login", state.login);
          updateAuthUI();
        }
      })
      .catch(() => {});
  }
  setStatus(state.token ? "Token saved" : "Token cleared");
}

// ---------- Repos ----------
async function loadRepos() {
  if (!state.token) {
    $("#view-repos").innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-key" style="font-size:28px;opacity:.4;margin-bottom:8px"></i>
        <div>Set GitHub token to load repos</div>
      </div>`;
    return;
  }
  setStatus("Loading repositories...");
  try {
    const repos = await api("/api/repos");
    state.repos = Array.isArray(repos) ? repos : [];
    renderRepos();
    setStatus(`${state.repos.length} repositories`);
  } catch (e) {
    $("#view-repos").innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
    setStatus("Failed to load repos");
  }
}

function renderRepos() {
  const el = $("#view-repos");
  if (!state.repos.length) {
    el.innerHTML = `<div class="empty-state">No repositories found</div>`;
    return;
  }
  el.innerHTML = state.repos
    .map(
      (r) => `
    <div class="repo-item ${state.currentRepo?.name === r.name ? "active" : ""}"
         data-owner="${r.owner.login}" data-name="${r.name}" data-branch="${r.default_branch}">
      <span class="icon"><i class="fa-solid fa-${r.private ? "lock" : "folder"}"></i></span>
      <span>${r.full_name}</span>
    </div>`
    )
    .join("");

  el.querySelectorAll(".repo-item").forEach((item) => {
    item.addEventListener("click", () => {
      state.currentRepo = {
        owner: item.dataset.owner,
        name: item.dataset.name,
        default_branch: item.dataset.branch,
      };
      state.currentPath = "";
      switchView("files");
      loadTree();
      renderRepos();
    });
  });
}

// ---------- File Tree ----------
async function loadTree(path = "") {
  if (!state.currentRepo) return;
  setStatus(`Loading ${path || "root"}...`);
  try {
    const data = await api(
      `/api/tree/${state.currentRepo.owner}/${state.currentRepo.name}?path=${encodeURIComponent(path)}&branch=${state.currentRepo.default_branch}`
    );
    state.currentPath = path;
    renderTree(Array.isArray(data) ? data : [data]);
    renderBreadcrumb();
    setStatus(`Opened ${state.currentRepo.name}`);
  } catch (e) {
    $("#file-tree").innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
    setStatus("Failed to load tree");
  }
}

function renderTree(items) {
  const el = $("#file-tree");
  items.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === "dir" ? -1 : 1;
  });

  el.innerHTML = items
    .map((item) => {
      const icon = item.type === "dir" ? "folder" : "file-code";
      return `
      <div class="tree-item" data-type="${item.type}" data-path="${item.path}" data-sha="${item.sha || ""}">
        <span class="icon"><i class="fa-solid fa-${icon}"></i></span>
        <span>${item.name}</span>
      </div>`;
    })
    .join("");

  el.querySelectorAll(".tree-item").forEach((item) => {
    item.addEventListener("click", () => {
      const type = item.dataset.type;
      const path = item.dataset.path;
      if (type === "dir") loadTree(path);
      else openFile(path, item.dataset.sha);
    });
  });
}

function renderBreadcrumb() {
  const el = $("#breadcrumb");
  if (!state.currentRepo) {
    el.innerHTML = "";
    return;
  }
  const parts = state.currentPath ? state.currentPath.split("/") : [];
  let html = `<span data-path="">${state.currentRepo.name}</span>`;
  let acc = "";
  parts.forEach((p) => {
    acc = acc ? `${acc}/${p}` : p;
    html += ` / <span data-path="${acc}">${p}</span>`;
  });
  el.innerHTML = html;
  el.querySelectorAll("span").forEach((s) => {
    s.addEventListener("click", () => loadTree(s.dataset.path));
  });
}

// ---------- Multi-tab Editor ----------
function detectLanguage(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  const map = {
    js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    c: "c", cpp: "cpp", h: "c", cs: "csharp", php: "php",
    html: "html", css: "css", scss: "scss", json: "json", md: "markdown",
    yml: "yaml", yaml: "yaml", toml: "ini", sh: "shell", bash: "shell",
    sql: "sql", vue: "html", svelte: "html",
  };
  return map[ext] || "plaintext";
}

function tabId(path) {
  return state.currentRepo
    ? `${state.currentRepo.owner}/${state.currentRepo.name}/${path}`
    : path;
}

function getActiveTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

function renderTabs() {
  const bar = $("#tab-bar");
  const list = $("#tabs");
  if (!state.tabs.length) {
    bar.classList.remove("has-tabs");
    list.innerHTML = "";
    return;
  }
  bar.classList.add("has-tabs");
  list.innerHTML = state.tabs
    .map(
      (t) => `
    <div class="editor-tab ${t.id === state.activeTabId ? "active" : ""} ${t.dirty ? "dirty" : ""}"
         data-id="${t.id}">
      <span class="tab-name">${t.path.split("/").pop()}</span>
      <span class="tab-close" data-close="${t.id}" title="Close">
        <i class="fa-solid fa-xmark" style="font-size:11px"></i>
      </span>
    </div>`
    )
    .join("");

  list.querySelectorAll(".editor-tab").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) return;
      activateTab(el.dataset.id);
    });
  });
  list.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(btn.dataset.close);
    });
  });
}

function activateTab(id) {
  // Save current content into tab
  const prev = getActiveTab();
  if (prev && state.editor) {
    prev.content = state.editor.getValue();
  }

  state.activeTabId = id;
  const tab = getActiveTab();
  if (!tab) return;

  $("#welcome").style.display = "none";
  $("#editor-container").classList.add("visible");
  $("#current-file").textContent = tab.path;

  if (state.editor) {
    let model = tab.model;
    if (!model || model.isDisposed?.()) {
      model = monaco.editor.createModel(tab.content, tab.language);
      tab.model = model;
    }
    state.editor.setModel(model);
  }
  renderTabs();
}

async function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  if (tab.dirty) {
    const ok = await ui.confirm(`Close "${tab.path}"?\nUnsaved changes will be lost.`, "Close tab");
    if (!ok) return;
  }
  if (tab.model && !tab.model.isDisposed?.()) tab.model.dispose();
  state.tabs.splice(idx, 1);

  if (state.activeTabId === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    state.activeTabId = next ? next.id : null;
    if (next) activateTab(next.id);
    else {
      $("#editor-container").classList.remove("visible");
      $("#welcome").style.display = "flex";
      $("#current-file").textContent = "No file open";
      if (state.editor) state.editor.setModel(null);
    }
  }
  renderTabs();
}

async function openFile(path, sha) {
  if (!state.currentRepo) return;
  const id = tabId(path);
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) {
    activateTab(id);
    if (isMobile()) setSidebarOpen(false);
    return;
  }

  setStatus(`Opening ${path}...`);
  try {
    const data = await api(
      `/api/file/${state.currentRepo.owner}/${state.currentRepo.name}/${path}?branch=${state.currentRepo.default_branch}`
    );
    const content = data.decoded || (data.content ? atob(data.content.replace(/\n/g, "")) : "");
    const language = detectLanguage(path);

    const tab = {
      id,
      path,
      sha: data.sha,
      content,
      language,
      dirty: false,
      model: null,
      owner: state.currentRepo.owner,
      repo: state.currentRepo.name,
      branch: state.currentRepo.default_branch,
    };
    state.tabs.push(tab);
    activateTab(id);
    if (isMobile()) setSidebarOpen(false);
    setStatus(`Opened ${path}`);
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
}

function updateInlineToggleUI() {
  const label = $("#inline-toggle-label");
  const btn = $("#btn-inline-toggle");
  const icon = $("#inline-toggle-icon");
  if (label) label.textContent = state.inlineSuggest ? "Inline On" : "Inline Off";
  if (btn) {
    btn.classList.toggle("accent", state.inlineSuggest);
    btn.classList.toggle("ghost", !state.inlineSuggest);
    btn.title = state.inlineSuggest
      ? "Inline AI suggestions on (click to disable)"
      : "Inline AI suggestions off (click to enable)";
  }
  if (icon) {
    icon.className = state.inlineSuggest
      ? "fa-solid fa-lightbulb"
      : "fa-regular fa-lightbulb";
  }
  // Keep neuron usage visible; only tweak title/tooltip if needed
  updateNeuronBar(lastQuota);
}

function toggleInlineSuggest() {
  state.inlineSuggest = !state.inlineSuggest;
  localStorage.setItem("inline_suggest", state.inlineSuggest ? "1" : "0");
  updateInlineToggleUI();
  setStatus(state.inlineSuggest ? "Inline AI suggestions enabled" : "Inline AI suggestions disabled");
}

function registerInlineCompletions() {
  if (!window.monaco || state.inlineProviderDisposable) return;

  let debounceTimer = null;
  let lastAbort = null;

  state.inlineProviderDisposable = monaco.languages.registerInlineCompletionsProvider(
    { pattern: "**" },
    {
      provideInlineCompletions: (model, position, _context, token) => {
        if (!state.inlineSuggest) {
          return { items: [] };
        }

        return new Promise((resolve) => {
          if (debounceTimer) clearTimeout(debounceTimer);
          if (lastAbort) {
            try { lastAbort.abort(); } catch {}
          }

          debounceTimer = setTimeout(async () => {
            if (token.isCancellationRequested) {
              resolve({ items: [] });
              return;
            }

            try {
              const offset = model.getOffsetAt(position);
              const full = model.getValue();
              // Limit context for cost
              const prefix = full.slice(Math.max(0, offset - 3500), offset);
              const suffix = full.slice(offset, offset + 1200);
              // Skip empty / tiny prefix
              if (prefix.trim().length < 8) {
                resolve({ items: [] });
                return;
              }

              const controller = new AbortController();
              lastAbort = controller;

              const headers = { "Content-Type": "application/json" };
              if (state.token) headers["X-GitHub-Token"] = state.token;

              const res = await fetch("/api/ai", {
                method: "POST",
                headers,
                signal: controller.signal,
                body: JSON.stringify({
                  action: "complete",
                  stream: false,
                  language: model.getLanguageId(),
                  filename: getActiveTab()?.path || "file",
                  prefix,
                  suffix,
                }),
              });

              if (token.isCancellationRequested) {
                resolve({ items: [] });
                return;
              }

              const data = await res.json().catch(() => ({}));
              if (data?.quota) updateNeuronBar(data.quota);
              if (!res.ok) {
                if (data?.code === "NEURON_QUOTA" || data?.quota?.blocked) {
                  handleQuotaError(data);
                }
                resolve({ items: [] });
                return;
              }

              let insertText = (data.result || "").replace(/\r\n/g, "\n");
              // Don't suggest if empty or too long
              if (!insertText || insertText.length > 2000) {
                resolve({ items: [] });
                return;
              }
              // Avoid repeating the last chars of prefix
              const tail = prefix.slice(-20);
              if (tail && insertText.startsWith(tail)) {
                insertText = insertText.slice(tail.length);
              }
              if (!insertText) {
                resolve({ items: [] });
                return;
              }

              resolve({
                items: [
                  {
                    insertText,
                    range: new monaco.Range(
                      position.lineNumber,
                      position.column,
                      position.lineNumber,
                      position.column
                    ),
                  },
                ],
              });
            } catch {
              resolve({ items: [] });
            }
          }, 650);
        });
      },
      freeInlineCompletions: () => {},
    }
  );
}

function initEditor() {
  require.config({
    paths: { vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.0/min/vs" },
  });
  require(["vs/editor/editor.main"], () => {
    state.editor = monaco.editor.create($("#editor-container"), {
      value: "",
      language: "plaintext",
      theme: state.theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      minimap: { enabled: window.innerWidth > 900 },
      scrollBeyondLastLine: false,
      padding: { top: 12 },
      lineNumbers: "on",
      renderLineHighlight: "line",
      cursorBlinking: "smooth",
      smoothScrolling: true,
      // Prefer inline completions UI
      inlineSuggest: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: false },
    });

    state.editor.onDidChangeModelContent(() => {
      const tab = getActiveTab();
      if (tab) {
        tab.dirty = true;
        renderTabs();
      }
    });

    registerInlineCompletions();
    updateInlineToggleUI();
  });
}

async function commitFile() {
  const tab = getActiveTab();
  if (!tab || !state.editor) {
    setStatus("No file open");
    return;
  }
  const content = state.editor.getValue();
  const message = await ui.prompt("Commit message:", `Update ${tab.path}`, "Commit");
  if (message === null || message === "") return;

  setStatus("Committing...");
  try {
    const result = await api("/api/commit", {
      method: "POST",
      body: JSON.stringify({
        owner: tab.owner,
        repo: tab.repo,
        path: tab.path,
        content,
        message,
        branch: tab.branch,
        sha: tab.sha,
      }),
    });
    tab.content = content;
    tab.dirty = false;
    tab.sha = result.content?.sha || tab.sha;
    renderTabs();
    setStatus("Committed successfully ✓");
  } catch (e) {
    setStatus(`Commit failed: ${e.message}`);
    await ui.alert("Commit failed: " + e.message, "Commit error");
  }
}

// ---------- Streaming AI ----------
function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMsgHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${escapeHtml(code.trim())}</code></pre>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

function addMessage(role, text, streaming = false) {
  const el = $("#ai-messages");
  const div = document.createElement("div");
  div.className = `msg ${role}${streaming ? " streaming" : ""}`;
  div.innerHTML = formatMsgHtml(text);
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}

function finishMessage(div, fullText) {
  div.classList.remove("streaming");
  div.innerHTML = formatMsgHtml(fullText);
  if (fullText.includes("```")) {
    const btn = document.createElement("button");
    btn.className = "btn accent sm apply-btn";
    btn.innerHTML = `<i class="fa-solid fa-check"></i> Apply to editor`;
    btn.onclick = () => {
      const match = fullText.match(/```(?:\w*)\n([\s\S]*?)```/);
      if (match && state.editor) {
        state.editor.setValue(match[1].trim());
        const tab = getActiveTab();
        if (tab) tab.dirty = true;
        renderTabs();
        setStatus("Code applied to editor");
      }
    };
    div.appendChild(btn);
  }
}

async function sendAI() {
  if (state.streaming) return;
  if (lastQuota?.blocked) {
    setQuotaLock(true, lastQuota);
    setStatus("AI paused · daily neuron quota");
    return;
  }
  const input = $("#ai-input");
  const prompt = input.value.trim();
  if (!prompt) return;

  const action = $("#ai-action").value;
  let code = "";
  let language = "plaintext";
  if (state.editor) {
    const selection = state.editor.getSelection();
    const model = state.editor.getModel();
    if (model) {
      if (selection && !selection.isEmpty()) {
        code = model.getValueInRange(selection);
      } else {
        code = state.editor.getValue();
      }
      language = model.getLanguageId();
    }
  }

  addMessage("user", prompt);
  input.value = "";
  setStatus("AI streaming...");
  state.streaming = true;

  const assistantDiv = addMessage("assistant", "", true);
  let fullText = "";

  try {
    const res = await api("/api/ai", {
      method: "POST",
      stream: true,
      body: JSON.stringify({
        action,
        prompt,
        code: code || undefined,
        language,
        filename: getActiveTab()?.path,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (handleQuotaError(err)) {
        throw new Error(err.error || "Daily AI quota reached");
      }
      throw new Error(err.error || res.statusText);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const chunk = json.response || json.delta || "";
            if (chunk) {
              fullText += chunk;
              assistantDiv.innerHTML = formatMsgHtml(fullText);
              $("#ai-messages").scrollTop = $("#ai-messages").scrollHeight;
            }
          } catch {
            /* ignore partial */
          }
        }
      }
    }

    finishMessage(assistantDiv, fullText || "(empty response)");
    setStatus("AI ready");
    // Refresh neuron counter after successful request
    checkQuota();
  } catch (e) {
    assistantDiv.classList.remove("streaming");
    assistantDiv.innerHTML = formatMsgHtml(`Error: ${e.message}`);
    setStatus("AI error");
    checkQuota();
  } finally {
    state.streaming = false;
  }
}

function updateBackdrop() {
  const show = isMobile() && (state.sidebarOpen || state.aiOpen);
  $("#backdrop")?.classList.toggle("visible", show);
}

function setSidebarOpen(open) {
  state.sidebarOpen = open;
  const el = $("#sidebar");
  if (!el) return;
  if (isMobile()) {
    el.classList.toggle("open", open);
    el.classList.remove("collapsed");
  } else {
    el.classList.toggle("collapsed", !open);
    el.classList.remove("open");
  }
  updateBackdrop();
  // Let Monaco relayout after width change
  setTimeout(() => state.editor?.layout?.(), 220);
}

function toggleSidebar() {
  setSidebarOpen(!state.sidebarOpen);
}

function setAIOpen(open) {
  state.aiOpen = open;
  $("#ai-panel")?.classList.toggle("open", open);
  // On mobile, close sidebar when opening AI
  if (open && isMobile() && state.sidebarOpen) {
    setSidebarOpen(false);
  }
  updateBackdrop();
  setTimeout(() => state.editor?.layout?.(), 220);
}

function toggleAI() {
  setAIOpen(!state.aiOpen);
}

function closeOverlays() {
  if (isMobile()) {
    setSidebarOpen(false);
    setAIOpen(false);
  }
}

// ---------- Views ----------
function switchView(name) {
  $$(".sidebar-header .tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
}

// ---------- Events ----------
function bindEvents() {
  $("#btn-github-login") && ($("#btn-github-login").onclick = connectGitHub);
  $("#btn-github-login-welcome") && ($("#btn-github-login-welcome").onclick = connectGitHub);
  $("#btn-token").onclick = openTokenModal;
  $("#btn-cancel-token").onclick = closeTokenModal;
  $("#btn-save-token").onclick = saveToken;
  $("#btn-save").onclick = commitFile;
  $("#btn-inline-toggle") && ($("#btn-inline-toggle").onclick = toggleInlineSuggest);
  $("#btn-ai-toggle").onclick = toggleAI;
  $("#btn-close-ai").onclick = () => setAIOpen(false);
  $("#btn-send-ai").onclick = sendAI;
  $("#btn-theme").onclick = toggleTheme;
  $("#btn-sidebar").onclick = toggleSidebar;
  $("#btn-sidebar-close").onclick = () => setSidebarOpen(false);

  // Custom dialog actions
  $("#ui-dialog-ok").onclick = () => {
    const input = $("#ui-dialog-input");
    const isPrompt = !input.classList.contains("hidden");
    if (isPrompt) ui._close(input.value);
    else ui._close(true);
  };
  $("#ui-dialog-cancel").onclick = () => {
    const input = $("#ui-dialog-input");
    const isPrompt = !input.classList.contains("hidden");
    ui._close(isPrompt ? null : false);
  };
  $("#ui-dialog").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const input = $("#ui-dialog-input");
      const isPrompt = !input.classList.contains("hidden");
      ui._close(isPrompt ? null : false);
    }
    if (e.key === "Enter" && e.target === $("#ui-dialog-input")) {
      e.preventDefault();
      ui._close($("#ui-dialog-input").value);
    }
  });

  // Custom select (AI action)
  const trigger = $("#ai-action-trigger");
  const menu = $("#ai-action-menu");
  const nativeSelect = $("#ai-action");
  const label = $("#ai-action-label");
  if (trigger && menu && nativeSelect) {
    trigger.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle("hidden");
    };
    menu.querySelectorAll("li").forEach((li) => {
      li.onclick = () => {
        const value = li.dataset.value;
        nativeSelect.value = value;
        label.textContent = li.textContent;
        menu.querySelectorAll("li").forEach((x) => x.classList.toggle("active", x === li));
        menu.classList.add("hidden");
      };
    });
    document.addEventListener("click", () => menu.classList.add("hidden"));
  }

  $("#backdrop").onclick = closeOverlays;

  $("#btn-refresh").onclick = () => {
    if ($(".sidebar-header .tab.active")?.dataset.view === "repos") loadRepos();
    else if (state.currentRepo) loadTree(state.currentPath);
  };

  $("#btn-use-selection").onclick = () => {
    if (!state.editor) return;
    const model = state.editor.getModel();
    if (!model) return;
    const sel = model.getValueInRange(state.editor.getSelection());
    if (sel) $("#ai-input").value = ($("#ai-input").value + "\n" + sel).trim();
  };

  $("#ai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendAI();
    }
  });

  $$(".sidebar-header .tab").forEach((t) => {
    t.onclick = () => switchView(t.dataset.view);
  });

  // Keep layout correct on rotate / resize
  window.addEventListener("resize", () => {
    if (isMobile()) {
      // Mobile: panels are overlays — don't force desktop collapsed state
      $("#sidebar")?.classList.remove("collapsed");
      if (!state.sidebarOpen) $("#sidebar")?.classList.remove("open");
    } else {
      $("#sidebar")?.classList.remove("open");
      $("#sidebar")?.classList.toggle("collapsed", !state.sidebarOpen);
      $("#backdrop")?.classList.remove("visible");
    }
    state.editor?.layout?.();
  });
}

// ---------- Init ----------

// ---------- Neuron quota gate ----------
let quotaTimer = null;
let quotaCountdownTimer = null;

function formatHMS(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

function setQuotaLock(show, quota) {
  const el = $("#quota-lock");
  if (!el) return;
  el.classList.toggle("hidden", !show);
  if (!show) return;

  lastQuota = quota || lastQuota;
  const resetAt = lastQuota?.resetAt || 0;
  const label = $("#quota-reset-label");
  if (label && resetAt) {
    label.textContent = new Date(resetAt).toISOString().replace("T", " ").replace(".000Z", " UTC");
  }
  const stats = $("#quota-stats");
  if (stats && lastQuota) {
    stats.textContent = `Used ~${lastQuota.used} / ${lastQuota.limit} neurons (soft ${lastQuota.softLimit}) · ${lastQuota.tracking}`;
  }

  if (quotaCountdownTimer) clearInterval(quotaCountdownTimer);
  const tick = () => {
    const left = (lastQuota?.resetAt || 0) - Date.now();
    const cd = $("#quota-countdown");
    if (cd) cd.textContent = formatHMS(left);
    if (left <= 0) {
      // try unlock after reset
      checkQuota(true);
    }
  };
  tick();
  quotaCountdownTimer = setInterval(tick, 1000);

  // Pause inline AI while locked
  if (state.inlineSuggest) {
    state._inlineWasOn = true;
    state.inlineSuggest = false;
    updateInlineToggleUI();
  }
}

async function checkQuota(forceUnlockAttempt) {
  try {
    const res = await fetch("/api/quota");
    if (!res.ok) return;
    const q = await res.json();
    lastQuota = q;
    updateNeuronBar(q);
    if (q.blocked) {
      setQuotaLock(true, q);
      setStatus("AI paused · daily neuron quota");
    } else {
      setQuotaLock(false, q);
      if (forceUnlockAttempt && state._inlineWasOn) {
        state.inlineSuggest = true;
        state._inlineWasOn = false;
        updateInlineToggleUI();
      }
    }
  } catch {
    /* ignore network */
  }
}

function handleQuotaError(payload) {
  if (payload?.code === "NEURON_QUOTA" || payload?.quota?.blocked) {
    const q = payload.quota || payload;
    setQuotaLock(true, q);
    updateNeuronBar(q);
    setStatus("AI paused · daily neuron quota");
    return true;
  }
  return false;
}

function startQuotaPolling() {
  checkQuota();
  if (quotaTimer) clearInterval(quotaTimer);
  quotaTimer = setInterval(() => checkQuota(), 60000); // every minute
}


function init() {
  applyTheme(state.theme);
  // Mobile starts with sidebar closed
  if (isMobile()) {
    state.sidebarOpen = false;
    setSidebarOpen(false);
  } else {
    setSidebarOpen(true);
  }
  setAIOpen(false);
  bindEvents();
  initEditor();
  handleOAuthReturn();
  updateAuthUI();
  updateInlineToggleUI();
  startQuotaPolling();

  if (state.token) loadRepos();
  else setStatus("Lumen ready · Connect GitHub to begin");
}

init();
