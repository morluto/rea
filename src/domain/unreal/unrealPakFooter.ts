import { BinaryReader } from "../binaryContainer.js";
import { UNREAL_PAK_FOOTER_LAYOUTS } from "./unrealPak.js";

/** The magic every pak footer layout carries before its version. */
export const UNREAL_PAK_MAGIC = 0x5a6f12e1;

export type UnrealPakFooterLayout = (typeof UNREAL_PAK_FOOTER_LAYOUTS)[number];

/** The fields one footer layout serializes, in the order they appear. */
export interface UnrealPakFooterShape {
  readonly version: number;
  readonly keyGuid: boolean;
  readonly encryptedFlag: boolean;
  readonly frozenFlag: boolean;
  readonly compressionSlots: 0 | 4 | 5;
}

export const unrealPakFooterShape = (
  layout: UnrealPakFooterLayout,
): UnrealPakFooterShape => {
  const version =
    layout === "v8a" || layout === "v8b" ? 8 : Number(layout.slice(1));
  return {
    version,
    keyGuid: version >= 7,
    encryptedFlag: version >= 4,
    frozenFlag: version === 9,
    compressionSlots: version < 8 ? 0 : layout === "v8a" ? 4 : 5,
  };
};

export const unrealPakFooterBytes = (shape: UnrealPakFooterShape): number =>
  (shape.keyGuid ? 16 : 0) +
  (shape.encryptedFlag ? 1 : 0) +
  4 +
  4 +
  8 +
  8 +
  20 +
  (shape.frozenFlag ? 1 : 0) +
  shape.compressionSlots * 32;

/** The longest footer layout, so a tail of this many bytes holds any footer. */
export const UNREAL_PAK_MAX_FOOTER_BYTES = Math.max(
  ...UNREAL_PAK_FOOTER_LAYOUTS.map((layout) =>
    unrealPakFooterBytes(unrealPakFooterShape(layout)),
  ),
);

const littleEndian = (bytes: Uint8Array): BinaryReader =>
  new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "unreal-pak",
  );

/** A footer layout whose magic and version match the end of a tail. */
export interface UnrealPakFooterMatch {
  readonly layout: UnrealPakFooterLayout;
  readonly shape: UnrealPakFooterShape;
  /** Footer start within the tail. */
  readonly start: number;
  /** Byte offset of the footer's index offset field within the tail. */
  readonly indexAt: number;
}

/**
 * The first layout, newest first, whose magic and version end `tail`. Only
 * the magic and version are checked; the caller decides what else it trusts.
 */
export const matchUnrealPakFooter = (
  tail: Uint8Array,
): UnrealPakFooterMatch | undefined => {
  const reader = littleEndian(tail);
  for (const layout of UNREAL_PAK_FOOTER_LAYOUTS) {
    const shape = unrealPakFooterShape(layout);
    const size = unrealPakFooterBytes(shape);
    if (size > tail.length) continue;
    const start = tail.length - size;
    const magicAt =
      start + (shape.keyGuid ? 16 : 0) + (shape.encryptedFlag ? 1 : 0);
    if (reader.u32(magicAt) !== UNREAL_PAK_MAGIC) continue;
    if (reader.u32(magicAt + 4) !== shape.version) continue;
    return { layout, shape, start, indexAt: magicAt + 8 };
  }
  return undefined;
};

/**
 * Whether the final bytes of a file of `fileSize` bytes are a pak footer
 * whose index lies between the start of the file and the footer. Magic and
 * version alone could end arbitrary bytes, so a footer naming an empty index
 * or one outside the file does not claim the format.
 */
export const hasUnrealPakFooter = (
  tail: Uint8Array,
  fileSize: number,
): boolean => {
  if (tail.length > fileSize) return false;
  const match = matchUnrealPakFooter(tail);
  if (match === undefined) return false;
  const reader = littleEndian(tail);
  const indexOffset = reader.word(match.indexAt, 64);
  const indexSize = reader.word(match.indexAt + 8, 64);
  const footerOffset = BigInt(fileSize - (tail.length - match.start));
  return indexSize > 0n && indexOffset + indexSize <= footerOffset;
};
