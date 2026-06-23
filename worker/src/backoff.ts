import type { WatchDefinition } from "./types.js";

export function nextAlarmDelay(def: WatchDefinition, roundNo: number): number {
  const { schedule_sec, hold_last, jitter_pct } = def.backoff;
  const idx = roundNo < schedule_sec.length ? roundNo : hold_last ? schedule_sec.length - 1 : -1;
  if (idx < 0) return -1; // schedule exhausted without hold_last

  const base = schedule_sec[idx];
  const jitter = base * (jitter_pct / 100) * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(base + jitter)) * 1000;
}

export function isTimedOut(def: WatchDefinition, startedAt: number): boolean {
  return Date.now() - startedAt >= def.backoff.timeout_sec * 1000;
}

export function timeRemainingMs(def: WatchDefinition, startedAt: number): number {
  return Math.max(0, startedAt + def.backoff.timeout_sec * 1000 - Date.now());
}
