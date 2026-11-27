import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { megaDriveRom } from "../domain/megaDriveRom.fixture.js";
import {
  MEGA_DRIVE_MAX_ROM_BYTES,
  MEGA_DRIVE_MAX_SMD_BLOCKS,
  MEGA_DRIVE_SMD_BLOCK_BYTES,
  MEGA_DRIVE_SMD_HEADER_BYTES,
} from "../domain/megaDriveRom.js";
import { MegaDriveRomArtifactReader } from "./MegaDriveRomArtifactReader.js";

const readRejected = async (bytes: Buffer) => {
  const reader = new MegaDriveRomArtifactReader(
    await createTestTempFile("rea-mega-drive-boundary-", "game.bin", bytes),
  );
  try {
    for await (const _entry of reader.entries()) {
      // A refusal is raised before the first entry.
    }
  } finally {
    await reader.close();
  }
};

const sparse = async (logicalSize: number): Promise<string> => {
  const directory = await createTestTempDirectory("rea-mega-drive-sparse-");
  const path = join(directory, "game.bin");
  await writeFile(path, Buffer.alloc(0));
  const handle = await open(path, "r+");
  try {
    await handle.truncate(logicalSize);
  } finally {
    await handle.close();
  }
  return path;
};

const readPath = async (path: string) => {
  const reader = new MegaDriveRomArtifactReader(path);
  try {
    for await (const _entry of reader.entries()) {
      // A refusal is raised before the first entry.
    }
  } finally {
    await reader.close();
  }
};

it("refuses a header cut short", async () => {
  const bytes = megaDriveRom().subarray(0, 0x180);
  await expect(readRejected(bytes)).rejects.toThrow(/truncated/u);
  // A recognized header that stops short is truncated, with its measured
  // extent, not malformed.
  await expect(readRejected(bytes)).rejects.toMatchObject({
    reason: "truncated",
    parseFailure: {
      kind: "truncated",
      format: "mega-drive-rom",
      extent: { availableBytes: 0x180, requiredBytes: 0x200 },
    },
  });
});

it("refuses an SMD dump past the block ceiling without reading the body", async () => {
  const path = await sparse(
    MEGA_DRIVE_SMD_HEADER_BYTES +
      (MEGA_DRIVE_MAX_SMD_BLOCKS + 1) * MEGA_DRIVE_SMD_BLOCK_BYTES,
  );
  await expect(readPath(path)).rejects.toMatchObject({
    reason: "limit",
    boundary: "file-size",
    fixedAllowance: {
      name: "The Mega Drive SMD block ceiling",
      kind: "input",
      limit: MEGA_DRIVE_MAX_SMD_BLOCKS,
      unit: "blocks",
    },
  });
});

it("refuses a file past the ROM byte ceiling when it is not an SMD size", async () => {
  const path = await sparse(MEGA_DRIVE_MAX_ROM_BYTES + 1);
  await expect(readPath(path)).rejects.toMatchObject({
    reason: "limit",
    boundary: "file-size",
    fixedAllowance: {
      name: "The Mega Drive ROM byte ceiling",
      kind: "input",
      limit: MEGA_DRIVE_MAX_ROM_BYTES,
      unit: "bytes",
    },
  });
});

it("refuses a plain image whose size matches a max SMD dump", async () => {
  const path = await sparse(
    MEGA_DRIVE_SMD_HEADER_BYTES +
      MEGA_DRIVE_MAX_SMD_BLOCKS * MEGA_DRIVE_SMD_BLOCK_BYTES,
  );
  const handle = await open(path, "r+");
  try {
    const sega = Buffer.from("SEGA");
    await handle.write(sega, 0, sega.length, 0x100);
  } finally {
    await handle.close();
  }
  await expect(readPath(path)).rejects.toMatchObject({
    reason: "limit",
    boundary: "file-size",
    fixedAllowance: {
      name: "The Mega Drive ROM byte ceiling",
      kind: "input",
      limit: MEGA_DRIVE_MAX_ROM_BYTES,
      unit: "bytes",
    },
  });
});

it("keeps a checksum mismatch and a reversed ROM range as unknown coverage", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await createTestTempFile(
      "rea-mega-drive-boundary-",
      "game.bin",
      megaDriveRom({ checksum: 1, romStart: 0x300, romEnd: 0x100 }),
    ),
  );
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations.join("\n")).toContain("does not match");
  expect(snapshot.limitations.join("\n")).toContain("before ROM start");
});
