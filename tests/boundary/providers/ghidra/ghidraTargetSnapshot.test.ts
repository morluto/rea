import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { createGhidraTestRuntime } from "../../../fixtures/ghidraRuntime.js";
import type { PrivateRuntimeRoot } from "../../../../src/process/PrivateRuntimeRoot.js";

import { createGhidraTargetSnapshot } from "../../../../src/ghidra/GhidraTargetSnapshot.js";

const roots: string[] = [];
const runtimes: PrivateRuntimeRoot[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
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
    const runtime = await createGhidraTestRuntime(root);
    runtimes.push(runtime);

    const snapshot = await createGhidraTargetSnapshot(
      source,
      runtime.path,
      sha256,
    );

    expect(snapshot).toMatchObject({
      path: join(runtime.path, `target-${sha256.slice(0, 12)}.exe`),
      sha256,
    });
    await expect(readFile(snapshot.path)).resolves.toEqual(bytes);
  });

  it("rejects a mismatched digest and removes the failed runtime snapshot", async () => {
    const root = await createTestTempDirectory("rea-ghidra-snapshot-");
    roots.push(root);
    const source = join(root, "source with unsafe extension.%PATH%");
    await writeFile(source, "changed target");
    const runtime = await createGhidraTestRuntime(root);
    runtimes.push(runtime);
    const expected = "a".repeat(64);
    const snapshotPath = join(
      runtime.path,
      `target-${expected.slice(0, 12)}.bin`,
    );

    await expect(
      createGhidraTargetSnapshot(source, runtime.path, expected),
    ).rejects.toThrow(/digest mismatch/u);
    await runtime.close();
    await expect(access(snapshotPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
