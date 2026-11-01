import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { expect, it } from "vitest";

import { UnityWebDataArtifactReader } from "./UnityWebDataArtifactReader.js";
import { buildUnityWebData } from "../../tests/fixtures/unity.js";
import { classifyArtifactBytesAtPath } from "../../tests/fixtures/artifactClassification.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const collect = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const writeCarrier = async (bytes: Buffer): Promise<string> => {
  const path = join(
    await createTestTempDirectory("rea-unity-web-data-"),
    "Build.data.gz",
  );
  await writeFile(path, bytes);
  return path;
};

const members = [
  { path: "boot.config", bytes: Buffer.from("wait-for-native-debugger=0\n") },
  { path: "Resources/unity_default_resources", bytes: Buffer.alloc(40, 7) },
  { path: "data.unity3d", bytes: Buffer.from("UnityFS\0not-a-real-bundle") },
];

it("classifies the signature regardless of a .gz name", () => {
  expect(
    classifyArtifactBytesAtPath("Build.data.gz", buildUnityWebData(members)),
  ).toEqual({ kind: "container", format: "unity-web-data" });
});

it("inventories stored members with their names and offsets", async () => {
  const path = await writeCarrier(buildUnityWebData(members));
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(snapshot.manifest.root_format).toBe("unity-web-data");
  const root = snapshot.occurrences.find((row) => row.logical_path === ".");
  expect(root?.format_metadata).toEqual({
    kind: "unity-web-data",
    signature: "UnityWebData1.0",
    directory_end: 20 + 3 * 12 + 11 + 33 + 12,
    member_count: 3,
  });
  const reader = new UnityWebDataArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    expect(entries.map(({ path: member }) => member)).toEqual(
      members.map(({ path: member }) => member),
    );
    for (const [index, entry] of entries.entries())
      expect(await collect(await reader.open(entry))).toEqual(
        members[index]!.bytes,
      );
  } finally {
    await reader.close();
  }
});

it.each([
  [
    "a member past the end of the file",
    (bytes: Buffer) => bytes.writeUInt32LE(bytes.length, 24),
    "outside the data area",
  ],
  [
    "a name longer than the directory",
    (bytes: Buffer) => bytes.writeUInt32LE(4096, 28),
    "name exceeds the directory",
  ],
  [
    "a directory end past the file",
    (bytes: Buffer) => bytes.writeUInt32LE(bytes.length + 1, 16),
    "lies outside",
  ],
])("rejects %s", async (_name, corrupt, message) => {
  const bytes = buildUnityWebData(members);
  corrupt(bytes);
  const reader = new UnityWebDataArtifactReader(await writeCarrier(bytes));
  try {
    await expect(async () => {
      for await (const _ of reader.entries()) void _;
    }).rejects.toThrow(message);
  } finally {
    await reader.close();
  }
});

it("rejects duplicate member paths", async () => {
  const bytes = buildUnityWebData([members[0]!, members[0]!]);
  const reader = new UnityWebDataArtifactReader(await writeCarrier(bytes));
  try {
    await expect(async () => {
      for await (const _ of reader.entries()) void _;
    }).rejects.toThrow("duplicate member path");
  } finally {
    await reader.close();
  }
});
