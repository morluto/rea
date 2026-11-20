import {
  BinaryFormatFailure,
  type BinaryContainer,
} from "../binaryContainer.js";
import {
  classifyFatContainerEvidence,
  readFatContainerHeader,
  readFatHeaderPrefix,
  readMachoHeaderPrefixFacts,
} from "../apple/machoContainer.js";
import { readElfImage, readElfImageCooperative } from "./elfImage.js";
import type { ZstandardFramePause } from "../compression/zstandardExactFrame.js";
import { readPeImage } from "./peImage.js";
import { readMachoImage } from "../apple/machoImage.js";

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const hasElfMagic = (bytes: Buffer): boolean =>
  bytes.subarray(0, ELF_MAGIC.length).equals(ELF_MAGIC);

/** Identify an ELF, PE, or thin Mach-O image and its file sections. */
export const readBinaryContainer = (
  bytes: Buffer,
  operation: string,
): BinaryContainer =>
  hasElfMagic(bytes)
    ? readElfImage(bytes, operation)
    : readNonElfContainer(bytes);

/** Read the same facts, allowing the operation to pause during ELF name decoding. */
export const readBinaryContainerCooperative = async (
  bytes: Buffer,
  operation: string,
  pause: ZstandardFramePause,
): Promise<BinaryContainer> =>
  hasElfMagic(bytes)
    ? readElfImageCooperative(bytes, operation, pause)
    : readNonElfContainer(bytes);

const readNonElfContainer = (bytes: Buffer): BinaryContainer => {
  if (bytes.subarray(0, 2).equals(Buffer.from("MZ"))) return readPeImage(bytes);
  if (bytes.length >= 4) {
    const fatPrefix = readFatHeaderPrefix(bytes);
    if (fatPrefix.state === "incomplete" || fatPrefix.state === "parsed") {
      const fatHeader = readFatContainerHeader(bytes, bytes.length);
      if (fatHeader.state === "malformed")
        throw new BinaryFormatFailure("malformed", fatHeader.reason);
      const identity =
        fatHeader.state === "parsed"
          ? classifyFatContainerEvidence(fatHeader, bytes)
          : undefined;
      // An invalid FAT-shaped table is not proof of a Mach-O container: JVM
      // constant-pool bytes can share both the magic and a known CPU value.
      const confirmedFatMachO = identity?.state === "mach-o";
      if (confirmedFatMachO)
        throw new BinaryFormatFailure(
          "unsupported",
          "Universal/fat Mach-O containers require selecting a thin slice",
        );
    }
    if (readMachoHeaderPrefixFacts(bytes).format !== null)
      return readMachoImage(bytes);
  }
  throw new BinaryFormatFailure(
    "unsupported",
    "Only ELF, PE, and thin Mach-O native images are supported",
  );
};
