import { machoArchitectureName } from "../../domain/apple/machoCpuIdentity.js";
import type {
  AppleIps,
  AppleIpsJoin,
  RecordedInteger,
} from "../../domain/native/appleIps.js";

/**
 * Slice identity join between a recorded Apple .ips report and one
 * caller-selected Mach-O or dSYM. Only UUID and CPU identity are read from the
 * join artifact; the report stays the owner of its own recorded rows.
 */

const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const FAT_CIGAM = 0xbebafeca;
const FAT_MAGIC_64 = 0xcafebabf;
const FAT_CIGAM_64 = 0xbfbafeca;
const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const MAX_SLICES = 64;

const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

const recorded = (value: bigint): RecordedInteger => ({
  decimal: value.toString(),
  hex: value < 0n ? null : `0x${value.toString(16)}`,
});

/** Canonical uppercase UUID text, or the source spelling when not 16 bytes. */
const canonicalUuidBytes = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength !== 16) return null;
  const hex = Buffer.from(bytes).toString("hex").toUpperCase();
  if (hex === "00000000000000000000000000000000") return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

interface SliceIdentity {
  readonly index: number;
  readonly offset: bigint;
  readonly arch: string;
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly uuid: string | null;
  readonly textVmaddr: bigint | null;
  readonly unexamined: readonly string[];
}

type SliceParse =
  | { readonly kind: "slices"; readonly slices: readonly SliceIdentity[] }
  | { readonly kind: "unreadable"; readonly reason: string };

const readSliceIdentities = (bytes: Uint8Array): SliceParse => {
  if (bytes.byteLength < 28)
    return {
      kind: "unreadable",
      reason: "artifact is shorter than a Mach-O header",
    };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Mach-O magics are stored little-endian on every supported Apple host.
  const thinMagic = view.getUint32(0, true);
  if (thinMagic === MH_MAGIC || thinMagic === MH_MAGIC_64) {
    const slice = sliceAt(view, 0, 0);
    return slice === null
      ? { kind: "unreadable", reason: "Mach-O slice header is unreadable" }
      : { kind: "slices", slices: [slice] };
  }
  const magic = view.getUint32(0, false);
  if (
    magic !== FAT_MAGIC &&
    magic !== FAT_CIGAM &&
    magic !== FAT_MAGIC_64 &&
    magic !== FAT_CIGAM_64
  )
    return {
      kind: "unreadable",
      reason: "artifact is neither a Mach-O slice nor a FAT container",
    };
  const littleEndian = magic === FAT_CIGAM || magic === FAT_CIGAM_64;
  const wide = magic === FAT_MAGIC_64 || magic === FAT_CIGAM_64;
  const count = view.getUint32(4, littleEndian);
  if (count === 0)
    return { kind: "unreadable", reason: "FAT container declares no slices" };
  if (count > MAX_SLICES)
    return {
      kind: "unreadable",
      reason: `FAT container declares ${String(count)} slices, above the ${String(MAX_SLICES)}-slice limit`,
    };
  const recordSize = wide ? 32 : 20;
  if (8 + count * recordSize > bytes.byteLength)
    return { kind: "unreadable", reason: "FAT slice table is truncated" };
  const slices: SliceIdentity[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = 8 + index * recordSize;
    const offset = wide
      ? view.getBigUint64(base + 8, littleEndian)
      : BigInt(view.getUint32(base + 8, littleEndian));
    const size = wide
      ? view.getBigUint64(base + 16, littleEndian)
      : BigInt(view.getUint32(base + 12, littleEndian));
    if (offset + size > BigInt(bytes.byteLength))
      return {
        kind: "unreadable",
        reason: `FAT slice ${String(index)} extends beyond the artifact`,
      };
    const slice = sliceAt(view, Number(offset), index);
    if (slice === null)
      return {
        kind: "unreadable",
        reason: `FAT slice ${String(index)} is not a Mach-O image`,
      };
    slices.push(slice);
  }
  return { kind: "slices", slices };
};

