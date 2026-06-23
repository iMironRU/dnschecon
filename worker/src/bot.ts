/**
 * Bot conversation logic: /watch dialog, /list, /delete
 * State machine lives in KV (conv:{chatId}) with 10-min TTL.
 */
import type { Env } from "./types.js";
import { checkCreateLimits, registerWatch, unregisterWatch } from "./limits.js";
import { createWatchFile, deleteWatchFile } from "./github.js";

const CONV_TTL = 600; // seconds

type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";

interface ConvState {
  step: "await_domain" | "await_type" | "await_values" | "await_confirm";
  domain?: string;
  type?: RecordType;
  values?: string[];
}

// ── KV helpers ─────────────────────────────────────────────────────────────

async function getConv(chatId: number, env: Env): Promise<ConvState | null> {
  const raw = await env.DNSCHECON_KV.get(`conv:${chatId}`);
  return raw ? (JSON.parse(raw) as ConvState) : null;
}

async function setConv(chatId: number, state: ConvState, env: Env): Promise<void> {
  await env.DNSCHECON_KV.put(`conv:${chatId}`, JSON.stringify(state), {
    expirationTtl: CONV_TTL,
  });
}

async function clearConv(chatId: number, env: Env): Promise<void> {
  await env.DNSCHECON_KV.delete(`conv:${chatId}`);
}

// ── Telegram helpers ────────────────────────────────────────────────────────

async function send(
  token: string,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<number | null> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  });
  const d = (await resp.json()) as { ok: boolean; result?: { message_id: number } };
  return d.ok ? (d.result?.message_id ?? null) : null;
}

async function editText(
  token: string,
  chatId: number,
  msgId: number,
  text: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: msgId, text, parse_mode: "HTML", ...extra }),
  });
}

export async function answerCbq(token: string, cbqId: string, text?: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: cbqId, ...(text ? { text } : {}) }),
  });
}

// ── Keyboards ──────────────────────────────────────────────────────────────

const CANCEL_ROW = [{ text: "❌ Отмена", callback_data: "cancel" }];

const TYPE_KB = {
  inline_keyboard: [
    [
      { text: "A", callback_data: "type:A" },
      { text: "AAAA", callback_data: "type:AAAA" },
      { text: "CNAME", callback_data: "type:CNAME" },
    ],
    [
      { text: "MX", callback_data: "type:MX" },
      { text: "TXT", callback_data: "type:TXT" },
      { text: "NS", callback_data: "type:NS" },
    ],
    [CANCEL_ROW[0]],
  ],
};

function confirmKb() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Создать", callback_data: "confirm:yes" },
        { text: "❌ Отмена", callback_data: "cancel" },
      ],
    ],
  };
}

// ── DO access ──────────────────────────────────────────────────────────────

function getDoStub(id: string, env: Env) {
  return env.WATCH_DO.get(env.WATCH_DO.idFromName(id));
}

async function getWatchState(
  id: string,
  env: Env
): Promise<{ domain: string; type: string; status: string; roundNo: number; matchCount: number; total: number; startedAt: number } | null> {
  try {
    const stub = getDoStub(id, env);
    const resp = await stub.fetch(`https://dnschecon-internal/${id}/state`);
    const data = (await resp.json()) as {
      ok: boolean;
      state?: {
        definition: { domain: string; type: string };
        status: string;
        roundNo: number;
        startedAt: number;
        resolvers: unknown[];
        perResolverState: Record<string, { result: string }>;
      };
    };
    if (!data.ok || !data.state) return null;
    const { definition: def, status, roundNo, startedAt, resolvers, perResolverState } = data.state;
    const matchCount = Object.values(perResolverState).filter((r) => r.result === "match").length;
    const total = resolvers?.length ?? 0;
    return { domain: def.domain, type: def.type, status, roundNo, matchCount, total, startedAt };
  } catch {
    return null;
  }
}

// ── Format helpers ─────────────────────────────────────────────────────────

function statusIcon(s: string): string {
  return s === "active" ? "🔄" : s === "done" ? "✅" : s === "timeout" ? "⏰" : s === "paused" ? "⏸" : "❌";
}

function statusLabel(s: string): string {
  return (
    { active: "активен", done: "завершён", timeout: "таймаут", paused: "пауза", error: "ошибка" }[s] ?? s
  );
}

function durStr(sec: number): string {
  if (sec < 60) return `${sec} сек`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  return `${Math.floor(sec / 3600)} ч ${Math.floor((sec % 3600) / 60)} мин`;
}

// ── /watch flow ────────────────────────────────────────────────────────────

