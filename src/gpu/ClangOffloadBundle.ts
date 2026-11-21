import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { scheduler } from "node:timers/promises";
import type { GpuObject } from "../domain/gpu/gpuCodeObjects.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
} from "../domain/binaryContainer.js";
import { assertArtifactReadActive } from "../resources/index.js";
import {
  gpuCount,
  GPU_OBJECT_BYTES,
  GPU_REPORT_BYTES,
  rejectGpu,
  type GpuSource,
} from "./GpuSource.js";
import { gpuObject } from "./GpuObject.js";
import {
  isAmdGpuBundleId,
  readAmdGpuBundleTarget,
  type AmdGpuTargetIdentity,
} from "./AmdGpuTarget.js";
export const CLANG_BUNDLE_MAGIC = Buffer.from("__CLANG_OFFLOAD_BUNDLE__");
export const CCOB_MAGIC = Buffer.from("CCOB");
const CLANG_BUNDLE_HEADER_BYTES = 32;
const CLANG_BUNDLE_ENTRY_BYTES = 24;
const CLANG_BUNDLE_MAX_ENTRIES = 65_536;
const CLANG_BUNDLE_MAX_ID_BYTES = 65_536;
export const readClangBundleDirectory = async (
  source: GpuSource,
  base: number,
  signal?: AbortSignal,
): Promise<{
  declarations: { object: GpuObject; amdTarget: AmdGpuTargetIdentity | null }[];
  end: number;
}> => {
  const header = await source.read(base, CLANG_BUNDLE_HEADER_BYTES);
  if (!header.subarray(0, CLANG_BUNDLE_MAGIC.length).equals(CLANG_BUNDLE_MAGIC))
    rejectGpu("Invalid Clang offload bundle magic");
  const declaredCount = new BinaryReader(
    header,
    true,
    "clang offload bundle",
  ).word(CLANG_BUNDLE_MAGIC.length, 64);
  // Each directory entry needs three 64-bit words before its variable ID.
  const sourceEnd = BigInt(source.size);
  const firstEntry = base + CLANG_BUNDLE_HEADER_BYTES;
  if (
    declaredCount * BigInt(CLANG_BUNDLE_ENTRY_BYTES) >
    sourceEnd - BigInt(firstEntry)
  )
    rejectGpu("Clang offload bundle directory is truncated");
  const count = gpuCount(declaredCount);
  if (count > CLANG_BUNDLE_MAX_ENTRIES)
    throw new BinaryResourceFailure(
      "structure",
      CLANG_BUNDLE_MAX_ENTRIES,
      "HIP bundle entry count exceeds the inventory budget",
      "hip-bundle-entries",
      "entries",
    );
  // One wrapper/identity per admitted entry. Processor text is
  // no longer than its admitted name; cumulative name bytes remain
  // within the 16 MiB directory bound before identities are allocated.
  const declarations: {
    object: GpuObject;
    amdTarget: AmdGpuTargetIdentity | null;
  }[] = [];
  let position = firstEntry;
  let firstPayload = sourceEnd;
  let lastPayloadEnd = firstEntry;
  for (let index = 0; index < count; index++) {
    if (index % 256 === 0) {
      await scheduler.yield();
      assertArtifactReadActive(signal);
    }
    const entry = new BinaryReader(
      await source.read(position, CLANG_BUNDLE_ENTRY_BYTES),
      true,
      "clang offload bundle",
    );
    const rawOffset = BigInt(base) + entry.word(0, 64);
    const rawSize = entry.word(8, 64);
    const rawNameSize = entry.word(16, 64);
    if (rawOffset > sourceEnd || rawSize > sourceEnd - rawOffset)
      rejectGpu("HIP entry range is outside its bundle");
    const offset = Number(rawOffset);
    const size = Number(rawSize);
    if (rawSize > 0n) {
      if (rawOffset < firstPayload) firstPayload = rawOffset;
      lastPayloadEnd = Math.max(lastPayloadEnd, offset + size);
    }

    const nameOffset = position + CLANG_BUNDLE_ENTRY_BYTES;
    const minimumDirectoryEnd =
      BigInt(nameOffset + (count - index - 1) * CLANG_BUNDLE_ENTRY_BYTES) +
      rawNameSize;
    if (minimumDirectoryEnd > sourceEnd)
      rejectGpu("HIP bundle ID or following entry is outside its bundle");
    if (minimumDirectoryEnd > firstPayload)
      rejectGpu("HIP entry overlaps its bundle directory");
    const nameSize = Number(rawNameSize);
    if (nameSize > CLANG_BUNDLE_MAX_ID_BYTES)
      throw new BinaryResourceFailure(
        "structure",
        CLANG_BUNDLE_MAX_ID_BYTES,
        `HIP bundle ID exceeds ${String(CLANG_BUNDLE_MAX_ID_BYTES)} bytes`,
        "hip-bundle-id-bytes",
        "bytes",
      );
    if (nameOffset - base + nameSize > GPU_REPORT_BYTES)
      throw new BinaryResourceFailure(
        "structure",
        GPU_REPORT_BYTES,
        "HIP bundle directory exceeds its retained byte budget",
        "hip-bundle-directory-bytes",
        "bytes",
      );
    let name: string;
    try {
      name = decodeStrictUtf8(
        await source.read(nameOffset, nameSize),
        "preserve",
      );
    } catch (cause) {
      if (cause instanceof TypeError)
        return rejectGpu("HIP bundle ID is not valid UTF-8");
      throw cause;
    }

    const row = gpuObject(source, {
      offset,
      size,
      kind: name.startsWith("host-")
        ? "host"
        : isAmdGpuBundleId(name)
          ? "amdgpu"
          : "unknown",
      metadata: { offset: position, size: CLANG_BUNDLE_ENTRY_BYTES + nameSize },
    });
    row.bundle_id = name;
    const amdTarget = readAmdGpuBundleTarget(name);
    row.target = amdTarget?.key ?? null;
    declarations.push({ object: row, amdTarget });
    position = nameOffset + nameSize;
  }
  return { declarations, end: Math.max(position, lastPayloadEnd) };
};
export const readCcobHeader = (bytes: Buffer, remaining: number) => {
  if (bytes.length < 20) rejectGpu("CCOB header is truncated");
  if (!bytes.subarray(0, CCOB_MAGIC.length).equals(CCOB_MAGIC))
    rejectGpu("Invalid CCOB magic");
  const reader = new BinaryReader(bytes, true, "ccob");
  const version = reader.u16(4),
    method = reader.u16(6);
  let width: number, total: number, decoded: bigint, hash: bigint;
  if (version === 1) {
    width = 20;
    total = remaining;
    decoded = reader.word(8, 32);
    hash = reader.word(12, 64);
  } else if (version === 2) {
    width = 24;
    if (bytes.length < width) rejectGpu("CCOB v2 header is truncated");
    total = reader.u32(8);
    decoded = reader.word(12, 32);
    hash = reader.word(16, 64);
  } else if (version === 3) {
    width = 32;
    if (bytes.length < width) rejectGpu("CCOB v3 header is truncated");
    total = gpuCount(reader.word(8, 64));
    decoded = reader.word(16, 64);
    hash = reader.word(24, 64);
  } else
    throw new BinaryFormatFailure(
      "unsupported",
      `Unsupported CCOB version ${version}`,
    );
  if (total < width || total > remaining)
    rejectGpu("CCOB declared extent is invalid");
  return { version, method, width, total, decoded, hash };
};

/** After failed/unsupported v1 decoding only: a marker is an uncertain recovery candidate. */
export const findLegacyCcobRecoveryTotal = async (
  source: GpuSource,
  base: number,
): Promise<number> => {
  const searchEnd = Math.min(source.size, base + GPU_OBJECT_BYTES);
  let position = base + 20;
  let tail: Buffer = Buffer.alloc(0);
  while (position < searchEnd) {
    const bytes = await source.read(
      position,
      Math.min(64 * 1024, searchEnd - position),
    );
    const haystack = tail.length === 0 ? bytes : Buffer.concat([tail, bytes]);
    const index = haystack.indexOf("CCOB");
    if (index >= 0) return position - tail.length + index - base;
    tail = haystack.subarray(Math.max(0, haystack.length - 3));
    position += bytes.length;
  }
  if (searchEnd < source.size)
    throw new BinaryResourceFailure(
      "structure",
      GPU_OBJECT_BYTES,
      "Legacy CCOB v1 extent exceeds the 128 MiB decoding budget",
    );
  return source.size - base;
};
