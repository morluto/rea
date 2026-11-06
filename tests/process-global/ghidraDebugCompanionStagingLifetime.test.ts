import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  member: "",
  stagedMember: "",
  refuseCloses: false,
  refused: [] as FileHandle[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      // Only the staging source and destination descriptors are faulted; the
      // fixture's own file I/O keeps real close semantics.
      if (args[0] !== fault.member && args[0] !== fault.stagedMember)
        return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        if (fault.refuseCloses) {
          fault.refused.push(handle);
          throw new Error("controlled dSYM staging descriptor close failure");
        }
        await close();
      };
      return handle;
    },
  };
});

import { stageGhidraDebugCompanion } from "../../src/ghidra/GhidraDebugCompanion.js";
import {
  ArtifactFileCleanupFailure,
  artifactFilePrimaryFacts,
} from "../../src/artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { AnalysisArtifactChangedError } from "../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

beforeEach(() => {
  fault.member = "";
  fault.stagedMember = "";
  fault.refuseCloses = false;
  fault.refused = [];
});

const stagingFixture = async () => {
  const root = await createTestTempDirectory("rea-dsym-staging-close-");
  const bytes = Buffer.from("caller-selected DWARF member bytes");
  const runtime = join(root, "private-runtime");
  await mkdir(runtime);
  const memberPath = join(root, "original-member");
  await writeFile(memberPath, bytes, { mode: 0o640 });
  const snapshot = join(runtime, "snapshot-name");
  fault.member = memberPath;
  fault.stagedMember = join(
    runtime,
    "snapshot-name.dSYM",
    "Contents",
    "Resources",
    "DWARF",
    "snapshot-name",
  );
  return {
    bytes,
    runtime,
    snapshot,
    companion: {
      sourcePath: join(root, "caller.dSYM"),
      memberPath,
      memberSha256: createHash("sha256").update(bytes).digest("hex"),
      memberSizeBytes: bytes.length,
      uuid: "11111111-2222-3333-4444-555555555555",
    },
  };
};

const settle = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (cause: unknown) => cause,
  );

it("retains failed staging closes for cleanup retry after a completed copy", async () => {
  const fixture = await stagingFixture();
  const resources = new ArtifactResourceScope();
  fault.refuseCloses = true;
  const failure = await settle(
    stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
      { resourceScope: resources },
    ),
  );
  fault.refuseCloses = false;
  expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
  // Both the source and destination descriptors attempted their own close.
  expect(fault.refused).toHaveLength(2);
  expect(resources.hasPending).toBe(true);
  // The partial staged tree is removed only after both closes settled; the
  // caller's member is untouched.
  expect(await readdir(fixture.runtime)).toEqual([]);
  expect(
    (await readFile(fixture.companion.memberPath)).equals(fixture.bytes),
  ).toBe(true);
  // Retained owners release once their closes succeed.
  await resources.close();
  expect(resources.hasPending).toBe(false);
});

it("keeps a digest mismatch primary when the later closes also fail", async () => {
  const fixture = await stagingFixture();
  const resources = new ArtifactResourceScope();
  fault.refuseCloses = true;
  const failure = await settle(
    stageGhidraDebugCompanion(
      {
        ...fixture.companion,
        memberSha256: createHash("sha256").update("other").digest("hex"),
      },
      fixture.runtime,
      fixture.snapshot,
      { resourceScope: resources },
    ),
  );
  fault.refuseCloses = false;
  expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
  // The source close wraps the destination close failure, which in turn
  // carries the digest mismatch as its operation outcome.
  const primary = artifactFilePrimaryFacts(failure).cause;
  expect(primary).toBeInstanceOf(AnalysisArtifactChangedError);
  expect(primary).toMatchObject({
    message: expect.stringContaining("dSYM member digest mismatch"),
  });
  expect(resources.hasPending).toBe(true);
  expect(await readdir(fixture.runtime)).toEqual([]);
  await resources.close();
  expect(resources.hasPending).toBe(false);
});
