import { BinaryReader } from "../binaryContainer.js";
import { LC } from "./machoLoadCommandCodes.js";
import type { MachoDependency } from "./dylibResolution.js";
import { err, ok, type Result } from "../result.js";
import {
  readMachoCommandStringBytes,
  type MachoCommandStringFailure,
} from "./machoLoadCommands.js";

const DEPENDENCY_COMMANDS: ReadonlyMap<number, MachoDependency["command"]> =
  new Map([
    [LC.LOAD_DYLIB, "LC_LOAD_DYLIB"],
    [LC.LOAD_WEAK_DYLIB, "LC_LOAD_WEAK_DYLIB"],
    [LC.REEXPORT_DYLIB, "LC_REEXPORT_DYLIB"],
    [LC.LAZY_LOAD_DYLIB, "LC_LAZY_LOAD_DYLIB"],
    [LC.LOAD_UPWARD_DYLIB, "LC_LOAD_UPWARD_DYLIB"],
  ]);

/** Dependency order follows command order; LC_ID_DYLIB does not consume an ordinal. */
export const machoDependencyCommand = (code: number) =>
  DEPENDENCY_COMMANDS.get(code) ?? null;

export const MACHO_DYLIB_FIELDS_OFFSET = 12;
export const MACHO_DYLIB_NAME_MIN = 24;
const MACHO_DYLIB_USE_NAME_OFFSET = 28;
const DYLIB_USE_MARKER = 0x1a741800;

// dyld interprets the alternate encoding on linked dependency commands.
const canUseDylibFlags = (command: number, nameOffset: number): boolean =>
  nameOffset === MACHO_DYLIB_USE_NAME_OFFSET &&
  (command === LC.LOAD_DYLIB ||
    command === LC.LOAD_WEAK_DYLIB ||
    command === LC.REEXPORT_DYLIB ||
    command === LC.LOAD_UPWARD_DYLIB);

export const machoDylibFieldsSize = (
  command: number,
  nameOffset: number,
): number =>
  (canUseDylibFlags(command, nameOffset)
    ? MACHO_DYLIB_USE_NAME_OFFSET
    : MACHO_DYLIB_NAME_MIN) - MACHO_DYLIB_FIELDS_OFFSET;

/** Decode an admitted dylib prefix. The command, marker and name offset select the encoding. */
export const readMachoDylibFields = (
  bytes: Uint8Array,
  command: number,
  nameOffset: number,
  littleEndian: boolean,
) => {
  const reader = new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    littleEndian,
    "macho",
  );
  const timestamp = reader.u32(0);
  return {
    nameOffset,
    currentVersion: reader.u32(4),
    compatibilityVersion: reader.u32(8),
    encoding:
      canUseDylibFlags(command, nameOffset) && timestamp === DYLIB_USE_MARKER
        ? { kind: "use" as const, flags: reader.u32(12) }
        : { kind: "timestamp" as const, timestamp },
  };
};

interface MachoDylibCommandFacts {
  readonly encoding: "dylib_command" | "dylib_use_command";
  /** Classic commands have no flags field. Unknown modern bits remain source facts. */
  readonly flags: number | null;
  readonly currentVersion: number;
  readonly compatibilityVersion: number;
  readonly nameOffset: number;
  readonly nameBytes: Uint8Array;
}

/** Decode classic or marker-bearing dylib fields without imposing text or flag policy. */
export const readMachoDylibCommandFacts = (
  body: Uint8Array,
  command: number,
  littleEndian: boolean,
): Result<
  MachoDylibCommandFacts,
  | {
      readonly _tag: "InvalidMachoDylibCommand";
      readonly reason: "truncated-header";
    }
  | MachoCommandStringFailure
> => {
  if (body.byteLength < MACHO_DYLIB_NAME_MIN)
    return err({
      _tag: "InvalidMachoDylibCommand",
      reason: "truncated-header",
    });
  const name = readMachoCommandStringBytes(
    body,
    MACHO_DYLIB_NAME_MIN,
    littleEndian,
  );
  if (!name.ok) return name;
  const offset = name.value.offset;
  const { encoding, currentVersion, compatibilityVersion } =
    readMachoDylibFields(
      body.subarray(
        MACHO_DYLIB_FIELDS_OFFSET,
        MACHO_DYLIB_FIELDS_OFFSET + machoDylibFieldsSize(command, offset),
      ),
      command,
      offset,
      littleEndian,
    );
  return ok({
    encoding: encoding.kind === "use" ? "dylib_use_command" : "dylib_command",
    flags: encoding.kind === "use" ? encoding.flags : null,
    currentVersion,
    compatibilityVersion,
    nameOffset: offset,
    nameBytes: name.value.bytes,
  });
};
