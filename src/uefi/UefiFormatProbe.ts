import type { FileHandle } from "node:fs/promises";
import { readFileHandleRange } from "../filesystem/readFileHandleRange.js";
import { claimsExecutableHeader } from "../domain/binaryTarget.js";
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
 * Admit one volume whose header passes the full header plausibility checks
 * (checksum, block-map terminator, mapped extent) and declares the FFS2
 * or FFS3 file system. Rejected signature hits stay inconclusive so plain
 * bytes containing `_FVH` cannot claim the format.
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
    ({ header }) =>
      header.checksumValid &&
      header.absoluteBase % VOLUME_ALIGNMENT_BYTES === 0 &&
      header.fileSystem !== "unsupported",
  );
}

/** Known file facts a caller already read before probing for a PI flash image. */
export interface UefiFlashProbeKnownInput {
  readonly fileSize?: number;
  readonly prefix?: Buffer;
}

/**
 * Detect a PI flash image through an aligned `_FVH` plausibility probe over
 * the declared admission prefix (1 MiB). The prefix decides most misses
 * cheaply; only files that actually carry the signature cost a bounded
 * whole-image read. Images whose first volume lies beyond the prefix stay
 * unrecognized — an honest admission gap, noted in the probe contract.
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
    const tail = await readFileHandleRange(
      handle,
      known.prefix.length,
      probeBytes - known.prefix.length,
      throwIfCancelled,
    );
    prefix = Buffer.concat([known.prefix, tail]);
  } else {
    prefix = await readFileHandleRange(handle, 0, probeBytes, throwIfCancelled);
  }
  throwIfCancelled();
  if (claimsExecutableHeader(prefix, size) || !prefix.includes("_FVH", "ascii"))
    return false;

  const readLimit = Math.min(UEFI_FIRMWARE_LIMITS.inputBytes, size);
  let observed: Buffer;
  if (readLimit <= prefix.length) {
    observed = prefix;
  } else {
    const tail = await readFileHandleRange(
      handle,
      prefix.length,
      readLimit - prefix.length,
      throwIfCancelled,
    );
    observed = Buffer.concat([prefix, tail]);
  }
  throwIfCancelled();
  return admitUefiFlashImage(observed, prefix.length);
}
