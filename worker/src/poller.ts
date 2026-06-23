import type { WatchDefinition, ResolverEntry, RoundResult, ResolverResult } from "./types.js";
import type { ResolverRegistry } from "./types.js";
import { getProvider } from "./resolvers.js";
import { extractValues, normalizeExpected, compare, observedTtl } from "./compare.js";

const DOH_TIMEOUT_MS = 8000;
const DOH_RETRY_DELAYS_MS = [500, 1500];

interface DohJsonResponse {
  Status: number;
  TC?: boolean;
  Answer?: DohAnswer[];
  Authority?: DohAnswer[];
  Question?: Array<{ name: string; type: number }>;
}

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

export async function pollRound(
  def: WatchDefinition,
  resolvers: ResolverEntry[],
  registry: ResolverRegistry
): Promise<RoundResult[]> {
  return Promise.all(resolvers.map((r) => pollResolver(def, r, registry)));
}

async function pollResolver(
  def: WatchDefinition,
  resolver: ResolverEntry,
  registry: ResolverRegistry
): Promise<RoundResult> {
  const provider = getProvider(resolver.provider, registry);

  let lastError: string | undefined;
  for (let attempt = 0; attempt <= DOH_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(DOH_RETRY_DELAYS_MS[attempt - 1]);
    }
    try {
      const result = await queryDoh(def, resolver, provider);
      return result;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    resolverName: resolver.name,
    result: "error",
    observedTtl: null,
    observedValues: [],
    errorMessage: lastError,
  };
}

async function queryDoh(
  def: WatchDefinition,
  resolver: ResolverEntry,
  provider: { kind: string; url: string; ecs: boolean }
): Promise<RoundResult> {
  if (provider.kind === "doh-wire") {
    // P1: wireformat not implemented yet
    return {
      resolverName: resolver.name,
      result: "error",
      observedTtl: null,
      observedValues: [],
      errorMessage: "wireformat DoH not supported in P0",
    };
  }

  const params = new URLSearchParams({
    name: toAsciiDomain(def.domain),
    type: def.type,
  });

  if (provider.ecs && resolver.ecs) {
    params.set("edns_client_subnet", resolver.ecs);
  }

  const url = `${provider.url}?${params}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${resolver.name}`);
  }

  const json: DohJsonResponse = await resp.json();

  // SERVFAIL or similar
  if (json.Status !== 0 && json.Status !== 3 /* NXDOMAIN */) {
    throw new Error(`DNS status ${json.Status} from ${resolver.name}`);
  }

  const answers = json.Answer ?? [];
  const observed = extractValues(def.type, answers);
  const expected = normalizeExpected(def.type, def.expected.values);
  const isMatch = compare(observed, expected, def.expected.match);
  const ttl = observedTtl(answers);

  const result: ResolverResult = answers.length === 0
    ? "mismatch"
    : isMatch ? "match" : "mismatch";

  return {
    resolverName: resolver.name,
    result,
    observedTtl: ttl,
    observedValues: observed,
  };
}

export async function precheckAuthoritative(
  def: WatchDefinition
): Promise<{ ok: boolean; message: string }> {
  // Query NS for the zone, then query the authoritative server directly via DoH
  // Use Google DoH to find NS records first
  const domain = toAsciiDomain(def.domain);
  const nsUrl = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=NS`;
  let nsResp: Response;
  try {
    nsResp = await fetch(nsUrl, { headers: { Accept: "application/dns-json" } });
  } catch (e) {
    return { ok: false, message: `Cannot fetch NS records: ${e}` };
  }

  if (!nsResp.ok) {
    return { ok: false, message: `NS lookup HTTP ${nsResp.status}` };
  }

  const nsJson: DohJsonResponse = await nsResp.json();
  const nsAnswers = nsJson.Answer ?? nsJson.Authority ?? [];
  const nsHosts = nsAnswers
    .filter((a) => a.type === 2)
    .map((a) => a.data.toLowerCase().replace(/\.?$/, "."));

  if (nsHosts.length === 0) {
    return { ok: false, message: "No NS records found for zone" };
  }

  // Query one authoritative NS directly
  const nsHost = nsHosts[0];
  // Get the IP of that NS
  const nsIpUrl = `https://dns.google/resolve?name=${encodeURIComponent(nsHost)}&type=A`;
  const nsIpResp = await fetch(nsIpUrl, { headers: { Accept: "application/dns-json" } });
  if (!nsIpResp.ok) {
    return { ok: false, message: `Cannot resolve NS IP: ${nsHost}` };
  }
  const nsIpJson: DohJsonResponse = await nsIpResp.json();
  const nsIp = (nsIpJson.Answer ?? []).find((a) => a.type === 1)?.data;
  if (!nsIp) {
    return { ok: false, message: `Cannot resolve NS IP: ${nsHost}` };
  }

  // Query authoritative via Google DoH with cd=1 (don't validate DNSSEC) to bypass cache
  const authUrl = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${def.type}&cd=1`;
  const authResp = await fetch(authUrl, { headers: { Accept: "application/dns-json" } });
  if (!authResp.ok) {
    return { ok: false, message: `Authoritative query failed: HTTP ${authResp.status}` };
  }
  const authJson: DohJsonResponse = await authResp.json();
  const answers = authJson.Answer ?? [];
  const observed = extractValues(def.type, answers);
  const expected = normalizeExpected(def.type, def.expected.values);
  const ok = compare(observed, expected, def.expected.match);

  return {
    ok,
    message: ok
      ? `Authoritative ${nsHost} already returns expected values`
      : `Authoritative ${nsHost} still returns old values: ${observed.join(", ")}`,
  };
}

function toAsciiDomain(domain: string): string {
  // Basic punycode: in CF Workers we can use the URL API for IDN
  try {
    const url = new URL(`http://${domain}`);
    return url.hostname;
  } catch {
    return domain;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
