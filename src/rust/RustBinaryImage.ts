import type {
  BinaryContainer,
  ImageSection,
} from "../domain/binaryContainer.js";
import { malformedInput, unsupportedInput } from "../domain/parseFailure.js";
import { keyedBy, uniqueKeyed } from "../domain/keyedCollection.js";
import type { ZstandardFramePause } from "../domain/compression/zstandardExactFrame.js";
import type { NativeByteSource } from "../domain/native/nativeSectionDirectory.js";
import { readBinaryContainerFromReader } from "../domain/native/readBinaryContainer.js";
import type {
  RustAuditableMetadata,
  RustBinary,
  RustContainerBits,
} from "../domain/rust/rustBinary.js";
import {
  DEFAULT_RUSTC_HASH_LIMIT,
  rustcPartialCoverage,
  rustDependencySectionName,
} from "../domain/rust/rustBinary.js";
import { RUST_PRODUCER_DEFAULTS } from "../domain/rust/rustResourceLimits.js";
import {
  readAuditableSectionFromReader,
  RUST_AUDITABLE_FORMAT,
} from "./RustAuditableReader.js";
import {
  hasWasmPreamble,
  readRustWasmSectionsFromReader,
} from "./RustWasmImage.js";

const RUSTC_PREFIX = Buffer.from("/rustc/");
const HASH_BYTES = 40;
/** Streamed scan window for `/rustc/<40-hex>/` literals across read-only spans. */
const RUSTC_SCAN_WINDOW_BYTES = 1024 * 1024;
/** Overlap keeps any 48-byte `/rustc/<40-hex>[/\]` match intact across window boundaries. */
const RUSTC_SCAN_OVERLAP_BYTES = RUSTC_PREFIX.length + HASH_BYTES;

/** Container identity plus optional dependency metadata and inferred rustc commits. */
export interface RustBinaryImage {
  readonly format: RustBinary["format"];
  readonly architecture: string;
  readonly bits: RustContainerBits;
  readonly byte_order: RustBinary["byte_order"];
  readonly auditable_metadata: RustAuditableMetadata | null;
  readonly rustc_commit: RustBinary["rustc_commit"];
  readonly section_names_limitation?: string;
}

interface FileSpan {
  readonly offset: number;
  readonly size: number;
}

/** The stored dependency stream and the PE padding allowance that may follow it. */
interface DependencySpan extends FileSpan {
  readonly peFileAlignment?: number | undefined;
}

/** Container identity and the exact file spans that Rust metadata lookups read. */
interface RustImageLayout extends Pick<
  RustBinaryImage,
  "format" | "architecture" | "bits" | "byte_order" | "section_names_limitation"
> {
  readonly section_name: RustAuditableMetadata["section_name"];
  readonly dependency: DependencySpan | null;
  /** Spans where rustc stores constant `/rustc/<hash>/` path strings. */
  readonly compiler_strings: readonly FileSpan[];
}

const readSlice = (
  source: NativeByteSource,
  offset: number,
  length: number,
): Promise<Buffer> => {
  if (length <= 0 || offset >= source.size)
    return Promise.resolve(Buffer.alloc(0));
  const clamped = Math.min(length, source.size - offset);
  if (source.prefix !== undefined && offset + clamped <= source.prefix.length)
    return Promise.resolve(source.prefix.subarray(offset, offset + clamped));
  return source.readRange(offset, clamped);
};

/** Stream Rust dependency and compiler-path inspection over a range reader. */
export const readRustBinaryImageFromHandle = async (
  source: NativeByteSource,
  maxRustcHashes: number | undefined,
  maxOutputBytes: number | undefined,
  pause: ZstandardFramePause,
): Promise<RustBinaryImage> => {
  const effectiveMaxHashes = maxRustcHashes ?? DEFAULT_RUSTC_HASH_LIMIT;
  const effectiveMaxOutputBytes =
    maxOutputBytes ?? RUST_PRODUCER_DEFAULTS.output_bytes;
  const preamble = await readSlice(source, 0, Math.min(source.size, 8));
  const layout: RustImageLayout = hasWasmPreamble(preamble)
    ? await wasmLayoutFromReader(source, pause)
    : nativeLayoutFromContainer(
        await readBinaryContainerFromReader(
          source,
          "inspect_rust_binary",
          pause,
        ),
      );
  const { section_name, dependency, compiler_strings, ...identity } = layout;
  const auditable_metadata =
    dependency === null
      ? null
      : await readAuditableSectionFromReader(
          section_name,
          dependency,
          (offset, length) => readSlice(source, offset, length),
          pause,
          {
            maxOutputBytes: effectiveMaxOutputBytes,
            peFileAlignment: dependency.peFileAlignment,
          },
        );
  const rustc_commit = await rustcCommitFromReader(
    source,
    compiler_strings,
    effectiveMaxHashes,
    effectiveMaxOutputBytes,
    pause,
  );
  return {
    ...identity,
    auditable_metadata,
    rustc_commit,
  };
};

const wasmLayoutFromReader = async (
  source: NativeByteSource,
  pause: ZstandardFramePause,
): Promise<RustImageLayout> => {
  const { dependency_sections, data_section } =
    await readRustWasmSectionsFromReader(source, pause);
  if (dependency_sections.length > 1) throw duplicateDependencySection();
  return {
    format: "wasm",
    architecture: "wasm",
    bits: null,
    byte_order: "little",
    section_name: rustDependencySectionName("wasm"),
    dependency: dependency_sections[0] ?? null,
    compiler_strings: data_section === null ? [] : [data_section],
  };
};

