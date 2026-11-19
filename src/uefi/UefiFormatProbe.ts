import type { FileHandle } from "node:fs/promises";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { FFS2_FILE_SYSTEM_GUID, FFS3_FILE_SYSTEM_GUID } from "./UefiGuid.js";
import { imageRegion, type ScanRegion } from "./UefiBytes.js";
import { scanFirmwareVolumes } from "./FirmwareVolume.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";

/** Signature hits evaluate a bounded candidate set so one bogus `_FVH` cannot
 * deny a real volume that follows it in the same window. */
const PROBE_CANDIDATE_BUDGET = 64;
/** PI volume placement; unaligned signature hits stay format-inconclusive. */
const VOLUME_ALIGNMENT_BYTES = 16;

/**
 * Admit one volume whose header passes the full WP-B plausibility rules
 * (checksum, block-map terminator, mapped extent) and declares the FFS2
 * or FFS3 file system. Rejected signature hits stay inconclusive so plain
 * bytes containing `_FVH` cannot claim the format.
 */
export function admitUefiFlashImage(buffer: Buffer): boolean {
  const region: ScanRegion = imageRegion(buffer, 0, buffer.length);
  const scan = scanFirmwareVolumes(region, PROBE_CANDIDATE_BUDGET);
  return scan.volumes.some(
    ({ header }) =>
      header.checksumValid &&
      header.absoluteBase % VOLUME_ALIGNMENT_BYTES === 0 &&
      (header.fileSystemGuid === FFS2_FILE_SYSTEM_GUID ||
        header.fileSystemGuid === FFS3_FILE_SYSTEM_GUID),
  );
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
): Promise<boolean> {
  const throwIfCancelled = (): void => {
    if (signal?.aborted === true)
      throw new AnalysisCancelledError("resolve_binary_target");
  };
  const { size } = await handle.stat();
  const window = Buffer.allocUnsafe(
    Math.min(UEFI_FIRMWARE_LIMITS.scanProbeBytes, size),
  );
  const observed = await handle.read(window, 0, window.length, 0);
  if (
    !window
      .subarray(0, observed.bytesRead)
      .includes(Buffer.from("_FVH", "ascii"))
  )
    return false;
  const admitted = Buffer.allocUnsafe(
    Math.min(UEFI_FIRMWARE_LIMITS.inputBytes, size),
  );
  let bytesRead = 0;
  while (bytesRead < admitted.length) {
    throwIfCancelled();
    const read = await handle.read(
      admitted,
      bytesRead,
      admitted.length - bytesRead,
      bytesRead,
    );
    if (read.bytesRead === 0) break;
    bytesRead += read.bytesRead;
  }
  return admitUefiFlashImage(admitted.subarray(0, bytesRead));
}
