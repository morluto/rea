import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { createGhidraTargetSnapshot } from "../src/ghidra/GhidraTargetSnapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Ghidra target snapshot", () => {
  it("copies an exact digest-bound target into the private runtime", async () => {
    const root = await createTestTempDirectory("rea-ghidra-snapshot-");
    roots.push(root);
    const source = join(root, "source.exe");
    const bytes = Buffer.from("native PE fixture");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(source, bytes);

    const snapshot = await createGhidraTargetSnapshot(source, root, sha256);

    expect(snapshot).toEqual({
      path: join(root, `target-${sha256.slice(0, 12)}.exe`),
      sha256,
    });
    await expect(readFile(snapshot.path)).resolves.toEqual(bytes);
  });

  it("removes a snapshot whose digest differs from admission", async () => {
    const root = await createTestTempDirectory("rea-ghidra-snapshot-");
    roots.push(root);
    const source = join(root, "source with unsafe extension.%PATH%");
    await writeFile(source, "changed target");
    const expected = "a".repeat(64);
    const snapshotPath = join(root, `target-${expected.slice(0, 12)}.bin`);

    await expect(
      createGhidraTargetSnapshot(source, root, expected),
    ).rejects.toThrow(/digest mismatch/u);
    await expect(access(snapshotPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
