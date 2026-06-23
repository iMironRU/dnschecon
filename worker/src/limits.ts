import type { Env } from "./types.js";

const MAX_USERS = 500;
const MAX_WATCHES_PER_USER = 10;

interface UserRecord {
  watchIds: string[];
  createdAt: number;
}

async function getUser(chatId: number, env: Env): Promise<UserRecord | null> {
  const raw = await env.DNSCHECON_KV.get(`user:${chatId}`);
  return raw ? (JSON.parse(raw) as UserRecord) : null;
}

async function saveUser(chatId: number, record: UserRecord, env: Env): Promise<void> {
  await env.DNSCHECON_KV.put(`user:${chatId}`, JSON.stringify(record));
}

async function getUserCount(env: Env): Promise<number> {
  const raw = await env.DNSCHECON_KV.get("meta:userCount");
  return raw ? parseInt(raw, 10) : 0;
}

export async function checkCreateLimits(
  chatId: number,
  env: Env
): Promise<{ ok: true } | { ok: false; error: "limit_watches" | "limit_users" }> {
  const user = await getUser(chatId, env);
  if (user) {
    if (user.watchIds.length >= MAX_WATCHES_PER_USER) {
      return { ok: false, error: "limit_watches" };
    }
    return { ok: true };
  }
  const count = await getUserCount(env);
  if (count >= MAX_USERS) {
    return { ok: false, error: "limit_users" };
  }
  return { ok: true };
}

export async function registerWatch(chatId: number, watchId: string, env: Env): Promise<void> {
  const user = await getUser(chatId, env);
  if (user) {
    if (!user.watchIds.includes(watchId)) {
      user.watchIds.push(watchId);
      await saveUser(chatId, user, env);
    }
  } else {
    await saveUser(chatId, { watchIds: [watchId], createdAt: Date.now() }, env);
    const count = await getUserCount(env);
    await env.DNSCHECON_KV.put("meta:userCount", String(count + 1));
  }
}

export async function unregisterWatch(chatId: number, watchId: string, env: Env): Promise<void> {
  const user = await getUser(chatId, env);
  if (!user) return;
  user.watchIds = user.watchIds.filter((id) => id !== watchId);
  await saveUser(chatId, user, env);
}
