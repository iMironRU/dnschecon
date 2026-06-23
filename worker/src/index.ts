import type { Env, WatchDefinition } from "./types.js";
import { WatchDO } from "./watch-do.js";
import { fetchWatchDefinition, listWatchIds, createWatchFile, deleteWatchFile } from "./github.js";
import { validateInitData } from "./telegram.js";
import { verifyGithubWebhook } from "./auth.js";
import { invalidateRegistryCache } from "./resolvers.js";
import { checkCreateLimits, registerWatch, unregisterWatch } from "./limits.js";

export { WatchDO };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // Serve Mini App static assets (everything except API and webhooks)
    if (!pathname.startsWith("/api/") && !pathname.startsWith("/webhook/")) {
      return env.ASSETS.fetch(request);
    }

    // GitHub webhook
    if (pathname === "/webhook/github" && method === "POST") {
      return handleGithubWebhook(request, env);
    }

    // Telegram bot webhook
    if (pathname === "/webhook/telegram" && method === "POST") {
      return handleTelegramWebhook(request, env);
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

  if (method === "POST" && sub === "/retry") {
    return handleStartWatch(id, env);
  }

  if (method === "DELETE" && sub === "") {
    return handleDeleteWatch(id, env);
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
          const data: { ok: boolean; state?: { definition: { domain: string; type: string }; status: string; roundNo: number; startedAt: number; perResolverState: Record<string, { result: string }> } } = await resp.json();
          if (!data.ok || !data.state) return { id, status: "unknown" };
          const { definition: def, status, roundNo, startedAt, perResolverState } = data.state;
          const matchCount = Object.values(perResolverState).filter((r) => r.result === "match").length;
          const total = Object.keys(perResolverState).length;
          return { id, domain: def.domain, type: def.type, status, roundNo, startedAt, matchCount, total };
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

  const chatId = def.notify.telegram_chat_ids[0];
  const limitCheck = await checkCreateLimits(chatId, env);
  if (!limitCheck.ok) return json({ ok: false, error: limitCheck.error }, 403);

  try {
    await createWatchFile(def, env);
    const stub = getDoStub(def.id, env);
    const resp = await stub.fetch(doUrl(def.id, "init"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    if (resp.ok || resp.status === 200) {
      await registerWatch(chatId, def.id, env);
    }
    return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function handleDeleteWatch(id: string, env: Env): Promise<Response> {
  try {
    const stub = getDoStub(id, env);
    // Get owner chatId from DO state before cancelling
    const stateResp = await stub.fetch(doUrl(id, "state")).catch(() => null);
    let chatId: number | null = null;
    if (stateResp?.ok) {
      const data: { ok: boolean; state?: { definition: { notify: { telegram_chat_ids: number[] } } } } =
        await stateResp.json();
      chatId = data.state?.definition?.notify?.telegram_chat_ids?.[0] ?? null;
    }
    await stub.fetch(doUrl(id, "cancel"), { method: "POST" }).catch(() => {});
    await deleteWatchFile(id, env);
    if (chatId) await unregisterWatch(chatId, id, env);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}

async function doAction(id: string, action: string, env: Env): Promise<Response> {
  const stub = getDoStub(id, env);
  const resp = await stub.fetch(doUrl(id, action), { method: "POST" });
  return new Response(resp.body, { status: resp.status, headers: { "Content-Type": "application/json" } });
}

const WORKER_URL = "https://dnschecon.mal-9a0.workers.dev";

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  // Verify secret token header (set when registering the webhook)
  const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const msg = update.message;
  if (!msg?.text) return new Response("OK");

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith("/start")) {
    await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: WELCOME_TEXT,
      reply_markup: {
        inline_keyboard: [[
          {
            text: "🚀 Открыть DNSChecon",
            web_app: { url: WORKER_URL },
          },
        ]],
      },
    });
  } else if (text.startsWith("/help")) {
    await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: HELP_TEXT,
      reply_markup: {
        inline_keyboard: [[
          { text: "📡 Открыть приложение", web_app: { url: WORKER_URL } },
        ]],
      },
    });
  } else if (text.startsWith("/status")) {
    await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      parse_mode: "HTML",
      text: "📋 Используй приложение для просмотра активных watch'ей.",
      reply_markup: {
        inline_keyboard: [[
          { text: "📡 Открыть DNSChecon", web_app: { url: WORKER_URL } },
        ]],
      },
    });
  }

  return new Response("OK");
}

const WELCOME_TEXT = `👋 <b>Привет! Я DNSChecon</b> — монитор распространения DNS.

Когда ты меняешь DNS-запись, новые значения расходятся по планете постепенно — разные резолверы переключаются в разное время (от секунд до 48 часов). Я слежу за этим в реальном времени и сообщу, когда <b>все регионы сошлись</b>.

<b>Как работает:</b>
① Создаёшь watch — указываешь домен, тип записи и ожидаемое значение
② Я опрашиваю резолверы по всему миру (US, EU, JP, BR, RU, AU + Cloudflare)
③ Обновляю прогресс прямо в этом чате
④ Присылаю уведомление, когда всё сошлось (или вышел таймаут)

<b>Команды:</b>
/start — это сообщение
/help — подробная справка
/status — открыть список watch'ей

👇 Нажми кнопку, чтобы начать:`;

const HELP_TEXT = `📖 <b>DNSChecon — справка</b>

<b>Типы записей:</b> A, AAAA, CNAME, MX, TXT, NS

<b>Резолверы (пресет global-8):</b>
• 🇩🇪 Google EU/DE
• 🇺🇸 Google US
• 🇯🇵 Google JP
• 🇧🇷 Google BR
• 🇷🇺 Google RU
• 🇦🇺 Google AU
• 🌐 Cloudflare (глобальный)

Geo-срез делается через <b>EDNS Client Subnet</b> — один провайдер, разные регионы, честная картина.

<b>Режимы сходимости:</b>
• <code>all</code> — ждём все резолверы
• <code>quorum</code> — достаточно N из M

<b>Backoff:</b> 30s → 30s → 60s → 60s → 2m → 5m → 10m → 30m → 1h → каждый час
Таймаут по умолчанию — 48 часов.

<b>Precheck authoritative:</b> перед стартом проверяет, что авторитарный NS уже отдаёт новое значение.`;

async function tgCall(token: string, method: string, body: unknown): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; first_name: string };
    text?: string;
  };
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
