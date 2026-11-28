// Exploratory, unpublished contract prototype. No CLI/MCP/host registration.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

export const CONTRACT = "rea-companion-prototype-v1";
export const LIMITS = Object.freeze({ json: 65536, file: 262144, total: 1048576, files: 64, entries: 8 });
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const keys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...expected].sort().join("|");
const requireThat = (condition, tag, detail) => {
  if (!condition) throw Object.assign(new Error(detail), { tag });
};
const boundary = async (operation) => {
  try { return { ok: true, value: await operation() }; }
  catch (cause) { return { ok: false, error: { tag: cause.tag ?? "unreadable", detail: cause.message } }; }
};
const text = (bytes) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

// JSON.parse owns grammar; this bounded token walk additionally rejects duplicate
// decoded object keys (including escaped spellings) and excessive nesting.
export function strictJson(bytes) {
  requireThat(bytes.length <= LIMITS.json, "limit", "JSON exceeds byte limit");
  const source = text(bytes);
  const value = JSON.parse(source);
  const tokens = source.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? [];
  let cursor = 0;
  const visit = (depth) => {
    requireThat(depth <= 32, "limit", "JSON nesting exceeds 32");
    const token = tokens[cursor++];
    if (token === "{") {
      const seen = new Set();
      while (tokens[cursor] !== "}") {
        const key = JSON.parse(tokens[cursor++]);
        requireThat(!seen.has(key), "duplicate-key", `Duplicate key: ${key}`);
        seen.add(key);
        cursor++; // colon, already checked by JSON.parse
        visit(depth + 1);
        if (tokens[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    } else if (token === "[") {
      while (tokens[cursor] !== "]") {
        visit(depth + 1);
        if (tokens[cursor] !== ",") break;
        cursor++;
      }
      cursor++;
    }
  };
  visit(0);
  return value;
}

const component = (part) => /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== ".." &&
  !part.endsWith(".") && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part);
const relativePath = (path) => typeof path === "string" && path.length <= 240 &&
  path.split("/").every(component);
const absolutePath = (path) => {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.normalize("NFC") !== path) return false;
  const root = parse(path).root;
  // Refuse UNC/device namespaces before any filesystem call (including network shares).
  return (root === "/" || /^[a-zA-Z]:\\$/.test(root)) && path.slice(root.length).split(/[\\/]/).every((part) =>
    part.length > 0 && !/[\u0000-\u001f:]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
};
const same = (a, b) => ["dev", "ino", "size", "mode", "nlink", "mtimeNs", "ctimeNs"].every((key) => a[key] === b[key]);

// This detects observed replacements; it is not a same-user race sandbox.
// Node exposes symlinks/junctions, not every platform-specific reparse policy.
async function inspectParents(path) {
  const parents = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const state = await lstat(parent, { bigint: true });
    requireThat(state.isDirectory() && !state.isSymbolicLink(), "unsafe-path", `Unsafe directory: ${parent}`);
    parents.push([parent, state]);
    if (parent === parse(parent).root) break;
  }
  return parents;
}

async function readSelected(path, maximum) {
  requireThat(absolutePath(path), "unsafe-path", "Select a normalized absolute path");
  const parents = await inspectParents(path);
  requireThat(await realpath(path) === path, "unsafe-path", "Path spelling redirects or aliases the selected path");
  const before = await lstat(path, { bigint: true });
  requireThat(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n, "unsafe-path", "Expected an unlinked regular file");
  requireThat(before.size <= BigInt(maximum), "limit", "File exceeds byte limit");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    requireThat(same(before, await handle.stat({ bigint: true })), "changed", "File changed before read");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    requireThat(BigInt(length) === before.size && same(before, await handle.stat({ bigint: true })) &&
      same(before, await lstat(path, { bigint: true })), "changed", "File changed during read");
    for (const [parent, state] of parents) {
      requireThat(same(state, await lstat(parent, { bigint: true })), "changed", "Parent changed during read");
    }
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

function scopeValue(scope) {
  requireThat(keys(scope, ["client", "profileRoot", "reaRoot"]) &&
    ["codex", "claude_code"].includes(scope.client) && absolutePath(scope.profileRoot) && absolutePath(scope.reaRoot),
  "scope", "Select one explicit client, profile and REA root; no discovery or fallback");
  return scope;
}

function registryValue(bytes, scope) {
  scopeValue(scope);
  const registry = strictJson(bytes);
  requireThat(keys(registry, ["schemaVersion", "scope", "entries"]) && registry.schemaVersion === 1,
    "registry-schema", "Unknown or invalid registry; preserve it unchanged");
  scopeValue(registry.scope);
  requireThat(Object.keys(scope).every((key) => scope[key] === registry.scope[key]), "binding", "Registry belongs to a different selection");
  requireThat(Array.isArray(registry.entries) && registry.entries.length <= LIMITS.entries, "registry-schema", "Invalid entry count");
  const seen = new Set();
  for (const entry of registry.entries) {
    requireThat(keys(entry, ["id", "root", "manifest", "manifestDigest", "enabled", "delivery"]) && id(entry.id) &&
      absolutePath(entry.root) && relativePath(entry.manifest) && hash(entry.manifestDigest) &&
      typeof entry.enabled === "boolean" && entry.delivery === "checked-text", "registry-schema", "Invalid grant");
    const identity = `${entry.root.toLowerCase()}/${entry.manifest.toLowerCase()}`;
    requireThat(!seen.has(entry.id) && !seen.has(identity), "collision", "Duplicate registration");
    seen.add(entry.id); seen.add(identity);
  }
  return registry;
}

async function checkedPackage(entry, requestedPath) {
  const manifestBytes = await readSelected(join(entry.root, entry.manifest), LIMITS.json);
  requireThat(digest(manifestBytes) === entry.manifestDigest, "manifest-changed", "Manifest identity differs from the approved grant");
  const manifest = strictJson(manifestBytes);
  requireThat(keys(manifest, ["schemaVersion", "id", "version", "description", "entrypoint", "contract", "files"]) &&
    manifest.schemaVersion === 1, "manifest-schema", "Unknown or invalid manifest; preserve it unchanged");
  requireThat(manifest.contract === CONTRACT, "incompatible", "Unsupported integration contract");
  requireThat(manifest.id === entry.id && typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version) &&
    typeof manifest.description === "string" && manifest.description.length > 0 && manifest.description.length <= 512 &&
    relativePath(manifest.entrypoint) && manifest.files !== null && typeof manifest.files === "object" && !Array.isArray(manifest.files),
  "manifest-schema", "Invalid manifest metadata");
  const files = Object.entries(manifest.files);
  requireThat(files.length > 0 && files.length <= LIMITS.files && Object.hasOwn(manifest.files, manifest.entrypoint), "inventory", "Invalid inventory size or missing entrypoint");
  const seen = new Set();
  const prefixes = new Map();
  for (const [path, sha] of files) {
    requireThat(relativePath(path) && hash(sha) && path.toLowerCase() !== entry.manifest.toLowerCase() && !seen.has(path.toLowerCase()),
      "inventory", "Unsafe, duplicate or self-inventoried path");
    seen.add(path.toLowerCase());
    const parts = path.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join("/");
      const folded = prefix.toLowerCase();
      requireThat(!prefixes.has(folded) || prefixes.get(folded) === prefix, "inventory", "Case-colliding path components");
      prefixes.set(folded, prefix);
    }
  }
  const selected = requestedPath ?? manifest.entrypoint;
  requireThat(Object.hasOwn(manifest.files, selected), "inventory", "Requested text is not inventoried");
  let total = 0;
  const checked = new Map();
  for (const [path, sha] of files) {
    const bytes = await readSelected(join(entry.root, path), Math.min(LIMITS.file, LIMITS.total - total));
    total += bytes.length;
    requireThat(digest(bytes) === sha, "content-changed", `Inventoried content differs: ${path}`);
    checked.set(path, bytes);
  }
  // A second observation refuses updates noticed across the inventory walk.
  requireThat(digest(await readSelected(join(entry.root, entry.manifest), LIMITS.json)) === entry.manifestDigest,
    "changed", "Manifest changed across inventory read");
  for (const [path, bytes] of checked) {
    requireThat(digest(await readSelected(join(entry.root, path), LIMITS.file)) === digest(bytes), "changed", "Inventory changed across read");
  }
  text(checked.get(manifest.entrypoint));
  return { manifest, selected, bytes: checked.get(selected) };
}

