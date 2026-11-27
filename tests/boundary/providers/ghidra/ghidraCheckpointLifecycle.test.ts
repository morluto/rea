import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "../../../support/testWait.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  chmod,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";

import { join } from "node:path";
import { ArtifactResourceScope } from "../../../../src/resources/ArtifactResourceScope.js";
import { createAnalysisProfile } from "../../../../src/domain/analysisProfile.js";
import { GhidraClient } from "../../../../src/ghidra/GhidraClient.js";
import type { BridgeMaxReplyBytes } from "../../../../src/config/bridgeMaxReplyBytes.js";
import { ConfigurationError } from "../../../../src/domain/configurationErrors.js";
import {
  GhidraCheckpoint,
  GhidraCheckpointSupersededError,
  resolveGhidraCheckpoint,
} from "../../../../src/ghidra/GhidraCheckpoint.js";
import { err } from "../../../../src/domain/result.js";
import { ProviderCleanupError } from "../../../../src/domain/providerCleanupError.js";
import {
  GhidraLaunchError,
  type GhidraLauncher,
} from "../../../../src/ghidra/GhidraLauncher.js";
import { GhidraFixtureLauncher } from "./ghidraClient.fixture.js";
import type { GhidraCheckpointSaveWait } from "../../../../src/config/ghidraCheckpointSaveWait.js";
import { acquireOwnedLease } from "../../../../src/process/OwnedLease.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { projectSessionError } from "../../../../src/ghidra/GhidraSessionErrorProjection.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock("../../../../src/process/OwnedLease.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/process/OwnedLease.js")
    >();
  return { ...actual, acquireOwnedLease: vi.fn(actual.acquireOwnedLease) };
});
const restoreLeases = async () => {
  const actual = await vi.importActual<
    typeof import("../../../../src/process/OwnedLease.js")
  >("../../../../src/process/OwnedLease.js");
  vi.mocked(acquireOwnedLease)
    .mockReset()
    .mockImplementation(actual.acquireOwnedLease);
};

const clients: GhidraClient[] = [],
  launchers: GhidraFixtureLauncher[] = [];
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  await restoreLeases();
  for (const launcher of launchers.splice(0))
    for (const child of launcher.processes)
      if (child.connected) child.send("release_checkpoint");
  for (const client of clients.splice(0)) await client.close();
});

it.skipIf(process.platform === "win32")(
  "reopens after startup publication succeeds but staging removal fails",
  async () => {
    const f = await fixture();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let failed = false;
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (
        !failed &&
        typeof path === "string" &&
        /checkpoint-[a-f0-9-]+\.gzf$/.test(path)
      ) {
        failed = true;
        throw new Error("controlled staging removal failure");
      }
      await actual.rm(path, options);
    });
    expect((await f.client.start()).ok).toBe(false);
    await access(join(f.selection.directory, "current.json"));
    expect((await f.client.start()).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    for (const root of f.launcher.runtimeRoots)
      await expect(access(root)).rejects.toThrow();
  },
);
const profile = createAnalysisProfile(
  { id: "ghidra", name: "Ghidra", version: "12.1.4" },
  { checkpoint_test: true },
);
async function fixture(
  mode: ConstructorParameters<typeof GhidraFixtureLauncher>[0] = "checkpoint",
  bridgeMaxReplyBytes?: BridgeMaxReplyBytes,
) {
  const root = await createTestTempDirectory("rea-checkpoint-lifecycle-");
  const targetPath = join(root, "target");
  await writeFile(targetPath, "source target bytes");
  const sha256 = createHash("sha256")
    .update("source target bytes")
    .digest("hex");
  const selection = await resolveGhidraCheckpoint(
    root,
    sha256,
    profile,
    new ArtifactResourceScope(),
  );
  const launcher = new GhidraFixtureLauncher(mode);
  launchers.push(launcher);
  const client = new GhidraClient({
    launcher,
    targetPath,
    targetSha256: sha256,
    providerVersion: "12.1.4",
    profileDigest: profile.digest,
    checkpoint: selection,
    startupTimeoutMs: 10_000,
    ...(bridgeMaxReplyBytes === undefined ? {} : { bridgeMaxReplyBytes }),
  });
  clients.push(client);
  return { root, selection, launcher, client, targetPath, sha256 };
}

