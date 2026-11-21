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
import { ellipsisExcerpt } from "../excerpt.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

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
  /**
   * True when the member's bytes live in the companion `.unpacked` directory,
   * outside the selected archive. A packed and an unpacked entry can share a
   * path and size, so this distinguishes their otherwise identical facts.
   */
  readonly unpacked: boolean;
  /** True when the member declares the executable bit. */
  readonly executable: boolean;
  /**
   * The owning reader's parsed integrity declaration, unvalidated by this pass,
   * or null when none was declared. Retained so an integrity-bearing member is
   * never indistinguishable from one without.
   */
  readonly declaredIntegrity: {
    readonly algorithm: string;
    readonly digest: string;
  } | null;
  /** The owning reader's per-entry limitations (unknown size, integrity, ...). */
  readonly limitations: readonly string[];
}

export interface AsarClassificationContext {
  /** Paths proven reachable from the archive's own package.json. */
  readonly reachable: ReadonlySet<string>;
  /**
   * True when the pass stopped before the whole inventory, for any reason (an
   * over-budget header, the reader's listing budget, ...). It drives coverage
   * only; the caller states the specific reason through `extraLimitations`, so
   * the disclosure is never misattributed to the wrong budget.
   */
  readonly inventoryTruncated: boolean;
  /** Reader-supplied limitation details to surface first (the truncation reason). */
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
    : `${ellipsisExcerpt(text, MAX_LIMITATION_UNITS)} (${String(text.length)} units; sha256 ${sha256Hex(text)})`;

/** An unknown declared size must stay distinct from a genuine zero-byte member. */
const sizeSuffix = (entry: AsarInventoryEntry): string =>
  entry.size === null
    ? " Declared size is unknown; this is not a zero-byte member."
    : "";

/**
 * Reader-parsed source facts that distinguish two entries sharing a path and
 * size. Without them a packed entrypoint and an unpacked one — whose bytes live
 * outside the archive — would produce identical facts, so they are preserved
 * through the fact detail rather than dropped when mapping the inventory.
 */
const sourceFactsSuffix = (entry: AsarInventoryEntry): string => {
  const notes: string[] = [];
  if (entry.unpacked)
    notes.push(
      "Member is unpacked; its bytes live in the companion .unpacked directory, outside this archive, so the declared size does not bound in-archive content.",
    );
  if (entry.executable) notes.push("Declares the executable bit.");
  if (entry.declaredIntegrity !== null)
    notes.push(
      `Declares a ${entry.declaredIntegrity.algorithm} integrity digest this pass did not validate.`,
    );
  return notes.length === 0 ? "" : ` ${notes.join(" ")}`;
};

/**
 * Fixed budget on the package.json member bytes this pass decodes and parses to
 * prove reachability. A small ASAR header can still declare a package.json
 * member holding most of the archive's bytes; parsing it whole would allocate a
 * string and object tree unbounded by the header, listing or fact budgets, so
 * representation growth is charged here before allocation.
 */
export const MAX_ASAR_MANIFEST_BYTES = 8 * 1024 * 1024;
/** Maximum distinct reachable module paths retained before reachability is partial. */
export const MAX_REACHABLE_PATHS = 4096;
/** Maximum nesting of `exports` conditions walked when proving reachability. */
const MAX_EXPORTS_DEPTH = 8;

/** Proven-reachable paths plus a note when a budget left reachability partial. */
export interface AsarReachability {
  readonly reachable: ReadonlySet<string>;
  /** Present when the manifest or path budget stopped reachability short. */
  readonly limitation?: string;
}

/** Best-effort reachable module paths from an archive's own package.json bytes. */
export const reachableAsarPaths = (manifest: Buffer): AsarReachability => {
  const reachable = new Set<string>(["package.json"]);
  // Bound the parsed manifest before allocation: an inflated package.json must
  // not exhaust the pass that normalizes an inflated artifact.
  if (manifest.length > MAX_ASAR_MANIFEST_BYTES)
    return {
      reachable,
      limitation: `The archive's package.json is ${String(manifest.length)} bytes, beyond this pass's fixed ${String(MAX_ASAR_MANIFEST_BYTES)}-byte manifest budget; reachability beyond package.json is unverified.`,
    };
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest.toString("utf8"));
  } catch {
    // A malformed manifest leaves reachability unproven, never confabulated.
    return { reachable };
  }
  if (parsed === null || typeof parsed !== "object") return { reachable };
  const record = parsed as Record<string, unknown>;
  let capped = false;
  const normalize = (value: unknown): void => {
    if (typeof value !== "string") return;
    if (reachable.size >= MAX_REACHABLE_PATHS) {
      capped = true;
      return;
    }
    reachable.add(value.replace(/^\.?\//u, ""));
  };
  // `exports` may be a bare string, a conditional/subpath object, an array
  // fallback, or any nesting of these (e.g. an `{ import, require }` pair). Walk
  // the subtree in place so an entrypoint declared only in a nested condition is
  // proven reachable rather than mislabeled a decoy, bounded by the reachable-
  // path count and a fixed depth so a crafted manifest cannot drive the walk.
  const addExportPaths = (value: unknown, depth: number): void => {
    if (typeof value === "string") {
      normalize(value);
      return;
    }
    if (capped || depth >= MAX_EXPORTS_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (capped) return;
        addExportPaths(item, depth + 1);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      const exportsRecord = value as Record<string, unknown>;
      for (const key in exportsRecord) {
        if (!Object.hasOwn(exportsRecord, key)) continue;
        if (capped) return;
        addExportPaths(exportsRecord[key], depth + 1);
      }
    }
  };
  normalize(record["main"]);
  addExportPaths(record["exports"], 0);
  return capped
    ? {
        reachable,
        limitation: `Reachable module paths beyond ${String(MAX_REACHABLE_PATHS)} were not retained; reachability is partial and the remaining entries are reported unverified rather than reachable.`,
      }
    : { reachable };
};

const sizeBytes = (entry: AsarInventoryEntry): number => entry.size ?? 0;

/**
 * Ceiling for an aggregate byte total, matching the output schema's `safeCount`
 * (a non-negative safe integer). Declared member sizes are each bounded only by
 * that ceiling, so summing several can exceed it — and integer addition above
 * 2^53 is not exact. An unbounded total would be a number the output schema
 * rejects, which would discard every retained fact, so the total saturates here
 * and the over-limit state is disclosed as an explicit lower bound instead.
 */
const SAFE_BYTES_CEILING = Number.MAX_SAFE_INTEGER;

/** Add a member size to an aggregate, saturating at the reportable ceiling. */
const addSaturating = (
  total: number,
  size: number,
): { readonly total: number; readonly capped: boolean } => {
  const sum = total + size;
  return sum > SAFE_BYTES_CEILING
    ? { total: SAFE_BYTES_CEILING, capped: true }
    : { total: sum, capped: false };
};

/** Beyond this, a retained entry name is folded to a bounded, ASCII-safe sample. */
const MAX_ENTRY_NAME_UNITS = 256;

/**
 * Bound a retained entry name. A reachable or packaged entry can still carry a
 * multi-megabyte path, which must not reach the result verbatim and overflow the
 * MCP response; an over-long name is folded to a bounded sample and the exact
 * path is retained by digest, so identity stays separate from display.
 */
const boundedEntryName = (
  path: string,
  budget: NormalizerBudget,
): { readonly name: string; readonly sha256: string | null } =>
  path.length <= MAX_ENTRY_NAME_UNITS
    ? { name: path, sha256: null }
    : {
        name: canonicalizeSample(Buffer.from(path, "utf8"), budget.sampleUnits),
        sha256: canonicalizeDigest(Buffer.from(path, "utf8")),
      };

/** A note appended when an entry's path was folded, naming its exact reference. */
const foldedNameDetail = (path: string, sha256: string | null): string =>
  sha256 === null
    ? ""
    : ` Path name is ${String(path.length)} units; folded to a bounded sample, exact path retained by sha256.`;

const reachableFact = (
  entry: AsarInventoryEntry,
  budget: NormalizerBudget,
): CanonicalizeFact => {
  const bounded = boundedEntryName(entry.path, budget);
  return {
    collection: "asar-entry",
    name: bounded.name,
    classification: "behavior-relevant",
    bytes: sizeBytes(entry),
    location: null,
    sha256: bounded.sha256,
    sample: null,
    detail: `Reachable from package.json main/exports.${sizeSuffix(entry)}${sourceFactsSuffix(entry)}${foldedNameDetail(entry.path, bounded.sha256)}`,
  };
};

const unverifiedFact = (
  entry: AsarInventoryEntry,
  budget: NormalizerBudget,
): CanonicalizeFact => {
  const bounded = boundedEntryName(entry.path, budget);
  return {
    collection: "asar-entry",
    name: bounded.name,
    classification: "unverified",
    bytes: sizeBytes(entry),
    location: null,
    sha256: bounded.sha256,
    sample: null,
    detail:
      (entry.kind === "file"
        ? "Packaged entry; reachability from entrypoints unverified."
        : `${entry.kind} entry; reachability from entrypoints unverified.`) +
      sizeSuffix(entry) +
      sourceFactsSuffix(entry) +
      foldedNameDetail(entry.path, bounded.sha256),
  };
};

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
  detail: `Inventory entry with a ${String(entry.path.length)}-character path; unreferenced path inflation.${sizeSuffix(entry)}${sourceFactsSuffix(entry)}`,
});

