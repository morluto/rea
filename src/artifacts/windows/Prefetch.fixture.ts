import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

/** Generations whose header this reader parses, plus one it only identifies. */
export const PREFETCH_VERSIONS = ["17", "23", "26"] as const;

const SIGNATURE = Buffer.from("SCCA", "ascii");
const MAM = Buffer.from("MAM", "ascii");
const MAM_VERSION = 4;
const MAM_CHECKSUM_FLAG = 0x80;
const NAME_BYTES = 60;
const RUN_COUNT_OFFSET = 0x98;

export interface PrefetchFixtureOptions {
  readonly version: (typeof PREFETCH_VERSIONS)[number];
  readonly name?: string;
  readonly hash?: number;
  readonly runCount?: number;
  readonly runTimeSlots?: number;
  /**
   * Replace the header with a MAM container. `checksum` sets the wrapper's
   * optional checksum flag beside the XPRESS Huffman algorithm.
   */
  readonly compressed?: boolean;
  readonly checksum?: boolean;
}

/**
 * A header-only Prefetch file. Every byte the reader does not interpret stays
 * zero, so a field it starts reading without a matching writer fails the tests.
 */
export const prefetchFixture = ({
  version,
  name = "GOOGLE.EXE",
  hash = 0x1a2b_3c4d,
  runCount = 7,
  runTimeSlots = 8,
  compressed = false,
  checksum = false,
}: PrefetchFixtureOptions): Buffer => {
  const bytes = Buffer.alloc(512);
  if (compressed) {
    MAM.copy(bytes, 0);
    // The wrapper's own version byte; the reader uses it to tell a MAM
    // container from a file that merely starts with these three letters.
    bytes[MAM.length] = MAM_VERSION | (checksum ? MAM_CHECKSUM_FLAG : 0);
    return bytes;
  }
  bytes.writeUInt32LE(Number(version), 0);
  SIGNATURE.copy(bytes, 4);
  bytes.writeUInt32LE(bytes.length, 0x0c);
  bytes.write(`${name}\0`, 0x10, NAME_BYTES, "utf16le");
  bytes.writeUInt32LE(hash, 0x4c);
  // File information starts with a 12-byte metrics array, then the FILETIME of
  // the last run, then the run count.
  bytes.writeUInt32LE(runTimeSlots > 0 ? 1 : 0, 0x54 + 0x10);
  bytes.writeUInt32LE(runCount, RUN_COUNT_OFFSET);
  return bytes;
};

export const writePrefetch = async (
  fileName: string,
  bytes: Buffer,
): Promise<string> => {
  const directory = await createTestTempDirectory("rea-prefetch-");
  const path = join(directory, fileName);
  await writeFile(path, bytes);
  return path;
};
