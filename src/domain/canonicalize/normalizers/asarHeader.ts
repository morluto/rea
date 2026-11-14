import type {
  CanonicalizeFact,
  CanonicalizeReduction,
} from "../canonicalizeArtifact.js";
import {
  canonicalizeDigest,
  canonicalizeSample,
  type ArtifactNormalizer,
  type NormalizedArtifactFacts,
  type NormalizerBudget,
} from "../normalizer.js";

/** REA's documented default ASAR header admission budget (16 MiB). */
const ASAR_DOCUMENTED_MAX_HEADER_BYTES = 16 * 1024 * 1024;
/** Path length beyond which an inventory entry reads as inflation, not a real module. */
const MAX_PLAUSIBLE_ENTRY_PATH_UNITS = 512;
/** Multiplier bounding the pass's own entry walk against inventory inflation. */
const ENTRY_BUDGET_FACTOR = 256;
const MIN_ENTRY_BUDGET = 4096;

interface AsarHeaderLocation {
  readonly json: string;
  readonly contentBase: number;
  readonly headerBufferBytes: number;
}

/** Locate and slice the ASAR JSON header defensively; null if the framing is malformed. */
const locateHeader = (bytes: Buffer): AsarHeaderLocation | null => {
  if (bytes.length < 16 || bytes.readUInt32LE(0) !== 4) return null;
  const headerBufferBytes = bytes.readUInt32LE(4);
  const jsonLength = bytes.readUInt32LE(12);
  const jsonStart = 16;
  const jsonEnd = jsonStart + jsonLength;
  if (jsonLength === 0 || jsonEnd > bytes.length) return null;
  if (bytes[jsonStart] !== 0x7b /* { */) return null;
  return {
    json: bytes.toString("utf8", jsonStart, jsonEnd),
    contentBase: 8 + headerBufferBytes,
    headerBufferBytes,
  };
};

const recognizes = (bytes: Buffer): boolean => locateHeader(bytes) !== null;

interface AsarFileNode {
  readonly files?: Record<string, AsarFileNode>;
  readonly size?: number;
  readonly offset?: string;
  readonly unpacked?: boolean;
}

interface FlatEntry {
  readonly path: string;
  readonly isFile: boolean;
  readonly size: number;
  readonly offset: string | null;
}

const flattenEntries = (
  root: Record<string, AsarFileNode>,
  entryBudget: number,
): { readonly entries: FlatEntry[]; readonly truncated: boolean } => {
  const entries: FlatEntry[] = [];
  const stack: { readonly name: string; readonly node: AsarFileNode }[] = [];
  for (const [name, node] of Object.entries(root)) stack.push({ name, node });
  let truncated = false;
  while (stack.length > 0) {
    if (entries.length >= entryBudget) {
      truncated = true;
      break;
    }
    const { name, node } = stack.pop()!;
    if (node.files !== undefined && typeof node.files === "object") {
      entries.push({ path: name, isFile: false, size: 0, offset: null });
      for (const [childName, childNode] of Object.entries(node.files))
        stack.push({ name: `${name}/${childName}`, node: childNode });
    } else
      entries.push({
        path: name,
        isFile: true,
        size: typeof node.size === "number" ? node.size : 0,
        offset: typeof node.offset === "string" ? node.offset : null,
      });
  }
  return { entries, truncated };
};