async function startWatchDialog(chatId: number, env: Env): Promise<void> {
  const check = await checkCreateLimits(chatId, env);
  if (!check.ok) {
    await send(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      check.error === "limit_watches"
        ? "⚠️ Лимит: у вас уже 10 мониторингов. Удалите один через /delete, чтобы добавить новый."
        : "⚠️ Бот переполнен — новые пользователи временно не принимаются."
    );
    return;
  }
  await setConv(chatId, { step: "await_domain" }, env);
  await send(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "📡 <b>Новый мониторинг</b>\n\nВведите домен:\n<i>Пример: app.example.com</i>",
    { reply_markup: { inline_keyboard: [CANCEL_ROW] } }
  );
}

async function handleDomainInput(chatId: number, text: string, env: Env): Promise<void> {
  const domain = text.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain.includes(".")) {
    await send(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "⚠️ Введите корректный домен, например: <code>app.example.com</code>"
    );
    return;
  }
  await setConv(chatId, { step: "await_type", domain }, env);
  await send(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    `Домен: <code>${domain}</code>\n\nВыберите тип DNS-записи:`,
    { reply_markup: TYPE_KB }
  );
}

async function handleValuesInput(chatId: number, text: string, conv: ConvState, env: Env): Promise<void> {
  const values = text.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!values.length) {
    await send(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Введите хотя бы одно ожидаемое значение.");
    return;
  }
  const updated: ConvState = { ...conv, step: "await_confirm", values };
  await setConv(chatId, updated, env);
  const summary =
    `📋 <b>Проверьте параметры:</b>\n\n` +
    `• Домен: <code>${updated.domain}</code>\n` +
    `• Тип: <b>${updated.type}</b>\n` +
    `• Ожидаемое: <code>${values.join(", ")}</code>\n` +
    `• Резолверы: global-8 (7 точек)\n\n` +
    `Создать мониторинг?`;
  await send(env.TELEGRAM_BOT_TOKEN, chatId, summary, { reply_markup: confirmKb() });
}

