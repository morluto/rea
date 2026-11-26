import { BinaryReader } from "./binaryContainer.js";

/** Whether bytes start with a standalone Godot PCK header. */
export const hasGodotPckHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x47 &&
  bytes[1] === 0x44 &&
  bytes[2] === 0x50 &&
  bytes[3] === 0x43;

/** Common declared fields; support and pack extent admission belong to callers. */
export interface GodotPckHeaderFacts {
  readonly formatVersion: number;
  readonly engineMajor: number;
  readonly engineMinor: number;
  readonly enginePatch: number;
}

const pckReader = (bytes: Uint8Array): BinaryReader =>
  new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "godot-pck",
  );

/** Decode declared fields after the caller admits a complete 20-byte header. */
export const readGodotPckHeaderFacts = (
  bytes: Uint8Array,
): GodotPckHeaderFacts => {
  const reader = pckReader(bytes);
  return {
    formatVersion: reader.u32(4),
    engineMajor: reader.u32(8),
    engineMinor: reader.u32(12),
    enginePatch: reader.u32(16),
  };
};

/** End of a supported pack header, including its 16 reserved words. */
export const godotPckHeaderEnd = (start: number, version: number): number =>
  start + (version === 1 ? 84 : version === 2 ? 96 : 104);

/** Directory bytes and nonempty member data may begin at this boundary. */
export const godotPckDataStartsAfterHeader = (
  packStart: number,
  formatVersion: number,
  offset: number,
): boolean => offset >= godotPckHeaderEnd(packStart, formatVersion);

/** A terminal marker declares an extent; the located header still needs confirmation. */
export type GodotPckTrailerFacts =
  | { readonly state: "absent" }
  | {
      readonly state: "declared";
      readonly packBytes: bigint;
      readonly start: number | null;
      readonly end: number;
    };

/** Decode an admitted complete 12-byte trailer and its host-sized source extent. */
export const readGodotPckTrailerFacts = (
  trailer: Uint8Array,
  fileSize: number,
): GodotPckTrailerFacts => {
  if (!hasGodotPckHeader(trailer.subarray(8, 12))) return { state: "absent" };
  const packBytes = pckReader(trailer).word(0, 64);
  const end = fileSize - 12;
  return {
    state: "declared",
    packBytes,
    start: packBytes > BigInt(end) ? null : end - Number(packBytes),
    end,
  };
};
