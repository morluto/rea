import { createHash } from "node:crypto";

import type {
  CanonicalizeFact,
  CanonicalizeReduction,
} from "./canonicalizeArtifact.js";
import {
  canonicalizeDigest,
  canonicalizeSample,
  type NormalizedArtifactFacts,
  type NormalizerBudget,
} from "./normalizer.js";

/** Path length beyond which an inventory entry reads as inflation, not a real module. */
const MAX_PLAUSIBLE_ENTRY_PATH_UNITS = 512;

export type AsarEntryKind = "file" | "directory" | "symlink";

/**
 * One validated ASAR inventory entry, as the owning ASAR reader produced it.
 * The adapter maps the reader's richer entry down to this behavior-relevant
 * shape so classification stays a pure, format-reader-free domain concern.
 */
export interface AsarInventoryEntry {
  readonly path: string;
  readonly kind: AsarEntryKind;
  /** Declared size, or null when it cannot bound the member's content. */
  readonly size: number | null;
  /** The owning reader's per-entry limitations (unknown size, integrity, ...). */
  readonly limitations: readonly string[];
}

export interface AsarClassificationContext {
  /** Paths proven reachable from the archive's own package.json. */
  readonly reachable: ReadonlySet<string>;
  /** Declared header bytes when beyond REA's documented admission, else null. */
  readonly headerBytesOverDocumentedLimit: number | null;
  /** True when the owning reader stopped before the whole inventory. */
  readonly listingTruncated: boolean;
  /** Reader-supplied limitation details to surface first (e.g., a listing limit). */
  readonly extraLimitations?: readonly string[];
}

/** Maximum distinct per-entry limitation strings surfaced before summarizing. */
const MAX_ENTRY_LIMITATIONS = 64;
/** Maximum code units kept for one limitation note before it is retained by digest. */
const MAX_LIMITATION_UNITS = 512;

/**
 * Bound one reader-supplied limitation note. A note can embed an artifact's full
 * integrity declaration (a multi-megabyte hash), which must not reach the
 * result unbounded and overflow the MCP response budget; an oversized note is
 * shortened and retained by digest.
 */
const boundLimitation = (text: string): string =>
  text.length <= MAX_LIMITATION_UNITS
    ? text
    : `${text.slice(0, MAX_LIMITATION_UNITS)}… (${String(text.length)} units; sha256 ${createHash("sha256").update(text, "utf8").digest("hex")})`;

/** An unknown declared size must stay distinct from a genuine zero-byte member. */
const sizeSuffix = (entry: AsarInventoryEntry): string =>
  entry.size === null
    ? " Declared size is unknown; this is not a zero-byte member."
    : "";

