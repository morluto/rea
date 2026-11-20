import { readMachoCommandNames } from "../domain/apple/machoCommandNames.js";
import { MAX_LOAD_COMMAND_BYTES } from "../domain/apple/machoLoadCommandReader.js";
import { readMachoLoadCommandTableHeader } from "../domain/apple/machoLoadCommands.js";
import { parseFailureFromCause } from "../domain/parseFailure.js";

const MH_EXECUTE = 2;
const MACHO_HEADER_BYTES = 32;
const MAX_HINT_RECORDS = 65_536;

/** Positional read that may return fewer bytes at the end of the file. */
export type GhidraSnapshotRangeReader = (
  position: number,
  length: number,
) => Promise<Uint8Array>;

/** Whether a procedure selector asks for the C `main` symbol. */
export const isGhidraMainSelector = (procedure: unknown): boolean => {
  if (typeof procedure !== "string") return false;
  const name = procedure.trim().toLowerCase();
  return name === "main" || name === "_main";
};

const hex = (value: bigint): string => `0x${value.toString(16)}`;

const readExactly = async (
  read: GhidraSnapshotRangeReader,
  position: number,
  length: number,
): Promise<Uint8Array | undefined> => {
  const bytes = await read(position, length);
  return bytes.byteLength === length ? bytes : undefined;
};

/**
 * Recovery sentence naming the LC_MAIN entry of a thin Mach-O executable, or
 * `undefined` when the bytes do not establish one mapped address. Reads only
 * the Mach-O header and its declared load commands; a FAT container is not a
 * thin header and gets no hint. The
 * address assumes Ghidra loaded each segment at its declared vmaddr, which
 * holds for REA's own imports but not for a rebased project.
 */
export const ghidraMachoMainEntryHint = async (
  read: GhidraSnapshotRangeReader,
  fileSize: number,
): Promise<string | undefined> => {
  const header = await readExactly(
    read,
    0,
    Math.min(MACHO_HEADER_BYTES, fileSize),
  );
  if (header === undefined) return undefined;
  const table = readMachoLoadCommandTableHeader(header, fileSize);
  if (
    !table.ok ||
    table.value === null ||
    table.value.commandBytes > MAX_LOAD_COMMAND_BYTES
  )
    return undefined;
  const commands = await readExactly(
    read,
    0,
    table.value.headerSize + table.value.commandBytes,
  );
  if (commands === undefined) return undefined;
  let parsed: Awaited<ReturnType<typeof readMachoCommandNames>>;
  try {
    parsed = await readMachoCommandNames(
      (offset, size) =>
        Promise.resolve(commands.subarray(offset, offset + size)),
      fileSize,
      MAX_LOAD_COMMAND_BYTES,
      MAX_HINT_RECORDS,
    );
  } catch (cause: unknown) {
    if (parseFailureFromCause(cause) !== undefined) return undefined;
    throw cause;
  }
  if (parsed.header.fileType !== MH_EXECUTE) return undefined;
  const entrypoints = parsed.commands.flatMap(({ entrypoint }) =>
    entrypoint === undefined ? [] : [entrypoint.offset],
  );
  const [entryOffset] = entrypoints;
  if (entrypoints.length !== 1 || entryOffset === undefined) return undefined;
  const containing = parsed.commands.flatMap(({ segment }) =>
    segment !== undefined &&
    segment.fileSize > 0n &&
    segment.fileOffset <= entryOffset &&
    entryOffset - segment.fileOffset < segment.fileSize
      ? [segment.address + (entryOffset - segment.fileOffset)]
      : [],
  );
  const [mapped] = containing;
  if (containing.length !== 1 || mapped === undefined) return undefined;
  const address = hex(mapped);
  return `This Mach-O declares its entry point with LC_MAIN at file offset ${hex(entryOffset)}, analysis address ${address}; stripped binaries often have no main symbol, and Ghidra often names that function entry. Request ${address} explicitly to read it.`;
};
