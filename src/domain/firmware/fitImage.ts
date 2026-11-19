import { BinaryFormatFailure, BinaryReader } from "../binaryContainer.js";
import {
  hasDevicetreeMagic,
  readDevicetreeHeader,
} from "./devicetreeHeader.js";

/**
 * Whether a flattened devicetree prefix declares a top-level /images node, the
 * U-Boot FIT marker. Only the first 4 KiB is walked, so a FIT whose /images
 * node starts later stays a plain devicetree; the FIT reader's full parse
 * remains the authority for everything this probe accepts.
 */
export const hasFitImagesNode = (prefix: Buffer): boolean => {
  if (!hasDevicetreeMagic(prefix)) return false;
  const bytes = prefix.subarray(0, 4096);
  let extent: ReturnType<typeof readDevicetreeHeader>;
  try {
    extent = readDevicetreeHeader(bytes);
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) return false;
    throw cause;
  }
  const start = extent.header.off_dt_struct;
  const end = Math.min(
    bytes.length,
    extent.header.totalsize,
    extent.structureEnd,
  );
  const structurePrefix = bytes.subarray(0, end);
  const reader = new BinaryReader(structurePrefix, false, "fit");
  let cursor = start;
  let depth = 0;
  while (cursor <= end - 4) {
    const token = reader.u32(cursor);
    if (token === 1) {
      const nul = structurePrefix.indexOf(0, cursor + 4);
      if (nul < 0) return false;
      const next = Math.ceil((nul + 1) / 4) * 4;
      if (next > end) return false;
      const name = String.fromCharCode(...bytes.subarray(cursor + 4, nul));
      if (depth === 0 && name !== "") return false;
      if (depth === 1 && name === "images") return true;
      depth += 1;
      cursor = next;
    } else if (token === 2) {
      depth -= 1;
      if (depth <= 0) return false;
      cursor += 4;
    } else if (token === 3) {
      if (cursor > end - 12) return false;
      cursor += Math.ceil((12 + reader.u32(cursor + 4)) / 4) * 4;
    } else if (token === 4) cursor += 4;
    else return false;
  }
  return false;
};
