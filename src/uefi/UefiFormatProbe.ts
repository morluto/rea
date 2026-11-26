import type { FileHandle } from "node:fs/promises";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import { claimsExecutableHeader } from "../domain/binaryTarget.js";
import { recognizesArtifactPrefix } from "../domain/artifactFormatRecognition.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import { imageRegion, type ScanRegion } from "./UefiBytes.js";
import { scanFirmwareVolumes } from "./FirmwareVolume.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

/** Signature hits evaluate a bounded candidate set so one bogus `_FVH` cannot
 * deny a real volume that follows it in the same window. */
const PROBE_CANDIDATE_BUDGET = 64;
/** PI volume placement; unaligned signature hits stay format-inconclusive. */
const VOLUME_ALIGNMENT_BYTES = 16;

/**
 * Admit one aligned volume whose header passes the structural framing checks
 * (header length, block-map terminator, mapped extent). Checksum mismatches
 * are preserved as downstream `fv-checksum-mismatch` findings rather than
 * rejecting the image pre-lane. A volume with an unsupported file-system GUID,
 * such as an NVRAM variable store, is still a firmware volume: inventory
 * retains it without FFS entries. Rejected signature hits stay inconclusive so
 * plain bytes containing `_FVH` cannot claim the format.
 */
export function admitUefiFlashImage(
  buffer: Buffer,
  signatureEnd = buffer.length,
): boolean {
  const region: ScanRegion = imageRegion(buffer, 0, buffer.length);
  const scan = scanFirmwareVolumes(region, PROBE_CANDIDATE_BUDGET, {
    signatureEnd,
  });
  return scan.volumes.some(
    ({ header }) => header.absoluteBase % VOLUME_ALIGNMENT_BYTES === 0,
  );
}

/** Known file facts a caller already read before probing for a PI flash image. */
export interface UefiFlashProbeKnownInput {
  readonly fileSize?: number;
  readonly prefix?: Buffer;
}

/** Extend previously observed bytes without allocating a second tail buffer. */
const extendPrefix = async (
  handle: FileHandle,
  prefix: Buffer,
  length: number,
  assertActive: () => void,
): Promise<Buffer> => {
  const bytes = Buffer.alloc(length);
  prefix.copy(bytes);
  const tail = await readFileHandleRange(
    handle,
    prefix.length,
    length - prefix.length,
    assertActive,
    bytes.subarray(prefix.length),
  );
  return bytes.subarray(0, prefix.length + tail.length);
};

/**
 * Detect a PI flash image through an aligned `_FVH` plausibility probe over
 * the declared admission prefix (1 MiB). The prefix decides most misses
 * cheaply; only files that actually carry the signature cost a bounded
 * whole-image read. Images whose first volume lies beyond the prefix stay
 * unrecognized — an honest admission gap, noted in the probe contract.
 * A prefix the shared recognizer table claims, such as an ISO 9660
 * descriptor set, outranks the probe in every route that calls it.
 */
export async function probeUefiFlashImage(
  handle: FileHandle,
  signal?: AbortSignal,
  known?: UefiFlashProbeKnownInput,
): Promise<boolean> {
  const throwIfCancelled = (): void => {
    if (signal?.aborted === true)
      throw cancelledBy("resolve_binary_target", signal);
  };
  throwIfCancelled();
  const size = known?.fileSize ?? (await handle.stat()).size;
  throwIfCancelled();
  if (known?.prefix !== undefined && claimsExecutableHeader(known.prefix, size))
    return false;

  const probeBytes = Math.min(UEFI_FIRMWARE_LIMITS.scanProbeBytes, size);
  let prefix: Buffer;
  if (known?.prefix !== undefined && known.prefix.length >= probeBytes) {
    prefix = known.prefix.subarray(0, probeBytes);
  } else if (known?.prefix !== undefined && known.prefix.length > 0) {
    prefix = await extendPrefix(
      handle,
      known.prefix,
      probeBytes,
      throwIfCancelled,
    );
  } else {
    prefix = await readFileHandleRange(handle, 0, probeBytes, throwIfCancelled);
  }
  throwIfCancelled();
  if (
    claimsExecutableHeader(prefix, size) ||
    !prefix.includes("_FVH", "ascii") ||
    recognizesArtifactPrefix(prefix, size)
  )
    return false;

  const readLimit = Math.min(UEFI_FIRMWARE_LIMITS.inputBytes, size);
  const observed =
    readLimit <= prefix.length
      ? prefix
      : await extendPrefix(handle, prefix, readLimit, throwIfCancelled);
  throwIfCancelled();
  return admitUefiFlashImage(observed, prefix.length);
}
