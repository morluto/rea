import {
  BinaryFormatFailure,
  BinaryResourceFailure,
  type BinaryContainer,
  type ImageSection,
} from "../native/metadata/BinaryContainer.js";
import { readBinaryContainer } from "../native/metadata/readBinaryContainer.js";
import type {
  RustAuditableMetadata,
  RustBinary,
} from "../domain/rust/rustBinary.js";
import { DEFAULT_RUSTC_HASH_LIMIT } from "../domain/rust/rustBinary.js";
import { RUST_PRODUCER_DEFAULTS } from "../domain/rust/rustResourceLimits.js";
import {
  readAuditableSection,
  RustAuditableFormatFailure,
  RustAuditableResourceFailure,
} from "./RustAuditableReader.js";

const RUSTC_PREFIX = Buffer.from("/rustc/");
const HASH_BYTES = 40;

/** Container identity plus optional dependency metadata and inferred rustc commits. */
export interface RustBinaryImage {
  readonly format: RustBinary["format"];
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: RustBinary["byte_order"];
  readonly auditable_metadata: RustAuditableMetadata | null;
  readonly rustc_commit: RustBinary["rustc_commit"];
  readonly section_names_limitation?: string;
}

/** Read dependency metadata from container sections without executing the image. */
export const readRustBinaryImage = (
  bytes: Buffer,
  maxRustcHashes = DEFAULT_RUSTC_HASH_LIMIT,
  maxOutputBytes: number = RUST_PRODUCER_DEFAULTS.output_bytes,
): RustBinaryImage => {
  const container = readContainer(bytes);
  const dependency = dependencySection(container.format, container.sections);
  return {
    format: container.format,
    architecture: container.architecture,
    bits: container.bits,
    byte_order: container.byte_order,
    auditable_metadata:
      dependency === null
        ? null
        : readDependency(bytes, container.format, dependency, maxOutputBytes),
    rustc_commit: rustcCommit(bytes, container, maxRustcHashes, maxOutputBytes),
    ...(container.section_names_limitation === undefined
      ? {}
      : { section_names_limitation: container.section_names_limitation }),
  };
};

const readContainer = (bytes: Buffer) => {
  try {
    return readBinaryContainer(bytes);
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure)
      throw new RustAuditableFormatFailure(cause.kind, cause.message, {
        cause,
      });
    if (cause instanceof BinaryResourceFailure)
      throw new RustAuditableResourceFailure(
        {
          resource: "memory",
          reported_limits: { maximum_bytes: cause.maximum_bytes },
        },
        cause.message,
        {
          cause,
        },
      );
    throw cause;
  }
};

const dependencySection = (
  format: RustBinaryImage["format"],
  sections: readonly ImageSection[],
): ImageSection | null => {
  const expected = format === "macho" ? "__DATA,.dep-v0" : ".dep-v0";
  const matches = sections.filter((section) => section.name === expected);
  if (matches.length > 1)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Image contains more than one dependency section",
    );
  const section = matches[0];
  if (section === undefined) return null;
  if (section.compressed)
    throw new RustAuditableFormatFailure(
      "unsupported",
      "Compressed dependency sections are unsupported",
    );
  if (!section.file_backed)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Dependency section is not file-backed",
    );
  return section;
};

const readDependency = (
  bytes: Buffer,
  format: RustBinaryImage["format"],
  section: ImageSection,
  maxOutputBytes: number,
): RustAuditableMetadata =>
  readAuditableSection(
    format === "macho" ? "__DATA,.dep-v0" : ".dep-v0",
    section.offset,
    bytes.subarray(section.offset, section.offset + section.size),
    {
      maxOutputBytes,
      peFileAlignment:
        section.format === "pe" &&
        section.virtual_size === 0 &&
        section.file_alignment > 0 &&
        section.raw_size % section.file_alignment === 0
          ? section.file_alignment
          : undefined,
    },
  );

const rustcCommit = (
  bytes: Buffer,
  container: BinaryContainer,
  maxHashes: number,
  maxOutputBytes: number,
): RustBinaryImage["rustc_commit"] => {
  const retention: RustcPathRetention = {
    hashes: [],
    seen: new Set(),
    maxHashes,
    maxBytes: maxOutputBytes,
    bytes: 2,
    reason: undefined,
  };
  const sections = container.sections
    .filter((section) => section.read_only)
    .map(({ offset, size }) => ({ offset, size }));
  const loadRegions =
    container.format === "elf"
      ? (container.load_regions ?? [])
          .filter((region) => region.read && !region.write && !region.execute)
          .map(({ mapping }) => mapping)
      : [];
  // Overlapping section and ELF load ranges are scanned once, so total work
  // stays bounded by the file size however many mappings reference a range.
  for (const range of mergedReadOnlyFileRanges([...sections, ...loadRegions])) {
    collectHashes(bytes, range, retention);
    if (retention.reason !== undefined) break;
  }
  return retention.hashes.length === 0
    ? null
    : {
        evidence_kind: "inferred",
        hashes: retention.hashes,
        ...(retention.reason !== undefined
          ? {
              coverage: {
                status: "partial" as const,
                reason: retention.reason,
                effective_limit:
                  retention.reason === "report_bytes"
                    ? maxOutputBytes
                    : maxHashes,
              },
            }
          : {}),
      };
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

const mergedReadOnlyFileRanges = (
  ranges: readonly { readonly offset: number; readonly size: number }[],
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

const collectHashes = (
  bytes: Buffer,
  range: { readonly offset: number; readonly end: number },
  retention: RustcPathRetention,
): void => {
  const region = bytes.subarray(range.offset, range.end);
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
      const entry = { hash, file_offset: range.offset + at };
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
