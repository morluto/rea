import {
  BinaryFormatFailure,
  BinaryResourceFailure,
  type ImageSection,
} from "../native/metadata/BinaryContainer.js";
import { readBinaryContainer } from "../native/metadata/readBinaryContainer.js";
import type {
  RustAuditableMetadata,
  RustBinary,
} from "../domain/rust/rustBinary.js";
import {
  readAuditableSection,
  RustAuditableFormatFailure,
  RustAuditableResourceFailure,
} from "./RustAuditableReader.js";
import { hasWasmPreamble, readRustWasmSections } from "./RustWasmImage.js";

const RUSTC_PREFIX = Buffer.from("/rustc/");
const HASH_BYTES = 40;
/** One toolchain normally leaves one hash; a small cap bounds retained output. */
const MAX_RUSTC_HASHES = 64;

/** Container identity plus optional dependency metadata and inferred rustc commits. */
export interface RustBinaryImage {
  readonly format: RustBinary["format"];
  readonly architecture: string;
  readonly bits: RustBinary["bits"];
  readonly byte_order: RustBinary["byte_order"];
  readonly auditable_metadata: RustAuditableMetadata | null;
  readonly rustc_commit: RustBinary["rustc_commit"];
  readonly section_names_limitation?: string;
}

type FileSpan = Pick<ImageSection, "offset" | "size">;

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

/** Read dependency metadata from container sections without executing the image. */
export const readRustBinaryImage = (bytes: Buffer): RustBinaryImage => {
  const { section_name, dependency, compiler_strings, ...identity } =
    hasWasmPreamble(bytes) ? wasmLayout(bytes) : nativeLayout(bytes);
  return {
    ...identity,
    auditable_metadata:
      dependency === null
        ? null
        : readAuditableSection(
            section_name,
            dependency.offset,
            bytes.subarray(
              dependency.offset,
              dependency.offset + dependency.size,
            ),
            { peFileAlignment: dependency.peFileAlignment },
          ),
    rustc_commit: rustcCommit(bytes, compiler_strings),
  };
};

const nativeLayout = (bytes: Buffer): RustImageLayout => {
  const container = readContainer(bytes);
  const section_name =
    container.format === "macho" ? "__DATA,.dep-v0" : ".dep-v0";
  const dependency = dependencySection(
    container.sections.filter((section) => section.name === section_name),
  );
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
            peFileAlignment: peFileAlignment(dependency),
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

/** WebAssembly fixes little-endian encoding but declares no container word size. */
const wasmLayout = (bytes: Buffer): RustImageLayout => {
  const { dependency_sections, data_section } = readRustWasmSections(bytes);
  return {
    format: "wasm",
    architecture: "wasm",
    bits: null,
    byte_order: "little",
    section_name: ".dep-v0",
    dependency: singleDependencySection(dependency_sections),
    compiler_strings: data_section === null ? [] : [data_section],
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

/** cargo-auditable writes one dependency section; a second leaves the list ambiguous. */
const singleDependencySection = <Section>(
  matches: readonly Section[],
): Section | null => {
  if (matches.length > 1)
    throw new RustAuditableFormatFailure(
      "malformed",
      "Image contains more than one dependency section",
    );
  return matches[0] ?? null;
};

const dependencySection = (
  matches: readonly ImageSection[],
): ImageSection | null => {
  const section = singleDependencySection(matches);
  if (section === null) return null;
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

const peFileAlignment = (section: ImageSection): number | undefined =>
  section.format === "pe" &&
  section.virtual_size === 0 &&
  section.file_alignment > 0 &&
  section.raw_size % section.file_alignment === 0
    ? section.file_alignment
    : undefined;

const rustcCommit = (
  bytes: Buffer,
  spans: readonly FileSpan[],
): RustBinaryImage["rustc_commit"] => {
  const hashes: { hash: string; file_offset: number }[] = [];
  const seen = new Set<string>();
  // Overlapping sections and mappings are scanned once, so total work stays
  // bounded by the file size however many of them reference a range.
  for (const range of mergedRanges(spans))
    collectHashes(bytes, range, seen, hashes);
  return hashes.length === 0 ? null : { evidence_kind: "inferred", hashes };
};

const mergedRanges = (
  spans: readonly FileSpan[],
): { readonly offset: number; readonly end: number }[] => {
  const sorted = spans
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
  seen: Set<string>,
  hashes: { hash: string; file_offset: number }[],
): void => {
  const region = bytes.subarray(range.offset, range.end);
  let cursor = 0;
  while (cursor < region.length) {
    const at = region.indexOf(RUSTC_PREFIX, cursor);
    if (at < 0) return;
    const start = at + RUSTC_PREFIX.length;
    const hash = hashAt(region, start);
    if (hash !== null && !seen.has(hash)) {
      if (seen.size >= MAX_RUSTC_HASHES)
        throw new RustAuditableResourceFailure(
          {
            resource: "capacity",
            reported_limits: { maximum_rustc_hashes: MAX_RUSTC_HASHES },
          },
          `Compiler path data contains more than ${MAX_RUSTC_HASHES} distinct rustc commit paths.`,
        );
      seen.add(hash);
      hashes.push({ hash, file_offset: range.offset + at });
    }
    cursor = at + 1;
  }
};

const hashAt = (region: Buffer, start: number): string | null => {
  const end = start + HASH_BYTES;
  if (end >= region.length || region[end] !== 0x2f) return null;
  for (let index = start; index < end; index += 1) {
    const byte = region[index] ?? 0;
    const hex =
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66);
    if (!hex) return null;
  }
  return region.toString("latin1", start, end);
};