// All scope arguments here are MANUAL selections. They establish no host trust.
// No public API in this prototype accepts a caller boolean as host attestation.
export const resolveManual = (input) => boundary(async () => {
  const original = await readSelected(input.registryPath, LIMITS.json);
  const registry = registryValue(original, input.scope);
  const entry = registry.entries.find((item) => item.id === input.id);
  requireThat(entry !== undefined, "not-registered", "No selected registration");
  requireThat(entry.enabled, "disabled", "Registration is disabled");
  requireThat(input.expectedIdentity === entry.manifestDigest, "identity", "Select the exact approved identity");
  requireThat(input.relevant === true, "irrelevant", "Full instructions require explicit task relevance");
  const checked = await checkedPackage(entry, input.path);
  requireThat(digest(await readSelected(input.registryPath, LIMITS.json)) === digest(original), "changed", "Registry changed during resolution");
  return { id: entry.id, identity: entry.manifestDigest, baseDirectory: entry.root, path: checked.selected,
    text: text(checked.bytes), delivery: "manual-checked-text", hostDelivery: "not-assessed" };
});

export const resolveForHost = async () => ({ ok: false, error: { tag: "binding-unavailable",
  detail: "No trusted host adapter or fresh-session delivery proof. Automatic loading remains inactive." } });

