import { validMachOLoadCommandSize } from "./apple/machoLoadCommand.js";
import { err, ok, type Result } from "./result.js";

const LC_UUID = 0x1b;
const FAT_MAGIC_BE = 0xcafebabe;
const FAT_MAGIC_64_BE = 0xcafebabf;
const FAT_MAGIC_LE = 0xbebafeca;
const FAT_MAGIC_64_LE = 0xbfbafeca;
const THIN_LITTLE_MAGICS = new Set([0xcefaedfe, 0xcffaedfe]);
const THIN_BIG_MAGICS = new Set([0xfeedface, 0xfeedfacf]);
const UUID_BYTES = 16;

/** One LC_UUID with the cputype of the Mach-O image that declares it. */
export interface MachOUuidEntry {
  readonly cpuType: number;
  readonly uuid: string;
}

const formatUuid = (raw: Buffer): string => {
  const hex = raw.toString("hex").toUpperCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

/** One bounded read requested by the owning thin-image UUID decoder. */
export interface MachOUuidRead {
  readonly offset: number;
  readonly length: number;
}

/** A UUID-less image retains its CPU identity instead of disappearing. */
export interface MachOImageUuid {
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly uuid: string | null;
}

/**
 * Decode only command headers and UUID payloads. The same format owner drives
 * in-memory fixtures and incremental filesystem reads, so large unknown command
 * bodies are skipped without buffering them or inventing a format-size limit.
 */
export function* machoUuidReads(
  imageSize: number,
): Generator<MachOUuidRead, Result<MachOImageUuid, string>, Buffer> {
  if (imageSize < 4) return err("Mach-O header is truncated");
  const magicBytes = yield { offset: 0, length: 4 };
  if (magicBytes.length < 4) return err("Mach-O header is truncated");
  const magic = magicBytes.readUInt32BE(0);
  const little = THIN_LITTLE_MAGICS.has(magic);
  if (!little && !THIN_BIG_MAGICS.has(magic)) return err("not a Mach-O image");
  const wide = magic === 0xfeedfacf || magic === 0xcffaedfe;
  const headerSize = wide ? 32 : 28;
  if (imageSize < headerSize)
    return err("Mach-O header is truncated before its load commands");
  const header = yield { offset: 0, length: headerSize };
  if (header.length < headerSize)
    return err("Mach-O header is truncated before its load commands");
  const read32 = (bytes: Buffer, offset: number): number =>
    little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  const cpuType = read32(header, 4);
  const cpuSubtype = read32(header, 8);
  const commandCount = read32(header, 16);
  const declaredSize = read32(header, 20);
  if (declaredSize > imageSize - headerSize)
    return err("Mach-O load commands exceed the declared image region");
  const commandsEnd = headerSize + declaredSize;
  let cursor = headerSize;
  let observed: string | null = null;
  for (let index = 0; index < commandCount; index += 1) {
    if (commandsEnd - cursor < 8)
      return err(`Mach-O load command ${String(index)} is truncated`);
    const commandHeader = yield { offset: cursor, length: 8 };
    if (commandHeader.length < 8)
      return err(`Mach-O load command ${String(index)} is truncated`);
    const command = read32(commandHeader, 0);
    const size = read32(commandHeader, 4);
    if (!validMachOLoadCommandSize(size, commandsEnd - cursor, wide))
      return err(`Mach-O load command ${String(index)} has an invalid size`);
    if (command === LC_UUID) {
      if (size < 8 + UUID_BYTES)
        return err("LC_UUID load command is truncated");
      if (observed !== null)
        return err("Mach-O image declares more than one LC_UUID");
      const payload = yield { offset: cursor + 8, length: UUID_BYTES };
      if (payload.length < UUID_BYTES)
        return err("LC_UUID load command is truncated");
      observed = formatUuid(payload);
    }
    cursor += size;
  }
  if (cursor !== commandsEnd)
    return err(
      "Mach-O load commands do not fill the declared load-command span",
    );
  return ok({ cpuType, cpuSubtype, uuid: observed });
}

const readUuidsFromThin = (
  bytes: Buffer,
  offset: number,
  end: number,
): Result<MachOUuidEntry[], string> => {
  const decoder = machoUuidReads(end - offset);
  let step = decoder.next();
  while (!step.done) {
    const request = step.value;
    step = decoder.next(
      bytes.subarray(
        offset + request.offset,
        Math.min(end, offset + request.offset + request.length),
      ),
    );
  }
  if (!step.value.ok) return step.value;
  const identity = step.value.value;
  return ok(
    identity.uuid === null
      ? []
      : [
          {
            cpuType: identity.cpuType,
            uuid: identity.uuid,
          },
        ],
  );
};

/**
 * Read the LC_UUID of a Mach-O image with its declaring cputype, descending
 * into universal (FAT) containers of either byte order. Slice order is
 * preserved so a caller can attribute each UUID to its architecture; a zero
 * UUID is preserved: it is an observed value, not an unknown.
 */
export const readMachoUuidEntries = (
  bytes: Buffer,
): Result<MachOUuidEntry[], string> => {
  if (bytes.length < 8) return err("Mach-O image is truncated");
  const magic = bytes.readUInt32BE(0);
  const fat =
    magic === FAT_MAGIC_BE ||
    magic === FAT_MAGIC_64_BE ||
    magic === FAT_MAGIC_LE ||
    magic === FAT_MAGIC_64_LE;
  if (fat) {
    const wide = magic === FAT_MAGIC_64_BE || magic === FAT_MAGIC_64_LE;
    // The architecture table's byte order follows the observed magic.
    const big = magic === FAT_MAGIC_BE || magic === FAT_MAGIC_64_BE;
    const read32 = big
      ? (position: number) => bytes.readUInt32BE(position)
      : (position: number) => bytes.readUInt32LE(position);
    const count = read32(4);
    const entrySize = wide ? 32 : 20;
    if (count > 128 || 8 + count * entrySize > bytes.length)
      return err(
        "universal Mach-O container has an invalid architecture table",
      );
    const entries: MachOUuidEntry[] = [];
    for (let index = 0; index < count; index += 1) {
      const entry = 8 + index * entrySize;
      const cpuType = big ? bytes.readInt32BE(entry) : bytes.readInt32LE(entry);
      const sliceOffset = wide
        ? Number(
            big
              ? bytes.readBigUInt64BE(entry + 8)
              : bytes.readBigUInt64LE(entry + 8),
          )
        : read32(entry + 8);
      const sliceSize = wide
        ? Number(
            big
              ? bytes.readBigUInt64BE(entry + 16)
              : bytes.readBigUInt64LE(entry + 16),
          )
        : read32(entry + 12);
      if (sliceSize === 0) return err("universal Mach-O slice is empty");
      if (sliceOffset > bytes.length || sliceSize > bytes.length - sliceOffset)
        return err("universal Mach-O slice is out of bounds");
      const slice = readUuidsFromThin(
        bytes,
        sliceOffset,
        sliceOffset + sliceSize,
      );
      if (!slice.ok) return slice;
      for (const item of slice.value)
        entries.push({ cpuType, uuid: item.uuid });
    }
    return ok(entries);
  }
  return readUuidsFromThin(bytes, 0, bytes.length);
};

/** The LC_UUID values of a Mach-O image, without their architecture owner. */
export const readMachoUuids = (bytes: Buffer): Result<string[], string> => {
  const entries = readMachoUuidEntries(bytes);
  return entries.ok ? ok(entries.value.map(({ uuid }) => uuid)) : entries;
};

/**
 * A companion matches when it carries the UUID of the executable image REA
 * will analyze. Executable images without any LC_UUID cannot be matched and
 * are rejected explicitly instead of matching vacuously. An all-zero UUID is
 * an observed placeholder, not an identity, and never matches.
 */
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** A zero UUID is a recorded placeholder rather than a matching identity. */
export const usableMachOUuid = (uuid: string | null): uuid is string =>
  uuid !== null && uuid !== ZERO_UUID;

export const debugCompanionMatches = (input: {
  readonly executableUuids: readonly string[];
  readonly companionUuids: readonly string[];
}): Result<{ readonly uuid: string }, string> => {
  const executable = input.executableUuids.filter(usableMachOUuid);
  if (executable.length === 0)
    return err("the executable declares no LC_UUID to match against");
  const companions = new Set(input.companionUuids.filter(usableMachOUuid));
  for (const uuid of executable) if (companions.has(uuid)) return ok({ uuid });
  return err(
    "the debug companion's UUID does not match the executable's LC_UUID",
  );
};
