/* Lumen — AI coding workspace (multi-tab, streaming AI, theme, Lucide) */

const state = {
  token: localStorage.getItem("gh_token") || "",
  login: localStorage.getItem("gh_login") || "",
  theme: localStorage.getItem("theme") || "dark",
  repos: [],
  repoQuery: "",
  reviewRating: 0,
  reviews: [],
  editingReviewId: null,
  currentRepo: null,
  currentPath: "",
  tabs: [], // { id, path, sha, content, language, dirty, model? }
  activeTabId: null,
  editor: null,
  diffEditor: null,
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

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
  if (window.monaco && state.diffEditor) {
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
  if (path.startsWith("/api/reviews")) {
    const reviewToken = localStorage.getItem("review_edit_token");
    if (reviewToken) headers["X-Review-Token"] = reviewToken;
  }

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
  const limitLabel = limit >= 1000 ? `${Math.round(limit / 1000)}K neurons` : String(limit);
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
        ? `Signed in as ${state.login}.\nPilih repo di sidebar untuk mulai.`
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

/** Clear GitHub session (no confirm). Used by manual disconnect + quota lock. */
function forceLogoutGitHub(reason) {
  const wasConnected = Boolean(state.token);
  state.token = "";
  state.login = "";
  localStorage.removeItem("gh_token");
  localStorage.removeItem("gh_login");
  state.repos = [];
  state.currentRepo = null;
  state.currentPath = "";
  // Close all editor tabs cleanly
  state.tabs.forEach((t) => {
    if (t.model && !t.model.isDisposed?.()) {
      try {
        t.model.dispose();
      } catch {
        /* ignore */
      }
    }
  });
  state.tabs = [];
  state.activeTabId = null;
  if (state.editor) {
    try {
      state.editor.setModel(null);
    } catch {
      /* ignore */
    }
  }
  $("#editor-container")?.classList.remove("visible");
  const welcome = $("#welcome");
  if (welcome) welcome.style.display = "flex";
  const fileLabel = $("#current-file");
  if (fileLabel) fileLabel.textContent = "";
  renderTabs();
  renderRepos();
  const tree = $("#file-tree");
  if (tree) tree.innerHTML = "";
  const crumb = $("#breadcrumb");
  if (crumb) crumb.innerHTML = "";
  updateAuthUI();
  if (wasConnected) {
    setStatus(reason || "Disconnected from GitHub");
  }
}

function connectGitHub() {
  if (state.token) {
    // Already connected → disconnect
    ui.confirm("Disconnect GitHub account from Lumen?", "Disconnect").then((ok) => {
      if (!ok) return;
      forceLogoutGitHub("Disconnected from GitHub");
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
        <i class="fa-brands fa-github" style="font-size:28px;opacity:.4;margin-bottom:8px"></i>
        <div>Login GitHub to load repos</div>
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
  const query = state.repoQuery.trim().toLowerCase();
  const filteredRepos = query
    ? state.repos.filter((repo) => `${repo.full_name} ${repo.description || ""}`.toLowerCase().includes(query))
    : state.repos;
  if (!state.repos.length) {
    el.innerHTML = `<div class="empty-state">No repositories found</div>`;
    return;
  }
  el.innerHTML = `
    <div class="repo-search">
      <i class="fa-solid fa-magnifying-glass"></i>
      <input id="repo-search-input" type="search" placeholder="Search repositories..." autocomplete="off" value="${state.repoQuery.replace(/"/g, "&quot;")}" />
      <button id="repo-search-clear" class="icon-btn" type="button" title="Clear search" aria-label="Clear search">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    ${filteredRepos.length ? filteredRepos
    .map(
      (r) => `
    <div class="repo-item ${state.currentRepo?.name === r.name ? "active" : ""}"
         data-owner="${r.owner.login}" data-name="${r.name}" data-branch="${r.default_branch}">
      <span class="icon"><i class="fa-solid fa-${r.private ? "lock" : "folder"}"></i></span>
      <span>${r.full_name}</span>
    </div>`
    )
    .join("") : `<div class="empty-state repo-empty-search">No repositories match your search</div>`}`;

  const searchInput = $("#repo-search-input");
  searchInput?.addEventListener("input", (event) => {
    state.repoQuery = event.target.value;
    renderRepos();
    const nextInput = $("#repo-search-input");
    nextInput?.focus();
    nextInput?.setSelectionRange(state.repoQuery.length, state.repoQuery.length);
  });
  $("#repo-search-clear")?.addEventListener("click", () => {
    state.repoQuery = "";
    renderRepos();
    $("#repo-search-input")?.focus();
  });

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

function renderReviews(data = {}) {
  state.reviews = Array.isArray(data.reviews) ? data.reviews : state.reviews;
  const summary = $("#review-summary");
  const stars = $("#review-stars");
  const list = $("#review-list");
  if (!summary || !stars || !list) return;

  summary.textContent = data.count
    ? `${data.average} / 5 · ${data.count} review${data.count === 1 ? "" : "s"}`
    : "Be the first to review";
  stars.innerHTML = Array.from({ length: 5 }, (_, index) => {
    const rating = index + 1;
    return `<button class="review-star ${rating <= state.reviewRating ? "selected" : ""}" type="button" data-rating="${rating}" role="radio" aria-label="${rating} star${rating === 1 ? "" : "s"}" aria-checked="${rating === state.reviewRating}"><i class="fa-${rating <= state.reviewRating ? "solid" : "regular"} fa-star"></i></button>`;
  }).join("");
  const form = $("#review-comment");
  const submit = $("#btn-submit-review");
  const cancel = $("#btn-cancel-review-edit");
  const editing = state.editingReviewId ? state.reviews.find((review) => review.id === state.editingReviewId) : null;
  form?.classList.toggle("hidden", Boolean(state.reviews.some((review) => review.canEdit) && !editing));
  stars.classList.toggle("hidden", Boolean(state.reviews.some((review) => review.canEdit) && !editing));
  submit?.classList.toggle("hidden", Boolean(state.reviews.some((review) => review.canEdit) && !editing));
  cancel?.classList.toggle("hidden", !editing);
  if (submit) submit.innerHTML = editing ? `<i class="fa-solid fa-floppy-disk"></i> Save review` : `<i class="fa-solid fa-paper-plane"></i> Submit review`;
  if (editing && form && form.value !== editing.comment) form.value = editing.comment;
  stars.querySelectorAll("[data-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      state.reviewRating = Number(button.dataset.rating);
      renderReviews({ reviews: state.reviews, count: data.count, average: data.average });
    });
  });

  list.innerHTML = state.reviews.slice(0, 5).map((review) => `
    <article class="review-item">
      <div class="review-item-head">
        <strong>${escapeHtml(review.author || "Anonymous")}</strong>
        <span class="review-item-tools"><span class="review-item-stars">${"★".repeat(Number(review.rating) || 0)}</span>${review.canEdit ? `<button class="review-edit" type="button" data-edit-review="${review.id}" title="Edit review" aria-label="Edit review"><i class="fa-solid fa-pencil"></i></button>` : ""}</span>
      </div>
      <p>${escapeHtml(review.comment || "")}</p>
    </article>`).join("");
  list.querySelectorAll("[data-edit-review]").forEach((button) => {
    button.addEventListener("click", () => startReviewEdit(button.dataset.editReview));
  });
}

function startReviewEdit(id) {
  const review = state.reviews.find((item) => item.id === id && item.canEdit);
  if (!review) return;
  state.editingReviewId = id;
  state.reviewRating = Number(review.rating) || 0;
  renderReviews({ reviews: state.reviews, count: state.reviews.length, average: state.reviews.length ? state.reviews.reduce((sum, item) => sum + Number(item.rating || 0), 0) / state.reviews.length : 0 });
  $("#review-comment")?.focus();
}

function cancelReviewEdit() {
  state.editingReviewId = null;
  state.reviewRating = 0;
  $("#review-comment").value = "";
  renderReviews({ reviews: state.reviews, count: state.reviews.length, average: state.reviews.length ? state.reviews.reduce((sum, item) => sum + Number(item.rating || 0), 0) / state.reviews.length : 0 });
}

async function loadReviews() {
  try {
    const data = await api("/api/reviews");
    renderReviews(data);
  } catch {
    const summary = $("#review-summary");
    if (summary) summary.textContent = "Reviews unavailable";
  }
}

async function submitReview() {
  const button = $("#btn-submit-review");
  const commentInput = $("#review-comment");
  if (!state.reviewRating) {
    await ui.alert("Choose a star rating first.", "Review");
    return;
  }
  const comment = commentInput.value.trim();
  if (comment.length < 3) {
    await ui.alert("Write at least 3 characters in your review.", "Review");
    return;
  }
  button.disabled = true;
  try {
    const editingId = state.editingReviewId;
    const result = await api(editingId ? `/api/reviews/${editingId}` : "/api/reviews", {
      method: editingId ? "PUT" : "POST",
      body: JSON.stringify({ rating: state.reviewRating, comment }),
    });
    if (!editingId && result.editToken) localStorage.setItem("review_edit_token", result.editToken);
    commentInput.value = "";
    state.reviewRating = 0;
    state.editingReviewId = null;
    await loadReviews();
    setStatus("Review submitted");
  } catch (e) {
    await ui.alert(e.message, "Review failed");
  } finally {
    button.disabled = false;
  }
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

function updateFileActionsVisibility() {
  const hasOpenFile = state.tabs.length > 0;
  $$(".file-action").forEach((button) => button.classList.toggle("hidden", !hasOpenFile));
}

function renderTabs() {
  const bar = $("#tab-bar");
  const list = $("#tabs");
  updateFileActionsVisibility();
  if (!state.tabs.length) {
    bar.classList.remove("has-tabs");
    list.innerHTML = "";
    return;
  }
  bar.classList.add("has-tabs");
  list.innerHTML = state.tabs
    .map(
      (t) => `
    <div class="editor-tab ${t.id === state.activeTabId ? "active" : ""} ${t.dirty ? "dirty" : ""} ${t.savedContent !== t.remoteContent ? "pending" : ""}"
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
    const content = data.decoded ?? (data.content ? decodeBase64Utf8(data.content) : "");
    const language = detectLanguage(path);

    const tab = {
      id,
      path,
      sha: data.sha,
      content,
      remoteContent: content,
      savedContent: content,
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
      minimap: { enabled: false },
      wordWrap: "on",
      scrollBeyondLastLine: false,
      padding: { top: 12 },
      lineNumbers: "on",
      renderLineHighlight: "line",
      cursorBlinking: "smooth",
      smoothScrolling: true,
      inlineSuggest: { enabled: true },
      quickSuggestions: { other: true, comments: false, strings: false },
      selectionHighlight: true,
      occurrencesHighlight: "singleFile",
      readOnly: false,
      domReadOnly: false,
    });

    // Explicit Select All (Ctrl/Cmd+A) — some environments swallow Monaco's default
    state.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA, () => {
      const model = state.editor.getModel();
      if (!model) return;
      state.editor.setSelection(model.getFullModelRange());
      state.editor.focus();
    });

    // Clicking the container focuses the editor (needed after Apply)
    $("#editor-container")?.addEventListener("mousedown", () => {
      state.editor?.focus();
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
  const activeTab = getActiveTab();
  if (!activeTab || !state.editor) {
    setStatus("No file open");
    return;
  }
  activeTab.content = state.editor.getValue();
  if (activeTab.dirty) {
    await ui.alert(`Save "${activeTab.path}" before committing.`, "Unsaved changes");
    return;
  }

  const pendingTabs = state.tabs.filter((tab) => tab.savedContent !== tab.remoteContent);
  if (!pendingTabs.length) {
    setStatus("No saved changes to commit");
    return;
  }

  const message = await openCommitDialog(pendingTabs);
  if (message === null || message === "") return;

  setStatus(`Committing ${pendingTabs.length} file${pendingTabs.length === 1 ? "" : "s"}...`);
  try {
    for (const tab of pendingTabs) {
      const result = await api("/api/commit", {
        method: "POST",
        body: JSON.stringify({
          owner: tab.owner,
          repo: tab.repo,
          path: tab.path,
          content: tab.savedContent,
          message,
          branch: tab.branch,
          sha: tab.sha,
        }),
      });
      tab.remoteContent = tab.savedContent;
      tab.content = tab.savedContent;
      tab.sha = result.content?.sha || tab.sha;
    }
    renderTabs();
    setStatus(`Committed ${pendingTabs.length} file${pendingTabs.length === 1 ? "" : "s"} successfully`);
  } catch (e) {
    setStatus(`Commit failed: ${e.message}`);
    await ui.alert("Commit failed: " + e.message, "Commit error");
  }
}

let commitDialogResolve = null;

function openCommitDialog(pendingTabs) {
  return new Promise((resolve) => {
    commitDialogResolve = resolve;
    const modal = $("#commit-modal");
    const input = $("#commit-message-input");
    const files = $("#commit-modal-files");
    const status = $("#commit-ai-status");
    input.value = `Update ${pendingTabs.length} file${pendingTabs.length === 1 ? "" : "s"}`;
    files.textContent = pendingTabs.map((tab) => tab.path).join(" · ");
    status.textContent = "";
    modal.classList.remove("hidden");
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

function closeCommitDialog(message) {
  $("#commit-modal")?.classList.add("hidden");
  const resolve = commitDialogResolve;
  commitDialogResolve = null;
  if (resolve) resolve(message);
}

async function generateCommitMessage() {
  const pendingTabs = state.tabs.filter((tab) => tab.savedContent !== tab.remoteContent);
  if (!pendingTabs.length) return;
  const button = $("#btn-generate-commit");
  const status = $("#commit-ai-status");
  const diffContext = pendingTabs
    .map((tab) => {
      const before = tab.remoteContent.slice(0, 5000);
      const after = tab.savedContent.slice(0, 5000);
      return `FILE: ${tab.path}\nBEFORE:\n${before}\nAFTER:\n${after}`;
    })
    .join("\n\n")
    .slice(0, 24000);

  button.disabled = true;
  status.textContent = "Generating...";
  try {
    const data = await api("/api/ai", {
      method: "POST",
      body: JSON.stringify({
        action: "chat",
        stream: false,
        prompt: "Generate one concise Git commit message for these changes. Use imperative mood, English, and a conventional type prefix when appropriate (feat:, fix:, refactor:, docs:, chore:). Output ONLY the commit message on one line, maximum 72 characters. Do not use quotes, markdown, or a period at the end.",
        context: diffContext,
      }),
    });
    if (data.quota) updateNeuronBar(data.quota);
    const generated = String(data.result || "").replace(/[\r\n]+/g, " ").trim().replace(/^['"]|['"]$/g, "");
    if (!generated) throw new Error("AI returned an empty message");
    $("#commit-message-input").value = generated.slice(0, 72);
    status.textContent = "Generated";
  } catch (e) {
    status.textContent = "Generation failed";
    await ui.alert(`Could not generate commit message: ${e.message}`, "Commit message AI");
  } finally {
    button.disabled = false;
  }
}

function saveCurrentFile() {
  const tab = getActiveTab();
  if (!tab || !state.editor) {
    setStatus("No file open");
    return;
  }
  tab.content = state.editor.getValue();
  if (!tab.dirty) {
    setStatus(`${tab.path} is already saved`);
    return;
  }
  tab.savedContent = tab.content;
  tab.dirty = false;
  renderTabs();
  setStatus(`Saved ${tab.path} locally`);
}

function closeDiff() {
  $("#diff-modal")?.classList.add("hidden");
  if (state.diffEditor) state.diffEditor.layout();
}

function showDiff() {
  const tab = getActiveTab();
  if (!tab || !state.editor || !window.monaco) {
    setStatus("No file open");
    return;
  }
  tab.content = state.editor.getValue();
  const original = monaco.editor.createModel(tab.remoteContent, tab.language);
  const modified = monaco.editor.createModel(tab.content, tab.language);
  if (!state.diffEditor) {
    state.diffEditor = monaco.editor.createDiffEditor($("#diff-editor-container"), {
      theme: state.theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      minimap: { enabled: false },
      wordWrap: "on",
      scrollBeyondLastLine: false,
      renderSideBySide: true,
      originalEditable: false,
    });
  }
  const previous = state.diffEditor.getModel();
  if (previous) {
    previous.original.dispose();
    previous.modified.dispose();
  }
  state.diffEditor.setModel({ original, modified });
  $("#diff-file-name").textContent = tab.path;
  $("#diff-modal").classList.remove("hidden");
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
  // Extract fenced blocks first (before escaping / <br> conversion)
  const blocks = [];
  const withPlaceholders = String(text || "").replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = blocks.length;
    const safeLang = (lang || "").replace(/[^\w+-]/g, "");
    blocks.push({ lang: safeLang, code: code.trim() });
    return `\u0000BLOCK${idx}\u0000`;
  });

  let html = escapeHtml(withPlaceholders);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\n/g, "<br>");

  // Restore code blocks (unescaped content goes into <code> text)
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, n) => {
    const b = blocks[Number(n)];
    if (!b) return "";
    return `<div class="code-block" data-lang="${b.lang}"><pre><code class="lang-${b.lang}">${escapeHtml(b.code)}</code></pre></div>`;
  });
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

/** Extract plain code text from a .code-block or <pre> */
function getBlockCode(blockEl) {
  const code = blockEl.querySelector("code");
  if (code) return code.textContent || "";
  const pre = blockEl.tagName === "PRE" ? blockEl : blockEl.querySelector("pre");
  return pre ? pre.textContent || "" : "";
}

/** Guess a filename from the first lines of a code block (common AI patterns) */
function guessFilenameFromCode(code, lang) {
  const lines = String(code || "").split("\n").slice(0, 6);
  for (const line of lines) {
    // // path/to/file.ext   or   # path/to/file.ext   or   <!-- file.ext -->
    let m =
      line.match(/^\s*(?:\/\/|#|--)\s+([\w./\\-]+\.\w+)\s*$/) ||
      line.match(/^\s*<!--\s*([\w./\\-]+\.\w+)\s*-->/) ||
      line.match(/^\s*(?:File|Filename|Path)\s*:\s*([\w./\\-]+\.\w+)/i) ||
      line.match(/^\s*(?:###|##)\s+([\w./\\-]+\.\w+)\s*$/);
    if (m) return m[1].replace(/\\/g, "/");
  }
  // Fallback from language tag only if unique-ish
  return null;
}

function findTabByPathHint(hint) {
  if (!hint) return null;
  const norm = hint.replace(/\\/g, "/").toLowerCase();
  const base = norm.split("/").pop();
  // Prefer exact path match, then basename match
  return (
    state.tabs.find((t) => (t.path || "").toLowerCase() === norm) ||
    state.tabs.find((t) => (t.path || "").toLowerCase().endsWith("/" + base)) ||
    state.tabs.find((t) => (t.path || "").toLowerCase().endsWith(base)) ||
    null
  );
}

function applyCodeToEditor(code, lang) {
  if (!state.editor) {
    setStatus("No editor open — buka file dulu");
    return false;
  }
  let text = (code || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    setStatus("Empty code block");
    return false;
  }

  // If AI labeled the block with a filename and that tab is open, switch to it
  const hint = guessFilenameFromCode(text, lang);
  const targetTab = findTabByPathHint(hint);
  if (targetTab && targetTab.id !== state.activeTabId) {
    activateTab(targetTab.id);
  }

  const tab = getActiveTab();
  state.editor.setValue(text);

  // Switch language if Monaco knows it
  if (lang && window.monaco) {
    const model = state.editor.getModel();
    if (model) {
      const map = {
        js: "javascript",
        ts: "typescript",
        py: "python",
        sh: "shell",
        bash: "shell",
        yml: "yaml",
        md: "markdown",
        htm: "html",
      };
      const monoLang = map[lang] || lang;
      try {
        monaco.editor.setModelLanguage(model, monoLang);
      } catch {
        /* ignore unknown lang */
      }
      if (tab) tab.language = monoLang;
    }
  }

  if (tab) {
    tab.content = text;
    tab.dirty = true;
    renderTabs();
  }
  const label = tab?.path || "editor";
  setStatus(hint && targetTab ? `Applied to ${label}` : `Applied to ${label}`);
  state.editor.focus();
  return true;
}

async function copyCodeToClipboard(code, btn) {
  const text = (code || "").replace(/\r\n/g, "\n");
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.innerHTML;
      btn.innerHTML = `<i class="fa-solid fa-check"></i> Copied`;
      btn.classList.add("copied");
      setTimeout(() => {
        btn.innerHTML = prev;
        btn.classList.remove("copied");
      }, 1500);
    }
    setStatus("Code copied");
  } catch {
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      setStatus("Code copied");
    } catch {
      setStatus("Copy failed");
    }
    document.body.removeChild(ta);
  }
}

/** Attach Copy + Apply buttons to every code block inside an assistant message */
function enhanceCodeBlocks(msgDiv) {
  const blocks = msgDiv.querySelectorAll(".code-block");
  blocks.forEach((block) => {
    if (block.querySelector(".code-actions")) return; // already enhanced

    const lang = block.getAttribute("data-lang") || "";
    const actions = document.createElement("div");
    actions.className = "code-actions";

    const langLabel = document.createElement("span");
    langLabel.className = "code-lang";
    langLabel.textContent = lang || "code";

    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "btn ghost sm code-btn";
    btnCopy.innerHTML = `<i class="fa-regular fa-copy"></i> Copy`;
    btnCopy.title = "Copy code";
    btnCopy.onclick = (e) => {
      e.stopPropagation();
      copyCodeToClipboard(getBlockCode(block), btnCopy);
    };

    const btnApply = document.createElement("button");
    btnApply.type = "button";
    btnApply.className = "btn accent sm code-btn";
    btnApply.innerHTML = `<i class="fa-solid fa-check"></i> Apply`;
    btnApply.title = "Apply this block to the active editor tab";
    btnApply.onclick = (e) => {
      e.stopPropagation();
      applyCodeToEditor(getBlockCode(block), lang);
    };

    actions.appendChild(langLabel);
    actions.appendChild(btnCopy);
    actions.appendChild(btnApply);
    block.insertBefore(actions, block.firstChild);
  });
}

function finishMessage(div, fullText) {
  div.classList.remove("streaming");
  div.innerHTML = formatMsgHtml(fullText);
  enhanceCodeBlocks(div);
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
            // Workers AI native: { response: "..." } — sometimes response is a NUMBER
            // (e.g. 0). OpenAI-compatible: { choices: [{ delta: { content: "..." } }] }
            // NEVER use `||` here — numeric 0 is falsy and would be dropped
            // (margin: 0 → margin: px, rgba(0,0,0,.2) → rgba(,,,.2), 100% → 1%).
            let raw = "";
            if (json.response !== undefined && json.response !== null) {
              raw = json.response;
            } else if (json.delta !== undefined && json.delta !== null) {
              raw = typeof json.delta === "object" ? json.delta.content ?? "" : json.delta;
            } else if (json.choices?.[0]?.delta?.content != null) {
              raw = json.choices[0].delta.content;
            }
            const chunk = String(raw);
            if (chunk.length > 0) {
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
  $("#btn-reviews")?.classList.toggle("active", name === "reviews");
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
}

// ---------- Events ----------
function bindEvents() {
  $("#btn-github-login") && ($("#btn-github-login").onclick = connectGitHub);
  $("#btn-github-login-welcome") && ($("#btn-github-login-welcome").onclick = connectGitHub);
  $("#btn-token").onclick = openTokenModal;
  $("#btn-cancel-token").onclick = closeTokenModal;
  $("#btn-save-token").onclick = saveToken;
  $("#btn-save-file").onclick = saveCurrentFile;
  $("#btn-diff").onclick = showDiff;
  $("#btn-close-diff").onclick = closeDiff;
  $("#btn-save").onclick = commitFile;
  $("#btn-generate-commit").onclick = generateCommitMessage;
  $("#btn-cancel-commit").onclick = () => closeCommitDialog(null);
  $("#btn-confirm-commit").onclick = () => closeCommitDialog($("#commit-message-input").value.trim());
  $("#commit-modal").addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCommitDialog(null);
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      closeCommitDialog($("#commit-message-input").value.trim());
    }
  });
  $("#btn-inline-toggle") && ($("#btn-inline-toggle").onclick = toggleInlineSuggest);
  $("#btn-ai-toggle").onclick = toggleAI;
  $("#btn-close-ai").onclick = () => setAIOpen(false);
  $("#btn-send-ai").onclick = sendAI;
  $("#btn-theme").onclick = toggleTheme;
  $("#btn-sidebar").onclick = toggleSidebar;
  $("#btn-sidebar-close").onclick = () => setSidebarOpen(false);
  $("#btn-reviews").onclick = () => switchView("reviews");

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
    if ($("#btn-reviews")?.classList.contains("active")) loadReviews();
    else if ($(".sidebar-header .tab.active")?.dataset.view === "repos") loadRepos();
    else if (state.currentRepo) loadTree(state.currentPath);
  };
  $("#btn-submit-review").onclick = submitReview;
  $("#btn-cancel-review-edit").onclick = cancelReviewEdit;

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

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveCurrentFile();
    }
    if (e.key === "Escape" && !$("#diff-modal")?.classList.contains("hidden")) {
      closeDiff();
    }
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

// Track whether we already forced logout for this lock session (avoid repeat)
let quotaLogoutDone = false;

function setQuotaLock(show, quota) {
  const el = $("#quota-lock");
  if (!el) return;
  el.classList.toggle("hidden", !show);

  if (!show) {
    // Unlocked — allow logout again on next lock
    quotaLogoutDone = false;
    return;
  }

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

  // Global neuron exhausted → force logout active GitHub session (once per lock)
  if (!quotaLogoutDone) {
    quotaLogoutDone = true;
    forceLogoutGitHub("Logged out · daily neuron quota reached");
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
  loadReviews();

  if (state.token) loadRepos();
  else setStatus("Lumen ready · Connect GitHub to begin");
}

init();
