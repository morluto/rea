import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  PYTHON_39_MAGIC,
  cArchiveExecutable,
  pyzArchive,
  type CArchiveFixtureMember,
} from "../../src/artifacts/pyinstaller/CArchive.fixture.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import type { Evidence } from "../../src/domain/evidence.js";
import { connectArtifactComparisonMcp } from "../fixtures/artifactComparisonMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** Inspect archives and compare their inventories through MCP. */
const connectArchiveComparison = async () => {
  const root = await createTestTempDirectory("rea-pyinstaller-comparison-");
  const { inspect: inspectFile, compare } =
    await connectArtifactComparisonMcp();
  const inspect = async (
    name: string,
    members: readonly CArchiveFixtureMember[],
  ): Promise<Evidence> => {
    const path = join(root, name);
    await writeFile(
      path,
      cArchiveExecutable({ layout: "2.1", pythonVersion: 309, members }),
    );
    return inspectFile(path);
  };
  return { inspect, compare };
};

const occurrence = (evidence: Evidence, path: string) => {
  const found = artifactInventoryResultSchema
    .parse(evidence.normalized_result)
    .occurrences.find(({ logical_path }) => logical_path === path);
  if (found === undefined) throw new Error(`Missing ${path}`);
  return found;
};

it("reports a changed PyInstaller declaration whose member bytes are unavailable", async () => {
  const { inspect, compare } = await connectArchiveComparison();
  const link = (name: string) => [
    { name, typeCode: "n", payload: Buffer.from("target"), compress: false },
  ];

  // A rebuild on another filesystem can store the link name decomposed.
  // Normalization pairs the links; their stored names stay distinct.
  const nfc = "café-link";
  const left = await inspect("nfc", link(nfc));
  const right = await inspect("nfd", link("café-link"));
  expect(occurrence(left, nfc)).toMatchObject({
    hash_status: "not-hashed",
    format_metadata: { source_name: nfc },
  });
  expect(occurrence(right, nfc)).toMatchObject({
    hash_status: "not-hashed",
    format_metadata: { source_name: "café-link" },
  });

  const result = await compare(left, right);
  expect(
    result.changes.find(({ logical_path }) => logical_path === nfc),
  ).toMatchObject({
    classification: "changed",
    dimensions: ["metadata", "availability"],
    left_occurrence_id: occurrence(left, nfc).occurrence_id,
    right_occurrence_id: occurrence(right, nfc).occurrence_id,
  });
});

it("reports a PYZ namespace record that becomes encrypted", async () => {
  const { inspect, compare } = await connectArchiveComparison();
  const pyz = {
    name: "PYZ.pyz",
    typeCode: "z",
    compress: false,
    payload: pyzArchive({
      magic: PYTHON_39_MAGIC,
      modules: [
        {
          name: "ns.branch",
          typeCode: 3,
          body: Buffer.from("legacy namespace payload"),
          legacyNamespacePayload: true,
        },
      ],
    }),
  };
  const namespace = "PYZ.pyz/ns/branch";
  const plain = await inspect("plain", [pyz]);
  // The legacy key module also encrypts a nonempty namespace payload.
  const encrypted = await inspect("encrypted", [
    {
      name: "pyimod00_crypto_key",
      typeCode: "m",
      payload: Buffer.from("key module"),
      compress: false,
    },
    pyz,
  ]);
  expect(occurrence(encrypted, namespace)).toMatchObject({
    entry_kind: "metadata",
    artifact_id: null,
    encrypted: true,
  });

  const result = await compare(plain, encrypted);
  expect(
    result.changes.find(({ logical_path }) => logical_path === namespace),
  ).toMatchObject({
    classification: "changed",
    dimensions: ["metadata"],
    left_occurrence_id: occurrence(plain, namespace).occurrence_id,
    right_occurrence_id: occurrence(encrypted, namespace).occurrence_id,
  });
});
