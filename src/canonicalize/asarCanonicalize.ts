import {
  parseAsarHeaderExtents,
  parseAsarHeaderJson,
  ArtifactReaderFailure,
} from "../resources/index.js";
import {
  readAsarListing,
  type AsarListedEntry,
} from "../artifacts/AsarListing.js";
import { DEFAULT_ASAR_LISTING_ADMISSION } from "../config/asarListingAdmission.js";
import { DEFAULT_ASAR_MAX_HEADER_BYTES } from "../domain/analysisResourceLimits.js";
import {
  classifyAsarInventory,
  reachableAsarPaths,
  type AsarInventoryEntry,
  type AsarReachability,
} from "../domain/canonicalize/asarInventory.js";
import type {
  NormalizedArtifactFacts,
  NormalizerBudget,
} from "../domain/canonicalize/normalizer.js";

const JSON_START = 16;

const isJsonWhitespace = (value: number): boolean =>
  value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;

/**
 * Recognize an ASAR by its validated Pickle framing plus a header that begins
 * with an object token. This reuses the owning ASAR reader's extent checks,
 * never a second, weaker parser.
 */
export const looksLikeAsar = (bytes: Buffer): boolean => {
  if (bytes.length < JSON_START) return false;
  const extents = parseAsarHeaderExtents(
    bytes.subarray(0, JSON_START),
    bytes.length,
  );
  if (!extents.ok) return false;
  const end = Math.min(JSON_START + extents.value.jsonBytes, bytes.length);
  for (let index = JSON_START; index < end; index += 1) {
    const byte = bytes[index]!;
    if (isJsonWhitespace(byte)) continue;
    return byte === 0x7b; /* { */
  }
  return false;
};

const parseHeader = (bytes: Buffer, jsonBytes: number): unknown => {
  const end = Math.min(JSON_START + jsonBytes, bytes.length);
  // Interpret the header through the owning reader's one parser, so this path
  // cannot accept bytes the real reader would reject (bad UTF-8, duplicate
  // members) or decode them differently.
  try {
    return parseAsarHeaderJson(bytes.subarray(JSON_START, end));
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    throw new ArtifactReaderFailure(
      "format",
      "ASAR JSON header is not valid JSON",
      { cause },
    );
  }
};

const UNREADABLE_MANIFEST_LIMITATION =
  "The archive's package.json could not be read in-archive (absent, unpacked or out of range); reachability beyond package.json is unverified.";

/** Proven-reachable paths, read from the archive's own package.json member. */
const resolveReachable = (
  bytes: Buffer,
  contentBase: number,
  entries: readonly AsarListedEntry[],
): AsarReachability => {
  const manifest = entries.find(
    (entry) => entry.kind === "file" && entry.path === "package.json",
  );
  if (manifest === undefined) return { reachable: new Set() };
  // An unpacked package.json lives in the companion directory, not at an
  // in-archive offset: reading that offset would read unrelated packed bytes and
  // falsely "prove" reachability. Leave reachability unverified when we cannot
  // read the actual manifest from the archive.
  const unreadable: AsarReachability = {
    reachable: new Set(["package.json"]),
    limitation: UNREADABLE_MANIFEST_LIMITATION,
  };
  if (
    manifest.kind !== "file" ||
    manifest.unpacked ||
    manifest.packedOffset === undefined ||
    manifest.size === null
  )
    return unreadable;
  const start = contentBase + manifest.packedOffset;
  const end = start + manifest.size;
  if (!Number.isSafeInteger(start) || start < 0 || end > bytes.length)
    return unreadable;
  return reachableAsarPaths(bytes.subarray(start, end));
};

/**
 * Canonicalize an Electron .asar by reusing REA's owning ASAR reader for
 * framing, header and inventory validation, then classifying the validated
 * entries in a pure domain pass. The caller gates this on `looksLikeAsar` or an
 * explicit `asar` request.
 */
export const canonicalizeAsarBytes = async (
  bytes: Buffer,
  budget: NormalizerBudget,
  signal?: AbortSignal,
): Promise<NormalizedArtifactFacts> => {
  const extents = parseAsarHeaderExtents(
    bytes.subarray(0, JSON_START),
    bytes.length,
  );
  if (!extents.ok) throw extents.error;
  // Bound the header this pass will decode, parse and duplicate-scan before
  // allocating. This opt-in pass applies a fixed header budget it does not read
  // from settings, so the message describes that fixed cutoff rather than
  // promising a setting change that this path would ignore. Without the bound, a
  // header inflated up to the whole artifact is parsed before readAsarListing's
  // limits apply, so a deeply nested or key-dense header could exhaust memory.
  if (extents.value.headerBytes > DEFAULT_ASAR_MAX_HEADER_BYTES)
    return classifyAsarInventory([], budget, {
      reachable: new Set(),
      inventoryTruncated: true,
      extraLimitations: [
        `ASAR header is ${String(extents.value.headerBytes)} bytes, beyond this pass's fixed ${String(DEFAULT_ASAR_MAX_HEADER_BYTES)}-byte header budget; the pass does not parse a larger header, so the header structure is unverified.`,
      ],
    });
  const header = parseHeader(bytes, extents.value.jsonBytes);
  let entries: readonly AsarListedEntry[];
  try {
    entries = await readAsarListing(
      header,
      signal,
      DEFAULT_ASAR_LISTING_ADMISSION,
    );
  } catch (cause: unknown) {
    // An inflated inventory exceeds the reader's listing budget. Report an
    // explicit truncated result with the reader's own guidance, rather than let
    // the provider recommend an unrelated limit (`max_file_bytes`).
    if (cause instanceof ArtifactReaderFailure && cause.reason === "limit")
      return classifyAsarInventory([], budget, {
        reachable: new Set(),
        inventoryTruncated: true,
        extraLimitations: [cause.message],
      });
    throw cause;
  }
  const reachability = resolveReachable(
    bytes,
    8 + extents.value.headerBytes,
    entries,
  );
  const inventory: AsarInventoryEntry[] = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
    unpacked: entry.unpacked,
    executable: entry.executable,
    declaredIntegrity: entry.declaredIntegrity,
    limitations: entry.limitations,
  }));
  return classifyAsarInventory(inventory, budget, {
    reachable: reachability.reachable,
    inventoryTruncated: false,
    ...(reachability.limitation === undefined
      ? {}
      : { extraLimitations: [reachability.limitation] }),
  });
};
