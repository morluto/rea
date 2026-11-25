/**
 * ISO 9660 directory members: the records of one file or directory grouped,
 * their identifiers decoded, and the path segments inventory lists them by.
 */
import { win32 } from "node:path";

import { byteToHex } from "../../kernel/byteToHex.js";
import { logicalPathNfc } from "../artifactIdentity.js";
import { BinaryReader } from "../binaryContainer.js";
import { admitsCanonicalPathSyntax } from "../artifactPathSyntax.js";
import type { ParseFailureError } from "../parseFailure.js";
import {
  extentOf,
  ISO9660_DIRECTORY_RECORD_HEADER_BYTES,
  ISO9660_FLAG_DIRECTORY,
  ISO9660_FLAG_MULTI_EXTENT,
  ISO9660_FORMAT,
  ISO9660_MANDATORY_RECORDS,
  ISO9660_SECTOR_BYTES,
  iso9660Malformed,
  type Iso9660DirectoryRecord,
  type Iso9660DirectoryStep,
  type Iso9660Extent,
  type Iso9660ExtentLayout,
} from "./iso9660Structures.js";

// ECMA-119 §10.2 permits the protection and multi-extent bits to vary.
const SHARED_SECTION_FLAGS = 0x6f;
const FLAG_HIDDEN = 0x01;
const FLAG_ASSOCIATED = 0x04;

/**
 * One directory member: a single record, or every record of a multi-extent
 * file. `identifier`, `flags`, `recordingDate`, `fileUnitSize` and
 * `interleaveGapSize` are observed in the first record, at `recordOffset`;
 * the other sections must repeat its identifier and its flags apart from the
 * protection and multi-extent bits. `name`, `directory`, `dataLength`, `layout` and
 * `identifierCharset` are derived.
 */
export interface Iso9660Member {
  /** Absolute image offset of the member's first directory record. */
  readonly recordOffset: number;
  /** The stored identifier, including any `;version` suffix. */
  readonly identifier: string;
  /** The identifier without its version suffix or empty extension dot. */
  readonly name: string;
  readonly directory: boolean;
  readonly flags: number;
  readonly recordingDate: string | null;
  readonly fileUnitSize: number;
  readonly interleaveGapSize: number;
  readonly extents: readonly Iso9660Extent[];
  readonly dataLength: number;
  readonly layout: Iso9660ExtentLayout;
  /**
   * `ucs-2` for Joliet identifiers; `ascii` for primary identifiers within
   * 7-bit ASCII; `undeclared` when a primary identifier has bytes above 0x7F,
   * which ECMA-119 character sets do not define, so they are shown as Latin-1.
   */
  readonly identifierCharset: "ascii" | "ucs-2" | "undeclared";
}

const isHighSurrogate = (unit: number): boolean =>
  unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean =>
  unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Joliet names are big-endian UCS-2. A well-formed surrogate pair is read as
 * the UTF-16 character mastering tools write for it; an unpaired surrogate
 * names no character, so the record is malformed at that code unit.
 */
const decodeJolietIdentifier = (record: Iso9660DirectoryRecord): string => {
  const { identifier } = record;
  if (identifier.length % 2 !== 0)
    throw iso9660Malformed(
      "Joliet identifier has an odd byte length",
      record.offset + 32,
      "identifier_length",
    );
  const units = new BinaryReader(identifier, false, ISO9660_FORMAT);
  for (let at = 0; at < identifier.length; at += 2) {
    const unit = units.u16(at);
    if (
      isHighSurrogate(unit) &&
      at + 2 < identifier.length &&
      isLowSurrogate(units.u16(at + 2))
    ) {
      at += 2;
      continue;
    }
    if (isHighSurrogate(unit) || isLowSurrogate(unit))
      throw iso9660Malformed(
        "Joliet identifier contains an unpaired surrogate code unit",
        record.offset + ISO9660_DIRECTORY_RECORD_HEADER_BYTES + at,
        "file_identifier",
      );
  }
  return Buffer.from(identifier).swap16().toString("utf16le");
};

const decodeIdentifier = (
  record: Iso9660DirectoryRecord,
  joliet: boolean,
): Pick<Iso9660Member, "identifier" | "identifierCharset"> => {
  if (joliet)
    return {
      identifier: decodeJolietIdentifier(record),
      identifierCharset: "ucs-2",
    };
  return {
    identifier: record.identifier.toString("latin1"),
    identifierCharset: record.identifier.some((byte) => byte > 0x7f)
      ? "undeclared"
      : "ascii",
  };
};

const memberName = (identifier: string, directory: boolean): string => {
  if (directory) return identifier;
  const unversioned = identifier.replace(/;\d+$/u, "");
  return unversioned.endsWith(".") && !unversioned.endsWith("..")
    ? unversioned.slice(0, -1)
    : unversioned;
};

/**
 * Contiguous extents form one carrier range; separate extents need a
 * concatenation this reader does not perform, and interleaved file units
 * need a file-unit walk. A record parser admits a gap only with a file unit.
 */
