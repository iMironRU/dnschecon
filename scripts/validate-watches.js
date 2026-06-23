#!/usr/bin/env node
/**
 * Validates all watch YAML files against watch.schema.json.
 * Checks:
 *  - id matches filename
 *  - resolver preset exists in registry
 *  - ECS invariant: if provider.ecs == false, resolver.ecs must be null
 *  - expected.values format matches type
 *  - backoff.timeout_sec >= first schedule_sec
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const Ajv = require("ajv");

const ROOT = path.resolve(__dirname, "..");
const WATCHES_DIR = path.join(ROOT, "watches");
const SCHEMA_FILE = path.join(ROOT, "schema", "watch.schema.json");
const REGISTRY_FILE = path.join(ROOT, "resolvers", "registry.yaml");

const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8"));
const registry = yaml.load(fs.readFileSync(REGISTRY_FILE, "utf8"));

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

// IP validation regexes
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;
const FQDN_RE = /^[a-zA-Z0-9._-]+\.?$/;

let errors = 0;

function fail(file, msg) {
  console.error(`❌ ${file}: ${msg}`);
  errors++;
}

function validateValueFormat(type, value, file) {
  switch (type) {
    case "A":
      if (!IPV4_RE.test(value)) fail(file, `expected.values: "${value}" is not a valid IPv4 for type A`);
      break;
    case "AAAA":
      if (!IPV6_RE.test(value)) fail(file, `expected.values: "${value}" is not a valid IPv6 for type AAAA`);
      break;
    case "MX": {
      const parts = value.trim().split(/\s+/);
      if (parts.length < 2 || isNaN(Number(parts[0])))
        fail(file, `expected.values: "${value}" must be "priority host" for type MX`);
      break;
    }
    case "CNAME":
    case "NS":
      if (!FQDN_RE.test(value)) fail(file, `expected.values: "${value}" must be an FQDN for type ${type}`);
      break;
    case "TXT":
      // Any string is valid
      break;
  }
}

const watchFiles = fs
  .readdirSync(WATCHES_DIR)
  .filter((f) => f.endsWith(".yaml") && !f.startsWith("."));

if (watchFiles.length === 0) {
  console.log("No watch files found — skipping validation.");
  process.exit(0);
}

for (const filename of watchFiles) {
  const filepath = path.join(WATCHES_DIR, filename);
  let doc;
  try {
    doc = yaml.load(fs.readFileSync(filepath, "utf8"));
  } catch (e) {
    fail(filename, `YAML parse error: ${e.message}`);
    continue;
  }

  // JSON Schema validation
  const valid = validate(doc);
  if (!valid) {
    for (const err of validate.errors ?? []) {
      fail(filename, `Schema: ${err.instancePath} ${err.message}`);
    }
    continue;
  }

  // id must match filename
  const expectedId = filename.replace(/\.yaml$/, "");
  if (doc.id !== expectedId) {
    fail(filename, `id "${doc.id}" must match filename "${expectedId}"`);
  }

  // Resolver preset exists
  if (typeof doc.resolvers === "string" && doc.resolvers.startsWith("preset:")) {
    const presetName = doc.resolvers.replace("preset:", "");
    if (!registry.presets[presetName]) {
      fail(filename, `resolver preset "${presetName}" not found in registry.yaml`);
    } else {
      // Check ECS invariant for each resolver in preset
      for (const r of registry.presets[presetName]) {
        const provider = registry.providers[r.provider];
        if (!provider) {
          fail(filename, `provider "${r.provider}" not found in registry.yaml`);
          continue;
        }
        if (!provider.ecs && r.ecs !== null) {
          fail(filename, `resolver "${r.name}": provider "${r.provider}" has ecs=false but resolver.ecs is "${r.ecs}" (must be null)`);
        }
      }
    }
  } else if (Array.isArray(doc.resolvers)) {
    for (const r of doc.resolvers) {
      const provider = registry.providers[r.provider];
      if (!provider) {
        fail(filename, `provider "${r.provider}" not found in registry.yaml`);
        continue;
      }
      if (!provider.ecs && r.ecs !== null) {
        fail(filename, `resolver "${r.name}": provider "${r.provider}" has ecs=false but resolver.ecs is "${r.ecs}" (must be null)`);
      }
    }
  }

  // Value format validation
  for (const v of doc.expected.values) {
    validateValueFormat(doc.type, v, filename);
  }

  // Backoff timeout >= first interval
  if (doc.backoff.timeout_sec < doc.backoff.schedule_sec[0]) {
    fail(filename, `backoff.timeout_sec (${doc.backoff.timeout_sec}) must be >= first schedule_sec (${doc.backoff.schedule_sec[0]})`);
  }

  // Quorum mode requires quorum field
  if (doc.convergence.mode === "quorum" && !doc.convergence.quorum) {
    fail(filename, `convergence.quorum is required when mode=quorum`);
  }

  if (errors === 0 || !validate.errors?.length) {
    console.log(`✅ ${filename}`);
  }
}

if (errors > 0) {
  console.error(`\n${errors} validation error(s) found.`);
  process.exit(1);
} else {
  console.log(`\nAll ${watchFiles.length} watch file(s) valid.`);
}
