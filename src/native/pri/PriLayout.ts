import { setImmediate } from "node:timers/promises";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type {
  PriResources,
  PriSectionKind,
} from "../../domain/native/priResources.js";

export const priFailure = (message: string): never => {
  throw new ArtifactReaderFailure("format", message);
};

export const priLimit = (message: string): never => {
  throw new ArtifactReaderFailure("limit", message);
};

const YIELD_INTERVAL = 2048;

/** Yield to the event loop every `interval` iterations and honor cancellation. */
export const cooperate = async (
  iteration: number,
  signal: AbortSignal | undefined,
  interval = YIELD_INTERVAL,
): Promise<void> => {
  if (iteration % interval !== 0) return;
  await setImmediate();
  signal?.throwIfAborted();
};

const HEADER_BYTES = 32;
const FOOTER_BYTES = 16;
const TOC_ENTRY_BYTES = 32;
const SECTION_HEADER_BYTES = 32;
const SECTION_TRAILER_BYTES = 8;
const FOOTER_MARKER = 0xdefffade;
const SECTION_TRAILER_MARKER = 0xdef5fade;
const MAGICS = ["mrm_pri0", "mrm_pri1", "mrm_pri2", "mrm_prif"] as const;

/** Exact identifiers; version distinctions remain explicit in the decoded section. */
const KNOWN_SECTIONS: ReadonlyMap<string, PriSectionKind> = new Map([
  ["[mrm_pridescex]\0", "descriptor"],
  ["[mrm_hschema]  \0", "hierarchical-schema"],
  ["[mrm_hschemaex] ", "hierarchical-schema"],
  ["[mrm_decn_info]\0", "decision-info"],
  ["[mrm_res_map__]\0", "resource-map"],
  ["[mrm_res_map2_]\0", "resource-map"],
  ["[mrm_dataitem] \0", "data-items"],
  ["[mrm_rev_map]  \0", "reverse-map"],
  ["[def_file_list]\0", "referenced-files"],
]);

/** Section identifier without its NUL and space padding, for messages only. */
export const displayIdentifier = (identifier: string): string =>
  identifier.replace(/[\0 ]+$/u, "");

export const EXTENDED_SCHEMA_IDENTIFIER = "[mrm_hschemaex] ";
export const RESOURCE_MAP_V2_IDENTIFIER = "[mrm_res_map2_]\0";

/** One TOC entry whose header and trailer agree with the table of contents. */
export interface PriSection {
  readonly index: number;
  /** The original 16 bytes as Latin-1 characters, so every byte value is preserved. */
  readonly identifier: string;
  readonly kind: PriSectionKind;
  readonly qualifier: number;
  readonly flags: number;
  readonly sectionFlags: number;
  readonly offset: number;
  readonly length: number;
  readonly content: SectionContent;
}

/** Bounds-checked little-endian reads relative to one section's content bytes. */
export class SectionContent {
  constructor(
    readonly bytes: Buffer,
    readonly offset: number,
    readonly length: number,
    readonly label: string,
  ) {}

  /** Fail unless `[at, at + size)` lies inside the content. */
  require(at: number, size: number, what: string): number {
    if (
      !Number.isSafeInteger(at) ||
      !Number.isSafeInteger(size) ||
      at < 0 ||
      size < 0 ||
      at > this.length - size
    )
      priFailure(
        `${this.label} ${what} (${String(at)} + ${String(size)}) leaves the ${String(this.length)}-byte section content.`,
      );
    return this.offset + at;
  }

  u8(at: number, what: string): number {
    return this.bytes.readUInt8(this.require(at, 1, what));
  }

  u16(at: number, what: string): number {
    return this.bytes.readUInt16LE(this.require(at, 2, what));
  }

  u32(at: number, what: string): number {
    return this.bytes.readUInt32LE(this.require(at, 4, what));
  }

  /** File range for content-relative bytes, after the same bounds check. */
  fileRange(at: number, size: number, what: string) {
    return { offset: this.require(at, size, what), bytes: size };
  }
}

/** Header, footer, table of contents and section framing of one PRI file. */
export interface PriLayout {
  readonly header: PriResources["header"];
  readonly sections: readonly PriSection[];
}

