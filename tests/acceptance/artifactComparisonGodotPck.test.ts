import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import type { Evidence } from "../../src/domain/evidence.js";
import { connectArtifactComparisonMcp } from "../fixtures/artifactComparisonMcp.js";
import { buildGodotPck, type GodotPckMember } from "../fixtures/godotPck.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** Inspect one-member packs and compare their inventories through MCP. */
const connectPackComparison = async () => {
  const root = await createTestTempDirectory("rea-pck-comparison-");
  const { inspect: inspectFile, compare } =
    await connectArtifactComparisonMcp();
  const inspect = async (
    name: string,
    packMember: GodotPckMember,
  ): Promise<Evidence> => {
    const file = join(root, name);
    await writeFile(file, buildGodotPck(2, [packMember]));
    return inspectFile(file);
  };
  return { inspect, compare };
};

const member = (evidence: Evidence) => {
  const occurrence = artifactInventoryResultSchema
    .parse(evidence.normalized_result)
    .occurrences.find(({ logical_path }) => logical_path === "scenes/main.gd");
  if (occurrence === undefined) throw new Error("Missing scenes/main.gd");
  return occurrence;
};

it("pairs a Godot PCK member across stored res:// spellings", async () => {
  const { inspect, compare } = await connectPackComparison();

  // Godot 4.3 exports store res:// paths and 4.4.1 exports do not. Godot
  // looks both up by the same simplified path, which logical_path holds.
  const prefixed = await inspect("prefixed.pck", {
    path: "res://scenes/main.gd",
    data: "extends Node\n",
  });
  const relative = await inspect("relative.pck", {
    path: "scenes/main.gd",
    data: "extends Node\n",
  });
  expect(member(prefixed).format_metadata).toMatchObject({
    source_path: "res://scenes/main.gd",
  });
  expect(member(relative).format_metadata).toMatchObject({
    source_path: "scenes/main.gd",
  });
  expect(member(relative).artifact_id).toBe(member(prefixed).artifact_id);

  const result = await compare(prefixed, relative);
  expect(
    result.changes.filter(({ logical_path }) => logical_path !== "."),
  ).toEqual([]);
  expect(result.summary).toMatchObject({ unchanged: 1, unknown: 0 });
});

it("compares encryption and declared MD5 without claiming content equality", async () => {
  const { inspect, compare } = await connectPackComparison();
  const script = { path: "res://scenes/main.gd", data: "extends Node\n" };
  const encrypted = (
    name: string,
    ciphertext: string,
    plaintext = script.data,
  ) =>
    inspect(name, {
      path: script.path,
      data: ciphertext,
      flags: 1,
      md5: createHash("md5").update(plaintext).digest(),
    });
  const memberChanges = async (left: Evidence, right: Evidence) =>
    (await compare(left, right)).changes.filter(
      ({ logical_path }) => logical_path !== ".",
    );
  const plain = await inspect("plain.pck", script);
  const first = await encrypted("first.pck", "ciphertext A!");
  const firstMember = member(first);
  const plainMember = member(plain);
  expect(firstMember).toMatchObject({
    artifact_id: null,
    encrypted: true,
    hash_status: "unavailable",
  });
  expect(firstMember.occurrence_id).not.toBe(plainMember.occurrence_id);
  expect(await memberChanges(plain, first)).toMatchObject([
    {
      logical_path: "scenes/main.gd",
      classification: "unknown",
      dimensions: ["metadata", "availability"],
      left_occurrence_id: plainMember.occurrence_id,
      right_occurrence_id: firstMember.occurrence_id,
    },
  ]);

  const again = await encrypted("again.pck", "ciphertext B!");
  expect(await memberChanges(first, again)).toMatchObject([
    {
      logical_path: "scenes/main.gd",
      classification: "unknown",
      dimensions: ["availability"],
    },
  ]);
  // An all-zero MD5 is not a declared claim. The one-sided claim is the
  // metadata difference; the reader's note is not compared.
  const unclaimed = await inspect("unclaimed.pck", {
    path: script.path,
    data: "ciphertext D!",
    flags: 1,
    md5: Buffer.alloc(16),
  });
  expect(member(unclaimed)).not.toHaveProperty("declared_integrity");
  expect(await memberChanges(first, unclaimed)).toMatchObject([
    {
      logical_path: "scenes/main.gd",
      classification: "unknown",
      dimensions: ["metadata", "availability"],
    },
  ]);
  // Claims that differ declare different content, but REA cannot verify
  // them, so the difference is known and the content change is not.
  const edited = await encrypted(
    "edited.pck",
    "ciphertext C!",
    "extends Sprite2D\n",
  );
  expect(await memberChanges(first, edited)).toMatchObject([
    {
      logical_path: "scenes/main.gd",
      classification: "unknown",
      dimensions: ["metadata", "availability"],
    },
  ]);
});
