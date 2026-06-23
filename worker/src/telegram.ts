import type { WatchState } from "./types.js";

const TG_API = "https://api.telegram.org";

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  parseMode = "HTML"
): Promise<number | null> {
  const resp = await fetch(`${TG_API}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
  });
  const data: { ok: boolean; result?: { message_id: number } } = await resp.json();
  return data.ok ? (data.result?.message_id ?? null) : null;
}

export async function editMessage(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  parseMode = "HTML"
): Promise<void> {
  await fetch(`${TG_API}/bot${botToken}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
    }),
  });
}

export function buildProgressText(state: WatchState): string {
  const { definition: def, perResolverState, roundNo, startedAt, status } = state;
  const matchCount = Object.values(perResolverState).filter((r) => r.result === "match").length;
  const total = state.resolvers.length;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const elapsedStr = formatDuration(elapsed);

  const lines: string[] = [
    `📡 <b>DNSChecon</b> — <code>${def.domain}</code> (${def.type})`,
    `⏱ Elapsed: ${elapsedStr} | Round: ${roundNo + 1}`,
    ``,
    `Progress: ${matchCount}/${total} resolvers converged`,
    ``,
  ];

  for (const resolver of state.resolvers) {
    const rs = perResolverState[resolver.name];
    if (!rs) {
      lines.push(`⬜ ${resolver.name} (${resolver.region}) — pending`);
      continue;
    }
    const icon = rs.result === "match" ? "✅" : rs.result === "mismatch" ? "🔄" : "⚠️";
    const ttlStr = rs.observedTtl !== null ? ` TTL=${rs.observedTtl}s` : "";
    const valStr = rs.observedValues.length > 0 ? ` → ${rs.observedValues.slice(0, 2).join(", ")}` : "";
    lines.push(`${icon} ${resolver.name} (${resolver.region})${ttlStr}${valStr}`);
  }

  if (status === "done") {
    lines.push(``, `🎉 <b>Converged!</b> All resolvers match after ${elapsedStr}`);
  } else if (status === "timeout") {
    lines.push(``, `⏰ <b>Timed out</b> after ${elapsedStr}. ${matchCount}/${total} converged.`);
  } else if (status === "error") {
    lines.push(``, `❌ <b>Error</b> — check logs`);
  }

  return lines.join("\n");
}

export function buildFinalText(state: WatchState): string {
  return buildProgressText(state);
}

export function buildPrecheckFailText(def: { domain: string; type: string }, message: string): string {
  return [
    `⚠️ <b>DNSChecon precheck failed</b>`,
    `Domain: <code>${def.domain}</code> (${def.type})`,
    ``,
    message,
    ``,
    `Watch not started. Fix the authoritative DNS and retry.`,
  ].join("\n");
}

export function buildStartText(def: { domain: string; type: string; expected: { values: string[] } }): string {
  return [
    `🚀 <b>DNSChecon started</b>`,
    `Watching <code>${def.domain}</code> (${def.type})`,
    `Expected: <code>${def.expected.values.join(", ")}</code>`,
    ``,
    `First poll in ~30s…`,
  ].join("\n");
}

export async function validateInitData(
  initData: string,
  botToken: string
): Promise<boolean> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  params.delete("hash");

  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secretKeyBytes = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(botToken));

  const hmacKey = await crypto.subtle.importKey(
    "raw",
    secretKeyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(dataCheckString));
  const computed = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return computed === hash;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
