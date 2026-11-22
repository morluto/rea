import { z } from "zod";

import {
  findOverlappingFatSlices,
  readFatContainerHeader,
  readFatHeaderPrefix,
  readMachoHeaderPrefixFacts,
  validateFatSlice,
  type FatSliceDeclaration,
} from "./apple/machoContainer.js";
import { machoCpuSubtypeBase } from "./apple/machoCpuIdentity.js";
import {
  MachoLoadCommandCursor,
  machoCommandTableIssue,
  readMachoLoadCommandDeclarations,
} from "./apple/machoLoadCommands.js";
import { LC } from "./apple/machoLoadCommandCodes.js";
import { digestSchema } from "./digests.js";
import { localPathStringSchema } from "./localPath.js";
import {
  malformedInput,
  ParseFailureError,
  truncatedInput,
} from "./parseFailure.js";
import { err, ok, type Result } from "./result.js";

/** Canonical uppercase hex LC_UUID formatting emitted by Mach-O decoders. */
export const MACHO_UUID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/u;

/** Shared wire and persistence shape for an admitted Mach-O dSYM companion. */
export const machODebugCompanionCommitmentShape = {
  source_path: localPathStringSchema,
  uuid: z.string().regex(MACHO_UUID_PATTERN),
  member_sha256: digestSchema,
} as const;

/** Strict identity commitment for analysis profiles and persisted snapshots. */
export const machODebugCompanionCommitmentSchema = z.strictObject(
  machODebugCompanionCommitmentShape,
);
export type MachODebugCompanionCommitment = z.infer<
  typeof machODebugCompanionCommitmentSchema
>;

const UUID_BYTES = 16;
const MACHO_FORMAT = "mach-o";

/** Format failure established while reading Mach-O container or LC_UUID structure. */
export type MachOUuidParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"truncated">;

/** Shift a slice-relative parse offset into its enclosing container file. */
export const rebaseMachoParseFailure = (
  failure: MachOUuidParseError,
  baseOffset: number,
): MachOUuidParseError => {
  if (baseOffset === 0 || failure.failure.offset === undefined) return failure;
  const site = {
    offset: baseOffset + failure.failure.offset,
    ...(failure.failure.field === undefined
      ? {}
      : { field: failure.failure.field }),
    cause: failure,
  };
  return failure.kind === "truncated"
    ? truncatedInput(failure.failure.format, failure.failure.detail, site)
    : malformedInput(failure.failure.format, failure.failure.detail, site);
};

/** Classify one FAT slice range defect as truncated (past EOF) or malformed. */
export const fatSliceRangeParseFailure = (
  slice: Pick<FatSliceDeclaration, "offset" | "size">,
  fileSize: number,
  reason: string,
): MachOUuidParseError => {
  const site = { offset: slice.offset, field: "fat_arch" };
  return slice.offset > fileSize || slice.size > fileSize - slice.offset
    ? truncatedInput(MACHO_FORMAT, reason, site)
    : malformedInput(MACHO_FORMAT, reason, site);
};

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
): Generator<
  MachOUuidRead,
  Result<MachOImageUuid, MachOUuidParseError>,
  Buffer
> {
  if (imageSize < 4)
    return err(
      truncatedInput(MACHO_FORMAT, "Mach-O header is truncated", {
        offset: 0,
        field: "magic",
      }),
    );
  const magicBytes = yield { offset: 0, length: 4 };
  if (magicBytes.length < 4)
    return err(
      truncatedInput(MACHO_FORMAT, "Mach-O header is truncated", {
        offset: 0,
        field: "magic",
      }),
    );
  const prefix = readMachoHeaderPrefixFacts(magicBytes);
  if (prefix.format === null)
    return err(
      malformedInput(MACHO_FORMAT, "not a Mach-O image", {
        offset: 0,
        field: "magic",
      }),
    );
  const { headerSize } = prefix.format;
  if (imageSize < headerSize)
    return err(
      truncatedInput(
        MACHO_FORMAT,
        "Mach-O header is truncated before its load commands",
        { offset: 0, field: "mach_header" },
      ),
    );
  const header = yield { offset: 0, length: headerSize };
  const declarations = readMachoLoadCommandDeclarations(header, imageSize);
  if (!declarations.ok)
    return err(
      truncatedInput(MACHO_FORMAT, declarations.error, {
        offset: 0,
        field: "mach_header",
      }),
    );
  if (declarations.value === null)
    return err(
      malformedInput(MACHO_FORMAT, "not a Mach-O image", {
        offset: 0,
        field: "magic",
      }),
    );
  const tableIssue = machoCommandTableIssue(declarations.value, imageSize);
  if (tableIssue !== null)
    return err(
      tableIssue.kind === "extent"
        ? truncatedInput(MACHO_FORMAT, tableIssue.message, {
            offset: headerSize,
            field: "sizeofcmds",
          })
        : malformedInput(MACHO_FORMAT, tableIssue.message, {
            offset: 16,
            field: "ncmds",
          }),
    );
  const {
    identity: { cpuType, cpuSubtype },
  } = declarations.value;
  const commands = new MachoLoadCommandCursor(declarations.value);
  let observed: string | null = null;
  while (commands.nextOffset !== null) {
    const commandOffset = headerSize + commands.nextOffset;
    const commandHeader = yield { offset: commandOffset, length: 8 };
    if (commandHeader.length < 8)
      return err(
        truncatedInput(MACHO_FORMAT, "load command header is truncated", {
          offset: commandOffset,
          field: "load_command",
        }),
      );
    const frame = commands.read(commandHeader);
    if (!frame.ok)
      return err(
        malformedInput(MACHO_FORMAT, frame.error, {
          offset: commandOffset,
          field: "load_command",
        }),
      );
    if (frame.value.command === LC.UUID) {
      if (frame.value.size < 8 + UUID_BYTES)
        return err(
          malformedInput(MACHO_FORMAT, "LC_UUID load command is truncated", {
            offset: commandOffset,
            field: "LC_UUID",
          }),
        );
      if (observed !== null)
        return err(
          malformedInput(
            MACHO_FORMAT,
            "Mach-O image declares more than one LC_UUID",
            { offset: commandOffset, field: "LC_UUID" },
          ),
        );
      const payload = yield { offset: commandOffset + 8, length: UUID_BYTES };
      if (payload.length < UUID_BYTES)
        return err(
          truncatedInput(MACHO_FORMAT, "LC_UUID load command is truncated", {
            offset: commandOffset + 8,
            field: "LC_UUID",
          }),
        );
      observed = formatUuid(payload);
    }
  }
  const finished = commands.finish();
  if (!finished.ok)
    return err(
      malformedInput(MACHO_FORMAT, finished.error, {
        offset: headerSize,
        field: "sizeofcmds",
      }),
    );
  return ok({ cpuType, cpuSubtype, uuid: observed });
}

