import type { ResolverEntry, ResolverRegistry, ProviderConfig, Env } from "./types.js";

const REGISTRY_KV_KEY = "resolvers:registry";
const REGISTRY_KV_TTL = 300; // 5 min cache

// Bundled at deploy time — loaded via wrangler's text_blobs or inline
// For simplicity, we store the registry YAML inline and parse it here.
// In production, the registry is deployed with the worker and fetched via KV cache.

let _registryCache: ResolverRegistry | null = null;

export async function loadRegistry(env: Env): Promise<ResolverRegistry> {
  if (_registryCache) return _registryCache;

  const cached = await env.DNSCHECON_KV.get(REGISTRY_KV_KEY, "json");
  if (cached) {
    _registryCache = cached as ResolverRegistry;
    return _registryCache;
  }

  // Fetch from GitHub (registry is part of the repo, bundled at deploy)
  // Fallback: hardcoded default registry
  const registry = getDefaultRegistry();
  await env.DNSCHECON_KV.put(REGISTRY_KV_KEY, JSON.stringify(registry), {
    expirationTtl: REGISTRY_KV_TTL,
  });
  _registryCache = registry;
  return registry;
}

export function resolveResolvers(
  resolversField: string | ResolverEntry[],
  registry: ResolverRegistry
): ResolverEntry[] {
  if (Array.isArray(resolversField)) return resolversField;

  const presetName = resolversField.replace(/^preset:/, "");
  const preset = registry.presets[presetName];
  if (!preset) throw new Error(`Unknown resolver preset: ${presetName}`);
  return preset;
}

export function getProvider(providerName: string, registry: ResolverRegistry): ProviderConfig {
  const p = registry.providers[providerName];
  if (!p) throw new Error(`Unknown provider: ${providerName}`);
  return p;
}

export function invalidateRegistryCache(): void {
  _registryCache = null;
}

function getDefaultRegistry(): ResolverRegistry {
  return {
    presets: {
      "global-8": [
        { name: "google-de",  provider: "google",     ecs: "85.214.0.0/24",  region: "EU/DE" },
        { name: "google-us",  provider: "google",     ecs: "23.252.0.0/24",  region: "US" },
        { name: "google-jp",  provider: "google",     ecs: "126.0.0.0/24",   region: "JP" },
        { name: "google-br",  provider: "google",     ecs: "200.160.0.0/24", region: "BR" },
        { name: "google-ru",  provider: "google",     ecs: "77.88.8.0/24",   region: "RU" },
        { name: "google-au",  provider: "google",     ecs: "1.128.0.0/24",   region: "AU" },
        { name: "cloudflare", provider: "cloudflare", ecs: null,             region: "GLOBAL" },
      ],
      "quick-check": [
        { name: "google-us",  provider: "google",     ecs: "23.252.0.0/24",  region: "US" },
        { name: "cloudflare", provider: "cloudflare", ecs: null,             region: "GLOBAL" },
      ],
    },
    providers: {
      google: {
        kind: "doh-json",
        url: "https://dns.google/resolve",
        ecs: true,
      },
      cloudflare: {
        kind: "doh-json",
        url: "https://cloudflare-dns.com/dns-query",
        ecs: false,
      },
      quad9: {
        kind: "doh-wire",
        url: "https://dns.quad9.net/dns-query",
        ecs: false,
      },
    },
  };
}