/** Validate the fixed header and footer, returning the declared table positions. */
const readHeader = (bytes: Buffer): PriResources["header"] => {
  if (bytes.length < HEADER_BYTES + FOOTER_BYTES)
    priFailure("Truncated PRI file: the header and footer need 48 bytes.");
  const magic = MAGICS.find(
    (candidate) => bytes.toString("latin1", 0, 8) === candidate,
  );
  if (magic === undefined)
    return priFailure(
      "Expected a PRI file starting with mrm_pri0, mrm_pri1, mrm_pri2 or mrm_prif.",
    );
  if (bytes.readUInt16LE(8) !== 0 || bytes.readUInt16LE(10) !== 1)
    priFailure("Unsupported PRI header version fields.");
  const declaredBytes = bytes.readUInt32LE(12);
  if (declaredBytes !== bytes.length)
    priFailure(
      `PRI header declares ${String(declaredBytes)} bytes, but the artifact has ${String(bytes.length)}.`,
    );
  if (bytes.readUInt16LE(26) !== 0xffff || bytes.readUInt32LE(28) !== 0)
    priFailure("Unsupported PRI header reserved fields.");
  const footerOffset = bytes.length - FOOTER_BYTES;
  if (
    bytes.readUInt32LE(footerOffset) !== FOOTER_MARKER ||
    bytes.readUInt32LE(footerOffset + 4) !== declaredBytes ||
    bytes.toString("latin1", footerOffset + 8, footerOffset + 16) !== magic
  )
    priFailure("PRI footer does not match the header magic and size.");
  const tocOffset = bytes.readUInt32LE(16);
  const sectionsOffset = bytes.readUInt32LE(20);
  const sectionCount = bytes.readUInt16LE(24);
  const tocBytes = sectionCount * TOC_ENTRY_BYTES;
  if (tocOffset < HEADER_BYTES || tocOffset > footerOffset - tocBytes)
    priFailure(
      "PRI table of contents leaves the area between header and footer.",
    );
  if (sectionsOffset < HEADER_BYTES || sectionsOffset > footerOffset)
    priFailure("PRI section area starts outside the file body.");
  return {
    magic,
    declared_bytes: declaredBytes,
    toc: { offset: tocOffset, bytes: tocBytes },
    sections_offset: sectionsOffset,
    section_count: sectionCount,
    footer: { offset: footerOffset, bytes: FOOTER_BYTES },
  };
};

/** Read one table-of-contents entry and check that its section framing repeats it. */
const readSection = (
  bytes: Buffer,
  header: PriResources["header"],
  index: number,
): PriSection => {
  const entry = header.toc.offset + index * TOC_ENTRY_BYTES;
  const identifier = bytes.toString("latin1", entry, entry + 16);
  const flags = bytes.readUInt16LE(entry + 16);
  const sectionFlags = bytes.readUInt16LE(entry + 18);
  const qualifier = bytes.readUInt32LE(entry + 20);
  const offset = header.sections_offset + bytes.readUInt32LE(entry + 24);
  const length = bytes.readUInt32LE(entry + 28);
  const label = `PRI section ${String(index)}`;
  if (length < SECTION_HEADER_BYTES + SECTION_TRAILER_BYTES)
    priFailure(`${label} is shorter than its 40-byte framing.`);
  if (offset > header.footer.offset - length)
    priFailure(`${label} leaves the area before the PRI footer.`);
  if (
    bytes.toString("latin1", offset, offset + 16) !== identifier ||
    bytes.readUInt32LE(offset + 16) !== qualifier ||
    bytes.readUInt16LE(offset + 20) !== flags ||
    bytes.readUInt16LE(offset + 22) !== sectionFlags ||
    bytes.readUInt32LE(offset + 24) !== length ||
    bytes.readUInt32LE(offset + 28) !== 0
  )
    priFailure(`${label} header disagrees with its table-of-contents entry.`);
  const trailer = offset + length - SECTION_TRAILER_BYTES;
  if (
    bytes.readUInt32LE(trailer) !== SECTION_TRAILER_MARKER ||
    bytes.readUInt32LE(trailer + 4) !== length
  )
    priFailure(`${label} trailer does not repeat its length.`);
  return {
    index,
    identifier,
    kind: KNOWN_SECTIONS.get(identifier) ?? "unrecognized",
    qualifier,
    flags,
    sectionFlags,
    offset,
    length,
    content: new SectionContent(
      bytes,
      offset + SECTION_HEADER_BYTES,
      length - SECTION_HEADER_BYTES - SECTION_TRAILER_BYTES,
      `${label} (${displayIdentifier(identifier)})`,
    ),
  };
};

/** Validate the container before any section content is interpreted. */
export const readPriLayout = (bytes: Buffer): PriLayout => {
  const header = readHeader(bytes);
  const sections = Array.from(
    { length: header.section_count },
    (_unused, index) => readSection(bytes, header, index),
  );
  const occupied = [
    {
      offset: header.toc.offset,
      end: header.toc.offset + header.toc.bytes,
      what: "table of contents",
    },
    ...sections.map(({ index, offset, length }) => ({
      offset,
      end: offset + length,
      what: `PRI section ${String(index)}`,
    })),
  ].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < occupied.length; index++) {
    const previous = occupied[index - 1];
    const current = occupied[index];
    if (
      previous !== undefined &&
      current !== undefined &&
      current.offset < previous.end
    )
      priFailure(`${current.what} overlaps ${previous.what}.`);
  }
  return { header, sections };
};