const readThinImage = (
  bytes: Buffer,
  offset: number,
  end: number,
): Result<MachOImageUuid, MachOUuidParseError> => {
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
): Result<MachOUuidEntry[], MachOUuidParseError> => {
  const container = readFatContainerHeader(bytes, bytes.length);
  if (container.state === "not-fat") {
    const image = readThinImage(bytes, 0, bytes.length);
    return image.ok ? ok([thinEntry(image.value)]) : image;
  }
  if (container.state === "needs-data")
    return err(
      truncatedInput(
        MACHO_FORMAT,
        "the universal Mach-O container table is truncated",
        { offset: 0, field: "fat_header" },
      ),
    );
  if (container.state === "malformed") {
    const site = { offset: 0, field: "fat_header" };
    return err(
      readFatHeaderPrefix(bytes).state === "incomplete"
        ? truncatedInput(MACHO_FORMAT, container.reason, site)
        : malformedInput(MACHO_FORMAT, container.reason, site),
    );
  }
  for (const declaration of container.slices) {
    const rangeIssue = validateFatSlice(
      declaration,
      bytes.length,
      container.tableEnd,
    );
    if (rangeIssue !== null)
      return err(
        fatSliceRangeParseFailure(declaration, bytes.length, rangeIssue),
      );
  }
  const overlap = findOverlappingFatSlices(container.slices);
  if (overlap !== null)
    return err(
      malformedInput(
        MACHO_FORMAT,
        `FAT architectures ${overlap[0].index} and ${overlap[1].index} have overlapping slice ranges`,
        { offset: overlap[1].offset, field: "fat_arch" },
      ),
    );
  const entries: MachOUuidEntry[] = [];
  for (const declaration of container.slices) {
    const image = readThinImage(
      bytes,
      declaration.offset,
      declaration.offset + declaration.size,
    );
    if (!image.ok)
      return err(rebaseMachoParseFailure(image.error, declaration.offset));
    const identityIssue = validateFatSlice(
      declaration,
      bytes.length,
      container.tableEnd,
      image.value,
    );
    if (identityIssue !== null)
      return err(
        malformedInput(MACHO_FORMAT, identityIssue, {
          offset: declaration.offset,
          field: "fat_arch",
        }),
      );
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

export type MachOCompanionSliceMatch =
  | { readonly status: "matched"; readonly uuid: string }
  | { readonly status: "no-match" }
  | { readonly status: "ambiguous-slice" };

/**
 * Match a selected target slice against a companion image's slice entries. A
 * universal companion that repeats the selected CPU type and base subtype
 * cannot identify which slice a whole-file consumer will load when one of those
 * slices carries the target UUID, so its applicability is ambiguous rather than
 * aligned or absent.
 */
export const matchMachOCompanionEntries = (
  selected: {
    readonly cpuType: number;
    readonly cpuSubtypeBase: number;
    readonly uuid: string;
  },
  companionEntries: readonly MachOUuidEntry[],
): Result<MachOCompanionSliceMatch, string> => {
  if (!usableMachOUuid(selected.uuid))
    return err("the executable declares no LC_UUID to match against");
  const applicable = companionEntries.filter(
    ({ cpuType, cpuSubtypeBase }) =>
      cpuType === selected.cpuType &&
      cpuSubtypeBase === selected.cpuSubtypeBase,
  );
  if (applicable.length === 0) return ok({ status: "no-match" });
  if (applicable.length > 1) {
    const claimsTarget = applicable.some(
      ({ uuid }) => usableMachOUuid(uuid) && uuid === selected.uuid,
    );
    return ok(
      claimsTarget ? { status: "ambiguous-slice" } : { status: "no-match" },
    );
  }
  const matched = debugCompanionMatches({
    executableUuids: [selected.uuid],
    companionUuids: applicable
      .map(({ uuid }) => uuid)
      .filter((uuid): uuid is string => uuid !== null),
  });
  return ok(
    matched.ok
      ? { status: "matched", uuid: matched.value.uuid }
      : { status: "no-match" },
  );
};
