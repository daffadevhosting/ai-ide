/* Lumen — AI coding workspace (multi-tab, streaming AI, theme, Lucide) */

const state = {
  token: localStorage.getItem("gh_token") || "",
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
};

function isMobile() {
  return window.matchMedia("(max-width: 768px)").matches;
}

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function refreshIcons(root) {
  const api = window.lucide;
  if (!api || typeof api.createIcons !== "function") return;
  try {
    api.createIcons({
      root: root || document.body,
      attrs: { "stroke-width": 2 },
    });
  } catch {
    try { api.createIcons(); } catch { /* ignore */ }
  }
}

// ---------- Native-looking dialogs (match Lumen UI) ----------
const ui = {
  _resolve: null,

  _show({ title, message, mode, defaultValue }) {
    return new Promise((resolve) => {
      this._resolve = resolve;
      const dialog = $("#ui-dialog");
      const input = $("#ui-dialog-input");
      const cancel = $("#ui-dialog-cancel");
      const ok = $("#ui-dialog-ok");

      $("#ui-dialog-title").textContent = title || (mode === "prompt" ? "Input" : mode === "confirm" ? "Confirm" : "Notice");
      $("#ui-dialog-message").textContent = message || "";

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
      refreshIcons(dialog);
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
  const icon = $("#theme-icon");
  if (icon) {
    icon.setAttribute("data-lucide", theme === "dark" ? "sun" : "moon");
    refreshIcons();
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

// ---------- Token ----------
function openTokenModal() {
  $("#token-input").value = state.token;
  $("#token-modal").classList.remove("hidden");
  $("#token-input").focus();
  refreshIcons();
}
function closeTokenModal() {
  $("#token-modal").classList.add("hidden");
}
function saveToken() {
  state.token = $("#token-input").value.trim();
  localStorage.setItem("gh_token", state.token);
  closeTokenModal();
  if (state.token) loadRepos();
  setStatus(state.token ? "Token saved" : "Token cleared");
}

// ---------- Repos ----------
async function loadRepos() {
  if (!state.token) {
    $("#view-repos").innerHTML = `
      <div class="empty-state">
        <i data-lucide="key-round" style="width:32px;height:32px;opacity:.4;margin-bottom:8px"></i>
        <div>Set GitHub token to load repos</div>
      </div>`;
    refreshIcons();
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
      <span class="icon"><i data-lucide="${r.private ? "lock" : "folder"}"></i></span>
      <span>${r.full_name}</span>
    </div>`
    )
    .join("");
  refreshIcons();

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
        <span class="icon"><i data-lucide="${icon}"></i></span>
        <span>${item.name}</span>
      </div>`;
    })
    .join("");
  refreshIcons();

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
        <i data-lucide="x" style="width:12px;height:12px"></i>
      </span>
    </div>`
    )
    .join("");
  refreshIcons();

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
    });

    state.editor.onDidChangeModelContent(() => {
      const tab = getActiveTab();
      if (tab) {
        tab.dirty = true;
        renderTabs();
      }
    });
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
    btn.innerHTML = `<i data-lucide="check"></i> Apply to editor`;
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
    refreshIcons();
  }
}

async function sendAI() {
  if (state.streaming) return;
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
  } catch (e) {
    assistantDiv.classList.remove("streaming");
    assistantDiv.innerHTML = formatMsgHtml(`Error: ${e.message}`);
    setStatus("AI error");
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
  $("#btn-token").onclick = openTokenModal;
  $("#btn-cancel-token").onclick = closeTokenModal;
  $("#btn-save-token").onclick = saveToken;
  $("#btn-save").onclick = commitFile;
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
  // Lucide may load slightly after app.js — retry a few times
  refreshIcons();
  let tries = 0;
  const iconTimer = setInterval(() => {
    refreshIcons();
    tries += 1;
    if (window.lucide || tries > 20) clearInterval(iconTimer);
  }, 100);
  if (state.token) loadRepos();
  setStatus("Lumen ready · Set token to begin");
}

init();


