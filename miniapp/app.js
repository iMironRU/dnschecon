/* DNSChecon Mini App */

const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

// ── State ────────────────────────────────────────────────────────────────────

let currentWatchId = null;
let pollInterval = null;

// ── Screens ──────────────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ── API ───────────────────────────────────────────────────────────────────────

function getInitData() {
  return tg?.initData ?? "";
}

async function apiFetch(path, opts = {}) {
  const resp = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-InitData": getInitData(),
      ...(opts.headers ?? {}),
    },
  });
  return resp.json();
}

// ── List screen ──────────────────────────────────────────────────────────────

async function loadWatches() {
  const container = document.getElementById("watches-list");
  container.innerHTML = '<div class="loading">Loading…</div>';
  try {
    const data = await apiFetch("/api/watches");
    if (!data.ok) throw new Error(data.error);
    const watches = data.watches;
    if (!watches.length) {
      container.innerHTML = '<div class="empty">No watches yet.<br>Create one with + New Watch.</div>';
      return;
    }
    container.innerHTML = watches.map(renderWatchCard).join("");
    container.querySelectorAll(".watch-card").forEach((el) => {
      el.addEventListener("click", () => openDetail(el.dataset.id));
    });
  } catch (e) {
    container.innerHTML = `<div class="error">${e.message}</div>`;
  }
}

function renderWatchCard(w) {
  const statusLabel = {
    active: "Active",
    done: "Done ✓",
    timeout: "Timeout",
    error: "Error",
    paused: "Paused",
    unknown: "—",
  }[w.status] ?? w.status;

  const progress =
    w.matchCount !== undefined && w.total !== undefined
      ? `${w.matchCount}/${w.total} resolvers · round ${(w.roundNo ?? 0) + 1}`
      : "";

  return `
    <div class="watch-card" data-id="${w.id}">
      <div class="watch-card-header">
        <span class="watch-domain">${w.domain ?? w.id}</span>
        <span class="watch-type">${w.type ?? ""}</span>
      </div>
      <div class="watch-status status-${w.status}">${statusLabel}</div>
      ${progress ? `<div class="watch-progress">${progress}</div>` : ""}
    </div>`;
}

// ── Detail screen ─────────────────────────────────────────────────────────────

async function openDetail(id) {
  currentWatchId = id;
  showScreen("screen-detail");
  document.getElementById("detail-title").textContent = id;
  await refreshDetail();
  startPolling();
}

async function refreshDetail() {
  if (!currentWatchId) return;
  const container = document.getElementById("detail-content");
  try {
    const data = await apiFetch(`/api/watches/${currentWatchId}`);
    if (!data.ok) throw new Error(data.error);
    renderDetail(data.state);
  } catch (e) {
    container.innerHTML = `<div class="error">${e.message}</div>`;
  }
}

