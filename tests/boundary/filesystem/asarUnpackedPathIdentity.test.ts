import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import {
  ArtifactEntryContentUnavailable,
  type ArtifactEntry,
} from "../../../src/resources/index.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("keeps exact archive names without reading replacement-character companions", async () => {
  const root = await createTestTempDirectory("rea-asar-unpacked-identity-");
  const archive = join(root, "app.asar");
  const packed = Buffer.from("exact packed member");
  const companion = Buffer.from("different filesystem identity");
  const leafNames = ["\ud800.js", "\udc00.js"];
  const parentNames = ["dir\ud800", "dir\udc00"];
  const invalidNames = [
    ...leafNames,
    ...parentNames.map((name) => `${name}/member.js`),
  ];
  const validNames = ["\ufffd.js", "dir\ufffd/member.js", "🐍.js"];
  const fileTable = (leaves: string[], parents: string[], entry: object) =>
    Object.fromEntries([
      ...leaves.map((name) => [name, entry]),
      ...parents.map((name) => [name, { files: { "member.js": entry } }]),
    ]);
  const files = {
    ...fileTable(
      [...leafNames, "\ufffd.js", "🐍.js"],
      [...parentNames, "dir\ufffd"],
      { size: companion.length, unpacked: true },
    ),
    packed: {
      files: fileTable(leafNames, parentNames, {
        size: packed.length,
        offset: "0",
      }),
    },
  };
  await writeFile(
    archive,
    Buffer.concat([asarHeaderBytes(JSON.stringify({ files })), packed]),
  );
  const companionRoot = `${archive}.unpacked`;
  await mkdir(join(companionRoot, "dir\ufffd"), { recursive: true });
  for (const name of validNames)
    await writeFile(join(companionRoot, name), companion);

  const reader = new AsarArtifactReader(archive);
  try {
    const entries = new Map<string, ArtifactEntry>();
    for await (const entry of reader.entries()) entries.set(entry.path, entry);
    const read = async (name: string) =>
      buffer(await reader.open(entries.get(name)!));
    for (const name of invalidNames) {
      const entry = entries.get(name);
      expect(entry?.unpacked, name).toBe(true);
      await expect(reader.open(entry!), name).rejects.toBeInstanceOf(
        ArtifactEntryContentUnavailable,
      );
      expect((await read(`packed/${name}`)).equals(packed), name).toBe(true);
    }
    for (const name of validNames)
      expect((await read(name)).equals(companion), name).toBe(true);
  } finally {
    await reader.close();
  }

  const inventory = await inventoryArtifact(archive);
  const occurrence = (name: string) =>
    inventory.occurrences.find((entry) => entry.logical_path === name);
  const digest = createHash("sha256").update(packed).digest("hex");
  for (const name of invalidNames) {
    expect(occurrence(name), name).toMatchObject({
      artifact_id: null,
      hash_status: "unavailable",
      limitations: [
        expect.stringContaining("cannot be represented without replacement"),
      ],
    });
    const packedEntry = occurrence(`packed/${name}`);
    expect(packedEntry, name).toMatchObject({ hash_status: "verified" });
    expect(
      inventory.nodes.find(
        ({ artifact_id }) => artifact_id === packedEntry?.artifact_id,
      )?.sha256,
      name,
    ).toBe(digest);
  }
});
