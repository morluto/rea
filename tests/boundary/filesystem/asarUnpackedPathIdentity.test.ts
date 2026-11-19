import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";
import {
  ArtifactEntryContentUnavailable,
  type ArtifactEntry,
} from "../../../src/resources/index.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  "\ud800.js",
  "\udc00.js",
  "dir\ud800/member.js",
  "dir\udc00/member.js",
])("does not read a replacement-character companion for %j", async (name) => {
  const root = await createTestTempDirectory("rea-asar-unpacked-identity-");
  const archive = join(root, "app.asar");
  const packed = Buffer.from("exact packed member");
  const companion = Buffer.from("different filesystem identity");
  const replacement = name.replace(/[\ud800-\udfff]/gu, "\ufffd");
  let member: object = { size: companion.length, unpacked: true };
  for (const part of name.split("/").reverse())
    member = { files: { [part]: member } };
  const files = (member as { files: Record<string, object> }).files;
  let replacementMember: object = { size: companion.length, unpacked: true };
  for (const part of replacement.split("/").reverse())
    replacementMember = { files: { [part]: replacementMember } };
  Object.assign(files, (replacementMember as { files: object }).files);
  files.packed = {
    files: { [name.split("/").at(-1)!]: { size: packed.length, offset: "0" } },
  };
  files["🐍.js"] = { size: companion.length, unpacked: true };
  await writeFile(
    archive,
    Buffer.concat([asarHeaderBytes(JSON.stringify({ files })), packed]),
  );
  await mkdir(
    join(`${archive}.unpacked`, ...replacement.split("/").slice(0, -1)),
    { recursive: true },
  );
  await writeFile(join(`${archive}.unpacked`, replacement), companion);
  await writeFile(join(`${archive}.unpacked`, "🐍.js"), companion);
  const reader = new AsarArtifactReader(archive);
  try {
    const entries: ArtifactEntry[] = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const malformed = entries.find((entry) => entry.path === name)!;
    expect(malformed.unpacked).toBe(true);
    await expect(reader.open(malformed)).rejects.toBeInstanceOf(
      ArtifactEntryContentUnavailable,
    );
    const packedEntry = entries.find(
      (entry) => entry.path.startsWith("packed/") && entry.kind === "file",
    )!;
    const read = async (entry: typeof packedEntry) => {
      const chunks: Buffer[] = [];
      for await (const chunk of await reader.open(entry))
        chunks.push(Buffer.from(chunk as Uint8Array));
      return Buffer.concat(chunks);
    };
    expect((await read(packedEntry)).equals(packed)).toBe(true);
    expect(
      (await read(entries.find((entry) => entry.path === replacement)!)).equals(
        companion,
      ),
    ).toBe(true);
    expect(
      (await read(entries.find((entry) => entry.path === "🐍.js")!)).equals(
        companion,
      ),
    ).toBe(true);
  } finally {
    await reader.close();
  }
  const inventory = await inventoryArtifact(archive);
  const occurrence = inventory.occurrences.find(
    (entry) => entry.logical_path === name,
  )!;
  expect(occurrence).toMatchObject({ hash_status: "unavailable" });
  expect(occurrence.artifact_id).toBeNull();
  expect(occurrence.limitations.length).toBeGreaterThan(0);
  const packedOccurrence = inventory.occurrences.find(
    (entry) =>
      entry.logical_path.startsWith("packed/") &&
      entry.hash_status === "verified",
  )!;
  expect(
    inventory.nodes.find(
      (node) => node.artifact_id === packedOccurrence.artifact_id,
    )?.sha256,
  ).toBe(createHash("sha256").update(packed).digest("hex"));
});