const extentLayout = (
  layout: Iso9660ExtentLayout,
  previous: Iso9660Extent | undefined,
  next: Iso9660Extent,
): Iso9660ExtentLayout => {
  if (next.fileUnitSize !== 0) return "interleaved";
  if (
    layout === "contiguous" &&
    previous !== undefined &&
    (next.extendedAttributeLength !== 0 ||
      previous.dataLength % ISO9660_SECTOR_BYTES !== 0 ||
      next.dataOffset !== previous.dataOffset + previous.dataLength)
  )
    return "fragmented";
  return layout;
};

const memberOf = (
  first: Iso9660DirectoryRecord,
  joliet: boolean,
  extents: readonly Iso9660Extent[],
  dataLength: number,
  layout: Iso9660ExtentLayout,
): Iso9660Member => {
  const decoded = decodeIdentifier(first, joliet);
  const directory = (first.flags & ISO9660_FLAG_DIRECTORY) !== 0;
  return {
    recordOffset: first.offset,
    ...decoded,
    name: memberName(decoded.identifier, directory),
    directory,
    flags: first.flags,
    recordingDate: first.recordingDate,
    fileUnitSize: first.fileUnitSize,
    interleaveGapSize: first.interleaveGapSize,
    extents,
    dataLength,
    layout,
  };
};

/**
 * Group a directory's records into members. The opening `.` and `..` pair,
 * validated by {@link parseIso9660DirectoryExtent}, is skipped by position;
 * the records of a multi-extent file share one identifier and every flag
 * except protection and multi-extent, and end with the record whose multi-extent flag is
 * clear. An associated file and the ordinary file that shares its identifier
 * therefore stay separate members.
 *
 * One value is yielded per step: the member that step completed, or
 * `undefined` for padding, the opening pair, and a section that continues a
 * multi-extent file. A long chain or padding run therefore never completes
 * inside a single `next()`.
 */
export function* groupIso9660Members(
  steps: Iterable<Iso9660DirectoryStep>,
  joliet: boolean,
  admitExtent?: (extent: Iso9660Extent) => void,
): Generator<Iso9660Member | undefined> {
  let first: Iso9660DirectoryRecord | undefined;
  let extents: Iso9660Extent[] = [];
  let dataLength = 0;
  let layout: Iso9660ExtentLayout = "contiguous";
  let position = 0;
  for (const step of steps) {
    if (step.kind === "padding" || position++ < ISO9660_MANDATORY_RECORDS) {
      yield undefined;
      continue;
    }
    const { record } = step;
    if (first !== undefined && !record.identifier.equals(first.identifier))
      throw unterminatedMultiExtent(extents.at(-1)!.recordOffset);
    const continued = (record.flags & ISO9660_FLAG_MULTI_EXTENT) !== 0;
    if (
      first !== undefined &&
      ((record.flags ^ first.flags) & SHARED_SECTION_FLAGS) !== 0
    )
      throw iso9660Malformed(
        `a multi-extent file section's file flags 0x${byteToHex(record.flags)} disagree with its first section's 0x${byteToHex(first.flags)}`,
        record.offset + 25,
        "file_flags",
      );
    first ??= record;
    const extent = extentOf(record);
    admitExtent?.(extent);
    layout = extentLayout(layout, extents.at(-1), extent);
    extents.push(extent);
    dataLength += extent.dataLength;
    if (continued) {
      yield undefined;
      continue;
    }
    yield memberOf(first, joliet, extents, dataLength, layout);
    first = undefined;
    extents = [];
    dataLength = 0;
    layout = "contiguous";
  }
  if (first !== undefined)
    throw unterminatedMultiExtent(extents.at(-1)!.recordOffset);
}

/** The last section read still sets the multi-extent flag. */
const unterminatedMultiExtent = (
  recordOffset: number,
): ParseFailureError<"malformed"> =>
  iso9660Malformed(
    "a multi-extent file ends without its final record",
    recordOffset + 25,
    "file_flags",
  );

export const iso9660MemberIsHidden = (member: Iso9660Member): boolean =>
  (member.flags & FLAG_HIDDEN) !== 0;

export const iso9660MemberIsAssociated = (member: Iso9660Member): boolean =>
  (member.flags & FLAG_ASSOCIATED) !== 0;

const hasControlCharacter = (name: string): boolean => {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const unsafeSegment = (name: string): boolean =>
  name.length === 0 ||
  name === "." ||
  name === ".." ||
  name.includes("/") ||
  hasControlCharacter(name) ||
  !admitsCanonicalPathSyntax(name);

/**
 * A path segment for one member. Names with a separator, NUL or control
 * character, `.` or `..` become `entry-<index>`; repeated names gain a
 * numeric suffix. Uniqueness is checked in the NFC spelling inventory keys by.
 */
export const iso9660PathSegment = (
  name: string,
  index: number,
  used: Set<string>,
  rootDirectory = false,
): { readonly segment: string; readonly renamed: boolean } => {
  const renamed =
    unsafeSegment(name) || (rootDirectory && win32.isAbsolute(`${name}/`));
  const base = renamed ? `entry-${String(index)}` : logicalPathNfc(name);
  let unique = used.has(base) ? `${base}-${String(index)}` : base;
  let extra = 2;
  while (used.has(unique)) {
    unique = `${base}-${String(index)}-${String(extra)}`;
    extra += 1;
  }
  used.add(unique);
  return { segment: unique, renamed };
};
