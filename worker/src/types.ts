export type DnsType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "NS";
export type MatchMode = "exact-set" | "contains";
export type ConvergenceMode = "all" | "quorum";
export type WatchStatus = "active" | "done" | "timeout" | "error" | "paused";
export type ProgressMode = "off" | "edit-in-place" | "every-round";

export interface ResolverEntry {
  name: string;
  provider: string;
  ecs: string | null;
  region: string;
}

export interface WatchDefinition {
  id: string;
  domain: string;
  type: DnsType;
  expected: {
    values: string[];
    match: MatchMode;
  };
  resolvers: string | ResolverEntry[];
  convergence: {
    mode: ConvergenceMode;
    quorum?: number;
    confirmations: number;
  };
  backoff: {
    schedule_sec: number[];
    hold_last: boolean;
    jitter_pct: number;
    timeout_sec: number;
  };
  precheck_authoritative?: boolean;
  notify: {
    telegram_chat_ids: number[];
    progress: ProgressMode;
  };
  status: WatchStatus;
}

export type ResolverResult = "match" | "mismatch" | "error";

export interface ResolverState {
  result: ResolverResult;
  observedTtl: number | null;
  observedValues: string[];
  errorMessage?: string;
  lastUpdated: number;
}

export interface WatchState {
  definition: WatchDefinition;
  resolvers: ResolverEntry[];
  startedAt: number;
  roundNo: number;
  perResolverState: Record<string, ResolverState>;
  consecutiveFullRounds: number;
  status: WatchStatus;
  progressMessageId?: number;
}

export interface Env {
  WATCH_DO: DurableObjectNamespace;
  DNSCHECON_KV: KVNamespace;
  ASSETS: Fetcher;
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
}

export interface ProviderConfig {
  kind: "doh-json" | "doh-wire";
  url: string;
  ecs: boolean;
}

export interface ResolverRegistry {
  presets: Record<string, ResolverEntry[]>;
  providers: Record<string, ProviderConfig>;
}

export interface RoundResult {
  resolverName: string;
  result: ResolverResult;
  observedTtl: number | null;
  observedValues: string[];
  errorMessage?: string;
}
