import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  MFT_DEFAULT_RECORD_BYTES,
  MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
  NTFS_MFT_FILE_LIMIT_CODE,
  NTFS_MFT_MAX_FILE_SETTING,
  ntfsMftFileLimit,
  ntfsMftFileLimitMessage,
} from "../domain/windows/ntfsMft.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

/** A 1 KiB FILE record whose update sequence array covers both sectors. */
const recordBytes = (options: {
  readonly sequenceNumber?: number;
  readonly flags?: number;
}): Buffer => {
  const record = Buffer.alloc(MFT_DEFAULT_RECORD_BYTES);
  record.write("FILE", 0, "latin1");
  const sequenceNumber = options.sequenceNumber ?? 1;
  record.writeUInt16LE(48, 4);
  record.writeUInt16LE(3, 6);
  record.writeUInt16LE(sequenceNumber, 48);
  record.writeUInt16LE(0xa5a5, 50);
  record.writeUInt16LE(0xa5a5, 52);
  record.writeUInt16LE(sequenceNumber, 16);
  record.writeUInt16LE(1, 18);
  record.writeUInt16LE(56, 20);
  record.writeUInt16LE(options.flags ?? 0x0001, 22);
  record.writeUInt32LE(56, 24);
  record.writeUInt32LE(MFT_DEFAULT_RECORD_BYTES, 28);
  record.writeUInt16LE(sequenceNumber, 510);
  record.writeUInt16LE(sequenceNumber, 1022);
  return record;
};

const writeMft = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-ntfs-mft-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

it("reports a $MFT stream's record headers as the root occurrence", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeMft(
      "$MFT",
      Buffer.concat([recordBytes({}), recordBytes({ flags: 0x0003 })]),
    ),
  );
  expect(inventory.manifest.root_format).toBe("ntfs-mft");
  expect(inventory.coverage.status).toBe("complete");
  // A record stream declares no members, so the root is its whole inventory.
  expect(inventory.occurrences.map((row) => row.logical_path)).toEqual(["."]);
  expect(inventory.occurrences[0]).toMatchObject({
    artifact_format: "ntfs-mft",
    format_metadata: {
      kind: "ntfs-mft",
      record_bytes: MFT_DEFAULT_RECORD_BYTES,
      record_count: 2,
      in_use_record_count: 2,
      directory_record_count: 1,
      extension_record_count: 0,
      fixup_mismatch_count: 0,
      fixup_unverified_record_count: 0,
      truncated_tail_bytes: 0,
    },
  });
});

it("reports the configured file ceiling as a structured limit", async () => {
  const admission = {
    maximumBytes: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
    source: "setting" as const,
  };
  const fileBytes = recordBytes({}).length;
  const fileLimit = ntfsMftFileLimit(fileBytes, admission);
  let failure: unknown;
  try {
    await scanCanonicalArtifactInventory(
      await writeMft("$MFT", recordBytes({})),
      {
        environment: {
          [NTFS_MFT_MAX_FILE_SETTING]: String(MINIMUM_NTFS_MFT_MAX_FILE_BYTES),
        },
      },
    );
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  if (!(failure instanceof ArtifactReaderFailure))
    throw new Error("inventory failure was not an artifact reader failure");
  expect(failure.admission).toEqual({
    kind: "ntfs-mft-file",
    maximumBytes: admission.maximumBytes,
    source: admission.source,
    fileLimit,
  });
  expect(
    projectAnalysisError(translateArtifactFailure("inspect_artifact", failure)),
  ).toEqual(
    expect.objectContaining({
      code: "truncated",
      message: ntfsMftFileLimitMessage(fileLimit),
      remediation: { action: ntfsMftFileLimitMessage(fileLimit) },
      details: expect.objectContaining({
        reason: "limit",
        boundary: "file-size",
        admission: "ntfs-mft-file",
        file_limit_code: NTFS_MFT_FILE_LIMIT_CODE,
        setting: NTFS_MFT_MAX_FILE_SETTING,
        file_bytes: fileBytes,
        maximum_bytes: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
        maximum_bytes_source: "setting",
        floor_bytes: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
        restart_required: true,
      }),
    }),
  );
});

it("names a failed fixup in the coverage limitations", async () => {
  const record = recordBytes({ sequenceNumber: 4 });
  // A trailer that is not the sequence number marks the sector as not cleanly written.
  record.writeUInt16LE(0x1234, 510);
  const inventory = await scanCanonicalArtifactInventory(
    await writeMft("$MFT", record),
  );
  expect(inventory.manifest.root_format).toBe("ntfs-mft");
  expect(inventory.coverage.status).toBe("unknown");
  expect(inventory.limitations).toContainEqual(
    expect.stringMatching(/sector trailer that is not the update sequence/u),
  );
});
