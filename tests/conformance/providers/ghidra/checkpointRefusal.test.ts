import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { assertCheckpointRefusalPreservesManifest } from "../../../../scripts/lib/ghidra-checkpoint-refusal.mjs";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const checkpointFile = async (bytes: Uint8Array) => {
  const root = await createTestTempDirectory("rea-checkpoint-refusal-");
  const path = join(root, "current.json");
  await writeFile(path, bytes);
  return path;
};

const refusal = (code = "configuration_invalid", exitCode = 1) =>
  Object.assign(new Error("inert CLI refusal"), {
    code: exitCode,
    stdout: JSON.stringify({ code }),
    stderr: "controlled CLI diagnostic",
  });

it("checks the original manifest bytes after the CLI refuses", async () => {
  const bytes = Buffer.from("{");
  const path = await checkpointFile(bytes);
  await expect(
    assertCheckpointRefusalPreservesManifest(
      async () => {
        throw refusal();
      },
      path,
      bytes,
    ),
  ).resolves.toEqual({ code: "configuration_invalid" });
  expect((await readFile(path)).equals(bytes)).toBe(true);

  await expect(
    assertCheckpointRefusalPreservesManifest(
      async () => {
        // The same expected refusal must not hide replacement of the owned state.
        await writeFile(path, JSON.stringify({ replaced: true }));
        throw refusal();
      },
      path,
      bytes,
    ),
  ).rejects.toThrow(/changed the checkpoint manifest/u);
});

it.each([
  { name: "unexpected success", operation: async () => undefined },
  {
    name: "unrelated exit",
    operation: async () => {
      throw refusal("configuration_invalid", 2);
    },
  },
  {
    name: "different refusal",
    operation: async () => {
      throw refusal("capability_unavailable");
    },
  },
])(
  "rejects $name while checking manifest preservation",
  async ({ operation }) => {
    const bytes = Buffer.from("{");
    const path = await checkpointFile(bytes);
    await expect(
      assertCheckpointRefusalPreservesManifest(operation, path, bytes),
    ).rejects.toThrow();
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
