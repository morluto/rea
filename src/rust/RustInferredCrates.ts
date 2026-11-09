import { setImmediate } from "node:timers/promises";

import {
  DEFAULT_MAX_RUST_INFERRED_CRATES,
  MAX_RUSTC_VERSIONS_LIMIT,
  MAX_RUST_FINGERPRINT_SCAN_BYTES,
  type RustInferredCrate,
  type RustInferredCrates,
  type RustcVersion,
  type RustcVersions,
} from "../domain/rust/rustBinary.js";
import {
  isCargoGitSlugByte,
  isCrateNameByte,
  isLowerHex,
  isRegistryOrGitSlugByte,
  isValidCargoRegistryIndex,
  parseRustcVersionBannerAt,
  splitCargoGitCheckoutSegments,
  splitCargoRegistryCrateSegment,
} from "../domain/rust/rustSourceFingerprints.js";
import type {
  BinaryContainer,
  ImageSection,
} from "../native/metadata/BinaryContainer.js";

const CARGO_TOKEN = Buffer.from("cargo");
const RUSTC_TOKEN = Buffer.from("rustc ");
const SCAN_WINDOW_BYTES = 1024 * 1024;
const CANCELLATION_STRIDE = 512;
const MAX_TRACKED_INFERRED_CRATES = 100_000;
const MAX_TRACKED_RUSTC_VERSIONS = 1024;
const ELF_SHT_PROGBITS = 1;
const ELF_SHF_WRITE = 1n;
const ELF_SHF_EXECINSTR = 4n;

export interface FileByteRange {
  readonly offset: number;
  readonly end: number;
}

export interface RecoveredRustSourceFingerprints {
  readonly inferred_crates: RustInferredCrates;
  readonly rustc_versions: RustcVersions;
}

interface MutableInferredCrate {
  readonly name: string;
  readonly version: string | null;
  readonly source_kind: "registry" | "git";
  readonly registry_index: string | null;
  readonly checkout_id: string | null;
  readonly revision: string | null;
  readonly first_file_offset: number;
  reference_count: number;
  readonly retained: boolean;
}

interface MutableRustcVersion {
  readonly banner: string;
  readonly version: string;
  readonly channel: RustcVersion["channel"];
  readonly commit_hash: string | null;
  readonly commit_date: string | null;
  readonly first_file_offset: number;
  reference_count: number;
  readonly retained: boolean;
}

/** Merge overlapping or adjacent file ranges and clamp to `fileBytes`. */
export const mergedReadOnlyFileRanges = (
  ranges: readonly { readonly offset: number; readonly size: number }[],
  fileBytes?: number,
): FileByteRange[] => {
  const sorted = ranges
    .filter(
      ({ offset, size }) =>
        offset >= 0 &&
        size > 0 &&
        (fileBytes === undefined || offset < fileBytes),
    )
    .map(({ offset, size }) => ({
      offset,
      end:
        fileBytes === undefined
          ? offset + size
          : Math.min(fileBytes, offset + size),
    }))
    .filter(({ offset, end }) => end > offset)
    .sort((left, right) => left.offset - right.offset);
  const merged: { offset: number; end: number }[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.offset <= last.end)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
};

const isSafeElfCommentSection = (section: ImageSection): boolean =>
  section.format === "elf" &&
  section.name === ".comment" &&
  section.type === ELF_SHT_PROGBITS &&
  section.file_backed &&
  !section.compressed &&
  (section.flags & ELF_SHF_WRITE) === 0n &&
  (section.flags & ELF_SHF_EXECINSTR) === 0n;

const candidateFingerprintRanges = (
  bytes: Buffer,
  container: BinaryContainer,
): FileByteRange[] => {
  const sections = container.sections
    .filter((section) => section.read_only || isSafeElfCommentSection(section))
    .map(({ offset, size }) => ({ offset, size }));
  const loadRegions =
    container.format === "elf"
      ? (container.load_regions ?? [])
          .filter((region) => region.read && !region.write && !region.execute)
          .map(({ mapping }) => mapping)
      : [];
  return mergedReadOnlyFileRanges([...sections, ...loadRegions], bytes.length);
};

const isPathSeparator = (byte: number): boolean =>
  byte === 0x2f || byte === 0x5c;