async function confirmCreate(chatId: number, conv: ConvState, env: Env): Promise<string> {
  const { domain, type, values } = conv;
  if (!domain || !type || !values) return "⚠️ Неполные данные. Начните заново: /watch";

  const check = await checkCreateLimits(chatId, env);
  if (!check.ok) {
    return check.error === "limit_watches"
      ? "⚠️ Лимит: у вас уже 10 мониторингов."
      : "⚠️ Бот переполнен.";
  }

  const id =
    domain.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28) +
    "-" +
    type.toLowerCase();

  const def = {
    id,
    domain,
    type,
    expected: { values, match: "exact-set" as const },
    resolvers: "preset:global-8",
    convergence: { mode: "all" as const, confirmations: 1 },
    backoff: {
      schedule_sec: [30, 30, 60, 60, 120, 300, 600, 1800, 3600],
      hold_last: true,
      jitter_pct: 10,
      timeout_sec: 172800,
    },
    precheck_authoritative: false,
    notify: { telegram_chat_ids: [chatId], progress: "edit-in-place" as const },
    status: "active" as const,
  };

  try {
    await createWatchFile(def, env);
    const stub = getDoStub(id, env);
    const resp = await stub.fetch(`https://dnschecon-internal/${id}/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    const data = (await resp.json()) as { ok: boolean; error?: string };
    if (!data.ok) return `❌ Ошибка запуска: ${data.error}`;
    await registerWatch(chatId, id, env);
    return `🚀 <b>Мониторинг запущен!</b>\n\n<code>${domain}</code> · ${type}\nПервый опрос через ~30 сек.`;
  } catch (e) {
    return `❌ Ошибка: ${e}`;
  }
}

// ── /list ──────────────────────────────────────────────────────────────────

async function handleList(chatId: number, env: Env): Promise<void> {
  const raw = await env.DNSCHECON_KV.get(`user:${chatId}`);
  const user = raw ? (JSON.parse(raw) as { watchIds: string[] }) : null;

  if (!user || !user.watchIds.length) {
    await send(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "📭 У вас нет активных мониторингов.\n\nДобавьте первый: /watch"
    );
    return;
  }

  const states = await Promise.all(user.watchIds.map((id) => getWatchState(id, env)));
  const lines: string[] = [`📋 <b>Ваши мониторинги (${user.watchIds.length}/10):</b>\n`];

  for (let i = 0; i < user.watchIds.length; i++) {
    const id = user.watchIds[i];
    const st = states[i];
    if (!st) {
      lines.push(`• <code>${id}</code> — недоступен`);
      continue;
    }
    const elapsed = Math.round((Date.now() - st.startedAt) / 1000);
    const icon = statusIcon(st.status);
    lines.push(
      `${icon} <code>${st.domain}</code> · ${st.type}\n` +
        `   ${statusLabel(st.status)} · ${st.matchCount}/${st.total} · ${durStr(elapsed)}`
    );
  }
  lines.push("\nДля удаления: /delete");
  await send(env.TELEGRAM_BOT_TOKEN, chatId, lines.join("\n"));
}

// ── /delete ────────────────────────────────────────────────────────────────

async function startDeleteDialog(chatId: number, env: Env): Promise<void> {
  const raw = await env.DNSCHECON_KV.get(`user:${chatId}`);
  const user = raw ? (JSON.parse(raw) as { watchIds: string[] }) : null;

  if (!user || !user.watchIds.length) {
    await send(env.TELEGRAM_BOT_TOKEN, chatId, "📭 Нет мониторингов для удаления.");
    return;
  }

  const states = await Promise.all(user.watchIds.map((id) => getWatchState(id, env)));
  const keyboard = user.watchIds.map((id, i) => {
    const st = states[i];
    const label = st ? `${statusIcon(st.status)} ${st.domain} · ${st.type}` : id;
    return [{ text: label, callback_data: `delete:${id}` }];
  });
  keyboard.push([CANCEL_ROW[0]]);

  await send(
    env.TELEGRAM_BOT_TOKEN,
    chatId,
    "🗑 Выберите мониторинг для удаления:",
    { reply_markup: { inline_keyboard: keyboard } }
  );
}

async function deleteWatch(id: string, chatId: number, env: Env): Promise<string> {
  try {
    const stub = getDoStub(id, env);
    await stub.fetch(`https://dnschecon-internal/${id}/cancel`, { method: "POST" }).catch(() => {});
    await deleteWatchFile(id, env);
    await unregisterWatch(chatId, id, env);
    return `✅ Мониторинг <code>${id}</code> удалён.`;
  } catch (e) {
    return `❌ Ошибка удаления: ${e}`;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function handleMessage(chatId: number, text: string, env: Env): Promise<void> {
  const t = env.TELEGRAM_BOT_TOKEN;
  const cmd = text.split("@")[0].trim();

  if (cmd === "/watch") {
    await startWatchDialog(chatId, env);
    return;
  }
  if (cmd === "/list") {
    await handleList(chatId, env);
    return;
  }
  if (cmd === "/delete") {
    await startDeleteDialog(chatId, env);
    return;
  }
  if (cmd === "/cancel") {
    await clearConv(chatId, env);
    await send(t, chatId, "Диалог отменён.");
    return;
  }

  // Conversation continuation
  const conv = await getConv(chatId, env);
  if (!conv) return;

  if (conv.step === "await_domain") {
    await handleDomainInput(chatId, text, env);
    return;
  }
  if (conv.step === "await_values") {
    await handleValuesInput(chatId, text, conv, env);
    return;
  }
}

export async function handleCallback(
  chatId: number,
  cbqId: string,
  data: string,
  msgId: number,
  env: Env
): Promise<void> {
  const t = env.TELEGRAM_BOT_TOKEN;

  if (data === "cancel") {
    await clearConv(chatId, env);
    await answerCbq(t, cbqId, "Отменено");
    await editText(t, chatId, msgId, "❌ Диалог отменён.");
    return;
  }

  if (data.startsWith("type:")) {
    const type = data.slice(5) as RecordType;
    const conv = await getConv(chatId, env);
    if (!conv || conv.step !== "await_type") {
      await answerCbq(t, cbqId);
      return;
    }
    await setConv(chatId, { ...conv, step: "await_values", type }, env);
    await answerCbq(t, cbqId, type);
    await editText(
      t, chatId, msgId,
      `Домен: <code>${conv.domain}</code> · <b>${type}</b>\n\n` +
      `Введите ожидаемые значения (каждое с новой строки):\n` +
      typeHint(type)
    );
    return;
  }

  if (data === "confirm:yes") {
    const conv = await getConv(chatId, env);
    if (!conv || conv.step !== "await_confirm") {
      await answerCbq(t, cbqId);
      return;
    }
    await clearConv(chatId, env);
    await answerCbq(t, cbqId, "Создаём…");
    await editText(t, chatId, msgId, "⏳ Создаём мониторинг…");
    const result = await confirmCreate(chatId, conv, env);
    await editText(t, chatId, msgId, result);
    return;
  }

  if (data.startsWith("delete:")) {
    const watchId = data.slice(7);
    await answerCbq(t, cbqId, "Удаляем…");
    const result = await deleteWatch(watchId, chatId, env);
    await editText(t, chatId, msgId, result);
    return;
  }

  await answerCbq(t, cbqId);
}

function typeHint(type: string): string {
  const hints: Record<string, string> = {
    A:     "<i>Пример: 1.2.3.4</i>",
    AAAA:  "<i>Пример: 2001:db8::1</i>",
    CNAME: "<i>Пример: alias.example.com</i>",
    MX:    "<i>Пример: 10 mail.example.com</i>",
    TXT:   "<i>Пример: v=spf1 include:spf.example.com ~all</i>",
    NS:    "<i>Пример: ns1.example.com</i>",
  };
  return hints[type] ?? "";
}
