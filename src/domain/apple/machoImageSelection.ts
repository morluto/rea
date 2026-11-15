import { err, ok, type Result } from "../result.js";
import {
  classifyFatContainerEvidence,
  fatSliceOverlapReason,
  findOverlappingFatSlices,
  readFatContainerHeader,
  readMachoHeaderPrefixFacts,
  validateFatSlice,
  type FatContainerHeader,
  type FatSliceDeclaration,
} from "./machoContainer.js";

type UniversalMachoHeader = Extract<FatContainerHeader, { state: "parsed" }>;
interface MachoImageSelectionFailure {
  readonly kind: "malformed";
  readonly message: string;
}

/**
 * Admit a complete in-memory universal image whose slices do not overlap;
 * FAT-shaped JVM data remains unselected.
 */
export const readUniversalMachoImage = (
  bytes: Uint8Array,
): Result<UniversalMachoHeader | null, MachoImageSelectionFailure> => {
  const fat = readFatContainerHeader(bytes, bytes.byteLength);
  if (fat.state === "not-fat") return ok(null);
  if (fat.state !== "parsed")
    return err({
      kind: "malformed",
      message:
        fat.state === "malformed"
          ? fat.reason
          : "Universal Mach-O header is truncated",
    });
  const identity = classifyFatContainerEvidence(fat, bytes);
  if (identity.state === "malformed")
    return err({ kind: "malformed", message: identity.reason });
  if (identity.state !== "mach-o") return ok(null);
  // Every range is valid here; aliased declarations are a malformed container,
  // as the artifact reader also rules, not slices to choose between.
  const overlap = findOverlappingFatSlices(fat.slices);
  return overlap === null
    ? ok(fat)
    : err({ kind: "malformed", message: fatSliceOverlapReason(overlap) });
};

/** Validate the selected declaration against the complete embedded CPU identity. */
export const readUniversalMachoSlice = (
  bytes: Buffer,
  header: UniversalMachoHeader,
  slice: FatSliceDeclaration,
): Result<Buffer, MachoImageSelectionFailure> => {
  const image = bytes.subarray(slice.offset, slice.offset + slice.size);
  const identity = readMachoHeaderPrefixFacts(image).identity;
  const message =
    identity === null
      ? `FAT architecture ${slice.index} has a truncated Mach-O identity`
      : validateFatSlice(slice, bytes.length, header.tableEnd, identity);
  return message === null ? ok(image) : err({ kind: "malformed", message });
};