function renderDetail(state) {
  const def = state.definition;
  const container = document.getElementById("detail-content");
  const elapsed = Math.round((Date.now() - state.startedAt) / 1000);
  const matchCount = Object.values(state.perResolverState).filter((r) => r.result === "match").length;
  const total = state.resolvers.length;
  const pct = total > 0 ? Math.round((matchCount / total) * 100) : 0;
  const timeoutMs = def.backoff.timeout_sec * 1000;
  const remaining = Math.max(0, state.startedAt + timeoutMs - Date.now());

  document.getElementById("detail-title").textContent = `${def.domain} (${def.type})`;

  const statusClass = `status-${state.status}`;
  const statusLabel = { active: "Active", done: "Converged ✓", timeout: "Timed out", error: "Error", paused: "Paused" }[state.status] ?? state.status;

  const barClass = state.status === "done" ? "done" : state.status === "timeout" ? "timeout" : "";

  const resolverRows = state.resolvers.map((r) => {
    const rs = state.perResolverState[r.name];
    const icon = !rs ? "⬜" : rs.result === "match" ? "✅" : rs.result === "mismatch" ? "🔄" : "⚠️";
    const ttlStr = rs?.observedTtl != null ? `TTL ${rs.observedTtl}s` : "";
    const vals = rs?.observedValues?.slice(0, 2).join(", ") ?? "";
    return `
      <div class="resolver-row">
        <span class="resolver-icon">${icon}</span>
        <div class="resolver-info">
          <div class="resolver-name">${r.name}</div>
          <div class="resolver-region">${r.region}</div>
          ${vals ? `<div class="resolver-values">${vals}</div>` : ""}
        </div>
        <div class="resolver-ttl">${ttlStr}</div>
      </div>`;
  }).join("");

  container.innerHTML = `
    <div class="detail-summary">
      <div class="row"><span class="label">Status</span><span class="${statusClass}">${statusLabel}</span></div>
      <div class="row"><span class="label">Progress</span><span>${matchCount}/${total}</span></div>
      <div class="row"><span class="label">Round</span><span>${state.roundNo + 1}</span></div>
      <div class="row"><span class="label">Elapsed</span><span>${formatDuration(elapsed)}</span></div>
      ${state.status === "active" ? `<div class="row"><span class="label">Timeout in</span><span>${formatDuration(Math.round(remaining / 1000))}</span></div>` : ""}
      <div class="progress-bar-wrap">
        <div class="progress-bar ${barClass}" style="width:${pct}%"></div>
      </div>
    </div>
    <div class="resolver-grid">${resolverRows}</div>`;

  // Update action buttons
  const btnPause = document.getElementById("btn-pause");
  const btnResume = document.getElementById("btn-resume");
  const btnCancel = document.getElementById("btn-cancel");

  if (state.status === "active") {
    btnPause.classList.remove("hidden");
    btnResume.classList.add("hidden");
    btnCancel.classList.remove("hidden");
  } else if (state.status === "paused") {
    btnPause.classList.add("hidden");
    btnResume.classList.remove("hidden");
    btnCancel.classList.remove("hidden");
  } else {
    btnPause.classList.add("hidden");
    btnResume.classList.add("hidden");
    btnCancel.classList.add("hidden");
  }
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(refreshDetail, 4000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

// ── Create screen ─────────────────────────────────────────────────────────────

document.getElementById("form-create").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = document.getElementById("form-error");
  errEl.classList.add("hidden");

  const domain = document.getElementById("f-domain").value.trim();
  const type = document.getElementById("f-type").value;
  const valuesRaw = document.getElementById("f-values").value.trim();
  const match = document.getElementById("f-match").value;
  const preset = document.getElementById("f-preset").value;
  const chatId = parseInt(document.getElementById("f-chatid").value, 10);
  const precheck = document.getElementById("f-precheck").checked;

  if (!domain || !valuesRaw || !chatId) {
    showError(errEl, "Please fill in all required fields.");
    return;
  }

  const values = valuesRaw.split("\n").map((v) => v.trim()).filter(Boolean);
  const id = slugify(domain) + "-" + type.toLowerCase();

  const body = {
    id,
    domain,
    type,
    expected: { values, match },
    resolvers: preset,
    convergence: { mode: "all", confirmations: 1 },
    backoff: { schedule_sec: [30, 30, 60, 60, 120, 300, 600, 1800, 3600], hold_last: true, jitter_pct: 10, timeout_sec: 172800 },
    precheck_authoritative: precheck,
    notify: { telegram_chat_ids: [chatId], progress: "edit-in-place" },
    status: "active",
  };

  const submitBtn = e.target.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Starting…";

  try {
    const data = await apiFetch("/api/watches", { method: "POST", body: JSON.stringify(body) });
    if (!data.ok) throw new Error(data.error ?? data.message ?? "Failed");
    showScreen("screen-list");
    loadWatches();
  } catch (err) {
    showError(errEl, err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Start Watching";
  }
});

// ── Button handlers ───────────────────────────────────────────────────────────

document.getElementById("btn-new").addEventListener("click", () => showScreen("screen-create"));
document.getElementById("btn-back-create").addEventListener("click", () => showScreen("screen-list"));
document.getElementById("btn-back-detail").addEventListener("click", () => {
  stopPolling();
  currentWatchId = null;
  showScreen("screen-list");
  loadWatches();
});

document.getElementById("btn-pause").addEventListener("click", () => watchAction("pause"));
document.getElementById("btn-resume").addEventListener("click", () => watchAction("resume"));
document.getElementById("btn-cancel").addEventListener("click", () => {
  if (confirm("Cancel this watch?")) watchAction("cancel");
});

async function watchAction(action) {
  if (!currentWatchId) return;
  await apiFetch(`/api/watches/${currentWatchId}/${action}`, { method: "POST" });
  await refreshDetail();
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30);
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadWatches();