const sliceAt = (
  view: DataView,
  offset: number,
  index: number,
): SliceIdentity | null => {
  if (offset + 28 > view.byteLength) return null;
  const magic = view.getUint32(offset, true);
  const wide = magic === MH_MAGIC_64;
  if (!wide && magic !== MH_MAGIC) return null;
  const cpuType = view.getUint32(offset + 4, true);
  const cpuSubtype = view.getUint32(offset + 8, true);
  const headerSize = wide ? 32 : 28;
  const commandCount = view.getUint32(offset + 16, true);
  let cursor = offset + headerSize;
  let uuid: string | null = null;
  let textVmaddr: bigint | null = null;
  const unexamined: string[] = [];
  for (let command = 0; command < commandCount; command += 1) {
    if (cursor + 8 > view.byteLength) {
      unexamined.push(
        `load command ${String(cursor)} stops outside the artifact; later load commands and the symbol table are unexamined`,
      );
      break;
    }
    const kind = view.getUint32(cursor, true);
    const size = view.getUint32(cursor + 4, true);
    if (size < 8 || cursor + size > view.byteLength) {
      unexamined.push(
        `load command ${String(cursor)} has an invalid size; later load commands and the symbol table are unexamined`,
      );
      break;
    }
    if (kind === LC_UUID && size >= 24 && uuid === null)
      uuid = canonicalUuidBytes(
        new Uint8Array(view.buffer, view.byteOffset + cursor + 8, 16),
      );
    if (
      (kind === LC_SEGMENT || kind === LC_SEGMENT_64) &&
      textVmaddr === null
    ) {
      const segmentWide = kind === LC_SEGMENT_64;
      const segmentHeader = segmentWide ? 72 : 56;
      if (size >= segmentHeader) {
        const name = text
          .decode(new Uint8Array(view.buffer, view.byteOffset + cursor + 8, 16))
          .replace(/\0.*$/su, "");
        if (name === "__TEXT")
          textVmaddr = segmentWide
            ? view.getBigUint64(cursor + 24, true)
            : BigInt(view.getUint32(cursor + 24, true));
      }
    }
    cursor += size;
  }
  return {
    index,
    offset: BigInt(offset),
    arch: machoArchitectureName(cpuType, cpuSubtype),
    cpuType,
    cpuSubtype,
    uuid,
    textVmaddr,
    unexamined,
  };
};

const comparableArch = (value: string): string =>
  value.trim().toLowerCase().replaceAll("-", "");

const ARCH_ALIASES: Readonly<Record<string, string>> = {
  arm64: "arm64",
  arm64e: "arm64e",
  x8664: "x86_64",
  x86_64: "x86_64",
  i386: "i386",
  armv7: "armv7",
  armv7s: "armv7s",
  armv8: "arm64",
};

const architecturesAgree = (recorded: string, slice: string): boolean => {
  const left =
    ARCH_ALIASES[comparableArch(recorded)] ?? comparableArch(recorded);
  const right = ARCH_ALIASES[comparableArch(slice)] ?? comparableArch(slice);
  return left === right;
};