const isPathBoundaryDelimiter = (byte: number): boolean =>
  isPathSeparator(byte) ||
  byte <= 0x20 ||
  byte === 0x22 ||
  byte === 0x27 ||
  byte === 0x28 ||
  byte === 0x3a ||
  byte === 0x3d;

const hasCargoPathBoundary = (region: Uint8Array, start: number): boolean => {
  if (start === 0) return true;
  const previous = region[start - 1] ?? 0;
  if (isPathBoundaryDelimiter(previous)) return true;
  if (previous === 0x2e) {
    return start === 1 || isPathBoundaryDelimiter(region[start - 2] ?? 0);
  }
  return false;
};

const matchesAscii = (
  region: Uint8Array,
  offset: number,
  literal: string,
): boolean => {
  if (offset + literal.length > region.length) return false;
  for (let index = 0; index < literal.length; index += 1) {
    if (region[offset + index] !== literal.charCodeAt(index)) return false;
  }
  return true;
};

const isRegistryCrateDirByte = (byte: number): boolean =>
  isCrateNameByte(byte) || byte === 0x2e || byte === 0x2b;

type ParsedCargoCrateCandidate = Omit<
  RustInferredCrate,
  "first_file_offset" | "reference_count"
>;

const parseCargoCrateAt = (
  region: Buffer,
  start: number,
): ParsedCargoCrateCandidate | null => {
  if (!hasCargoPathBoundary(region, start)) return null;
  const afterCargo = start + CARGO_TOKEN.length;
  if (afterCargo >= region.length || !isPathSeparator(region[afterCargo] ?? 0))
    return null;
  const kindStart = afterCargo + 1;
  if (
    matchesAscii(region, kindStart, "registry") &&
    isPathSeparator(region[kindStart + 8] ?? 0) &&
    matchesAscii(region, kindStart + 9, "src") &&
    isPathSeparator(region[kindStart + 12] ?? 0)
  ) {
    const indexStart = kindStart + 13;
    let indexEnd = indexStart;
    const maxIndexEnd = Math.min(region.length, indexStart + 129);
    while (
      indexEnd < maxIndexEnd &&
      isRegistryOrGitSlugByte(region[indexEnd] ?? 0)
    )
      indexEnd += 1;
    if (
      indexEnd === indexStart ||
      indexEnd - indexStart > 128 ||
      !isPathSeparator(region[indexEnd] ?? 0)
    )
      return null;
    const registryIndex = region.toString("latin1", indexStart, indexEnd);
    if (!isValidCargoRegistryIndex(registryIndex)) return null;

    const crateStart = indexEnd + 1;
    let crateEnd = crateStart;
    const maxCrateEnd = Math.min(region.length, crateStart + 258);
    while (
      crateEnd < maxCrateEnd &&
      isRegistryCrateDirByte(region[crateEnd] ?? 0)
    )
      crateEnd += 1;
    if (
      crateEnd - crateStart < 7 ||
      crateEnd - crateStart > 257 ||
      !isPathSeparator(region[crateEnd] ?? 0)
    )
      return null;
    const split = splitCargoRegistryCrateSegment(
      region.toString("latin1", crateStart, crateEnd),
    );
    if (split === null) return null;
    return {
      name: split.name,
      version: split.version,
      source_kind: "registry",
      registry_index: registryIndex,
      checkout_id: null,
      revision: null,
    };
  }

  if (
    matchesAscii(region, kindStart, "git") &&
    isPathSeparator(region[kindStart + 3] ?? 0) &&
    matchesAscii(region, kindStart + 4, "checkouts") &&
    isPathSeparator(region[kindStart + 13] ?? 0)
  ) {
    const checkoutStart = kindStart + 14;
    let checkoutEnd = checkoutStart;
    const maxCheckoutEnd = Math.min(region.length, checkoutStart + 146);
    while (
      checkoutEnd < maxCheckoutEnd &&
      isCargoGitSlugByte(region[checkoutEnd] ?? 0)
    )
      checkoutEnd += 1;
    if (
      checkoutEnd - checkoutStart < 18 ||
      checkoutEnd - checkoutStart > 145 ||
      !isPathSeparator(region[checkoutEnd] ?? 0)
    )
      return null;
    const revStart = checkoutEnd + 1;
    let revEnd = revStart;
    const maxRevEnd = Math.min(region.length, revStart + 41);
    while (revEnd < maxRevEnd && isLowerHex(region[revEnd] ?? 0)) revEnd += 1;
    if (
      revEnd - revStart < 7 ||
      revEnd - revStart > 40 ||
      !isPathSeparator(region[revEnd] ?? 0)
    )
      return null;
    const split = splitCargoGitCheckoutSegments(
      region.toString("latin1", checkoutStart, checkoutEnd),
      region.toString("latin1", revStart, revEnd),
    );
    if (split === null) return null;
    return {
      name: split.name,
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: split.checkout_id,
      revision: split.revision,
    };
  }

  return null;
};

