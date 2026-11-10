import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { AnalysisSettings } from "../application/AnalysisSettings.js";
import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  DEFAULT_REGF_MAX_FILE_BYTES,
  MAXIMUM_REGF_MAX_FILE_BYTES,
  MINIMUM_REGF_MAX_FILE_BYTES,
  REGF_BASE_BLOCK_BYTES,
  REGF_HIVE_FILE_LIMIT_CODE,
  REGF_HIVE_MAX_FILE_SETTING,
  REGF_HIVE_MAX_FILE_SETTING_ID,
  regfHiveFileLimit,
} from "../domain/windows/registryHive.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

/** A 4 KiB base block followed by one hive bin holding two cells. */
const hiveBytes = (): Buffer => {
  const binSize = 4096;
  const hive = Buffer.alloc(REGF_BASE_BLOCK_BYTES + binSize);
  hive.write("regf", 0, "latin1");
  hive.writeUInt32LE(4, 4);
  hive.writeUInt32LE(4, 8);
  hive.writeUInt32LE(1, 20);
  hive.writeUInt32LE(5, 24);
  hive.writeUInt32LE(0x20, 36);
  hive.writeUInt32LE(binSize, 40);
  let xor = 0;
  for (let offset = 0; offset < 508; offset += 4)
    xor ^= hive.readUInt32LE(offset);
  hive.writeUInt32LE(xor >>> 0, 508);
  const bin = REGF_BASE_BLOCK_BYTES;
  hive.write("hbin", bin, "latin1");
  hive.writeUInt32LE(0, bin + 4);
  hive.writeUInt32LE(binSize, bin + 8);
  hive.writeInt32LE(-32, bin + 32);
  hive.writeInt32LE(-48, bin + 64);
  return hive;
};

const writeHive = async (name: string): Promise<string> => {
  const directory = await createTestTempDirectory("rea-regf-hive-");
  const path = join(directory, name);
  await writeFile(path, hiveBytes());
  return path;
};

it("reports a hive's base block and cell counts as the root occurrence", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await writeHive("SYSTEM"),
  );
  expect(inventory.manifest.root_format).toBe("regf-hive");
  expect(inventory.coverage.status).toBe("complete");
  // A hive declares no members, so the root is its whole inventory.
  expect(inventory.occurrences.map((row) => row.logical_path)).toEqual(["."]);
  expect(inventory.occurrences[0]).toMatchObject({
    artifact_format: "regf-hive",
    format_metadata: {
      kind: "regf-hive",
      major_version: 1,
      minor_version: 5,
      primary_sequence: 4,
      secondary_sequence: 4,
      dirty: false,
      checksum_matches: true,
      hive_bin_count: 1,
      cell_count: 2,
      allocated_cell_count: 2,
    },
  });
});

