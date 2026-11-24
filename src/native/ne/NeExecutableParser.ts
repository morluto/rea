import { setImmediate } from "node:timers/promises";
import { BinaryReader } from "../../domain/binaryContainer.js";
import { assertArtifactReadActive } from "../../resources/index.js";
import {
  decodeLimit,
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../../domain/parseFailure.js";
import {
  mzWindowsHeaderLayoutLimitation,
  observeMzWindowsHeader,
} from "../../domain/dosMz.js";
import { jsonParts } from "../../domain/jsonSerialization.js";
import type {
  InspectNeExecutableInput,
  NeExecutable,
  NeIdentity,
} from "../../domain/native/neExecutable.js";

type Range = { offset: number; bytes: number };
type Name = { name: string; location: Range };
type OrdinalName = Name & { ordinal: number };

const HEADER_BYTES = 0x40;
const METADATA_BYTES = 8 * 1024 * 1024;
const LIBRARY_FLAG = 0x8000;
const DATA_SEGMENT_FLAG = 0x0001;
const RELOCATIONS_FLAG = 0x0100;
const RELOCATION_BYTES = 8;
const MOVABLE_BUNDLE = 0xff;
const INT_3F = 0x3fcd;
const MAX_ALIGNMENT_SHIFT = 15;

/** The ParseFailure format of NE images. */
export const NE_FORMAT = "ne";

/** Named decode budgets: the caller's row budget and the fixed metadata allowance. */
export type NeLimit = "max_rows" | "metadata_bytes";

const neFailure = (message: string): never => {
  throw malformedInput(NE_FORMAT, message);
};
const limit = (message: string, name: NeLimit, maximum: number): never => {
  throw decodeLimit(NE_FORMAT, message, { name, maximum });
};

/** Count bytes through the canonical bounded JSON writer. */
const jsonBytes = (value: unknown, maximum: number): number => {
  let size = 0;
  for (const part of jsonParts(value)) {
    size += Buffer.byteLength(part, "utf8");
    if (size > maximum) return size;
  }
  return size;
};

/** Bounded reads and row/metadata budgets shared by every NE table decoder. */
class NeReader {
  rows = 0;
  #metadataBytes = 0;
  #paced = 0;
  readonly #binary: BinaryReader;

  constructor(
    readonly bytes: Buffer,
    readonly ne: number,
    readonly maxRows: number,
    readonly signal: AbortSignal | undefined,
  ) {
    this.#binary = new BinaryReader(bytes, true, NE_FORMAT);
  }

  require(offset: number, length: number, what: string): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > this.bytes.length - length
    ) {
      const detail = `NE ${what} at ${String(offset)} + ${String(length)} leaves the artifact.`;
      // A structure that starts inside the file but ends past it is truncated;
      // one that cannot start inside the file is malformed.
      if (
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        offset >= 0 &&
        length >= 0 &&
        offset < this.bytes.length
      )
        throw truncatedInput(NE_FORMAT, detail, {
          offset,
          field: what,
          extent: {
            availableBytes: this.bytes.length,
            requiredBytes: offset + length,
          },
        });
      throw malformedInput(NE_FORMAT, detail, { field: what });
    }
  }

  u8(offset: number): number {
    return this.#binary.u8(offset);
  }

  u16(offset: number): number {
    return this.#binary.u16(offset);
  }

  u32(offset: number): number {
    return this.#binary.u32(offset);
  }

  /** A field of the NE header, relative to its signature. */
  field(relative: number): number {
    return this.u16(this.ne + relative);
  }

  async examine(count: number): Promise<void> {
    if (count > this.maxRows - this.rows)
      limit(
        "NE table row budget exceeded; no partial inventory was returned.",
        "max_rows",
        this.maxRows,
      );
    this.rows += count;
    if (this.rows % 1024 < count) {
      await setImmediate();
      assertArtifactReadActive(this.signal);
    }
  }

  /**
   * Yield and check cancellation every 1024 structures that are not rows,
   * such as empty resource types, so a long table cannot run unobserved.
   */
  async pace(): Promise<void> {
    this.#paced++;
    if (this.#paced % 1024 === 0) {
      await setImmediate();
      assertArtifactReadActive(this.signal);
    }
  }

  /** Reserve a retained row's JSON bytes, plus its array separator. */
  account<T>(value: T): T {
    this.#metadataBytes +=
      jsonBytes(value, METADATA_BYTES - this.#metadataBytes) + 1;
    if (this.#metadataBytes > METADATA_BYTES)
      limit(
        "NE metadata exceeds the 8 MiB complete-result allocation budget.",
        "metadata_bytes",
        METADATA_BYTES,
      );
    return value;
  }

  /** Length-prefixed 8-bit name; `trailer` bytes after it belong to the row. */
  name(at: number, what: string, trailer = 0): Name | null {
    this.require(at, 1, what);
    const length = this.u8(at);
    if (length === 0) return null;
    this.require(at, 1 + length + trailer, what);
    return {
      name: this.bytes.toString("latin1", at + 1, at + 1 + length),
      location: { offset: at, bytes: 1 + length + trailer },
    };
  }

  /** Name rows with ordinals, ending at a zero length byte before `end`. */
  async nameTable(
    at: number,
    end: number,
    what: string,
  ): Promise<OrdinalName[]> {
    const table: OrdinalName[] = [];
    let cursor = at;
    for (;;) {
      if (cursor >= end) return neFailure(`Unterminated NE ${what}.`);
      const row = this.name(cursor, what, 2);
      if (row === null) return table;
      if (row.location.offset + row.location.bytes > end)
        neFailure(`NE ${what} row leaves its table.`);
      await this.examine(1);
      table.push(
        this.account({
          ...row,
          ordinal: this.u16(cursor + row.location.bytes - 2),
        }),
      );
      cursor += row.location.bytes;
    }
  }
}

const readHeader = (reader: NeReader): NeExecutable["header"] => {
  const { ne } = reader;
  const flags = reader.field(0x0c);
  const shift = reader.field(0x32);
  if (shift > MAX_ALIGNMENT_SHIFT) neFailure("NE alignment shift exceeds 15.");
  return {
    location: { offset: ne, bytes: HEADER_BYTES },
    linker_version: {
      major: reader.u8(ne + 0x02),
      minor: reader.u8(ne + 0x03),
    },
    checksum: reader.u32(ne + 0x08),
    flags,
    module_kind: (flags & LIBRARY_FLAG) !== 0 ? "library" : "application",
    auto_data_segment: reader.field(0x0e),
    heap_bytes: reader.field(0x10),
    stack_bytes: reader.field(0x12),
    entry_point: { segment: reader.field(0x16), offset: reader.field(0x14) },
    initial_stack: { segment: reader.field(0x1a), offset: reader.field(0x18) },
    alignment_shift: shift,
    target_os: reader.u8(ne + 0x36),
    other_flags: reader.u8(ne + 0x37),
    expected_windows_version: {
      major: reader.u8(ne + 0x3f),
      minor: reader.u8(ne + 0x3e),
    },
  };
};

const readSegments = async (
  reader: NeReader,
  shift: number,
): Promise<NeExecutable["segments"]> => {
  const count = reader.field(0x1c);
  const table = reader.ne + reader.field(0x22);
  reader.require(table, count * 8, "segment table");
  await reader.examine(count);
  const segments: NeExecutable["segments"] = [];
  for (let index = 0; index < count; index++) {
    const row = table + index * 8;
    const sector = reader.u16(row);
    // A zero length or minimum allocation denotes 64 KiB.
    const length = reader.u16(row + 2) || 0x10000;
    const flags = reader.u16(row + 4);
    const what = `segment ${String(index + 1)}`;
    let location: Range | null = null;
    let relocations: NeExecutable["segments"][number]["relocations"] = null;
    if (sector !== 0) {
      const offset = sector * 2 ** shift;
      reader.require(offset, length, what);
      location = { offset, bytes: length };
      if ((flags & RELOCATIONS_FLAG) !== 0) {
        const at = offset + length;
        reader.require(at, 2, `${what} relocations`);
        const records = reader.u16(at);
        const size = 2 + records * RELOCATION_BYTES;
        reader.require(at, size, `${what} relocations`);
        relocations = { count: records, location: { offset: at, bytes: size } };
      }
    }
    segments.push(
      reader.account({
        index: index + 1,
        kind:
          (flags & DATA_SEGMENT_FLAG) !== 0
            ? ("data" as const)
            : ("code" as const),
        flags,
        location,
        minimum_allocation_bytes: reader.u16(row + 6) || 0x10000,
        relocations,
      }),
    );
  }
  return segments;
};

const readResources = async (
  reader: NeReader,
): Promise<{ resources: NeExecutable["resources"]; truncated: number }> => {
  const resources: NeExecutable["resources"] = [];
  let truncated = 0;
  // An empty resource table starts where the resident name table does.
  if (reader.field(0x24) === reader.field(0x26))
    return { resources, truncated };
  const table = reader.ne + reader.field(0x24);
  reader.require(table, 2, "resource table");
  const shift = reader.u16(table);
  if (shift > MAX_ALIGNMENT_SHIFT)
    neFailure("NE resource alignment shift exceeds 15.");
  const identity = (encoded: number): NeIdentity => {
    if ((encoded & 0x8000) !== 0) return { kind: "id", id: encoded & 0x7fff };
    if (encoded === 0) return { kind: "none" };
    const named = reader.name(table + encoded, "resource name");
    if (named === null) return neFailure("Empty NE resource name.");
    return { kind: "name", ...named };
  };
  let cursor = table + 2;
  for (;;) {
    reader.require(cursor, 2, "resource type");
    const typeId = reader.u16(cursor);
    if (typeId === 0) return { resources, truncated };
    await reader.pace();
    reader.require(cursor, 8, "resource type");
    const count = reader.u16(cursor + 2);
    reader.require(cursor + 8, count * 12, "resource entries");
    await reader.examine(count);
    const type = identity(typeId);
    for (let index = 0; index < count; index++) {
      const entry = cursor + 8 + index * 12;
      const offset = reader.u16(entry) * 2 ** shift;
      const length = reader.u16(entry + 2) * 2 ** shift;
      let location: Range | null = null;
      // Offset 0 marks a resource without file data. Lengths are stored in
      // alignment units, so a final resource may declare up to one unit more
      // than the file holds; its location then covers only the bytes present.
      if (offset !== 0) {
        const present = Math.min(length, reader.bytes.length - offset);
        if (present < 0 || length - present >= 2 ** shift)
          reader.require(offset, length, "resource");
        if (present < length) truncated++;
        location = { offset, bytes: present };
      }
      resources.push(
        reader.account({
          type,
          name: identity(reader.u16(entry + 6)),
          flags: reader.u16(entry + 4),
          location,
          declared_bytes: length,
          entry_location: { offset: entry, bytes: 12 },
        }),
      );
    }
    cursor += 8 + count * 12;
  }
};

const readNonresidentNames = async (
  reader: NeReader,
): Promise<OrdinalName[]> => {
  const size = reader.field(0x20);
  if (size === 0) return [];
  // Unlike the other tables, this offset is absolute in the file.
  const at = reader.u32(reader.ne + 0x2c);
  reader.require(at, size, "non-resident name table");
  return reader.nameTable(at, at + size, "non-resident name table");
};

const readModuleReferences = async (
  reader: NeReader,
): Promise<NeExecutable["module_references"]> => {
  const count = reader.field(0x1e);
  const table = reader.ne + reader.field(0x28);
  const importedNames = reader.ne + reader.field(0x2a);
  reader.require(table, count * 2, "module reference table");
  await reader.examine(count);
  const references: NeExecutable["module_references"] = [];
  for (let index = 0; index < count; index++) {
    const named = reader.name(
      importedNames + reader.u16(table + index * 2),
      "imported name",
    );
    if (named === null) return neFailure("Empty NE module reference name.");
    references.push(reader.account({ index: index + 1, ...named }));
  }
  return references;
};

/**
 * Entry bundles: a count, then 0 (unused ordinals), 0xFF (movable entries of
 * flags, INT 3Fh, segment, offset) or a fixed segment number (flags, offset).
 */
const readEntries = async (
  reader: NeReader,
): Promise<NeExecutable["entries"]> => {
  const start = reader.ne + reader.field(0x04);
  const end = start + reader.field(0x06);
  reader.require(start, end - start, "entry table");
  const within = (at: number, length: number): void => {
    if (at + length > end) neFailure("NE entry bundle overruns its table.");
  };
  const entries: NeExecutable["entries"] = [];
  let cursor = start;
  let ordinal = 1;
  while (cursor < end) {
    const count = reader.u8(cursor);
    if (count === 0) break;
    within(cursor, 2);
    const kind = reader.u8(cursor + 1);
    cursor += 2;
    if (kind === 0) {
      ordinal += count;
      continue;
    }
    const movable = kind === MOVABLE_BUNDLE;
    const size = movable ? 6 : 3;
    within(cursor, count * size);
    await reader.examine(count);
    for (let index = 0; index < count; index++, ordinal++, cursor += size) {
      if (movable && reader.u16(cursor + 1) !== INT_3F)
        neFailure("NE movable entry lacks its INT 3Fh thunk.");
      entries.push(
        reader.account({
          ordinal,
          movable,
          segment: movable ? reader.u8(cursor + 3) : kind,
          offset: reader.u16(cursor + (movable ? 4 : 1)),
          flags: reader.u8(cursor),
          location: { offset: cursor, bytes: size },
        }),
      );
    }
  }
  return entries;
};

const withoutOrdinal = (row: OrdinalName | undefined): Name | null =>
  row === undefined ? null : { name: row.name, location: row.location };

/**
 * Decode the NE header and its segment, resource, name, module-reference and
 * entry tables. Segment data, relocation records and resource payloads stay
 * opaque; nothing is loaded or executed.
 */
export const parseNeExecutable = async (
  bytes: Buffer,
  artifact: NeExecutable["artifact"],
  input: InspectNeExecutableInput,
  signal?: AbortSignal,
): Promise<NeExecutable> => {
  assertArtifactReadActive(signal);
  const windows = observeMzWindowsHeader(bytes);
  if (windows.state !== "declared" || windows.signature !== "NE")
    return neFailure("Expected an MZ image declaring an NE header.");
  const overlapping = mzWindowsHeaderLayoutLimitation(windows);
  if (overlapping !== undefined)
    throw unsupportedInput(NE_FORMAT, overlapping, {
      offset: windows.offset,
      field: "header",
    });
  const reader = new NeReader(bytes, windows.offset, input.max_rows, signal);
  reader.require(reader.ne, HEADER_BYTES, "header");
  const header = readHeader(reader);
  const segments = await readSegments(reader, header.alignment_shift);
  const { resources, truncated } = await readResources(reader);
  // The first resident name is the module name; the first non-resident name is
  // the module description.
  const [moduleName, ...residentNames] = await reader.nameTable(
    reader.ne + reader.field(0x26),
    bytes.length,
    "resident name table",
  );
  const [description, ...nonresidentNames] = await readNonresidentNames(reader);
  const moduleReferences = await readModuleReferences(reader);
  const entries = await readEntries(reader);
  const report: NeExecutable = {
    artifact,
    format: "ne",
    header,
    module_name: withoutOrdinal(moduleName),
    description: withoutOrdinal(description),
    segments,
    resources,
    resident_names: residentNames,
    nonresident_names: nonresidentNames,
    module_references: moduleReferences,
    entries,
    coverage: { status: "complete", examined_rows: reader.rows },
    limitations: [
      "Static NE header and table inventory; segment data, relocation records and resource payloads remain opaque.",
      "Names are 8-bit strings decoded byte-for-byte as latin1; the original code page is not recorded in the image.",
      "Imported function names are referenced only from relocation records, which are counted but not decoded.",
      ...(truncated === 0
        ? []
        : [
            truncated === 1
              ? "1 resource's declared length passes the end of the file by less than one alignment unit; its location covers only the bytes present."
              : `${String(truncated)} resources' declared lengths pass the end of the file by less than one alignment unit; their locations cover only the bytes present.`,
          ]),
    ],
  };
  assertArtifactReadActive(signal);
  if (jsonBytes(report, METADATA_BYTES) > METADATA_BYTES)
    limit(
      "NE result exceeds the 8 MiB allocation budget.",
      "metadata_bytes",
      METADATA_BYTES,
    );
  return report;
};
