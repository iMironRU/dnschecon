import type { Env, WatchDefinition, WatchState } from "./types.js";

const GH_API = "https://api.github.com";

export async function fetchWatchDefinition(
  id: string,
  env: Env
): Promise<WatchDefinition> {
  const path = `watches/${id}.yaml`;
  const raw = await fetchRepoFile(path, env);
  return parseYamlWatch(raw);
}

export async function listWatchIds(env: Env): Promise<string[]> {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/watches?ref=${env.GITHUB_BRANCH}`;
  const resp = await ghFetch(url, env);
  if (!resp.ok) throw new Error(`GitHub list watches failed: ${resp.status}`);
  const items: Array<{ name: string; type: string }> = await resp.json();
  return items
    .filter((i) => i.type === "file" && i.name.endsWith(".yaml"))
    .map((i) => i.name.replace(/\.yaml$/, ""));
}

export async function writeConvergenceLog(
  state: WatchState,
  env: Env
): Promise<void> {
  const id = state.definition.id;
  const timestamp = new Date().toISOString();
  const logPath = `watches/.logs/${id}-${timestamp.replace(/[:.]/g, "-")}.json`;
  const content = JSON.stringify(
    {
      id,
      status: state.status,
      startedAt: new Date(state.startedAt).toISOString(),
      completedAt: timestamp,
      roundNo: state.roundNo,
      perResolverState: state.perResolverState,
    },
    null,
    2
  );

  await createRepoFile(logPath, content, `dnschecon: ${id} ${state.status}`, env);
}

async function fetchRepoFile(path: string, env: Env): Promise<string> {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;
  const resp = await ghFetch(url, env);
  if (!resp.ok) throw new Error(`GitHub fetch ${path} failed: ${resp.status}`);
  const data: { content: string; encoding: string } = await resp.json();
  if (data.encoding !== "base64") throw new Error(`Unexpected encoding: ${data.encoding}`);
  return atob(data.content.replace(/\n/g, ""));
}

async function createRepoFile(
  path: string,
  content: string,
  message: string,
  env: Env
): Promise<void> {
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  // GitHub requires sha when updating an existing file
  let sha: string | undefined;
  const existing = await ghFetch(`${url}?ref=${env.GITHUB_BRANCH}`, env);
  if (existing.ok) {
    const data: { sha: string } = await existing.json();
    sha = data.sha;
  }

  const body = JSON.stringify({
    message,
    content: btoa(content),
    branch: env.GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  });
  const resp = await ghFetch(url, env, { method: "PUT", body });
  if (!resp.ok && resp.status !== 201) {
    const text = await resp.text();
    throw new Error(`GitHub create file failed ${resp.status}: ${text}`);
  }
}

export async function createWatchFile(
  def: WatchDefinition,
  env: Env
): Promise<void> {
  const path = `watches/${def.id}.yaml`;
  const yaml = serializeWatchYaml(def);
  await createRepoFile(path, yaml, `dnschecon: add watch ${def.id}`, env);
}

export async function deleteWatchFile(id: string, env: Env): Promise<void> {
  const path = `watches/${id}.yaml`;
  const url = `${GH_API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;
  const existing = await ghFetch(`${url}?ref=${env.GITHUB_BRANCH}`, env);
  if (!existing.ok) return; // already gone
  const { sha }: { sha: string } = await existing.json();
  const body = JSON.stringify({
    message: `dnschecon: delete watch ${id}`,
    sha,
    branch: env.GITHUB_BRANCH,
  });
  const resp = await ghFetch(url, env, { method: "DELETE", body });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub delete failed ${resp.status}: ${text}`);
  }
}

function ghFetch(
  url: string,
  env: Env,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "DNSChecon/1.0",
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> | undefined),
    },
  });
}

function parseYamlWatch(yaml: string): WatchDefinition {
  // Minimal YAML parser for watch definitions
  // Using a simple line-by-line parser since we control the format
  // In production, bundle a proper YAML parser (js-yaml)
  // For now, delegate to the dynamic import approach
  // This is called from Worker context where we can't use Node.js require
  return parseSimpleYaml(yaml) as unknown as WatchDefinition;
}

function serializeWatchYaml(def: WatchDefinition): string {
  const lines: string[] = [
    `id: ${def.id}`,
    `domain: ${def.domain}`,
    `type: ${def.type}`,
    `expected:`,
    `  values: [${def.expected.values.map((v) => JSON.stringify(v)).join(", ")}]`,
    `  match: ${def.expected.match}`,
    `resolvers: ${typeof def.resolvers === "string" ? def.resolvers : JSON.stringify(def.resolvers)}`,
    `convergence:`,
    `  mode: ${def.convergence.mode}`,
    ...(def.convergence.quorum !== undefined ? [`  quorum: ${def.convergence.quorum}`] : []),
    `  confirmations: ${def.convergence.confirmations}`,
    `backoff:`,
    `  schedule_sec: [${def.backoff.schedule_sec.join(", ")}]`,
    `  hold_last: ${def.backoff.hold_last}`,
    `  jitter_pct: ${def.backoff.jitter_pct}`,
    `  timeout_sec: ${def.backoff.timeout_sec}`,
    ...(def.precheck_authoritative !== undefined ? [`precheck_authoritative: ${def.precheck_authoritative}`] : []),
    `notify:`,
    `  telegram_chat_ids: [${def.notify.telegram_chat_ids.join(", ")}]`,
    `  progress: ${def.notify.progress}`,
    `status: ${def.status}`,
  ];
  return lines.join("\n") + "\n";
}

function parseSimpleYaml(text: string): Record<string, unknown> {
  return parseYamlProper(text);
}

function parseYamlProper(text: string): Record<string, unknown> {
  // Simple recursive YAML parser for our specific format
  const lines = text.split("\n").filter((l) => l.trimEnd() !== "" && !l.trim().startsWith("#"));

  function getIndent(line: string): number {
    return line.length - line.trimStart().length;
  }

  function parseInlineValue(v: string): unknown {
    const t = v.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null" || t === "~") return null;
    const n = Number(t);
    if (!isNaN(n) && t !== "") return n;
    if (t.startsWith("[") && t.endsWith("]")) {
      const inner = t.slice(1, -1).trim();
      if (!inner) return [];
      // Handle quoted items
      const items: string[] = [];
      let cur = "";
      let inQuote = false;
      let quoteChar = "";
      for (const ch of inner) {
        if (!inQuote && (ch === '"' || ch === "'")) { inQuote = true; quoteChar = ch; continue; }
        if (inQuote && ch === quoteChar) { inQuote = false; items.push(cur); cur = ""; continue; }
        if (!inQuote && ch === ",") { if (cur.trim()) items.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      if (cur.trim()) items.push(cur.trim());
      return items.map((item) => parseInlineValue(item));
    }
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  }

  function parseLines(startIdx: number, baseIndent: number): [Record<string, unknown>, number] {
    const obj: Record<string, unknown> = {};
    let idx = startIdx;
    while (idx < lines.length) {
      const line = lines[idx];
      const indent = getIndent(line);
      if (indent < baseIndent) break;
      if (indent > baseIndent) { idx++; continue; }

      const colonIdx = line.indexOf(":", indent);
      if (colonIdx === -1) { idx++; continue; }
      const key = line.slice(indent, colonIdx).trim();
      const rest = line.slice(colonIdx + 1).trim();

      idx++;
      if (rest === "" || rest.startsWith("#")) {
        // Could be nested object or list
        if (idx < lines.length && getIndent(lines[idx]) > baseIndent) {
          if (lines[idx].trimStart().startsWith("- ")) {
            // Array of objects
            const arr: unknown[] = [];
            while (idx < lines.length && lines[idx].trimStart().startsWith("- ")) {
              const itemLine = lines[idx];
              const itemIndent = getIndent(itemLine);
              const itemRest = itemLine.slice(itemIndent + 2).trim();
              idx++;
              if (itemRest.includes(":")) {
                // Inline object like { name: x, provider: y }
                if (itemRest.startsWith("{") && itemRest.endsWith("}")) {
                  arr.push(parseInlineObject(itemRest));
                } else {
                  // First key of nested object
                  const subObj: Record<string, unknown> = {};
                  const [k, v] = itemRest.split(":").map((s) => s.trim());
                  subObj[k] = parseInlineValue(v);
                  while (idx < lines.length && getIndent(lines[idx]) > itemIndent) {
                    const subLine = lines[idx];
                    const subColon = subLine.indexOf(":");
                    if (subColon !== -1) {
                      const sk = subLine.slice(0, subColon).trim();
                      const sv = subLine.slice(subColon + 1).trim();
                      subObj[sk] = parseInlineValue(sv);
                    }
                    idx++;
                  }
                  arr.push(subObj);
                }
              } else {
                arr.push(parseInlineValue(itemRest));
              }
            }
            obj[key] = arr;
          } else {
            const [nested, newIdx] = parseLines(idx, getIndent(lines[idx]));
            obj[key] = nested;
            idx = newIdx;
          }
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseInlineValue(rest);
      }
    }
    return [obj, idx];
  }

  const [result] = parseLines(0, 0);
  return result;
}

function parseInlineObject(s: string): Record<string, unknown> {
  // Parse { key: val, key: val } format
  const inner = s.slice(1, -1).trim();
  const obj: Record<string, unknown> = {};
  // Split by ", " but be careful of nested values
  const pairs = inner.split(/,\s*/);
  for (const pair of pairs) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    const v = pair.slice(colonIdx + 1).trim();
    // Remove quotes
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      obj[k] = v.slice(1, -1);
    } else if (v === "null" || v === "~") {
      obj[k] = null;
    } else if (v === "true") {
      obj[k] = true;
    } else if (v === "false") {
      obj[k] = false;
    } else {
      const n = Number(v);
      obj[k] = isNaN(n) ? v : n;
    }
  }
  return obj;
}
