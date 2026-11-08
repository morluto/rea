import {
  findOverlappingFatSlices,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
  validateFatSlice,
} from "./apple/machoContainer.js";
import { machoCpuSubtypeBase } from "./apple/machoCpuIdentity.js";
import {
  MachoLoadCommandCursor,
  readMachoLoadCommandTableHeader,
} from "./apple/machoLoadCommands.js";
import { err, ok, type Result } from "./result.js";

const LC_UUID = 0x1b;
const UUID_BYTES = 16;

/**
 * One LC_UUID with the CPU identity of the Mach-O image that declares it.
 * The subtype keeps only its base bits: capability flags do not change which
 * image a UUID belongs to. A UUID-less image keeps its place as a null entry.
 */
export interface MachOUuidEntry {
  readonly cpuType: number;
  readonly cpuSubtypeBase: number;
  readonly uuid: string | null;
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
  const prefix = readMachoHeaderPrefixFacts(magicBytes);
  if (prefix.format === null) return err("not a Mach-O image");
  const { headerSize } = prefix.format;
  if (imageSize < headerSize)
    return err("Mach-O header is truncated before its load commands");
  const header = yield { offset: 0, length: headerSize };
  const table = readMachoLoadCommandTableHeader(header, imageSize);
  if (!table.ok) return table;
  if (table.value === null) return err("not a Mach-O image");
  const {
    identity: { cpuType, cpuSubtype },
  } = table.value;
  const commands = new MachoLoadCommandCursor(table.value);
  let observed: string | null = null;
  while (commands.nextOffset !== null) {
    const commandOffset = headerSize + commands.nextOffset;
    const commandHeader = yield { offset: commandOffset, length: 8 };
    const frame = commands.read(commandHeader);
    if (!frame.ok) return frame;
    if (frame.value.command === LC_UUID) {
      if (frame.value.size < 8 + UUID_BYTES)
        return err("LC_UUID load command is truncated");
      if (observed !== null)
        return err("Mach-O image declares more than one LC_UUID");
      const payload = yield { offset: commandOffset + 8, length: UUID_BYTES };
      if (payload.length < UUID_BYTES)
        return err("LC_UUID load command is truncated");
      observed = formatUuid(payload);
    }
  }
  const finished = commands.finish();
  if (!finished.ok) return finished;
  return ok({ cpuType, cpuSubtype, uuid: observed });
}

const readThinImage = (
  bytes: Buffer,
  offset: number,
  end: number,
): Result<MachOImageUuid, string> => {
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
  return step.value;
};

const thinEntry = (identity: MachOImageUuid): MachOUuidEntry => ({
  cpuType: identity.cpuType,
  cpuSubtypeBase: machoCpuSubtypeBase(identity.cpuSubtype),
  uuid: identity.uuid,
});

/**
 * Read the LC_UUID of a Mach-O image with its declaring CPU identity,
 * descending into universal (FAT) containers through the shared container
 * owner: slice ranges, alignment, and table-versus-header CPU agreement get
 * the same checks every other FAT consumer applies. Slice order is preserved
 * so a caller can attribute each UUID to its architecture; a zero UUID is
 * preserved: it is an observed value, not an unknown.
 */
export const readMachoUuidEntries = (
  bytes: Buffer,
): Result<MachOUuidEntry[], string> => {
  const container = readFatContainerHeader(bytes, bytes.length);
  if (container.state === "not-fat") {
    const image = readThinImage(bytes, 0, bytes.length);
    return image.ok ? ok([thinEntry(image.value)]) : image;
  }
  if (container.state === "needs-data")
    return err("the universal Mach-O container table is truncated");
  if (container.state === "malformed") return err(container.reason);
  for (const declaration of container.slices) {
    const rangeIssue = validateFatSlice(
      declaration,
      bytes.length,
      container.tableEnd,
    );
    if (rangeIssue !== null) return err(rangeIssue);
  }
  const overlap = findOverlappingFatSlices(container.slices);
  if (overlap !== null)
    return err(
      `FAT architectures ${overlap[0].index} and ${overlap[1].index} have overlapping slice ranges`,
    );
  const entries: MachOUuidEntry[] = [];
  for (const declaration of container.slices) {
    const image = readThinImage(
      bytes,
      declaration.offset,
      declaration.offset + declaration.size,
    );
    if (!image.ok) return image;
    const identityIssue = validateFatSlice(
      declaration,
      bytes.length,
      container.tableEnd,
      image.value,
    );
    if (identityIssue !== null) return err(identityIssue);
    entries.push({
      cpuType: declaration.cpuType,
      cpuSubtypeBase: machoCpuSubtypeBase(declaration.cpuSubtype),
      uuid: image.value.uuid,
    });
  }
  return ok(entries);
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
