import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  member: "",
  stagedMember: "",
  matchStagedMember: false,
  observedStagedMembers: [] as string[],
  refuseCloses: false,
  closeCount: 0,
  onClose: undefined as ((attempt: number) => void) | undefined,
  refused: [] as FileHandle[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      const path = typeof args[0] === "string" ? args[0] : "";
      const matchedStaged =
        path === fault.stagedMember ||
        (fault.matchStagedMember && path.includes(".dSYM") && args[1] === "wx");
      if (matchedStaged) fault.observedStagedMembers.push(path);
      // Only the staging source and destination descriptors are faulted; the
      // fixture's own file I/O keeps real close semantics.
      if (path !== fault.member && !matchedStaged) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        fault.closeCount += 1;
        fault.onClose?.(fault.closeCount);
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

import { GhidraClient } from "../../src/ghidra/GhidraClient.js";
import { stageGhidraDebugCompanion } from "../../src/ghidra/GhidraDebugCompanion.js";
import { silentLogger } from "../../src/logger.js";
import {
  ArtifactFileCleanupFailure,
  ArtifactResourceScope,
  artifactFilePrimaryFacts,
} from "../../src/resources/index.js";
import { AnalysisArtifactChangedError } from "../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const clients: GhidraClient[] = [];

beforeEach(() => {
  fault.member = "";
  fault.stagedMember = "";
  fault.matchStagedMember = false;
  fault.observedStagedMembers = [];
  fault.refuseCloses = false;
  fault.closeCount = 0;
  fault.onClose = undefined;
  fault.refused = [];
});

afterEach(async () => {
  fault.refuseCloses = false;
  for (const client of clients.splice(0)) await client.close();
  for (const handle of fault.refused) if (handle.fd >= 0) await handle.close();
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
    root,
    bytes,
    runtime,
    snapshot,
    stagedMember: fault.stagedMember,
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

it("retains failed staging closes without unlinking the open staged file until release", async () => {
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
  // The destination descriptor stays linked on disk until its owner closes it;
  // partial staged entries belong to the private runtime owner.
  expect((await stat(fixture.stagedMember)).nlink).toBeGreaterThanOrEqual(1);
  expect((await fault.refused[0]!.stat()).nlink).toBeGreaterThanOrEqual(1);
  expect(
    (await readFile(fixture.companion.memberPath)).equals(fixture.bytes),
  ).toBe(true);
  // Retained owners release once their closes succeed.
  await resources.close();
  expect(resources.hasPending).toBe(false);
  expect(fault.refused.every((handle) => handle.fd === -1)).toBe(true);
});

it("keeps a digest mismatch primary and leaves the open staged file linked when closes also fail", async () => {
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
  expect((await stat(fixture.stagedMember)).nlink).toBeGreaterThanOrEqual(1);
  expect((await fault.refused[0]!.stat()).nlink).toBeGreaterThanOrEqual(1);
  await resources.close();
  expect(resources.hasPending).toBe(false);
  expect(fault.refused.every((handle) => handle.fd === -1)).toBe(true);
});

it("preserves caller cancellation arriving during outer staging close after destination close failed", async () => {
  const fixture = await stagingFixture();
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const abortReason = new Error("cancelled during outer staging close");
  fault.refuseCloses = true;
  fault.onClose = (attempt) => {
    // Attempt 1 is destination.close(); attempt 2 is source.close().
    if (attempt === 2) controller.abort(abortReason);
  };
  const failure = await settle(
    stageGhidraDebugCompanion(
      fixture.companion,
      fixture.runtime,
      fixture.snapshot,
      { resourceScope: resources, signal: controller.signal },
    ),
  );
  fault.refuseCloses = false;
  expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
  expect(failure).toMatchObject({
    reason: "cancelled",
    cancellation: { reason: abortReason },
  });
  expect(resources.hasPending).toBe(true);
  expect((await stat(fixture.stagedMember)).nlink).toBeGreaterThanOrEqual(1);
  expect((await fault.refused[0]!.stat()).nlink).toBeGreaterThanOrEqual(1);
  await resources.close();
  expect(resources.hasPending).toBe(false);
  expect(fault.refused.every((handle) => handle.fd === -1)).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "defers private runtime root removal in GhidraClient until failed dSYM staging handles release",
  async () => {
    const fixture = await stagingFixture();
    const targetPath = join(fixture.root, "target");
    const targetBytes = Buffer.from("target bytes for Ghidra snapshot");
    await writeFile(targetPath, targetBytes);
    const targetSha256 = createHash("sha256").update(targetBytes).digest("hex");
    fault.matchStagedMember = true;
    fault.refuseCloses = true;

    const client = new GhidraClient({
      launcher: {
        launch: async () => {
          throw new Error("Staging failure must prevent Ghidra launch");
        },
      },
      targetPath,
      targetSha256,
      debugCompanion: fixture.companion,
      providerVersion: "12.2",
      profileDigest: "c".repeat(64),
      logger: silentLogger,
    });
    clients.push(client);

    const started = await client.start();
    expect(started.ok).toBe(false);
    expect(fault.observedStagedMembers).toHaveLength(1);
    const stagedMember = fault.observedStagedMembers[0]!;
    const runtimeRoot = dirname(
      dirname(dirname(dirname(dirname(stagedMember)))),
    );
    const destinationHandle = fault.refused[0]!;
    // While the destination descriptor has not released, neither the staged
    // file nor the private runtime root may be unlinked out from under it.
    expect(destinationHandle.fd).toBeGreaterThanOrEqual(0);
    expect((await stat(stagedMember)).nlink).toBeGreaterThanOrEqual(1);
    expect((await destinationHandle.stat()).nlink).toBeGreaterThanOrEqual(1);

    fault.refuseCloses = false;
    const closed = await client.close();
    expect(closed).toMatchObject({ ok: true });
    expect(fault.refused.every((handle) => handle.fd === -1)).toBe(true);
    await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