it("reports the configured file ceiling as a structured limit", async () => {
  const bytes = hiveBytes();
  const admission = {
    maximumBytes: MINIMUM_REGF_MAX_FILE_BYTES,
    source: "setting" as const,
  };
  const fileLimit = regfHiveFileLimit(bytes.length, admission);
  let failure: unknown;
  try {
    await scanCanonicalArtifactInventory(await writeHive("SYSTEM"), {
      environment: {
        [REGF_HIVE_MAX_FILE_SETTING]: String(MINIMUM_REGF_MAX_FILE_BYTES),
      },
    });
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  if (!(failure instanceof ArtifactReaderFailure))
    throw new Error("inventory failure was not an artifact reader failure");
  expect(failure.admission).toEqual({
    kind: "regf-hive-file",
    maximumBytes: admission.maximumBytes,
    source: admission.source,
    fileLimit,
  });
  expect(
    projectAnalysisError(translateArtifactFailure("inspect_artifact", failure)),
  ).toMatchObject({
    code: "truncated",
    details: {
      reason: "limit",
      boundary: "file-size",
      admission: "regf-hive-file",
      file_limit_code: REGF_HIVE_FILE_LIMIT_CODE,
      setting: REGF_HIVE_MAX_FILE_SETTING_ID,
      file_bytes: bytes.length,
      maximum_bytes: MINIMUM_REGF_MAX_FILE_BYTES,
      maximum_bytes_source: "setting",
      floor_bytes: MINIMUM_REGF_MAX_FILE_BYTES,
      maximum_setting_bytes: MAXIMUM_REGF_MAX_FILE_BYTES,
      rea_restart_required: false,
      limit: {
        setting: REGF_HIVE_MAX_FILE_SETTING_ID,
        effective_value: MINIMUM_REGF_MAX_FILE_BYTES,
        required_value: bytes.length,
        source: "setting",
        unit: "bytes",
        minimum: MINIMUM_REGF_MAX_FILE_BYTES,
        maximum: MAXIMUM_REGF_MAX_FILE_BYTES,
        applies_at: "next_operation",
        agent_editable: true,
        scope: "rea-runtime",
        rea_restart_required: false,
      },
    },
  });
});

it("applies a runtime ceiling on the next inventory", async () => {
  const bytes = hiveBytes();
  const path = await writeHive("SYSTEM");
  const settings = new AnalysisSettings({
    [REGF_HIVE_MAX_FILE_SETTING]: String(DEFAULT_REGF_MAX_FILE_BYTES),
  });
  expect(
    settings.update({
      changes: [
        {
          setting: REGF_HIVE_MAX_FILE_SETTING_ID,
          action: "set",
          value: MINIMUM_REGF_MAX_FILE_BYTES,
        },
      ],
    }).ok,
  ).toBe(true);
  expect(
    settings.inspect({ settings: [REGF_HIVE_MAX_FILE_SETTING_ID] }).settings[0],
  ).toMatchObject({
    setting: REGF_HIVE_MAX_FILE_SETTING_ID,
    value: MINIMUM_REGF_MAX_FILE_BYTES,
    source: "runtime",
    environment: REGF_HIVE_MAX_FILE_SETTING,
    applies_at: "next_operation",
  });
  let failure: unknown;
  try {
    await settings.run(() =>
      scanCanonicalArtifactInventory(path, {
        environment: {
          [REGF_HIVE_MAX_FILE_SETTING]: String(DEFAULT_REGF_MAX_FILE_BYTES),
        },
        analysisSettings: settings.read,
      }),
    );
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  if (!(failure instanceof ArtifactReaderFailure))
    throw new Error("runtime ceiling did not refuse the hive");
  expect(
    projectAnalysisError(translateArtifactFailure("inspect_artifact", failure)),
  ).toMatchObject({
    code: "truncated",
    details: {
      file_limit_code: REGF_HIVE_FILE_LIMIT_CODE,
      limit: {
        setting: REGF_HIVE_MAX_FILE_SETTING_ID,
        effective_value: MINIMUM_REGF_MAX_FILE_BYTES,
        source: "runtime",
        rea_restart_required: false,
      },
    },
  });
  expect(
    settings.update({
      changes: [
        {
          setting: REGF_HIVE_MAX_FILE_SETTING_ID,
          action: "set",
          value: bytes.length,
        },
      ],
    }).ok,
  ).toBe(true);
  const inventory = await scanCanonicalArtifactInventory(path, {
    environment: {
      [REGF_HIVE_MAX_FILE_SETTING]: String(DEFAULT_REGF_MAX_FILE_BYTES),
    },
    analysisSettings: settings.read,
  });
  expect(inventory.manifest.root_format).toBe("regf-hive");
});

it("names a dirty hive's sequence mismatch in the limitations", async () => {
  const directory = await createTestTempDirectory("rea-regf-hive-dirty-");
  const path = join(directory, "NTUSER.DAT");
  const hive = hiveBytes();
  hive.writeUInt32LE(4, 4);
  hive.writeUInt32LE(9, 8);
  // The base-block checksum covers the sequence pair, so recompute it.
  hive.writeUInt32LE(0, 508);
  let xor = 0;
  for (let offset = 0; offset < 508; offset += 4)
    xor ^= hive.readUInt32LE(offset);
  hive.writeUInt32LE(xor >>> 0, 508);
  await writeFile(path, hive);

  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.manifest.root_format).toBe("regf-hive");
  expect(inventory.limitations).toContainEqual(
    expect.stringMatching(/not cleanly closed/iu),
  );
});
