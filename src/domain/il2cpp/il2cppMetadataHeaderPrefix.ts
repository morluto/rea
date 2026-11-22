import { BinaryReader } from "../binaryContainer.js";
import { IL2CPP_METADATA_MAGIC } from "./il2cppMetadata.js";

export const IL2CPP_METADATA_PREFIX_BYTES = 8;

/** Parsed identity facts available before the complete IL2CPP header exists. */
export type Il2cppMetadataHeaderPrefix =
  | {
      readonly kind: "unavailable-magic";
      readonly magic: null;
      readonly rawVersion: null;
      readonly version: null;
    }
  | {
      readonly kind: "other-magic";
      readonly magic: number;
      readonly rawVersion: null;
      readonly version: null;
    }
  | {
      readonly kind: "il2cpp";
      readonly magic: typeof IL2CPP_METADATA_MAGIC;
      /** Unsigned bytes as stored; null means fewer than eight prefix bytes. */
      readonly rawVersion: number | null;
      /** The decoder's signed Int32 interpretation; null means unavailable. */
      readonly version: number | null;
    };

/** Parse the shared magic/version prefix once, retaining incomplete identity explicitly. */
export const observeIl2cppMetadataHeaderPrefix = (
  bytes: Uint8Array,
): Il2cppMetadataHeaderPrefix => {
  if (bytes.byteLength < 4)
    return {
      kind: "unavailable-magic",
      magic: null,
      rawVersion: null,
      version: null,
    };
  const reader = new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "il2cpp-metadata",
  );
  const magic = reader.u32(0);
  if (magic !== IL2CPP_METADATA_MAGIC)
    return {
      kind: "other-magic",
      magic,
      rawVersion: null,
      version: null,
    };
  if (bytes.byteLength < IL2CPP_METADATA_PREFIX_BYTES)
    return {
      kind: "il2cpp",
      magic: IL2CPP_METADATA_MAGIC,
      rawVersion: null,
      version: null,
    };
  const rawVersion = reader.u32(4);
  return {
    kind: "il2cpp",
    magic: IL2CPP_METADATA_MAGIC,
    rawVersion,
    version: rawVersion | 0,
  };
};
