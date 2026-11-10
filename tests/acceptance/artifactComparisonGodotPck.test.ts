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

it("reports a Godot PCK member that becomes encrypted", async () => {
  const { inspect, compare } = await connectPackComparison();
  const script = { path: "res://scenes/main.gd", data: "extends Node\n" };
  const plain = await inspect("plain.pck", script);
  const encrypted = await inspect("encrypted.pck", { ...script, flags: 1 });
  // REA does not decrypt members, so the encrypted member has no content.
  expect(member(encrypted)).toMatchObject({
    artifact_id: null,
    encrypted: true,
    hash_status: "unavailable",
  });

  // The encryption change is known; whether the script changed is not.
  const result = await compare(plain, encrypted);
  expect(
    result.changes.filter(({ logical_path }) => logical_path !== "."),
  ).toMatchObject([
    {
      logical_path: "scenes/main.gd",
      classification: "unknown",
      dimensions: ["metadata", "availability"],
      left_occurrence_id: member(plain).occurrence_id,
      right_occurrence_id: member(encrypted).occurrence_id,
    },
  ]);
});

it("compares encrypted Godot PCK members by their declared MD5", async () => {
  const { inspect, compare } = await connectPackComparison();
  // Godot hashes a member's unencrypted bytes, so every export of one script
  // declares the same MD5 whatever its random IV.
  const encrypted = (name: string, ciphertext: string, script: string) =>
    inspect(name, {
      path: "res://scenes/main.gd",
      data: ciphertext,
      flags: 1,
      md5: createHash("md5").update(script).digest(),
    });
  const first = await encrypted("first.pck", "ciphertext A", "extends Node\n");
  const again = await encrypted("again.pck", "ciphertext B", "extends Node\n");
  const edited = await encrypted(
    "edited.pck",
    "ciphertext C",
    "extends Sprite2D\n",
  );
  const memberChanges = async (left: Evidence, right: Evidence) =>
    (await compare(left, right)).changes.filter(
      ({ logical_path }) => logical_path !== ".",
    );

  // Equal claims are unverified, so they do not establish equality.
  expect(await memberChanges(first, again)).toMatchObject([
    {
      logical_path: "scenes/main.gd",
      classification: "unknown",
      dimensions: ["availability"],
    },
  ]);
  // An all-zero MD5 is no claim, and one claim alone proves no change. The
  // reader notes the all-zero MD5, and that note is the metadata difference.
  const unclaimed = await inspect("unclaimed.pck", {
    path: "res://scenes/main.gd",
    data: "ciphertext D",
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
  expect(await memberChanges(first, edited)).toMatchObject([
    {
      logical_path: "scenes/main.gd",
      classification: "unknown",
      dimensions: ["metadata", "availability"],
    },
  ]);
});
