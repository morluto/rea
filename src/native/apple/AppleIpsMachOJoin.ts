import {
  readUniversalMachoImage,
  readUniversalMachoSlice,
} from "../../domain/apple/machoImageSelection.js";
import {
  readMachoLoadCommandTableHeader,
  MachoLoadCommandCursor,
} from "../../domain/apple/machoLoadCommands.js";
import {
  readMachoSegmentHeader,
  admitMachoSegmentCommand,
} from "../../domain/apple/machoSegmentHeader.js";
import { FieldReader } from "./AppleIpsFieldReader.js";
import { machoArchitectureName } from "../../domain/apple/machoCpuIdentity.js";
import type {
  AppleIps,
  AppleIpsJoin,
} from "../../domain/native/appleIps.js";

/**
 * Slice identity join between a recorded Apple .ips report and one
 * caller-selected Mach-O or dSYM. Only UUID and CPU identity are read from the
 * join artifact; the report stays the owner of its own recorded rows.
 */

const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_UUID = 0x1b;
const MAX_SLICES = 64;

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

const readSliceIdentities = (bytes: Buffer): SliceParse => {
  const fat = readUniversalMachoImage(bytes);
  if (!fat.ok) return { kind: "unreadable", reason: fat.error.message };
  if (fat.value === null) {
    const slice = sliceAt(bytes, 0n, 0);
    return slice === null
      ? {
          kind: "unreadable",
          reason: "Mach-O slice or command table is unreadable",
        }
      : { kind: "slices", slices: [slice] };
  }
  if (fat.value.slices.length > MAX_SLICES)
    return { kind: "unreadable", reason: "Join slice allowance exceeded" };
  const slices: SliceIdentity[] = [];
  for (const declaration of fat.value.slices) {
    const selected = readUniversalMachoSlice(bytes, fat.value, declaration);
    if (!selected.ok)
      return { kind: "unreadable", reason: selected.error.message };
    const slice = sliceAt(
      selected.value,
      BigInt(declaration.offset),
      declaration.index,
    );
    if (slice === null)
      return {
        kind: "unreadable",
        reason: `FAT slice ${String(declaration.index)} or its command table is unreadable`,
      };
    slices.push(slice);
  }
  return { kind: "slices", slices };
};

const sliceAt = (
  bytes: Buffer,
  offset: bigint,
  index: number,
): SliceIdentity | null => {
  const parsed = readMachoLoadCommandTableHeader(bytes, bytes.length);
  if (!parsed.ok || parsed.value === null) return null;
  const header = parsed.value;
  const cursor = new MachoLoadCommandCursor(header);
  let uuid: string | null = null;
  let uuidSeen = false;
  let textVmaddr: bigint | null = null;
  for (;;) {
    const next = cursor.nextOffset;
    if (next === null) break;
    const command = bytes.subarray(header.headerSize + next);
    const frame = cursor.read(command);
    if (!frame.ok) return null;
    const payload = command.subarray(0, frame.value.size);
    if (frame.value.command === LC_UUID) {
      if (uuidSeen || payload.length !== 24) return null;
      uuidSeen = true;
      uuid = canonicalUuidBytes(payload.subarray(8, 24));
    }
    if (
      frame.value.command === LC_SEGMENT ||
      frame.value.command === LC_SEGMENT_64
    ) {
      const wide = frame.value.command === LC_SEGMENT_64;
      if (wide !== header.wide) return null;
      const segment = readMachoSegmentHeader(
        payload,
        wide,
        header.littleEndian,
      );
      if (
        !segment.ok ||
        !admitMachoSegmentCommand(
          segment.value,
          payload.length,
          wide ? 64 : 32,
          bytes.length,
        ).ok
      )
        return null;
      const name = segment.value.nameBytes
        .toString("utf8")
        .replace(/\0.*$/su, "");
      if (name === "__TEXT") {
        if (textVmaddr !== null) return null;
        textVmaddr = segment.value.address;
      }
    }
  }
  if (!cursor.finish().ok) return null;
  const { cpuType, cpuSubtype } = header.identity;
  return {
    index,
    offset,
    cpuType,
    cpuSubtype,
    arch: machoArchitectureName(cpuType, cpuSubtype),
    uuid,
    textVmaddr,
    unexamined: [],
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
  read: FieldReader,
): AppleIpsJoin => {
  const parsed = readSliceIdentities(artifact.bytes);
  if (parsed.kind === "unreadable")
    return {
      status: "unreadable",
      path: input.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes.length,
      reason: parsed.reason,
    };
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
      slice_offset: read.decimalText64(slice.offset),
      slice_arch: slice.arch,
      text_vmaddr: read.recordedUnsigned64(slice.textVmaddr),
      runtime_base: read.retainIntegerReference(image.base),
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
        read,
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
      offset: read.decimalText64(slice.offset),
      arch: slice.arch,
      cpu_type: read.hexText32(slice.cpuType),
      cpu_subtype: read.hexText32(slice.cpuSubtype),
      uuid: slice.uuid,
      text_vmaddr:
        slice.textVmaddr === null
          ? null
          : read.recordedUnsigned64(slice.textVmaddr),
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
  readonly read: FieldReader;
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
  if (offset === null)
    return unjoined(
      threadIndex,
      frame.frame_index,
      "frame records no imageOffset",
    );
  const staticAddress = context.read.add(digest.text_vmaddr, offset);
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
