import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  binaryPlistAscii,
  binaryPlistFromObjects,
  binaryPlistObjectTable,
} from "./binaryPlistObjectTable.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

const integer128 = (value: bigint): Buffer => {
  const bytes = Buffer.alloc(17);
  bytes[0] = 0x14;
  const encoded = BigInt.asUintN(128, value);
  bytes.writeBigUInt64BE(encoded >> 64n, 1);
  bytes.writeBigUInt64BE(BigInt.asUintN(64, encoded), 9);
  return bytes;
};

const integer64 = (value: bigint): Buffer => {
  const bytes = Buffer.alloc(9);
  bytes[0] = 0x13;
  bytes.writeBigInt64BE(value, 1);
  return bytes;
};

/**
 * Minimal valid NSKeyedArchiver whose object-table entries 10 and 11 both
 * point at one Int64 record, beside an unrelated Int64 sibling (entry 12).
 * The shared record is encoded once; only its offset is listed twice.
 */
const sharedEntryArchiveBytes = (): Buffer => {
  const objects = [
    Buffer.from([0xd3, 1, 3, 4, 2, 8, 5]), // root dict: three key/value pairs
    binaryPlistAscii("$archiver"),
    binaryPlistAscii("NSKeyedArchiver"),
    binaryPlistAscii("$objects"),
    binaryPlistAscii("$top"),
    Buffer.from([0xd1, 6, 7]), // $top.root -> UID 1
    binaryPlistAscii("root"),
    Buffer.from([0x80, 1]), // UID 1
    Buffer.from([0xa4, 9, 10, 11, 12]), // $objects refs
    binaryPlistAscii("$null"),
    integer64(9_007_199_254_740_993n),
    integer64(1_152_921_504_606_846_979n),
  ];
  const offsets: number[] = [];
  let position = 8;
  for (const object of objects) {
    offsets.push(position);
    position += object.length;
  }
  // Entries 10 and 11 share the first Int64 record; entry 12 is the sibling.
  const [shared, sibling] = [offsets[10] ?? 0, offsets[11] ?? 0];
  offsets.splice(11, 1, shared, sibling);
  const bytes = Buffer.concat([
    Buffer.alloc(8),
    ...objects,
    Buffer.alloc(offsets.length + 32),
  ]);
  return binaryPlistObjectTable(bytes, offsets, position);
};

export const keyedArchiveSharedEntryFixture = async () => {
  const root = await createTestTempDirectory("rea-keyed-shared-entry-");
  const path = join(root, "archive.plist");
  const bytes = sharedEntryArchiveBytes();
  await writeFile(path, bytes);
  return {
    root,
    path,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
};

/** Minimal valid NSKeyedArchiver with a 16-byte integer and an Int64 control. */
const archiveBytes = (): Buffer =>
  binaryPlistFromObjects([
    Buffer.from([0xd3, 1, 3, 4, 2, 8, 5]), // root dict: three key/value pairs
    binaryPlistAscii("$archiver"),
    binaryPlistAscii("NSKeyedArchiver"),
    binaryPlistAscii("$objects"),
    binaryPlistAscii("$top"),
    Buffer.from([0xd1, 6, 7]), // $top.root -> UID 1
    binaryPlistAscii("root"),
    Buffer.from([0x80, 1]), // UID 1
    Buffer.from([0xa3, 9, 10, 11]), // $objects refs
    binaryPlistAscii("$null"),
    integer128(18_446_744_073_709_551_615n),
    integer64(9_223_372_036_854_775_807n),
  ]);

export const keyedArchiveWideIntegerFixture = async () => {
  const root = await createTestTempDirectory("rea-keyed-wide-integers-");
  const path = join(root, "archive.bin");
  const bytes = archiveBytes();
  await writeFile(path, bytes);
  return {
    root,
    path,
    bytes,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
};