interface FingerprintAccumulator {
  readonly cratesByKey: Map<string, MutableInferredCrate>;
  readonly retainedCrates: MutableInferredCrate[];
  readonly versionsByBanner: Map<string, MutableRustcVersion>;
  readonly retainedVersions: MutableRustcVersion[];
  readonly maxInferredCrates: number;
  cratesOverflowed: boolean;
  versionsOverflowed: boolean;
}

function* scanWindowCargoCandidates(
  region: Buffer,
  rangeOffset: number,
  windowStart: number,
  windowEnd: number,
  state: FingerprintAccumulator,
): Generator<void, void> {
  const cargoSlice = region.subarray(
    windowStart,
    Math.min(region.length, windowEnd + CARGO_TOKEN.length - 1),
  );
  let cargoCursor = 0;
  let cargoHits = 0;
  while (cargoCursor < cargoSlice.length) {
    const at = cargoSlice.indexOf(CARGO_TOKEN, cargoCursor);
    if (at < 0 || windowStart + at >= windowEnd) break;
    cargoHits += 1;
    if ((cargoHits & (CANCELLATION_STRIDE - 1)) === 0) yield;
    const matchStart = windowStart + at;
    const parsed = parseCargoCrateAt(region, matchStart);
    if (parsed !== null) {
      const key = JSON.stringify([
        parsed.source_kind,
        parsed.name,
        parsed.version,
        parsed.registry_index,
        parsed.checkout_id,
        parsed.revision,
      ]);
      const existing = state.cratesByKey.get(key);
      if (existing !== undefined) {
        existing.reference_count += 1;
      } else if (state.cratesByKey.size < MAX_TRACKED_INFERRED_CRATES) {
        const retained = state.retainedCrates.length < state.maxInferredCrates;
        if (!retained) state.cratesOverflowed = true;
        const entry: MutableInferredCrate = {
          ...parsed,
          first_file_offset: rangeOffset + matchStart,
          reference_count: 1,
          retained,
        };
        state.cratesByKey.set(key, entry);
        if (retained) state.retainedCrates.push(entry);
      } else {
        state.cratesOverflowed = true;
      }
    }
    cargoCursor = at + CARGO_TOKEN.length;
  }
}

function* scanWindowRustcCandidates(
  region: Buffer,
  rangeOffset: number,
  windowStart: number,
  windowEnd: number,
  regionTruncated: boolean,
  state: FingerprintAccumulator,
): Generator<void, void> {
  const rustcSlice = region.subarray(
    windowStart,
    Math.min(region.length, windowEnd + RUSTC_TOKEN.length - 1),
  );
  let rustcCursor = 0;
  let rustcHits = 0;
  while (rustcCursor < rustcSlice.length) {
    const at = rustcSlice.indexOf(RUSTC_TOKEN, rustcCursor);
    if (at < 0 || windowStart + at >= windowEnd) break;
    rustcHits += 1;
    if ((rustcHits & (CANCELLATION_STRIDE - 1)) === 0) yield;
    const matchStart = windowStart + at;
    const parsed = parseRustcVersionBannerAt(
      region,
      matchStart,
      regionTruncated,
    );
    if (parsed !== null) {
      const existing = state.versionsByBanner.get(parsed.banner);
      if (existing !== undefined) {
        existing.reference_count += 1;
      } else if (state.versionsByBanner.size < MAX_TRACKED_RUSTC_VERSIONS) {
        const retained =
          state.retainedVersions.length < MAX_RUSTC_VERSIONS_LIMIT;
        if (!retained) state.versionsOverflowed = true;
        const entry: MutableRustcVersion = {
          ...parsed,
          first_file_offset: rangeOffset + matchStart,
          reference_count: 1,
          retained,
        };
        state.versionsByBanner.set(parsed.banner, entry);
        if (retained) state.retainedVersions.push(entry);
      } else {
        state.versionsOverflowed = true;
      }
    }
    rustcCursor = at + RUSTC_TOKEN.length;
  }
}