// Registration is a reviewable value transform, not a file-writing operation.
// Approval covers the complete serialized next registry and its prior bytes.
export const planRegistration = (input) => boundary(async () => {
  const registry = registryValue(input.registryBytes, input.scope);
  const existing = registry.entries.find((item) => item.id === input.entry.id);
  const entry = { ...input.entry, enabled: input.entry.enabled ?? existing?.enabled ?? false };
  const next = { ...registry, entries: [...registry.entries.filter((item) => item.id !== entry.id), entry] };
  const unchanged = existing !== undefined && Object.keys(existing).every((key) => existing[key] === entry[key]);
  const bytes = unchanged ? input.registryBytes : Buffer.from(JSON.stringify(next, null, 2) + "\n");
  registryValue(bytes, input.scope);
  await checkedPackage(entry);
  const plan = { priorDigest: digest(input.registryBytes), registryText: text(bytes) };
  return { ...plan, approvalDigest: digest(JSON.stringify(plan)) };
});

export function approvePlan(plan, currentBytes, approvedDigest) {
  const identity = digest(JSON.stringify({ priorDigest: plan.priorDigest, registryText: plan.registryText }));
  requireThat(identity === approvedDigest && identity === plan.approvalDigest && digest(currentBytes) === plan.priorDigest,
    "approval", "Approval or current registry differs from the exact plan");
  return Buffer.from(plan.registryText);
}

// Disable needs no package read and preserves an unknown registry unchanged by refusal.
export const planDisable = (registryBytes, scope, selectedId) => boundary(async () => {
  const registry = registryValue(registryBytes, scope);
  requireThat(registry.entries.some((entry) => entry.id === selectedId), "not-registered", "No selected registration");
  const unchanged = registry.entries.find((entry) => entry.id === selectedId).enabled === false;
  for (const entry of registry.entries) if (entry.id === selectedId) entry.enabled = false;
  const plan = { priorDigest: digest(registryBytes), registryText: unchanged ? text(registryBytes) : JSON.stringify(registry, null, 2) + "\n" };
  return { ...plan, approvalDigest: digest(JSON.stringify(plan)) };
});

export const health = (input) => boundary(async () => {
  const registry = registryValue(await readSelected(input.registryPath, LIMITS.json), input.scope);
  const entry = registry.entries.find((item) => item.id === input.id);
  const content = !entry?.enabled ? { status: "not-assessed" } : await boundary(() => checkedPackage(entry));
  return { canonical: "not-assessed", consent: entry?.enabled === true ? "enabled" : entry ? "disabled" : "absent",
    content: content.status ?? (content.ok ? "checked" : "suspended"), contentFailure: content.error?.tag,
    binding: "manual-selection-only", delivery: "not-assessed",
    setupUpdate: entry?.enabled ? "suspended" : "preserved", scope: input.scope };
});