/** Another session on the same target, selecting the checkpoint as it is now. */
async function peer(
  f: Awaited<ReturnType<typeof fixture>>,
  launcher: GhidraLauncher = fixtureLauncher(),
  checkpointSaveWait?: GhidraCheckpointSaveWait,
) {
  const selection = await resolveGhidraCheckpoint(
    f.root,
    f.sha256,
    profile,
    new ArtifactResourceScope(),
  );
  const client = new GhidraClient({
    launcher,
    targetPath: f.targetPath,
    targetSha256: f.sha256,
    providerVersion: "12.1.4",
    profileDigest: profile.digest,
    checkpoint: selection,
    startupTimeoutMs: 10_000,
    ...(checkpointSaveWait === undefined ? {} : { checkpointSaveWait }),
  });
  clients.push(client);
  return { client, selection };
}
const packed = async (root: string, contents: string) => {
  const path = join(root, `${randomUUID()}.gzf`);
  await writeFile(path, contents);
  return path;
};
function fixtureLauncher() {
  const launcher = new GhidraFixtureLauncher("checkpoint");
  launchers.push(launcher);
  return launcher;
}
const rename = (client: GhidraClient) =>
  client.callTool("set_address_name", { address: "0x1000", name: "changed" });
const programs = async (directory: string) =>
  (await readdir(directory)).filter((name) => name.endsWith(".gzf"));