const rustcCommitFromReader = async (
  source: NativeByteSource,
  spans: readonly FileSpan[],
  maxHashes: number,
  maxOutputBytes: number,
  pause: ZstandardFramePause,
): Promise<RustBinaryImage["rustc_commit"]> => {
  const retention: RustcPathRetention = {
    hashes: [],
    seen: new Set(),
    maxHashes,
    maxBytes: maxOutputBytes,
    bytes: 2,
    reason: undefined,
  };
  for (const range of mergedFileRanges(spans)) {
    let cursor = range.offset;
    while (cursor < range.end && retention.reason === undefined) {
      if (cursor > range.offset) await pause();
      const length = Math.min(RUSTC_SCAN_WINDOW_BYTES, range.end - cursor);
      const chunk = await readSlice(source, cursor, length);
      collectHashesInChunk(chunk, cursor, retention);
      if (cursor + length >= range.end) break;
      cursor += length - RUSTC_SCAN_OVERLAP_BYTES;
    }
    if (retention.reason !== undefined) break;
  }
  return retention.hashes.length === 0
    ? null
    : {
        evidence_kind: "inferred",
        hashes: retention.hashes,
        ...(retention.reason !== undefined
          ? {
              coverage: rustcPartialCoverage(
                retention.reason,
                retention.reason === "report_bytes"
                  ? maxOutputBytes
                  : maxHashes,
              ),
            }
          : {}),
      };
};

const nativeLayoutFromContainer = (
  container: BinaryContainer,
): RustImageLayout => {
  const section_name = rustDependencySectionName(container.format);
  const dependency = dependencySection(section_name, container.sections);
  return {
    format: container.format,
    architecture: container.architecture,
    bits: container.bits,
    byte_order: container.byte_order,
    ...(container.section_names_limitation === undefined
      ? {}
      : { section_names_limitation: container.section_names_limitation }),
    section_name,
    dependency:
      dependency === null
        ? null
        : {
            offset: dependency.offset,
            size: dependency.size,
            peFileAlignment:
              dependency.format === "pe" &&
              dependency.virtual_size === 0 &&
              dependency.file_alignment > 0 &&
              dependency.raw_size % dependency.file_alignment === 0
                ? dependency.file_alignment
                : undefined,
          },
    compiler_strings: [
      ...container.sections.filter((section) => section.read_only),
      ...(container.format === "elf"
        ? (container.load_regions ?? [])
            .filter((region) => region.read && !region.write && !region.execute)
            .map(({ mapping }) => mapping)
        : []),
    ],
  };
};

/** cargo-auditable writes one dependency section; a second leaves the list ambiguous. */
const duplicateDependencySection = () =>
  malformedInput(
    RUST_AUDITABLE_FORMAT,
    "Image contains more than one dependency section",
  );

const dependencySection = (
  expected: RustAuditableMetadata["section_name"],
  sections: readonly ImageSection[],
): ImageSection | null => {
  const selected = uniqueKeyed(
    keyedBy(sections, ({ name }) => name),
    expected,
  );
  if (!selected.ok) throw duplicateDependencySection();
  const section = selected.value;
  if (section === undefined) return null;
  if (section.compressed)
    throw unsupportedInput(
      RUST_AUDITABLE_FORMAT,
      "Compressed dependency sections are unsupported",
      { undecodedContent: true },
    );
  if (!section.file_backed)
    throw malformedInput(
      RUST_AUDITABLE_FORMAT,
      "Dependency section is not file-backed",
    );
  return section;
};

/** One owner for compiler-path uniqueness, retained output and exhaustion. */
interface RustcPathRetention {
  readonly hashes: { hash: string; file_offset: number }[];
  readonly seen: Set<string>;
  readonly maxHashes: number;
  readonly maxBytes: number;
  bytes: number;
  reason: "max_rustc_hashes" | "report_bytes" | undefined;
}

const mergedFileRanges = (
  ranges: readonly FileSpan[],
): { readonly offset: number; readonly end: number }[] => {
  const sorted = ranges
    .filter(({ size }) => size > 0)
    .map(({ offset, size }) => ({ offset, end: offset + size }))
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

const collectHashesInChunk = (
  region: Buffer,
  baseOffset: number,
  retention: RustcPathRetention,
): void => {
  let cursor = 0;
  while (cursor < region.length) {
    const at = region.indexOf(RUSTC_PREFIX, cursor);
    if (at < 0) return;
    const start = at + RUSTC_PREFIX.length;
    const hash = hashAt(region, start);
    if (hash !== null && !retention.seen.has(hash)) {
      if (retention.seen.size >= retention.maxHashes) {
        retention.reason = "max_rustc_hashes";
        return;
      }
      const entry = { hash, file_offset: baseOffset + at };
      const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (entryBytes > retention.maxBytes - retention.bytes) {
        retention.reason = "report_bytes";
        return;
      }
      retention.bytes += entryBytes;
      retention.seen.add(hash);
      retention.hashes.push(entry);
    }
    cursor = at + 1;
  }
};

const hashAt = (region: Buffer, start: number): string | null => {
  const end = start + HASH_BYTES;
  // Windows builds join the remapped `/rustc/<hash>` prefix with `\`.
  if (end >= region.length || (region[end] !== 0x2f && region[end] !== 0x5c))
    return null;
  for (let index = start; index < end; index += 1) {
    const byte = region[index] ?? 0;
    const hex =
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
    if (!hex) return null;
  }
  return region.toString("latin1", start, end);
};