interface InventoryState {
  readonly core: CanonicalizeFact[];
  readonly collapsed: CanonicalizeFact[];
  coreRetained: number;
  overflow: number;
  overflowBytes: number;
  overflowBytesCapped: boolean;
  readonly overflowDigest: ReturnType<typeof createHash>;
  decoyExamined: number;
  decoyRetained: number;
  decoyOverflow: number;
  decoyBytes: number;
  decoyBytesCapped: boolean;
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
  const added = addSaturating(state.overflowBytes, sizeBytes(entry));
  state.overflowBytes = added.total;
  if (added.capped) state.overflowBytesCapped = true;
  state.overflowDigest.update(
    canonicalizeDigest(Buffer.from(entry.path, "utf8")),
  );
};

/**
 * Assemble the inventory's limitations: reader-supplied notes, the owning
 * reader's per-entry notes (unknown sizes, integrity declarations) surfaced
 * rather than dropped, and an explicit over-limit disclosure when an aggregate
 * byte total saturated at the reportable ceiling.
 */
const collectInventoryLimitations = (
  entries: readonly AsarInventoryEntry[],
  context: AsarClassificationContext,
  state: InventoryState,
): string[] => {
  // The truncation reason is supplied by the caller through extraLimitations,
  // not assumed here: the pass stops for an over-budget header as well as the
  // reader's listing budget, so a fixed message would misattribute one to the
  // other. The coverage object carries the truncated flag programmatically.
  const limitations: string[] = [...(context.extraLimitations ?? [])];
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
  // Declared member sizes can sum past the output schema's safe-integer ceiling.
  // Report the saturated total as an explicit lower bound rather than emit a
  // number the schema rejects, which would discard every retained fact.
  if (state.overflowBytesCapped)
    limitations.push(
      `The collapsed inventory byte total reached this pass's reportable maximum (${String(SAFE_BYTES_CEILING)}); the true aggregate of collapsed member sizes is at least this value.`,
    );
  if (state.decoyBytesCapped)
    limitations.push(
      `The decoy inventory byte total reached this pass's reportable maximum (${String(SAFE_BYTES_CEILING)}); the true aggregate of decoy member sizes is at least this value.`,
    );
  return limitations;
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
    overflowBytesCapped: false,
    overflowDigest: createHash("sha256"),
    decoyExamined: 0,
    decoyRetained: 0,
    decoyOverflow: 0,
    decoyBytes: 0,
    decoyBytesCapped: false,
    decoyDigest: createHash("sha256"),
  };

  // Retain proven-reachable entries first, in a pass of their own, so unverified
  // members listed ahead of a real entrypoint cannot consume the fact budget and
  // push that entrypoint into the overflow digest. Reachability then wins over
  // the retention budget, not only over the decoy heuristic: both passes share
  // one `maxFacts`, but reachable entries claim it before unverified ones.
  for (const entry of entries)
    if (context.reachable.has(entry.path))
      retainOrOverflow(state, budget, entry, reachableFact(entry, budget));

  for (const entry of entries) {
    if (context.reachable.has(entry.path)) continue;
    // A long, unreferenced path reads as inflation, not a real module.
    if (entry.path.length > MAX_PLAUSIBLE_ENTRY_PATH_UNITS) {
      state.decoyExamined += 1;
      const addedDecoy = addSaturating(state.decoyBytes, sizeBytes(entry));
      state.decoyBytes = addedDecoy.total;
      if (addedDecoy.capped) state.decoyBytesCapped = true;
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
      retainOrOverflow(state, budget, entry, unverifiedFact(entry, budget));
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

  const limitations = collectInventoryLimitations(entries, context, state);

  const omitted =
    state.overflow > 0 || state.decoyExamined - state.decoyRetained > 0;
  return {
    detected_format: "asar",
    normalizer: "asar-listing",
    core: state.core,
    collapsed: state.collapsed,
    reductions,
    coverage: {
      status: context.inventoryTruncated || omitted ? "partial" : "complete",
      examined: entries.length,
      total: context.inventoryTruncated ? null : entries.length,
      truncated: context.inventoryTruncated,
    },
    limitations,
  };
};
