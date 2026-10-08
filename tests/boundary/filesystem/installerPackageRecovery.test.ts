import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { expect, it } from "vitest";

import { extractArtifact } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import {
  MODE,
  gzipCpio,
  xarArchive,
} from "../../../src/artifacts/InstallerPackage.fixture.js";
import { scanArtifactInventory } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("extracts regular nested siblings while retaining skipped special-node evidence", async () => {
  const directory = await createTestTempDirectory("rea-pkg-extract-special-");
  const inputPath = join(directory, "Installer.pkg");
  const outputRoot = join(directory, "extracted");
  await writeFile(
    inputPath,
    xarArchive([
      {
        name: "Payload",
        data: gzipCpio([
          { name: "./fifo", mode: MODE.fifo },
          { name: "./usr/bin/tool", mode: MODE.executable, data: "tool bytes" },
        ]),
      },
    ]),
  );
  const extracted = await extractArtifact({
    inputPath,
    outputRoot,
    inputFormat: "pkg",
  });
  expect(await readFile(join(outputRoot, "Payload/usr/bin/tool"), "utf8")).toBe(
    "tool bytes",
  );
  expect(extracted.artifacts.map(({ relative_path }) => relative_path)).toEqual(
    ["Payload/usr/bin/tool"],
  );
  expect(extracted.extraction_manifest.selected_occurrence_ids).toHaveLength(1);
  expect(extracted.limitations).toContainEqual(
    expect.stringContaining("Payload/fifo was not extracted"),
  );
});

it("retains unsupported-encoding occurrences under the default inventory policy", async () => {
  const directory = await createTestTempDirectory("rea-pkg-unsupported-");
  const path = join(directory, "Installer.pkg");
  await writeFile(
    path,
    xarArchive([
      { name: "encoded", encoding: "bzip2", data: Buffer.from("opaque") },
      { name: "plain", data: Buffer.from("available") },
    ]),
  );
  const inventory = await scanArtifactInventory(path);
  expect(
    inventory.occurrences.find(
      ({ logical_path }) => logical_path === "encoded",
    ),
  ).toMatchObject({
    hash_status: "unavailable",
    artifact_id: null,
    limitations: [
      expect.stringContaining("Unsupported xar encoding application/x-bzip2"),
    ],
  });
  expect(
    inventory.occurrences.find(({ logical_path }) => logical_path === "plain"),
  ).toMatchObject({ hash_status: "verified" });
});

it("rejects a header whose decoded TOC length contradicts the actual data", async () => {
  const directory = await createTestTempDirectory("rea-pkg-toc-size-");
  const path = join(directory, "Installer.pkg");
  await writeFile(
    path,
    xarArchive([{ name: "plain", data: Buffer.from("ok") }], {
      tocDecodedSize: 1,
    }),
  );
  await expect(scanArtifactInventory(path)).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/xar TOC decoded \d+ bytes, expected 1/u),
  });
});

it("records stored-checksum contradictions without losing decoded content identity", async () => {
  const directory = await createTestTempDirectory("rea-pkg-stored-integrity-");
  const path = join(directory, "Installer.pkg");
  const decoded = Buffer.from("same decoded bytes");
  const archivedSha1 = "0".repeat(40);
  await writeFile(
    path,
    xarArchive([
      { name: "encoded", encoding: "zlib", data: decoded, archivedSha1 },
      { name: "plain", data: Buffer.from("ok") },
    ]),
  );
  const inventory = await scanArtifactInventory(path, {
    integrity: { mode: "record-and-continue" },
  });
  const entry = inventory.occurrences.find(
    ({ logical_path }) => logical_path === "encoded",
  );
  expect(entry).toMatchObject({ hash_status: "mismatched" });
  expect(
    inventory.nodes.find(
      ({ artifact_id }) => artifact_id === entry?.artifact_id,
    ),
  ).toMatchObject({
    size: decoded.length,
    sha256: createHash("sha256").update(decoded).digest("hex"),
  });
  const observed = createHash("sha1")
    .update(deflateSync(decoded))
    .digest("hex");
  expect(entry?.limitations).toContain(
    `Declared stored sha1 ${archivedSha1} disagrees with observed ${observed}.`,
  );
  await expect(scanArtifactInventory(path)).rejects.toMatchObject({
    reason: "integrity",
  });
});

it("preserves recovered directory CRC mismatches through graph materialization", async () => {
  const directory = await createTestTempDirectory("rea-pkg-directory-crc-");
  const path = join(directory, "Installer.pkg");
  await writeFile(
    path,
    xarArchive([
      {
        name: "Payload",
        data: gzipCpio(
          [
            { name: "dir", mode: MODE.directory, check: 1 },
            { name: "dir/good", mode: MODE.file, data: "ok" },
          ],
          "crc",
        ),
      },
    ]),
  );
  const inventory = await scanArtifactInventory(path, {
    integrity: { mode: "record-and-continue" },
  });
  expect(
    inventory.occurrences.find(
      ({ logical_path }) => logical_path === "Payload/dir",
    ),
  ).toMatchObject({
    hash_status: "mismatched",
    limitations: [
      "Declared decoded cpio-byte-sum 00000001 disagrees with observed 00000000.",
    ],
  });
  expect(
    inventory.occurrences.find(
      ({ logical_path }) => logical_path === "Payload/dir/good",
    ),
  ).toMatchObject({ hash_status: "verified" });
});