function* recoverRustSourceFingerprintsSteps(
  bytes: Buffer,
  container: BinaryContainer,
  maxInferredCrates: number,
): Generator<void, RecoveredRustSourceFingerprints> {
  const ranges = candidateFingerprintRanges(bytes, container);
  const state: FingerprintAccumulator = {
    cratesByKey: new Map(),
    retainedCrates: [],
    versionsByBanner: new Map(),
    retainedVersions: [],
    maxInferredCrates,
    cratesOverflowed: false,
    versionsOverflowed: false,
  };
  let remainingBudget = MAX_RUST_FINGERPRINT_SCAN_BYTES;
  let scanTruncated = false;

  for (const range of ranges) {
    yield;
    if (remainingBudget <= 0) {
      scanTruncated = true;
      break;
    }
    const rangeBytes = range.end - range.offset;
    const admittedBytes = Math.min(rangeBytes, remainingBudget);
    const regionTruncated = admittedBytes < rangeBytes;
    if (regionTruncated) scanTruncated = true;
    remainingBudget -= admittedBytes;

    const region = bytes.subarray(range.offset, range.offset + admittedBytes);
    for (
      let windowStart = 0;
      windowStart < region.length;
      windowStart += SCAN_WINDOW_BYTES
    ) {
      yield;
      const windowEnd = Math.min(
        region.length,
        windowStart + SCAN_WINDOW_BYTES,
      );
      yield* scanWindowCargoCandidates(
        region,
        range.offset,
        windowStart,
        windowEnd,
        state,
      );
      yield* scanWindowRustcCandidates(
        region,
        range.offset,
        windowStart,
        windowEnd,
        regionTruncated,
        state,
      );
    }
  }

  return {
    inferred_crates: {
      evidence_kind: "inferred",
      items: state.retainedCrates.map(
        ({ retained: _retained, ...item }) => item,
      ),
      discovered_count: state.cratesByKey.size,
      max_items: maxInferredCrates,
      truncated:
        scanTruncated ||
        state.cratesOverflowed ||
        state.cratesByKey.size > state.retainedCrates.length,
    },
    rustc_versions: {
      evidence_kind: "inferred",
      items: state.retainedVersions.map(
        ({ retained: _retained, ...item }) => item,
      ),
      discovered_count: state.versionsByBanner.size,
      truncated:
        scanTruncated ||
        state.versionsOverflowed ||
        state.versionsByBanner.size > state.retainedVersions.length,
    },
  };
}

/**
 * Linearly scan read-only ranges and safe ELF `.comment` sections for Cargo
 * source-path fingerprints and `rustc` version banners.
 */
export const recoverRustSourceFingerprints = (
  bytes: Buffer,
  container: BinaryContainer,
  maxInferredCrates: number = DEFAULT_MAX_RUST_INFERRED_CRATES,
  checkActive?: () => void,
): RecoveredRustSourceFingerprints => {
  const steps = recoverRustSourceFingerprintsSteps(
    bytes,
    container,
    maxInferredCrates,
  );
  for (;;) {
    checkActive?.();
    const next = steps.next();
    if (next.done) return next.value;
  }
};

/**
 * Asynchronous fingerprint scan yielding between bounded chunks so queued
 * `AbortSignal` timers, CLI interrupts, and MCP cancellations fire promptly.
 */
export const recoverRustSourceFingerprintsAsync = async (
  bytes: Buffer,
  container: BinaryContainer,
  maxInferredCrates: number = DEFAULT_MAX_RUST_INFERRED_CRATES,
  checkActive?: () => void,
): Promise<RecoveredRustSourceFingerprints> => {
  const steps = recoverRustSourceFingerprintsSteps(
    bytes,
    container,
    maxInferredCrates,
  );
  for (;;) {
    checkActive?.();
    const next = steps.next();
    if (next.done) return next.value;
    checkActive?.();
    await setImmediate();
  }
};
