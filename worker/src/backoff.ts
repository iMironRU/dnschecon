import type { WatchDefinition } from "./types.js";

export function nextAlarmDelay(def: WatchDefinition, roundNo: number): number {
  const { initial_sec, multiplier, max_sec, jitter_pct } = def.backoff;
  const base = Math.min(initial_sec * Math.pow(multiplier, roundNo), max_sec);
  const jitter = base * (jitter_pct / 100) * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(base + jitter)) * 1000;
}

export function isTimedOut(def: WatchDefinition, startedAt: number): boolean {
  return Date.now() - startedAt >= def.backoff.timeout_sec * 1000;
}

export function timeRemainingMs(def: WatchDefinition, startedAt: number): number {
  return Math.max(0, startedAt + def.backoff.timeout_sec * 1000 - Date.now());
}
