import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

/** Generations whose header this reader parses, plus one it only identifies. */
export const PREFETCH_VERSIONS = ["17", "23", "26"] as const;

const SIGNATURE = 0x53;
const MAM = Buffer.from("MSCF", "ascii");
const NAME_BYTES = 60;

export interface PrefetchFixtureOptions {
  readonly version: (typeof PREFETCH_VERSIONS)[number];
  readonly name?: string;
  readonly hash?: number;
  readonly runCount?: number;
  readonly runTimeSlots?: number;
  /** Replace the signature and body with a MAM ("MSCF") container. */
  readonly compressed?: boolean;
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
}: PrefetchFixtureOptions): Buffer => {
  const bytes = Buffer.alloc(version === "23" ? 512 : 320);
  bytes.write(version.padEnd(4, " "), 0, "latin1");
  if (compressed) {
    MAM.copy(bytes, 4);
    return bytes;
  }
  bytes.writeUInt8(SIGNATURE, 4);
  bytes.writeUInt32LE(bytes.length, 0x0c);
  bytes.write(name, 0x10, NAME_BYTES, "latin1");
  bytes.writeUInt32LE(hash, 0x4c);
  if (version === "23") {
    bytes.writeUInt32LE(0x54, 0x54);
    bytes.writeUInt32LE(0x5c, 0x5c);
    bytes.writeUInt32LE(1, 0x64);
    bytes.writeUInt32LE(0x6c, 0x6c);
    bytes.writeUInt32LE(runTimeSlots * 8, 0x70);
    bytes.writeUInt32LE(runCount, 0x84);
  }
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
