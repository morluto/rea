import { parseMzHeaderEvidence } from "../dosMz.js";
import { BinaryFormatFailure } from "../binaryContainer.js";
import { malformedInput } from "../parseFailure.js";
import { observePeCoffFrame, PE_COFF_FRAME_BYTES } from "../peCoffHeader.js";
import { observePeHeaderExtent } from "../peSectionHeader.js";
import {
  readPeOptionalHeaderStructure,
  type PeDataDirectory,
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

interface HeaderRead {
  readonly offset: number;
  readonly size: number;
}

interface PeImageHeaders {
  readonly machine: number;
  readonly format: "pe32" | "pe32-plus";
  readonly sectionCount: number;
  readonly optionalHeaderOffset: number;
  readonly directoryOffset: number;
  readonly dataDirectories: readonly PeDataDirectory[];
  readonly headerSize: number;
  readonly sectionTable: Buffer;
}

export type PeRangeReader = (
  offset: number,
  bytes: number,
) => Promise<Buffer | undefined>;

const headerRead = (
  fileSize: number,
  offset: number,
  bytes: number,
): HeaderRead => {
  requirePeExtent(fileSize, offset, bytes);
  return { offset, size: bytes };
};

/** Admit the PE header directory using its declared spans in either source. */
function* peImageHeaderReads(
  prefix: Buffer,
  fileSize: number,
): Generator<HeaderRead, PeImageHeaders, Buffer> {
  requirePeRange(prefix, 0, 64);
  if (prefix[0] !== 0x4d || prefix[1] !== 0x5a)
    peFailure("Expected an MZ PE image.");
  const evidence = parseMzHeaderEvidence(prefix, fileSize);
  const frame = yield* observePeCoffFrame(prefix, fileSize, evidence);
  const observed = frame.observation;
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
  if (frame.kind !== "pe")
    return peFailure(
      "MZ header does not declare a PE image in the inspected bytes.",
    );
  const pe = frame.observation.offset;
  requirePeExtent(fileSize, pe, PE_COFF_FRAME_BYTES);
  const { coff } = frame;
  if (!coff.ok) return peFailure(coff.error.message);
  const { sectionCount, optionalHeaderSize, machine } = coff.value;
  const optionalHeaderOffset = pe + PE_COFF_FRAME_BYTES;
  const optional = yield headerRead(
    fileSize,
    optionalHeaderOffset,
    optionalHeaderSize,
  );
  if (optionalHeaderSize < 64) peFailure("Truncated PE optional header.");
  const parsed = readPeOptionalHeaderStructure(optional);
  if (!parsed.ok)
    return peFailure(OPTIONAL_HEADER_FAILURES[parsed.error.reason]);
  const {
    sizeOfHeaders: headerSize,
    format,
    directoryOffset,
    dataDirectories,
  } = parsed.value;
  const { sectionTableOffset, sectionTableBytes, sizeOfHeadersState } =
    observePeHeaderExtent({
      optionalHeaderOffset,
      optionalHeaderSize,
      sectionCount,
      sizeOfHeaders: headerSize,
      fileSize,
    });
  const sectionRead = headerRead(
    fileSize,
    sectionTableOffset,
    sectionTableBytes,
  );
  if (sizeOfHeadersState !== "valid") peFailure("Invalid PE SizeOfHeaders.");
  const sectionTable = yield sectionRead;
  return {
    machine,
    format,
    sectionCount,
    optionalHeaderOffset,
    directoryOffset,
    dataDirectories,
    headerSize,
    sectionTable,
  };
}

/** Admit headers over one complete image without copying or inspecting section payloads. */
export const readPeImageHeaders = (bytes: Buffer) => {
  const steps = peImageHeaderReads(bytes, bytes.length);
  let next = steps.next();
  while (!next.done) {
    const { offset, size } = next.value;
    next = steps.next(bytes.subarray(offset, offset + size));
  }
  return next.value;
};

/** Admit the same headers from bounded file reads, skipping the DOS stub and padding. */
export const readPeImageHeadersAt = async (
  prefix: Buffer,
  fileSize: number,
  read: PeRangeReader,
) => {
  const steps = peImageHeaderReads(prefix, fileSize);
  let next = steps.next();
  while (!next.done) {
    const { offset, size: bytes } = next.value;
    // A PE can declare no sections. The caller need not support empty I/O.
    const record =
      bytes === 0 || offset + bytes <= prefix.length
        ? prefix.subarray(offset, offset + bytes)
        : await read(offset, bytes);
    if (record === undefined || record.length !== bytes)
      return peFailure(`Truncated PE header range at ${String(offset)}.`);
    next = steps.next(record);
  }
  return next.value;
};