/** Resolve every report image and frame against the selected artifact. */
export const resolveAppleIpsJoin = (
  report: AppleIps,
  artifact: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: Buffer;
  },
  input: { readonly path: string; readonly max_join_bytes: number },
): AppleIpsJoin => {
  const parsed = readSliceIdentities(artifact.bytes);
  if (parsed.kind === "unreadable")
    return { status: "unreadable", path: input.path, reason: parsed.reason };
  const matches: AppleIpsJoinDigest[] = [];
  const limitations: string[] = [];
  const matchedImage = new Map<number, AppleIpsJoinDigest>();
  const rejectedImage = new Map<number, string>();
  for (const image of report.images) {
    const recordedArch = image.arch ?? "";
    if (image.uuid === null || recordedArch === "") continue;
    const candidates = parsed.slices.filter(
      ({ uuid }) => uuid !== null && uuid === image.uuid,
    );
    if (candidates.length === 0) continue;
    const compatible = candidates.filter(({ arch }) =>
      architecturesAgree(recordedArch, arch),
    );
    if (compatible.length === 0) {
      const reason = `image ${String(image.index)} UUID ${image.uuid} matches a slice, but its recorded architecture ${JSON.stringify(recordedArch)} does not match ${candidates.map(({ arch }) => arch).join(", ")}; the join is rejected.`;
      limitations.push(reason);
      rejectedImage.set(image.index, reason);
      continue;
    }
    if (compatible.length > 1) {
      const reason = `image ${String(image.index)} UUID ${image.uuid} matches ${String(compatible.length)} slices; the join stays ambiguous.`;
      limitations.push(reason);
      rejectedImage.set(image.index, reason);
      continue;
    }
    const [slice] = compatible;
    if (slice === undefined) continue;
    if (slice.textVmaddr === null) {
      const reason = `slice ${String(slice.index)} has no readable __TEXT segment, so image ${String(image.index)} joins without a static base.`;
      limitations.push(reason);
      rejectedImage.set(image.index, reason);
      continue;
    }
    const digest: AppleIpsJoinDigest = {
      image_index: image.index,
      uuid: image.uuid,
      recorded_arch: recordedArch,
      slice_index: slice.index,
      slice_offset: slice.offset.toString(),
      slice_arch: slice.arch,
      text_vmaddr: recorded(slice.textVmaddr),
      runtime_base: image.base,
    };
    matches.push(digest);
    matchedImage.set(image.index, digest);
  }
  const frames = report.threads.flatMap((thread) =>
    thread.frames.map((frame) =>
      frameJoin(frame, thread.index, {
        images: report.images,
        matched: matchedImage,
        rejected: rejectedImage,
        slices: parsed.slices,
      }),
    ),
  );
  return {
    status: "selected",
    path: input.path,
    sha256: artifact.sha256,
    bytes: artifact.bytes.length,
    slices: parsed.slices.map((slice) => ({
      index: slice.index,
      offset: slice.offset.toString(),
      arch: slice.arch,
      cpu_type: `0x${slice.cpuType.toString(16)}`,
      cpu_subtype: `0x${slice.cpuSubtype.toString(16)}`,
      uuid: slice.uuid,
      text_vmaddr:
        slice.textVmaddr === null ? null : recorded(slice.textVmaddr),
      unexamined: [...slice.unexamined],
    })),
    image_matches: matches,
    frames,
    limitations,
  };
};

type AppleIpsJoinDigest = Extract<
  AppleIpsJoin,
  { readonly status: "selected" }
>["image_matches"][number];

interface FrameJoinContext {
  readonly images: AppleIps["images"];
  readonly matched: ReadonlyMap<number, AppleIpsJoinDigest>;
  readonly rejected: ReadonlyMap<number, string>;
  readonly slices: readonly SliceIdentity[];
}

const frameJoin = (
  frame: AppleIps["threads"][number]["frames"][number],
  threadIndex: number,
  context: FrameJoinContext,
): Extract<AppleIpsJoin, { status: "selected" }>["frames"][number] => {
  const { images, matched, rejected, slices } = context;
  const imageIndex = frame.image_index;
  if (imageIndex === null)
    return unjoined(
      threadIndex,
      frame.frame_index,
      "frame records no imageIndex",
    );
  const image = images[imageIndex];
  if (image === undefined)
    return unjoined(
      threadIndex,
      frame.frame_index,
      `frame imageIndex ${String(imageIndex)} has no usedImages row`,
    );
  if (image.uuid === null)
    return unjoined(
      threadIndex,
      frame.frame_index,
      `image ${String(imageIndex)} UUID is unknown, so it never joins`,
    );
  const digest = matched.get(imageIndex);
  if (digest === undefined) {
    const rejectReason = rejected.get(imageIndex);
    if (rejectReason !== undefined)
      return unjoined(threadIndex, frame.frame_index, rejectReason);
    const uuidMatched = slices.some(({ uuid }) => uuid === image.uuid);
    return unjoined(
      threadIndex,
      frame.frame_index,
      uuidMatched
        ? `image ${String(imageIndex)} UUID ${image.uuid} matches a slice whose architecture does not match ${JSON.stringify(image.arch ?? null)}`
        : `no slice LC_UUID matches image ${String(imageIndex)} UUID ${image.uuid}`,
    );
  }
  const offset = frame.image_offset;
  const staticAddress =
    offset === null
      ? null
      : recorded(BigInt(digest.text_vmaddr.decimal) + BigInt(offset.decimal));
  return {
    thread_index: threadIndex,
    frame_index: frame.frame_index,
    status: "joined",
    reason: null,
    static_address: staticAddress,
  };
};

const unjoined = (
  threadIndex: number,
  frameIndex: number,
  reason: string,
): Extract<AppleIpsJoin, { status: "selected" }>["frames"][number] => ({
  thread_index: threadIndex,
  frame_index: frameIndex,
  status: "unjoined",
  reason,
  static_address: null,
});