/** Best-effort reachable module paths from an archive's own package.json bytes. */
export const reachableAsarPaths = (manifest: Buffer): ReadonlySet<string> => {
  const reachable = new Set<string>(["package.json"]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.toString("utf8"));
  } catch {
    // A malformed manifest leaves reachability unproven, never confabulated.
    return reachable;
  }
  if (parsed === null || typeof parsed !== "object") return reachable;
  const record = parsed as Record<string, unknown>;
  const normalize = (value: unknown): void => {
    if (typeof value === "string") reachable.add(value.replace(/^\.?\//u, ""));
  };
  normalize(record["main"]);
  const exports = record["exports"];
  if (typeof exports === "string") normalize(exports);
  else if (exports !== null && typeof exports === "object")
    for (const value of Object.values(exports as Record<string, unknown>))
      normalize(value);
  return reachable;
};

const sizeBytes = (entry: AsarInventoryEntry): number => entry.size ?? 0;

const reachableFact = (entry: AsarInventoryEntry): CanonicalizeFact => ({
  collection: "asar-entry",
  name: entry.path,
  classification: "behavior-relevant",
  bytes: sizeBytes(entry),
  location: null,
  sha256: null,
  sample: null,
  detail: `Reachable from package.json main/exports.${sizeSuffix(entry)}`,
});

const unverifiedFact = (entry: AsarInventoryEntry): CanonicalizeFact => ({
  collection: "asar-entry",
  name: entry.path,
  classification: "unverified",
  bytes: sizeBytes(entry),
  location: null,
  sha256: null,
  sample: null,
  detail:
    (entry.kind === "file"
      ? "Packaged entry; reachability from entrypoints unverified."
      : `${entry.kind} entry; reachability from entrypoints unverified.`) +
    sizeSuffix(entry),
});

const decoyFact = (
  entry: AsarInventoryEntry,
  budget: NormalizerBudget,
): CanonicalizeFact => ({
  collection: "asar-entry",
  name: canonicalizeSample(Buffer.from(entry.path, "utf8"), budget.sampleUnits),
  classification: "decoy-unreachable",
  bytes: sizeBytes(entry),
  location: null,
  sha256: canonicalizeDigest(Buffer.from(entry.path, "utf8")),
  sample: null,
  detail: `Inventory entry with a ${String(entry.path.length)}-character path; unreferenced path inflation.${sizeSuffix(entry)}`,
});

interface InventoryState {
  readonly core: CanonicalizeFact[];
  readonly collapsed: CanonicalizeFact[];
  coreRetained: number;
  overflow: number;
  overflowBytes: number;
  readonly overflowDigest: ReturnType<typeof createHash>;
  decoyExamined: number;
  decoyRetained: number;
  decoyOverflow: number;
  decoyBytes: number;
  readonly decoyDigest: ReturnType<typeof createHash>;
}

const retainOrOverflow = (
  state: InventoryState,
  budget: NormalizerBudget,
  entry: AsarInventoryEntry,
  fact: CanonicalizeFact,
): void => {
  if (state.coreRetained < budget.maxFacts) {
    state.coreRetained += 1;
    state.core.push(fact);
    return;
  }
  state.overflow += 1;
  state.overflowBytes += sizeBytes(entry);
  state.overflowDigest.update(
    canonicalizeDigest(Buffer.from(entry.path, "utf8")),
  );
};

/** Classify validated ASAR entries: reachable first, then path-inflation decoys. */
export const classifyAsarInventory = (
  entries: readonly AsarInventoryEntry[],
  budget: NormalizerBudget,
  context: AsarClassificationContext,
): NormalizedArtifactFacts => {
  const state: InventoryState = {
    core: [],
    collapsed: [],
    coreRetained: 0,
    overflow: 0,
    overflowBytes: 0,
    overflowDigest: createHash("sha256"),
    decoyExamined: 0,
    decoyRetained: 0,
    decoyOverflow: 0,
    decoyBytes: 0,
    decoyDigest: createHash("sha256"),
  };

  for (const entry of entries) {
    // Proven reachability wins over every heuristic, so a real entrypoint with
    // a long path is never mislabeled an unreachable decoy.
    if (context.reachable.has(entry.path)) {
      retainOrOverflow(state, budget, entry, reachableFact(entry));
    } else if (entry.path.length > MAX_PLAUSIBLE_ENTRY_PATH_UNITS) {
      state.decoyExamined += 1;
      state.decoyBytes += sizeBytes(entry);
      if (state.decoyRetained < budget.maxFacts) {
        state.decoyRetained += 1;
        state.collapsed.push(decoyFact(entry, budget));
      } else {
        state.decoyOverflow += 1;
        state.decoyDigest.update(
          canonicalizeDigest(Buffer.from(entry.path, "utf8")),
        );
      }
    } else {
      retainOrOverflow(state, budget, entry, unverifiedFact(entry));
    }
  }

  const reductions: CanonicalizeReduction[] = [];
  if (state.overflow > 0)
    reductions.push({
      collection: "asar-entry",
      examined: state.coreRetained + state.overflow,
      retained: state.coreRetained,
      collapsed: state.overflow,
      collapsed_bytes: state.overflowBytes,
      group_sha256: state.overflowDigest.digest("hex"),
      basis:
        "Inventory entries beyond the exemplar budget were counted with a group digest, not retained; raise max_facts to retain more.",
    });
  if (state.decoyExamined > 0)
    reductions.push({
      collection: "asar-decoy",
      examined: state.decoyExamined,
      retained: state.decoyRetained,
      collapsed: state.decoyExamined - state.decoyRetained,
      collapsed_bytes: state.decoyBytes,
      group_sha256:
        state.decoyOverflow > 0 ? state.decoyDigest.digest("hex") : null,
      basis:
        "Entries with abnormally long paths were classified as unreferenced path inflation.",
    });

  const limitations: string[] = [...(context.extraLimitations ?? [])];
  if (context.headerBytesOverDocumentedLimit !== null)
    limitations.push(
      `ASAR header is ${String(context.headerBytesOverDocumentedLimit)} bytes, beyond REA's documented asar.max_header_bytes; canonicalized within the pass's own read budget.`,
    );
  if (context.listingTruncated)
    limitations.push(
      "The ASAR inventory was truncated by the reader's listing budget; the remaining inventory is unverified.",
    );
  // Surface the owning reader's per-entry limitations (unknown sizes, integrity
  // declarations) rather than dropping them when mapping to facts.
  const entryLimitations = new Set<string>();
  let entryLimitationsOverflow = false;
  for (const entry of entries)
    for (const limitation of entry.limitations) {
      if (entryLimitations.size >= MAX_ENTRY_LIMITATIONS) {
        entryLimitationsOverflow = true;
        break;
      }
      entryLimitations.add(boundLimitation(limitation));
    }
  limitations.push(...entryLimitations);
  if (entryLimitationsOverflow)
    limitations.push(
      `Additional per-entry limitations beyond ${String(MAX_ENTRY_LIMITATIONS)} distinct notes were omitted.`,
    );

  const omitted =
    state.overflow > 0 || state.decoyExamined - state.decoyRetained > 0;
  return {
    detected_format: "asar",
    normalizer: "asar-listing",
    core: state.core,
    collapsed: state.collapsed,
    reductions,
    coverage: {
      status: context.listingTruncated || omitted ? "partial" : "complete",
      examined: entries.length,
      total: context.listingTruncated ? null : entries.length,
      truncated: context.listingTruncated,
    },
    limitations,
  };
};
