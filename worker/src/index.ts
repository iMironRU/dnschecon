import type { Env, WatchDefinition } from "./types.js";
import { WatchDO } from "./watch-do.js";
import { fetchWatchDefinition, listWatchIds, createWatchFile } from "./github.js";
import { validateInitData } from "./telegram.js";
import { verifyGithubWebhook } from "./auth.js";
import { invalidateRegistryCache } from "./resolvers.js";

export { WatchDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Serve Mini App static assets
    if (pathname === "/" || pathname.startsWith("/miniapp/")) {
      return env.ASSETS.fetch(request);
    }

    // GitHub webhook
    if (pathname === "/webhook/github" && method === "POST") {
      return handleGithubWebhook(request, env);
    }

    // API routes — require Telegram initData auth
    if (pathname.startsWith("/api/")) {
      const initData = request.headers.get("X-Telegram-InitData");
      if (!initData) return unauthorized("Missing X-Telegram-InitData");
      const valid = await validateInitData(initData, env.TELEGRAM_BOT_TOKEN);
      if (!valid) return unauthorized("Invalid initData");

      return handleApi(request, env, url);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = request.method;

  // GET /api/watches
  if (pathname === "/api/watches" && method === "GET") {
    return handleListWatches(env);
  }

  // POST /api/watches (create new watch from Mini App)
  if (pathname === "/api/watches" && method === "POST") {
    return handleCreateWatch(request, env);
  }

  // Match /api/watches/:id
  const watchMatch = pathname.match(/^\/api\/watches\/([a-z0-9-]{1,40})(\/.*)?$/);
  if (!watchMatch) return notFound();

  const id = watchMatch[1];
  const sub = watchMatch[2] ?? "";

  if (method === "GET" && sub === "") {
    return handleGetWatch(id, env);
  }

  if (method === "POST" && sub === "/start") {
    return handleStartWatch(id, env);
  }

  if (method === "POST" && sub === "/pause") {
    return doAction(id, "pause", env);
  }

  if (method === "POST" && sub === "/resume") {
    return doAction(id, "resume", env);
  }

  if (method === "POST" && sub === "/cancel") {
    return doAction(id, "cancel", env);
  }

  return notFound();
}

async function handleListWatches(env: Env): Promise<Response> {
  try {
    const ids = await listWatchIds(env);
    const states = await Promise.all(
      ids.map(async (id) => {
        try {
          const stub = getDoStub(id, env);
          const resp = await stub.fetch(doUrl(id, "state"));
          const data: { ok: boolean; state?: { definition: { domain: string; type: string }; status: string; roundNo: number; perResolverState: Record<string, { result: string }> } } = await resp.json();
          if (!data.ok || !data.state) return { id, status: "unknown" };
          const { definition: def, status, roundNo, perResolverState } = data.state;
          const matchCount = Object.values(perResolverState).filter((r) => r.result === "match").length;
          const total = Object.keys(perResolverState).length;
          return { id, domain: def.domain, type: def.type, status, roundNo, matchCount, total };
        } catch {
          return { id, status: "unknown" };
        }
      })
    );
    return json({ ok: true, watches: states });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleGetWatch(id: string, env: Env): Promise<Response> {
  const stub = getDoStub(id, env);
  const resp = await stub.fetch(doUrl(id, "state"));
  return new Response(resp.body, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleStartWatch(id: string, env: Env): Promise<Response> {
  try {
    const def = await fetchWatchDefinition(id, env);
    const stub = getDoStub(id, env);
    const resp = await stub.fetch(doUrl(id, "init"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleCreateWatch(request: Request, env: Env): Promise<Response> {
  let body: Partial<WatchDefinition>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const def = applyDefaults(body);
  const err = validateWatch(def);
  if (err) return json({ ok: false, error: err }, 400);

  try {
    await createWatchFile(def, env);
    const stub = getDoStub(def.id, env);
    const resp = await stub.fetch(doUrl(def.id, "init"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function doAction(id: string, action: string, env: Env): Promise<Response> {
  const stub = getDoStub(id, env);
  const resp = await stub.fetch(doUrl(id, action), { method: "POST" });
  return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
}

async function handleGithubWebhook(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  const sig = request.headers.get("X-Hub-Signature-256") ?? "";
  const valid = await verifyGithubWebhook(body, sig, env.GITHUB_WEBHOOK_SECRET);
  if (!valid) return unauthorized("Invalid webhook signature");

  let payload: { ref?: string; commits?: Array<{ added?: string[]; modified?: string[]; removed?: string[] }> };
  try {
    payload = JSON.parse(body);
  } catch {
    return json({ ok: false, error: "invalid JSON" }, 400);
  }

  const branch = payload.ref?.replace("refs/heads/", "");
  if (branch !== env.GITHUB_BRANCH) return json({ ok: true, skipped: true });

  // Invalidate registry cache if registry changed
  const allChanged = (payload.commits ?? []).flatMap((c) => [
    ...(c.added ?? []),
    ...(c.modified ?? []),
  ]);

  if (allChanged.some((f) => f.startsWith("resolvers/"))) {
    invalidateRegistryCache();
  }

  // Find changed/added watch files
  const watchFiles = allChanged.filter((f) => f.startsWith("watches/") && f.endsWith(".yaml") && !f.startsWith("watches/.logs/"));
  const watchIds = watchFiles.map((f) => f.replace("watches/", "").replace(".yaml", ""));

  await Promise.all(
    watchIds.map(async (id) => {
      try {
        const def = await fetchWatchDefinition(id, env);
        if (def.status !== "active") return;
        const stub = getDoStub(id, env);
        await stub.fetch(doUrl(id, "init"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(def),
        });
      } catch (e) {
        console.error(`webhook: failed to init watch ${id}:`, e);
      }
    })
  );

  return json({ ok: true, activated: watchIds });
}

function getDoStub(id: string, env: Env): DurableObjectStub {
  const doId = env.WATCH_DO.idFromName(id);
  return env.WATCH_DO.get(doId);
}

function doUrl(id: string, action: string): string {
  return `https://dnschecon-internal/${id}/${action}`;
}

function applyDefaults(partial: Partial<WatchDefinition>): WatchDefinition {
  return {
    id: partial.id ?? "",
    domain: partial.domain ?? "",
    type: partial.type ?? "A",
    expected: partial.expected ?? { values: [], match: "exact-set" },
    resolvers: partial.resolvers ?? "preset:global-8",
    convergence: {
      mode: "all",
      confirmations: 1,
      ...partial.convergence,
    },
    backoff: {
      schedule_sec: [30, 30, 60, 60, 120, 300, 600, 1800, 3600],
      hold_last: true,
      jitter_pct: 10,
      timeout_sec: 172800,
      ...partial.backoff,
    },
    precheck_authoritative: partial.precheck_authoritative ?? false,
    notify: partial.notify ?? { telegram_chat_ids: [], progress: "edit-in-place" },
    status: "active",
  };
}

function validateWatch(def: WatchDefinition): string | null {
  if (!/^[a-z0-9-]{1,40}$/.test(def.id)) return "Invalid id";
  if (!def.domain) return "Missing domain";
  if (!["A", "AAAA", "CNAME", "MX", "TXT", "NS"].includes(def.type)) return "Invalid type";
  if (!def.expected.values.length) return "Expected values empty";
  if (!["exact-set", "contains"].includes(def.expected.match)) return "Invalid match mode";
  if (!def.notify.telegram_chat_ids.length) return "Missing telegram_chat_ids";
  if (def.backoff.timeout_sec < def.backoff.schedule_sec[0]) return "timeout_sec < first backoff interval";
  return null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized(message: string): Response {
  return json({ ok: false, error: message }, 401);
}

function notFound(): Response {
  return json({ ok: false, error: "not found" }, 404);
}
