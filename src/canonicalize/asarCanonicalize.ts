import { parseAsarHeaderExtents } from "../artifacts/AsarHeader.js";
import {
  readAsarListing,
  type AsarListedEntry,
} from "../artifacts/AsarListing.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { DEFAULT_ASAR_LISTING_ADMISSION } from "../config/asarListingAdmission.js";
import { DEFAULT_ASAR_MAX_HEADER_BYTES } from "../domain/analysisResourceLimits.js";
import {
  classifyAsarInventory,
  reachableAsarPaths,
  type AsarInventoryEntry,
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
  try {
    return JSON.parse(bytes.toString("utf8", JSON_START, end));
  } catch (cause: unknown) {
    throw new ArtifactReaderFailure(
      "format",
      "ASAR JSON header is not valid JSON",
      { cause },
    );
  }
};

/** Proven-reachable paths, read from the archive's own package.json member. */
const resolveReachable = (
  bytes: Buffer,
  contentBase: number,
  entries: readonly AsarListedEntry[],
): ReadonlySet<string> => {
  const manifest = entries.find(
    (entry) => entry.kind === "file" && entry.path === "package.json",
  );
  if (manifest === undefined) return new Set();
  if (
    manifest.kind !== "file" ||
    manifest.packedOffset === undefined ||
    manifest.size === null
  )
    return new Set(["package.json"]);
  const start = contentBase + manifest.packedOffset;
  const end = start + manifest.size;
  if (!Number.isSafeInteger(start) || start < 0 || end > bytes.length)
    return new Set(["package.json"]);
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
  const header = parseHeader(bytes, extents.value.jsonBytes);
  const entries = await readAsarListing(
    header,
    signal,
    DEFAULT_ASAR_LISTING_ADMISSION,
  );
  const reachable = resolveReachable(
    bytes,
    8 + extents.value.headerBytes,
    entries,
  );
  const inventory: AsarInventoryEntry[] = entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    size: entry.size,
  }));
  return classifyAsarInventory(inventory, budget, {
    reachable,
    headerBytesOverDocumentedLimit:
      extents.value.headerBytes > DEFAULT_ASAR_MAX_HEADER_BYTES
        ? extents.value.headerBytes
        : null,
    listingTruncated: false,
  });
};
