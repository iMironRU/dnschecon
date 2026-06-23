import type { DnsType, MatchMode } from "./types.js";

interface DohAnswer {
  name: string;
  type: number;
  TTL: number;
  data: string;
}

const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;
const DNS_TYPE_CNAME = 5;
const DNS_TYPE_MX = 15;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_NS = 2;

function normalizeFqdn(s: string): string {
  return s.toLowerCase().replace(/\.?$/, ".");
}

function normalizeIpv6(s: string): string {
  // Use URL to normalize IPv6 (available in Workers)
  try {
    const url = new URL(`http://[${s}]/`);
    return url.hostname.slice(1, -1);
  } catch {
    return s.toLowerCase();
  }
}

function normalizeMx(s: string): string {
  // "10 mail.example.com." → "10 mail.example.com."
  const parts = s.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${normalizeFqdn(parts.slice(1).join(" "))}`;
  return s;
}

function normalizeTxt(s: string): string {
  // Strip surrounding quotes if present
  return s.replace(/^"|"$/g, "");
}

export function extractValues(type: DnsType, answers: DohAnswer[]): string[] {
  const typeNum = dnsTypeNum(type);

  // Flatten CNAME chain for A/AAAA
  if (type === "A" || type === "AAAA") {
    const cnames = new Map<string, string>();
    for (const a of answers) {
      if (a.type === DNS_TYPE_CNAME) cnames.set(normalizeFqdn(a.name), normalizeFqdn(a.data));
    }
    return answers
      .filter((a) => a.type === typeNum)
      .map((a) => (type === "AAAA" ? normalizeIpv6(a.data) : a.data.trim()))
      .filter(Boolean);
  }

  return answers
    .filter((a) => a.type === typeNum)
    .map((a) => {
      switch (type) {
        case "CNAME":
        case "NS":
          return normalizeFqdn(a.data);
        case "MX":
          return normalizeMx(a.data);
        case "TXT":
          return normalizeTxt(a.data);
        default:
          return a.data.trim();
      }
    })
    .filter(Boolean);
}

export function normalizeExpected(type: DnsType, values: string[]): string[] {
  return values.map((v) => {
    switch (type) {
      case "CNAME":
      case "NS":
        return normalizeFqdn(v);
      case "MX":
        return normalizeMx(v);
      case "TXT":
        return normalizeTxt(v);
      case "AAAA":
        return normalizeIpv6(v);
      default:
        return v.trim();
    }
  });
}

export function compare(
  observed: string[],
  expected: string[],
  mode: MatchMode
): boolean {
  const obs = new Set(observed);
  const exp = new Set(expected);

  if (mode === "exact-set") {
    if (obs.size !== exp.size) return false;
    for (const v of exp) if (!obs.has(v)) return false;
    return true;
  }

  // contains: expected ⊆ observed
  for (const v of exp) if (!obs.has(v)) return false;
  return true;
}

function dnsTypeNum(type: DnsType): number {
  switch (type) {
    case "A":     return DNS_TYPE_A;
    case "AAAA":  return DNS_TYPE_AAAA;
    case "CNAME": return DNS_TYPE_CNAME;
    case "MX":    return DNS_TYPE_MX;
    case "TXT":   return DNS_TYPE_TXT;
    case "NS":    return DNS_TYPE_NS;
  }
}

export function observedTtl(answers: DohAnswer[]): number | null {
  if (answers.length === 0) return null;
  return Math.min(...answers.map((a) => a.TTL));
}
