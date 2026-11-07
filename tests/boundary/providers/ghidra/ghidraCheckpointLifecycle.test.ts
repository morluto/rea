import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactResourceScope } from "../../../../src/artifacts/ArtifactResourceScope.js";
import { createAnalysisProfile } from "../../../../src/domain/analysisProfile.js";
import { GhidraClient } from "../../../../src/ghidra/GhidraClient.js";
import { resolveGhidraCheckpoint } from "../../../../src/ghidra/GhidraCheckpoint.js";
import { GhidraFixtureLauncher } from "./ghidraClient.fixture.js";
import { awaitAcknowledgement } from "../../../fixtures/lifecycleAcknowledgement.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const roots: string[] = [],
  clients: GhidraClient[] = [],
  launchers: GhidraFixtureLauncher[] = [];
afterEach(async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  for (const launcher of launchers.splice(0))
    for (const child of launcher.processes)
      if (child.connected) child.send("release_checkpoint");
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
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
) {
  const root = await mkdtemp(join(tmpdir(), "rea-checkpoint-lifecycle-"));
  roots.push(root);
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
  });
  clients.push(client);
  return { root, selection, launcher, client, targetPath, sha256 };
}

it.skipIf(process.platform === "win32")(
  "saves completed initial analysis, leaves an unchanged checkpoint alone, and releases its lease",
  async () => {
    const f = await fixture();
    expect((await f.client.start()).ok).toBe(true);
    const path = join(f.selection.directory, "current.json"),
      before = await readFile(path, "utf8");
    expect((await f.client.close()).ok).toBe(true);
    expect(await readFile(path, "utf8")).toEqual(before);
    expect(f.launcher.requests).toContain("checkpoint_program");
    const selection = await resolveGhidraCheckpoint(
      f.root,
      f.sha256,
      profile,
      new ArtifactResourceScope(),
    );
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
    expect(f.launcher.packedPrograms.at(-1)?.sha256).toBe(
      JSON.parse(await readFile(path, "utf8")).source.sha256,
    );
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
  "does not release a Program or its lease before its final checkpoint acknowledges",
  async () => {
    const f = await fixture("checkpoint_hold_close");
    expect((await f.client.start()).ok).toBe(true);
    await f.client.callTool("set_address_name", {
      address: "0x1000",
      name: "changed",
    });
    const closing = f.client.close();
    await awaitAcknowledgement(
      f.launcher.checkpointHeld,
      closing,
      "final checkpoint",
    );
    expect(f.launcher.processes[0]!.exitCode).toBeNull();
    const selection = await resolveGhidraCheckpoint(
      f.root,
      f.sha256,
      profile,
      new ArtifactResourceScope(),
    );
    const other = new GhidraClient({
      launcher: f.launcher,
      targetPath: f.targetPath,
      targetSha256: f.sha256,
      providerVersion: "12.1.4",
      profileDigest: profile.digest,
      checkpoint: selection,
    });
    clients.push(other);
    expect((await other.start()).ok).toBe(false);
    f.launcher.processes[0]!.send("release_checkpoint");
    expect((await closing).ok).toBe(true);
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
    await awaitAcknowledgement(
      f.launcher.checkpointHeld,
      peer,
      "initial checkpoint",
    );
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
    await awaitAcknowledgement(
      f.launcher.checkpointHeld,
      starting,
      "initial checkpoint",
    );
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