/** Best-effort reachable module paths from the archive's own package.json. */
const reachablePaths = (
  bytes: Buffer,
  header: AsarHeaderLocation,
  entries: readonly FlatEntry[],
): ReadonlySet<string> => {
  const reachable = new Set<string>();
  const manifest = entries.find(
    (entry) => entry.isFile && entry.path === "package.json",
  );
  if (manifest?.offset === null || manifest === undefined) return reachable;
  const offset = Number(manifest.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return reachable;
  const start = header.contentBase + offset;
  const end = start + manifest.size;
  if (end > bytes.length) return reachable;
  reachable.add("package.json");
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8", start, end));
    if (parsed === null || typeof parsed !== "object") return reachable;
    const record = parsed as Record<string, unknown>;
    const normalize = (value: unknown) => {
      if (typeof value !== "string") return;
      reachable.add(value.replace(/^\.?\//u, ""));
    };
    normalize(record["main"]);
    const exports = record["exports"];
    if (typeof exports === "string") normalize(exports);
    else if (exports !== null && typeof exports === "object")
      for (const value of Object.values(exports as Record<string, unknown>))
        normalize(value);
  } catch {
    // A malformed manifest leaves reachability unproven, never confabulated.
  }
  return reachable;
};

const decoyEntryFact = (
  entry: FlatEntry,
  budget: NormalizerBudget,
): CanonicalizeFact => ({
  collection: "asar-entry",
  name: canonicalizeSample(Buffer.from(entry.path, "utf8"), budget.sampleUnits),
  classification: "decoy-unreachable",
  bytes: entry.size,
  location: null,
  sha256: canonicalizeDigest(Buffer.from(entry.path, "utf8")),
  sample: null,
  detail: `Inventory entry with a ${String(entry.path.length)}-character path; unreferenced path inflation.`,
});

const reachableEntryFact = (entry: FlatEntry): CanonicalizeFact => ({
  collection: "asar-entry",
  name: entry.path,
  classification: "behavior-relevant",
  bytes: entry.size,
  location: null,
  sha256: null,
  sample: null,
  detail: "Reachable from package.json main/exports.",
});

const unverifiedEntryFact = (entry: FlatEntry): CanonicalizeFact => ({
  collection: "asar-entry",
  name: entry.path,
  classification: "unverified",
  bytes: entry.size,
  location: null,
  sha256: null,
  sample: null,
  detail: entry.isFile
    ? "Packaged entry; reachability from entrypoints unverified."
    : "Directory entry; reachability from entrypoints unverified.",
});

const canonicalize = (
  bytes: Buffer,
  budget: NormalizerBudget,
): NormalizedArtifactFacts => {
  const header = locateHeader(bytes);
  if (header === null)
    return {
      detected_format: "asar",
      normalizer: "asar-header",
      core: [],
      collapsed: [],
      reductions: [],
      coverage: {
        status: "partial",
        examined: 0,
        total: null,
        truncated: false,
      },
      limitations: [
        "ASAR header framing was not recognized; structure unverified.",
      ],
    };

  const limitations: string[] = [];
  if (header.headerBufferBytes > ASAR_DOCUMENTED_MAX_HEADER_BYTES)
    limitations.push(
      `ASAR header is ${String(header.headerBufferBytes)} bytes, beyond REA's documented asar.max_header_bytes (${String(ASAR_DOCUMENTED_MAX_HEADER_BYTES)}); canonicalized within the pass's own read budget.`,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(header.json);
  } catch (cause) {
    return {
      detected_format: "asar",
      normalizer: "asar-header",
      core: [],
      collapsed: [],
      reductions: [],
      coverage: {
        status: "partial",
        examined: 0,
        total: null,
        truncated: false,
      },
      limitations: [
        ...limitations,
        `ASAR header JSON parse failed; inventory unverified: ${cause instanceof Error ? cause.message : "unknown error"}`,
      ],
    };
  }
  const filesRoot =
    parsed !== null &&
    typeof parsed === "object" &&
    "files" in parsed &&
    typeof (parsed as { files: unknown }).files === "object"
      ? ((parsed as { files: Record<string, AsarFileNode> }).files ?? {})
      : {};

  const entryBudget = Math.max(
    budget.maxFacts * ENTRY_BUDGET_FACTOR,
    MIN_ENTRY_BUDGET,
  );
  const { entries, truncated } = flattenEntries(filesRoot, entryBudget);
  const reachable = reachablePaths(bytes, header, entries);

  const core: CanonicalizeFact[] = [];
  const collapsed: CanonicalizeFact[] = [];
  let retainedCore = 0;
  let collapsedInventory = 0;
  let collapsedInventoryBytes = 0;
  let decoyEntries = 0;
  let decoyBytes = 0;

  for (const entry of entries) {
    if (entry.path.length > MAX_PLAUSIBLE_ENTRY_PATH_UNITS) {
      decoyEntries += 1;
      decoyBytes += entry.size;
      if (collapsed.length < budget.maxFacts)
        collapsed.push(decoyEntryFact(entry, budget));
    } else if (reachable.has(entry.path)) {
      core.push(reachableEntryFact(entry));
    } else if (retainedCore < budget.maxFacts) {
      retainedCore += 1;
      core.push(unverifiedEntryFact(entry));
    } else {
      collapsedInventory += 1;
      collapsedInventoryBytes += entry.size;
    }
  }

  const reductions: CanonicalizeReduction[] = [];
  if (collapsedInventory > 0)
    reductions.push({
      collection: "asar-entry",
      examined: retainedCore + collapsedInventory,
      retained: retainedCore,
      collapsed: collapsedInventory,
      collapsed_bytes: collapsedInventoryBytes,
      basis:
        "Inventory entries beyond the exemplar budget were counted, not retained; raise max_facts to retain more.",
    });
  if (decoyEntries > 0)
    reductions.push({
      collection: "asar-decoy",
      examined: decoyEntries,
      retained: 0,
      collapsed: decoyEntries,
      collapsed_bytes: decoyBytes,
      basis:
        "Entries with abnormally long paths were classified as unreferenced path inflation.",
    });
  if (truncated)
    limitations.push(
      `Stopped after ${String(entryBudget)} inventory entries; the remaining inventory is unverified.`,
    );

  return {
    detected_format: "asar",
    normalizer: "asar-header",
    core,
    collapsed,
    reductions,
    coverage: {
      status: truncated ? "partial" : "complete",
      examined: entries.length,
      total: truncated ? null : entries.length,
      truncated,
    },
    limitations,
  };
};

/** Canonicalize an Electron .asar by bounding the header inventory and flagging unreferenced path inflation. */
export const asarHeaderNormalizer: ArtifactNormalizer = {
  id: "asar-header",
  format: "asar",
  recognizes,
  canonicalize,
};