it.skipIf(process.platform === "win32")(
  "saves completed initial analysis, leaves an unchanged checkpoint alone, and releases its lease",
  async () => {
    const f = await fixture();
    expect(f.client.checkpointRestore()).toBeUndefined();
    expect((await f.client.start()).ok).toBe(true);
    expect(f.client.checkpointRestore()).toBeNull();
    const path = join(f.selection.directory, "current.json");
    const before = await readFile(path, "utf8");
    const manifest = JSON.parse(before);
    const sha256 = createHash("sha256")
      .update("fixture checkpoint initial")
      .digest("hex");
    expect(manifest).toMatchObject({
      version: 2,
      source: { kind: "initial-analysis", sha256 },
    });
    expect((await f.client.close()).ok).toBe(true);
    expect(f.client.checkpointRestore()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(before);
    const resources = new ArtifactResourceScope();
    const selection = await resolveGhidraCheckpoint(
      f.root,
      f.sha256,
      profile,
      resources,
    );
    expect(selection).toEqual(f.selection);
    const otherProfile = createAnalysisProfile(profile.provider, {
      checkpoint_test: false,
    });
    for (const [target, baseProfile] of [
      ["2".repeat(64), profile],
      [f.sha256, otherProfile],
    ] as const) {
      const other = await resolveGhidraCheckpoint(
        f.root,
        target,
        baseProfile,
        resources,
      );
      expect(other.directory).not.toBe(selection.directory);
    }
    const resumed = new GhidraClient({
      launcher: f.launcher,
      targetPath: f.targetPath,
      targetSha256: f.sha256,
      providerVersion: "12.1.4",
      profileDigest: profile.digest,
      checkpoint: selection,
      startupTimeoutMs: 10_000,
    });
    clients.push(resumed);
    expect((await resumed.start()).ok).toBe(true);
    const packed = {
      path: join(selection.directory, manifest.source.file),
      sha256,
    };
    expect(resumed.checkpointRestore()).toEqual(packed);
    expect(f.launcher.packedPrograms.at(-1)).toEqual(packed);
  },
);

it.skipIf(process.platform === "win32")(
  "saves the closing checkpoint under the session's ceilings after its seed is refused",
  async () => {
    // A seed refused after startup (its override reset) must not refuse the
    // closing checkpoint and leave the JVM running.
    let seedRefused = false;
    const f = await fixture("checkpoint", {
      get maximumBytes(): number {
        if (seedRefused)
          throw new ConfigurationError("invalid bridge.max_reply_bytes seed");
        return 1024 * 1024;
      },
      source: "runtime",
    });
    expect((await f.client.start()).ok).toBe(true);
    seedRefused = true;

    expect((await f.client.close()).ok).toBe(true);
    expect(f.launcher.requests).toContain("checkpoint_program");
    expect(f.launcher.requests).toContain("shutdown");
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a failed normal-close save editable and retries without deleting the previous checkpoint",
  async () => {
    const f = await fixture("checkpoint_fail_close");
    expect((await f.client.start()).ok).toBe(true);
    const path = join(f.selection.directory, "current.json"),
      before = await readFile(path, "utf8");
    expect(
      (
        await f.client.callTool("set_address_name", {
          address: "0x1000",
          name: "changed",
        })
      ).ok,
    ).toBe(true);
    expect((await f.client.close()).ok).toBe(false);
    expect(
      (await readdir(f.launcher.runtimeRoots[0]!)).filter((name) =>
        name.startsWith("checkpoint-"),
      ),
    ).toEqual([]);
    expect(f.client.isReady()).toBe(true);
    expect(await readFile(path, "utf8")).toEqual(before);
    expect((await f.client.callTool("list_documents", {})).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    expect(await readFile(path, "utf8")).not.toEqual(before);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a Program until its final checkpoint acknowledges while another session restores the same target",
  async () => {
    const f = await fixture("checkpoint_hold_close");
    expect((await f.client.start()).ok).toBe(true);
    await rename(f.client);
    const closing = f.client.close();
    await f.launcher.checkpointHold.reached(closing, "final checkpoint");
    expect(f.launcher.processes[0]!.exitCode).toBeNull();
    // The stalled save holds no lease a reader needs: a second session
    // restores the still-current generation and answers queries.
    const other = await peer(f);
    expect((await other.client.start()).ok).toBe(true);
    expect((await other.client.callTool("list_documents", {})).ok).toBe(true);
    expect(other.client.checkpointRestore()?.sha256).toBe(
      createHash("sha256").update("fixture checkpoint initial").digest("hex"),
    );
    f.launcher.processes[0]!.send("release_checkpoint");
    expect((await closing).ok).toBe(true);
    // The reader made no edits, so its close publishes nothing.
    const published = await readFile(
      join(f.selection.directory, "current.json"),
      "utf8",
    );
    expect(JSON.parse(published)).toMatchObject({
      source: { kind: "retained" },
    });
    expect((await other.client.close()).ok).toBe(true);
    expect(
      await readFile(join(f.selection.directory, "current.json"), "utf8"),
    ).toBe(published);
  },
);

it.skipIf(process.platform === "win32")(
  "lets two sessions analyze an unseen target at once and publishes its initial checkpoint once",
  async () => {
    const f = await fixture();
    const other = await peer(f);
    const [first, second] = await Promise.all([
      f.client.start(),
      other.client.start(),
    ]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(f.client.checkpointRestore()).toBeNull();
    expect(other.client.checkpointRestore()).toBeNull();
    const manifest = join(f.selection.directory, "current.json");
    const published = await readFile(manifest, "utf8");
    expect(JSON.parse(published)).toMatchObject({
      source: { kind: "initial-analysis" },
    });
    expect(await programs(f.selection.directory)).toHaveLength(1);
    expect((await f.client.callTool("list_documents", {})).ok).toBe(true);
    expect((await other.client.callTool("list_documents", {})).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    expect((await other.client.close()).ok).toBe(true);
    expect(await readFile(manifest, "utf8")).toBe(published);
    expect(await programs(f.selection.directory)).toHaveLength(1);
  },
);

it.skipIf(process.platform === "win32")(
  "refuses the later of two edited saves, keeps its session live, then discards on the next close",
  async () => {
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    const stale = await peer(f);
    expect((await stale.client.start()).ok).toBe(true);
    expect((await rename(f.client)).ok).toBe(true);
    expect((await rename(stale.client)).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    const manifest = join(f.selection.directory, "current.json");
    const published = await readFile(manifest, "utf8");
    const files = (await readdir(f.selection.directory)).sort();

    const refused = await stale.client.close();
    if (refused.ok) throw new Error("the stale save unexpectedly succeeded");
    expect(refused.error.cause).toBeInstanceOf(GhidraCheckpointSupersededError);
    expect(refused.error.cause).toMatchObject({ stage: "save" });
    expect(refused.error.diagnostics).toMatchObject({
      reason: expect.stringMatching(/were not saved.*Closing the target again/),
    });
    expect(refused.error).toMatchObject({
      remediationAction: expect.stringMatching(
        /edits were not saved.*Closing the target again discards/,
      ),
    });
    expect(await readFile(manifest, "utf8")).toBe(published);
    expect((await readdir(f.selection.directory)).sort()).toEqual(files);
    // Non-destructive: the refused session still answers from its Program.
    expect(stale.client.isReady()).toBe(true);
    expect((await stale.client.callTool("list_documents", {})).ok).toBe(true);

    // The refusal is permanent for this generation, so the next close
    // releases the session without another export or publication, and says
    // that it released the edits unsaved.
    expect(await stale.client.close()).toEqual({
      ok: true,
      value: {
        checkpoint: {
          status: "discarded",
          reason: "superseded",
          directory: f.selection.directory,
        },
      },
    });
    // The discard is reported once, by the close that released the edits.
    expect(await stale.client.close()).toEqual({ ok: true, value: null });
    expect(await readFile(manifest, "utf8")).toBe(published);
    expect((await readdir(f.selection.directory)).sort()).toEqual(files);
    expect(refused.error.cleanupResources).toEqual([]);
    for (const launcher of launchers)
      for (const root of launcher.runtimeRoots)
        await expect(access(root)).rejects.toThrow();
    // A reopened session restores the winner's generation.
    const reopened = await peer(f);
    expect(reopened.selection.state.kind).toBe("retained");
    expect((await reopened.client.start()).ok).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "discards on the next close when a refused save's lease release also failed",
  async () => {
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    const stale = await peer(f);
    expect((await stale.client.start()).ok).toBe(true);
    expect((await rename(f.client)).ok).toBe(true);
    expect((await rename(stale.client)).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    const manifest = join(f.selection.directory, "current.json");
    const published = await readFile(manifest, "utf8");
    const leases = await vi.importActual<
      typeof import("../../../../src/process/OwnedLease.js")
    >("../../../../src/process/OwnedLease.js");
    vi.mocked(acquireOwnedLease).mockImplementationOnce(async (input) => {
      const result = await leases.acquireOwnedLease(input);
      if (!result.acquired) return result;
      let failed = false;
      return {
        acquired: true,
        lease: {
          ...result.lease,
          release: async () => {
            if (!failed) {
              failed = true;
              throw new Error("controlled lease release failure");
            }
            await result.lease.release();
          },
        },
      };
    });
    const refused = await stale.client.close();
    if (refused.ok) throw new Error("the stale save unexpectedly succeeded");
    // Still the refusal, with the lease failure reported beside it.
    expect(refused.error.cause).toBeInstanceOf(GhidraCheckpointSupersededError);
    expect(refused.error).toMatchObject({
      remediationAction: expect.stringMatching(/edits were not saved/),
      diagnostics: {
        carried_cleanup_failure: expect.objectContaining({
          code: expect.any(String),
        }),
      },
    });
    expect(stale.client.unsavedCloseReport()).toMatchObject({
      checkpoint: { status: "discarded" },
    });
    // The refusal was recorded, so the next close discards instead of
    // attempting the impossible save again.
    expect(await stale.client.close()).toEqual({
      ok: true,
      value: {
        checkpoint: {
          status: "discarded",
          reason: "superseded",
          directory: f.selection.directory,
        },
      },
    });
    expect(await readFile(manifest, "utf8")).toBe(published);
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "reports released-unsaved edits on the close whose later cleanup fails, and not again on its retry",
  async () => {
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    const launcher = fixtureLauncher();
    const stale = await peer(f, launcher);
    expect((await stale.client.start()).ok).toBe(true);
    expect((await rename(f.client)).ok).toBe(true);
    expect((await rename(stale.client)).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    expect((await stale.client.close()).ok).toBe(false);
    expect(stale.client.unsavedCloseReport()).toMatchObject({
      checkpoint: { status: "discarded" },
    });
    // The JVM stops, releasing the edits, and then the runtime root cannot
    // be removed: that failure is the close that released them.
    const runtimeRoot = launcher.runtimeRoots[0] ?? "";
    await chmod(runtimeRoot, 0o500);
    try {
      const failed = await stale.client.close();
      if (failed.ok) throw new Error("the runtime root removal succeeded");
      expect(projectAnalysisError(failed.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          partial_observation: {
            checkpoint: {
              status: "discarded",
              reason: "superseded",
              directory: f.selection.directory,
            },
          },
        },
      });
      expect(stale.client.unsavedCloseReport()).toBeNull();
    } finally {
      await chmod(runtimeRoot, 0o700);
    }
    expect(await stale.client.close()).toEqual({ ok: true, value: null });
  },
);

it.skipIf(process.platform === "win32")(
  "reports an initial analysis superseded by another session's edits as a reopen, not as lost edits",
  async () => {
    const f = await fixture();
    // Another session publishes an initial checkpoint and then edits while
    // this session is still analyzing the unseen target.
    const analyzing = fixtureLauncher();
    const launcher: GhidraLauncher = {
      launch: async (session) => {
        const writer = new GhidraCheckpoint(
          f.selection,
          new ArtifactResourceScope(),
        );
        await writer.admit("writer");
        await writer.publish(
          await packed(f.root, "initial by another session"),
        );
        await writer.publish(await packed(f.root, "edited by another session"));
        return analyzing.launch(session);
      },
    };
    const late = await peer(f, launcher);
    const started = await late.client.start();
    if (started.ok) throw new Error("the superseded initial save succeeded");
    expect(started.error.cause).toBeInstanceOf(GhidraCheckpointSupersededError);
    expect(started.error.cause).toMatchObject({ stage: "restore" });
    const projected = projectAnalysisError(
      projectSessionError("list_documents", started.error, {
        limits: { ghidraStartupTimeoutMs: 10_000 },
        programName: undefined,
        source: "owned-checkpoint",
      }),
    );
    expect(projected).toMatchObject({
      code: "capability_unavailable",
      retryable: false,
    });
    expect(projected.message).toMatch(/reopen the target/);
    expect(projected.message).not.toMatch(
      /edits were not saved|again discards/,
    );
    // It holds no caller edits, so nothing is reported as released unsaved
    // and nothing blocks the reopen the refusal asks for.
    expect(late.client.unsavedCloseReport()).toBeNull();
    expect(await late.client.close()).toEqual({ ok: true, value: null });
    const reopened = await peer(f);
    expect((await reopened.client.start()).ok).toBe(true);
    expect(reopened.client.checkpointRestore()?.sha256).toBe(
      createHash("sha256").update("edited by another session").digest("hex"),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a startup lease-release failure visible beside a superseded initial analysis",
  async () => {
    const f = await fixture();
    const analyzing = fixtureLauncher();
    const launcher: GhidraLauncher = {
      launch: async (session) => {
        const writer = new GhidraCheckpoint(
          f.selection,
          new ArtifactResourceScope(),
        );
        await writer.admit("writer");
        await writer.publish(
          await packed(f.root, "initial by another session"),
        );
        await writer.publish(await packed(f.root, "edited by another session"));
        // The late session's own publication lease then fails to release once.
        const leases = await vi.importActual<
          typeof import("../../../../src/process/OwnedLease.js")
        >("../../../../src/process/OwnedLease.js");
        vi.mocked(acquireOwnedLease).mockImplementationOnce(async (input) => {
          const result = await leases.acquireOwnedLease(input);
          if (!result.acquired) return result;
          let failed = false;
          return {
            acquired: true,
            lease: {
              ...result.lease,
              release: async () => {
                if (!failed) {
                  failed = true;
                  throw new Error("controlled lease release failure");
                }
                await result.lease.release();
              },
            },
          };
        });
        return analyzing.launch(session);
      },
    };
    const late = await peer(f, launcher);
    const started = await late.client.start();
    if (started.ok) throw new Error("the superseded initial save succeeded");
    expect(started.error.cause).toBeInstanceOf(GhidraCheckpointSupersededError);
    // The release failure stays on the startup failure, through the one
    // accessor every consumer uses, rather than being dropped.
    expect(started.error.cleanupFailure?.cause).toMatchObject({
      message: "controlled lease release failure",
    });
    expect((await late.client.close()).ok).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "reports a close that waited out another session's publication with its save-wait limit",
  async () => {
    const f = await fixture();
    const wait = { waitMs: 100, source: "setting" } as const;
    const writer = await peer(f, fixtureLauncher(), wait);
    expect((await writer.client.start()).ok).toBe(true);
    expect((await rename(writer.client)).ok).toBe(true);
    vi.mocked(acquireOwnedLease).mockResolvedValue({
      acquired: false,
      owner: { runId: "publisher", processId: 4242 },
    });
    const busy = await writer.client.close();
    await restoreLeases();
    if (busy.ok) throw new Error("the close did not wait for the lease");
    expect(projectAnalysisError(busy.error)).toMatchObject({
      code: "cleanup_incomplete",
      remediation: {
        action: expect.stringMatching(/^Wait for that session's save/),
      },
      details: {
        limit: {
          control_kind: "environment",
          environment: "REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS",
          effective_value: 100,
        },
      },
    });
    // Contention is retryable: the next close saves the edits.
    expect((await writer.client.close()).ok).toBe(true);
    expect(
      JSON.parse(
        await readFile(join(f.selection.directory, "current.json"), "utf8"),
      ),
    ).toMatchObject({ source: { kind: "retained" } });
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "reports a restore whose packed Program was superseded during launch as a reopen (restore cleanup failed=%s)",
  async (cleanupFailed) => {
    // The private copy's descriptor close also failed; a later retry released it.
    const restoreCleanup = new ProviderCleanupError(
      "ghidra",
      ["restored-program.gzf"],
      { reason: "controlled descriptor close failure" },
    ).bindCleanupReleaseClaim({ cleanupReleased: true });
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    // The launcher's private copy finds the file removed by a publication
    // that completed after this session's admission.
    const launcher: GhidraLauncher = {
      launch: async (session) => {
        const writer = new GhidraCheckpoint(
          stale.selection,
          new ArtifactResourceScope(),
        );
        await writer.admit("writer");
        const edited = join(f.root, "edited.gzf");
        await writeFile(edited, "edited by another session");
        await writer.publish(edited);
        await expect(access(session.packedProgram!.path)).rejects.toThrow();
        return err(
          new GhidraLaunchError(
            "Ghidra checkpoint changed before its private import; reopen the target.",
            {
              checkpointRestoreFailed: true,
              ...(cleanupFailed ? { cleanupFailure: restoreCleanup } : {}),
            },
          ),
        );
      },
    };
    const stale = await peer(f, launcher);
    const started = await stale.client.start();
    if (started.ok) throw new Error("the superseded restore succeeded");
    expect(started.error.kind).toBe("checkpoint");
    expect(started.error.cause).toBeInstanceOf(GhidraCheckpointSupersededError);
    expect(started.error.cause).toMatchObject({ stage: "restore" });
    // The reopen explanation keeps the launcher's restore cleanup failure.
    if (cleanupFailed)
      expect(started.error.cleanupFailure).toBe(restoreCleanup);
    else expect(started.error.cleanupFailure).toBeUndefined();
    expect((await stale.client.close()).ok).toBe(true);
    const reopened = await peer(f);
    expect((await reopened.client.start()).ok).toBe(true);
    expect(reopened.client.checkpointRestore()?.sha256).toBe(
      createHash("sha256").update("edited by another session").digest("hex"),
    );
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a failed manifest read beside the launch error it was explaining",
  async () => {
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    const manifestClose = new ProviderCleanupError("ghidra", ["current.json"], {
      reason: "manifest descriptor close failed",
    });
    const explain = vi
      .spyOn(GhidraCheckpoint.prototype, "supersededRestore")
      .mockRejectedValueOnce(manifestClose);
    const launcher: GhidraLauncher = {
      launch: async () =>
        err(
          new GhidraLaunchError(
            "Ghidra checkpoint changed before its private import; reopen the target.",
            { checkpointRestoreFailed: true },
          ),
        ),
    };
    const stale = await peer(f, launcher);
    const started = await stale.client.start();
    explain.mockRestore();
    if (started.ok) throw new Error("the restore explanation succeeded");
    expect(started.error.kind).toBe("start");
    expect(started.error.cleanupFailure).toBe(manifestClose);
    expect(started.error.cause).not.toBeInstanceOf(
      GhidraCheckpointSupersededError,
    );
  },
);

it.skipIf(process.platform === "win32")(
  "retries startup after a manifest read that owns no cleanup",
  async () => {
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    const unreadable = new ConfigurationError(
      "checkpoint directory unreadable",
      {
        settings: [
          {
            setting: "REA_GHIDRA_CHECKPOINT_DIR",
            constraint: "directory unreadable",
          },
        ],
      },
    );
    const explain = vi
      .spyOn(GhidraCheckpoint.prototype, "supersededRestore")
      .mockRejectedValue(unreadable);
    let launches = 0;
    const launcher: GhidraLauncher = {
      launch: async () => {
        launches += 1;
        return err(
          new GhidraLaunchError(
            "Ghidra checkpoint changed before its private import; reopen the target.",
            { checkpointRestoreFailed: true },
          ),
        );
      },
    };
    const stale = await peer(f, launcher);
    const first = await stale.client.start();
    const second = await stale.client.start();
    explain.mockRestore();
    if (first.ok || second.ok)
      throw new Error("the manifest read was treated as a successful start");
    expect(first.error.kind).toBe("start");
    expect(first.error.cleanupFailure).toBeUndefined();
    expect(first.error.secondaryFailures).toContain(unreadable);
    expect(second.error.secondaryFailures).toContain(unreadable);
    expect(launches).toBe(2);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a launch failure after a restored copy even when another session saved meanwhile",
  async () => {
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    expect((await f.client.close()).ok).toBe(true);
    // The private copy succeeded; a later launch stage fails while another
    // session publishes. That failure is not a superseded restore.
    const launcher: GhidraLauncher = {
      launch: async () => {
        const writer = new GhidraCheckpoint(
          stale.selection,
          new ArtifactResourceScope(),
        );
        await writer.admit("writer");
        const edited = join(f.root, "edited.gzf");
        await writeFile(edited, "edited by another session");
        await writer.publish(edited);
        return err(new GhidraLaunchError("controlled JVM start failure"));
      },
    };
    const stale = await peer(f, launcher);
    const started = await stale.client.start();
    if (started.ok) throw new Error("the failed launch succeeded");
    expect(started.error.kind).toBe("start");
    expect(started.error.message).toContain("controlled JVM start failure");
    expect(started.error.cause).not.toBeInstanceOf(
      GhidraCheckpointSupersededError,
    );
    expect((await stale.client.close()).ok).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "retains a failed partial-file cleanup and retries it before exporting again",
  async () => {
    const f = await fixture("checkpoint_fail_close");
    expect((await f.client.start()).ok).toBe(true);
    const manifestPath = join(f.selection.directory, "current.json");
    const before = await readFile(manifestPath, "utf8");
    await f.client.callTool("set_address_name", {
      address: "0x1000",
      name: "changed",
    });
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (typeof path === "string" && /checkpoint-[a-f0-9-]+\.gzf$/.test(path))
        throw new Error("controlled partial cleanup failure");
      await actual.rm(path, options);
    });
    const first = await f.client.close();
    expect(first.ok).toBe(false);
    expect((await f.client.close()).ok).toBe(false);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect(
      (await readdir(f.launcher.runtimeRoots[0]!)).filter((name) =>
        name.startsWith("checkpoint-"),
      ),
    ).toHaveLength(1);
    if (first.ok) throw new Error("partial cleanup unexpectedly succeeded");
    expect(first.error.cleanupResources).toContain(f.launcher.runtimeRoots[0]);
    expect(f.client.isReady()).toBe(true);
    vi.mocked(rm).mockImplementation(actual.rm);
    expect((await f.client.close()).ok).toBe(true);
    expect(first.error.cleanupResources).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "lets a startup peer finish after another waiter cancels during initial checkpointing",
  async () => {
    const f = await fixture("checkpoint_hold_startup"),
      abort = new AbortController();
    const first = f.client.start(abort.signal),
      peer = f.client.start();
    const child = await f.launcher.started;
    await f.launcher.checkpointHold.reached(peer, "initial checkpoint");
    abort.abort("only this waiter");
    expect((await first).ok).toBe(false);
    child.send("release_checkpoint");
    expect((await peer).ok).toBe(true);
    expect(f.client.isReady()).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "cancels the last startup waiter without publishing a partial checkpoint and removes its runtime",
  async () => {
    const f = await fixture("checkpoint_hold_startup"),
      abort = new AbortController();
    const starting = f.client.start(abort.signal),
      child = await f.launcher.started;
    await f.launcher.checkpointHold.reached(starting, "initial checkpoint");
    abort.abort("last waiter");
    expect((await starting).ok).toBe(false);
    expect((await f.client.close()).ok).toBe(true);
    await expect(
      access(join(f.selection.directory, "current.json")),
    ).rejects.toThrow();
    for (const root of f.launcher.runtimeRoots)
      await expect(access(root)).rejects.toThrow();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "while the save polls the lease",
    "as soon as the close starts",
  ] as const)(
  "ends a graceful close's wait for another session's lease when a cancellation forces a stop %s",
  async (timing) => {
    const f = await fixture("checkpoint_hang_tool");
    // The wait would otherwise outlast this test by minutes.
    const waiting = await peer(f, f.launcher, {
      waitMs: 600_000,
      source: "setting",
    });
    expect((await waiting.client.start()).ok).toBe(true);
    expect((await rename(waiting.client)).ok).toBe(true);
    const controller = new AbortController();
    const active = waiting.client.callTool(
      "list_documents",
      {},
      { signal: controller.signal },
    );
    await waitFor(() =>
      expect(f.launcher.requests).toContain("list_documents"),
    );
    vi.mocked(acquireOwnedLease)
      .mockClear()
      .mockResolvedValue({
        acquired: false,
        owner: { runId: "publisher", processId: 4242 },
      });
    const closing = waiting.client.close();
    // Either the export finished and the save is polling the publisher's
    // lease, or the forced stop arrives before the save has started at all.
    if (timing === "while the save polls the lease")
      await waitFor(() =>
        expect(vi.mocked(acquireOwnedLease).mock.calls.length).toBeGreaterThan(
          1,
        ),
      );
    const started = Date.now();
    controller.abort(new Error("caller stopped waiting"));
    const [cancelled, closed] = await Promise.all([active, closing]);
    await restoreLeases();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(cancelled).toMatchObject({ ok: false });
    // The graceful close did not publish; the forced stop released the session.
    expect(closed).toMatchObject({ ok: false });
    expect(
      JSON.parse(
        await readFile(join(f.selection.directory, "current.json"), "utf8"),
      ),
    ).toMatchObject({ source: { kind: "initial-analysis" } });
    const child = f.launcher.processes.at(-1)!;
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "exit");
  },
);

it.skipIf(process.platform === "win32")(
  "stops the process when a caller cancels during a graceful close stalled on its checkpoint",
  async () => {
    const f = await fixture("checkpoint_hold_close_hang_tool");
    expect((await f.client.start()).ok).toBe(true);
    await f.client.callTool("set_address_name", {
      address: "0x1000",
      name: "changed",
    });
    const controller = new AbortController();
    const active = f.client.callTool(
      "list_documents",
      {},
      { signal: controller.signal },
    );
    // The tool request has crossed the socket and will never be answered.
    await waitFor(() =>
      expect(f.launcher.requests).toContain("list_documents"),
    );
    const closing = f.client.close();
    await f.launcher.checkpointHold.reached(closing, "final checkpoint");
    // The final checkpoint never answers either. The caller's cancellation
    // must escalate to a forced stop instead of queueing behind it.
    controller.abort(new Error("caller stopped waiting"));
    const [cancelled] = await Promise.all([active, closing]);
    expect(cancelled).toMatchObject({ ok: false });
    const child = f.launcher.processes[0]!;
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "exit");
  },
);

const typeEdits = [
  [
    "annotate_native_function",
    { procedure: "0x1000", signature: "int f(struct session *s)" },
  ],
  ["define_native_data_types", { declarations: "struct session { int id; };" }],
] as const;

it.skipIf(process.platform === "win32").each(typeEdits)(
  "reports a %s edit as not saved when the closing checkpoint fails, keeps it editable and saves it on retry",
  async (operation, parameters) => {
    const f = await fixture("checkpoint_fail_close");
    expect((await f.client.start()).ok).toBe(true);
    const path = join(f.selection.directory, "current.json"),
      before = await readFile(path, "utf8");
    expect((await f.client.callTool(operation, parameters)).ok).toBe(true);
    // The save fails: close reports it and the previous checkpoint is intact.
    expect((await f.client.close()).ok).toBe(false);
    expect(await readFile(path, "utf8")).toEqual(before);
    expect(
      (await readdir(f.launcher.runtimeRoots[0]!)).filter((name) =>
        name.startsWith("checkpoint-"),
      ),
    ).toEqual([]);
    // The live Program still holds the edit and accepts further requests.
    expect(f.client.isReady()).toBe(true);
    expect((await f.client.callTool("list_documents", {})).ok).toBe(true);
    expect(f.launcher.processes).toHaveLength(1);
    expect((await f.client.close()).ok).toBe(true);
    expect(await readFile(path, "utf8")).not.toEqual(before);
  },
);

it.skipIf(process.platform === "win32").each(typeEdits)(
  "cancelling an active %s edit stops the Program without saving and the next start restores the last checkpoint",
  async (operation, parameters) => {
    const f = await fixture("checkpoint_hang_edit");
    expect((await f.client.start()).ok).toBe(true);
    const path = join(f.selection.directory, "current.json"),
      before = await readFile(path, "utf8");
    const controller = new AbortController();
    const active = f.client.callTool(operation, parameters, {
      signal: controller.signal,
    });
    // The edit has crossed the socket and is in progress.
    await waitFor(() => expect(f.launcher.requests).toContain(operation));
    controller.abort(new Error("caller stopped waiting"));
    expect(await active).toMatchObject({
      ok: false,
      error: { kind: "cancelled" },
    });
    const child = f.launcher.processes[0]!;
    if (child.exitCode === null && child.signalCode === null)
      await once(child, "exit");
    // All or nothing: the interrupted Program was discarded, not checkpointed.
    expect(f.client.isReady()).toBe(false);
    expect(await readFile(path, "utf8")).toEqual(before);
    expect(f.launcher.requests).not.toContain("shutdown");
    // The next start is a new Program restored from the unchanged checkpoint.
    expect((await f.client.start()).ok).toBe(true);
    expect(f.launcher.processes).toHaveLength(2);
    expect(f.client.checkpointRestore()).not.toBeNull();
    expect((await f.client.close()).ok).toBe(true);
    expect(await readFile(path, "utf8")).toEqual(before);
  },
);
