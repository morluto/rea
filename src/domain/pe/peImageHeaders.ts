import { parseMzHeaderEvidence } from "../dosMz.js";
import { BinaryFormatFailure } from "../binaryContainer.js";
import { malformedInput } from "../parseFailure.js";
import { readPeCoffHeader } from "../peCoffHeader.js";
import { observePeHeaderExtent } from "../peSectionHeader.js";
import {
  readPeOptionalHeaderStructure,
  type PeOptionalHeaderFailure,
} from "../peOptionalHeader.js";

const OPTIONAL_HEADER_FAILURES: Readonly<
  Record<PeOptionalHeaderFailure["reason"], string>
> = {
  "truncated-magic": "Truncated PE optional header.",
  "unsupported-magic": "Unsupported PE optional header magic.",
  "truncated-fixed-fields": "Truncated PE data directory count.",
  "truncated-directory-table":
    "PE directory count exceeds its optional header.",
};

/** The bytes violate the PE structure this parser admits. */
export const peFailure = (message: string): never => {
  throw malformedInput("pe", message);
};

export const requirePeRange = (
  bytes: Buffer,
  offset: number,
  length: number,
): void => requirePeExtent(bytes.length, offset, length);

export const requirePeExtent = (
  fileSize: number,
  offset: number,
  length: number,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > fileSize - length
  )
    peFailure(
      `PE range ${String(offset)} + ${String(length)} leaves the artifact.`,
    );
};

/**
 * Shared PE header admission: signature, optional header, data directories,
 * and a section table that fits inside SizeOfHeaders. `bytes` may be a file
 * prefix that holds the header structures; file-space ranges are checked
 * against `fileSize`.
 */
export const readPeImageHeaders = (bytes: Buffer, fileSize = bytes.length) => {
  requirePeRange(bytes, 0, 64);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a)
    peFailure("Expected an MZ PE image.");
  const evidence = parseMzHeaderEvidence(bytes, fileSize);
  const observed = evidence.windowsHeader;
  if (observed.state === "absent" && evidence.dos.ok)
    throw new BinaryFormatFailure(
      "unsupported",
      "DOS MZ images do not contain PE resource or certificate tables",
    );
  if (observed.state === "declared" && observed.signature !== "PE")
    throw new BinaryFormatFailure(
      "unsupported",
      `${observed.signature} images do not contain PE resource or certificate tables`,
    );
  if (observed.state === "candidate" || observed.state === "signature-needed")
    requirePeRange(bytes, observed.offset, 24);
  if (observed.state !== "declared" || observed.signature !== "PE")
    return peFailure(
      "MZ header does not declare a PE image in the inspected bytes.",
    );
  const pe = observed.offset;
  requirePeRange(bytes, pe, 24);
  const coff = readPeCoffHeader(bytes.subarray(pe + 4, pe + 24));
  if (!coff.ok) return peFailure(coff.error.message);
  const {
    sectionCount,
    optionalHeaderSize: optionalSize,
    machine,
  } = coff.value;
  const optionalHeaderOffset = pe + 24;
  requirePeRange(bytes, optionalHeaderOffset, optionalSize);
  if (optionalSize < 64) peFailure("Truncated PE optional header.");
  const parsed = readPeOptionalHeaderStructure(
    bytes.subarray(optionalHeaderOffset, optionalHeaderOffset + optionalSize),
  );
  if (!parsed.ok)
    return peFailure(OPTIONAL_HEADER_FAILURES[parsed.error.reason]);
  const {
    sizeOfHeaders: headerSize,
    format,
    directoryOffset,
    dataDirectories,
  } = parsed.value;
  const {
    sectionTableOffset: table,
    sectionTableBytes,
    sizeOfHeadersState,
  } = observePeHeaderExtent({
    optionalHeaderOffset,
    optionalHeaderSize: optionalSize,
    sectionCount,
    sizeOfHeaders: headerSize,
    fileSize,
  });
  requirePeRange(bytes, table, sectionTableBytes);
  if (sizeOfHeadersState !== "valid") peFailure("Invalid PE SizeOfHeaders.");
  return {
    machine,
    format,
    sectionCount,
    optionalHeaderOffset,
    directoryOffset,
    dataDirectories,
    headerSize,
    table,
  };
};
