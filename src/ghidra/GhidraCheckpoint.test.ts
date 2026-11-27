import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createHash } from "node:crypto";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { waitFor } from "../../tests/support/testWait.js";
import {
  chmod,
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
  rm,
  rename,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { sha256Hex } from "../kernel/sha256Hex.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import {
  acquireOwnedLease,
  LEASE_OWNER_PROBE_ABORTED,
  LEASE_OWNER_RESPONSE_TIMED_OUT,
} from "../process/OwnedLease.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  GhidraCheckpoint,
  GhidraCheckpointBusyError,
  GhidraCheckpointSupersededError,
  hashGhidraPackedProgram,
  resolveGhidraCheckpoint,
} from "./GhidraCheckpoint.js";

const controls = vi.hoisted(() => ({
  file: undefined as
    | ((handle: FileHandle, path: string) => void | Promise<void>)
    | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      await controls.file?.(handle, String(args[0]));
      return handle;
    },
  };
});

vi.mock("../process/OwnedLease.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../process/OwnedLease.js")>();
  return { ...actual, acquireOwnedLease: vi.fn(actual.acquireOwnedLease) };
});

const owners: GhidraCheckpoint[] = [];
afterEach(async () => {
  controls.file = undefined;
  vi.restoreAllMocks();
  const leases = await vi.importActual<
    typeof import("../process/OwnedLease.js")
  >("../process/OwnedLease.js");
  vi.mocked(acquireOwnedLease)
    .mockReset()
    .mockImplementation(leases.acquireOwnedLease);
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(rm).mockReset().mockImplementation(actual.rm);
  vi.mocked(rename).mockReset().mockImplementation(actual.rename);
  for (const owner of owners.splice(0)) await owner.retryCleanup();
});

it.skipIf(process.platform === "win32")(
  "retains lease identity after release fails and releases it on retry",
  async () => {
    const f = await fixture();
    const actual = await vi.importActual<
      typeof import("../process/OwnedLease.js")
    >("../process/OwnedLease.js");
    vi.mocked(acquireOwnedLease).mockImplementationOnce(async (input) => {
      const result = await actual.acquireOwnedLease(input);
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
    await f.owner.admit("original");
    expect(f.owner.hasResources).toBe(false);
    await expect(f.owner.publish(f.packed)).rejects.toThrow(
      "controlled lease release failure",
    );
    // The manifest was committed; only the lease release is outstanding.
    const committed = await readFile(
      join(f.selection.directory, "current.json"),
      "utf8",
    );
    const retained = [...f.owner.cleanupResources];
    expect(retained).toHaveLength(1);
    expect(f.owner.hasResources).toBe(true);
    const peer = new GhidraCheckpoint(f.selection, f.resources);
    owners.push(peer);
    expect((await peer.admit("reader"))?.sha256).toBe(
      f.owner.observation.source?.sha256,
    );
    await f.owner.publish(f.packed);
    expect(f.owner.cleanupResources).toEqual([]);
    expect(f.owner.hasResources).toBe(false);
    expect(
      await readFile(join(f.selection.directory, "current.json"), "utf8"),
    ).toBe(committed);
    const edited = join(f.root, "edited.gzf");
    await writeFile(edited, "edited by the reader");
    await peer.publish(edited);
    expect(peer.observation.state.kind).toBe("retained");
  },
);
const profile = createAnalysisProfile(
  { id: "ghidra", name: "Ghidra", version: "12.1.4" },
  { import_mode: "test" },
);
const target = "1".repeat(64);
async function fixture(
  contents: string | Uint8Array = "controlled packed bytes",
) {
  const root = await createTestTempDirectory("rea-checkpoint-test-");
  const resources = new ArtifactResourceScope();
  const selection = await resolveGhidraCheckpoint(
    root,
    target,
    profile,
    resources,
  );
  const owner = new GhidraCheckpoint(selection, resources);
  owners.push(owner);
  const packed = join(root, "fixture.gzf");
  await writeFile(packed, contents);
  return { root, resources, selection, owner, packed };
}

it.skipIf(process.platform === "win32").each(
  ["manifest", "packed"].flatMap((stage) => [
    { stage, cancel: true, closeFails: false },
    { stage, cancel: true, closeFails: true },
    { stage, cancel: false, closeFails: true },
  ]),
)(
  "preserves $stage cancellation=$cancel and descriptor cleanup=$closeFails",
  async ({ stage, cancel, closeFails }) => {
    const f = await fixture();
    await f.owner.admit("writer");
    await f.owner.publish(f.packed);
    await f.owner.retryCleanup();
    const controller = new AbortController();
    const reason = { caller: "stopped hashing" };
    controls.file = (handle, path) => {
      if (!path.endsWith(stage === "manifest" ? "current.json" : ".gzf"))
        return;
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(
        async (...args: Parameters<typeof handle.read>) => {
          const result = await read(...args);
          if (cancel) controller.abort(reason);
          return result;
        },
      );
      if (closeFails)
        vi.spyOn(handle, "close").mockRejectedValueOnce(
          new Error("controlled checkpoint close failure"),
        );
    };
    try {
      const error = await resolveGhidraCheckpoint(
        f.root,
        target,
        profile,
        f.resources,
        controller.signal,
      ).catch((cause: unknown) => cause);
      if (cancel) {
        expect(error).toBeInstanceOf(AnalysisCancelledError);
        expect((error as AnalysisCancelledError).cause).toBe(reason);
      } else expect(error).toMatchObject({ _tag: "ProviderAdapterError" });
      expect(error).toMatchObject({ cleanupIncomplete: closeFails });
      expect(f.resources.hasPending).toBe(closeFails);
      await f.resources.retryCleanup();
      expect(error).toMatchObject({ cleanupIncomplete: false });
      expect(f.resources.hasPending).toBe(false);
    } finally {
      controls.file = undefined;
      await f.resources.retryCleanup();
    }
  },
);

it("hashes packed checkpoint bytes beyond the first buffer", async () => {
  const bytes = Buffer.concat([
    Buffer.alloc(64 * 1024, 0x61),
    Buffer.from("packed bytes beyond the initial read"),
  ]);
  const { packed, resources } = await fixture(bytes);
  const expected = createHash("sha256").update(bytes).digest("hex");
  await expect(hashGhidraPackedProgram(packed, resources)).resolves.toBe(
    expected,
  );
});

const edit = async (f: { root: string }, name: string) => {
  const path = join(f.root, `${name}.gzf`);
  await writeFile(path, `${name} packed bytes`);
  return path;
};
const peerOf = (f: Awaited<ReturnType<typeof fixture>>) => {
  const peer = new GhidraCheckpoint(f.selection, f.resources);
  owners.push(peer);
  return peer;
};
const programs = async (directory: string) =>
  (await readdir(directory)).filter((name) => name.endsWith(".gzf"));

it.skipIf(process.platform === "win32")(
  "admits concurrent sessions without holding a lease between publications",
  async () => {
    const f = await fixture();
    const other = peerOf(f);
    expect(await f.owner.admit("first")).toBeUndefined();
    expect(await other.admit("second")).toBeUndefined();
    expect(f.owner.hasResources).toBe(false);
    await f.owner.publish(f.packed);
    expect(f.owner.hasResources).toBe(false);
    const third = peerOf(f);
    expect((await third.admit("third"))?.sha256).toBe(
      f.owner.observation.source?.sha256,
    );
  },
);

it.skipIf(process.platform === "win32")(
  "adopts the initial analysis another session published first instead of publishing twice",
  async () => {
    const f = await fixture();
    const other = peerOf(f);
    await f.owner.admit("first");
    await other.admit("second");
    await f.owner.publish(f.packed);
    const manifest = join(f.selection.directory, "current.json");
    const committed = await readFile(manifest, "utf8");
    await other.publish(await edit(f, "second-initial"));
    expect(await readFile(manifest, "utf8")).toBe(committed);
    expect(await programs(f.selection.directory)).toHaveLength(1);
    expect(other.observation).toMatchObject({
      source: f.owner.observation.source,
      state: { kind: "initial-analysis" },
      pending_cleanup: [],
    });
    expect(other.hasResources).toBe(false);
    // The adopter's later edits build on the published generation.
    await other.publish(await edit(f, "second-edited"));
    expect(JSON.parse(await readFile(manifest, "utf8")).source).toEqual(
      other.observation.source,
    );
    expect(other.observation.state.kind).toBe("retained");
  },
);

it.skipIf(process.platform === "win32").each(["restored", "analyzed"] as const)(
  "refuses to save over a generation another session published (%s session)",
  async (start) => {
    const f = await fixture();
    const stale = peerOf(f);
    await f.owner.admit("first");
    if (start === "analyzed") await stale.admit("stale");
    await f.owner.publish(f.packed);
    if (start === "restored") await stale.admit("stale");
    await f.owner.publish(await edit(f, "first-edited"));
    const manifest = join(f.selection.directory, "current.json");
    const committed = await readFile(manifest, "utf8");
    const files = (await readdir(f.selection.directory)).sort();
    const staged = await edit(f, "stale-edited");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refused = await stale.publish(staged).catch((cause) => cause);
      expect(refused).toBeInstanceOf(GhidraCheckpointSupersededError);
      // A session that only analyzed has no edits to lose; it reopens.
      expect(refused).toMatchObject({
        stage: start === "analyzed" ? "restore" : "save",
      });
      expect(refused.message).toMatch(
        start === "analyzed" ? /reopen the target/ : /were not saved/,
      );
      if (start === "analyzed")
        expect(refused.message).not.toMatch(/edits were not saved/);
      expect(await readFile(manifest, "utf8")).toBe(committed);
      expect((await readdir(f.selection.directory)).sort()).toEqual(files);
      expect(stale.hasResources).toBe(false);
    }
    // The refused session did not disturb the winner or a later reader.
    await f.owner.publish(await edit(f, "first-edited-again"));
    const reader = peerOf(f);
    const selection = await resolveGhidraCheckpoint(
      f.root,
      target,
      profile,
      f.resources,
    );
    expect(selection.state).toEqual(f.owner.observation.state);
    await expect(reader.admit("reader")).rejects.toBeInstanceOf(
      GhidraCheckpointSupersededError,
    );
  },
);

/** Fail the next acquired lease's first release, then release normally. */
const failNextLeaseRelease = async () => {
  const leases = await vi.importActual<
    typeof import("../process/OwnedLease.js")
  >("../process/OwnedLease.js");
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
};

it.skipIf(process.platform === "win32")(
  "keeps a refused save typed when releasing its lease also fails",
  async () => {
    const f = await fixture();
    const stale = peerOf(f);
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    await stale.admit("stale");
    await f.owner.publish(await edit(f, "first-edited"));
    const staged = await edit(f, "stale-edited");
    await failNextLeaseRelease();
    const refused = await stale.publish(staged).catch((cause) => cause);
    // The refusal stays the owner's typed outcome, not a wrapped error.
    expect(refused).toBeInstanceOf(GhidraCheckpointSupersededError);
    expect(refused).toMatchObject({ stage: "save" });
    expect(refused.cleanupFailure?.cause).toMatchObject({
      message: "controlled lease release failure",
    });
    expect(stale.hasResources).toBe(true);
    await stale.retryCleanup();
    expect(stale.hasResources).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "stops before publishing when the lease wait is aborted while the lease is being acquired",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    const manifest = join(f.selection.directory, "current.json");
    const committed = await readFile(manifest, "utf8");
    const leases = await vi.importActual<
      typeof import("../process/OwnedLease.js")
    >("../process/OwnedLease.js");
    const forced = new AbortController();
    // The forced stop arrives during the acquisition's own directory work.
    vi.mocked(acquireOwnedLease).mockImplementationOnce(async (input) => {
      forced.abort(new Error("forced stop"));
      return leases.acquireOwnedLease(input);
    });
    await expect(
      f.owner.publish(await edit(f, "edited"), undefined, forced.signal),
    ).rejects.toThrow();
    expect(await readFile(manifest, "utf8")).toBe(committed);
    // The acquired lease was released by the publication's cleanup.
    expect(f.owner.hasResources).toBe(false);
    const peer = peerOf(f);
    expect((await peer.admit("peer"))?.sha256).toBe(
      f.owner.observation.source?.sha256,
    );
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a save when the manifest it restored was removed",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    await rm(join(f.selection.directory, "current.json"));
    await expect(
      f.owner.publish(await edit(f, "edited")),
    ).rejects.toBeInstanceOf(GhidraCheckpointSupersededError);
    await expect(
      access(join(f.selection.directory, "current.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.skipIf(process.platform === "win32")(
  "waits for another session's publication, then saves or reports contention",
  async () => {
    const f = await fixture();
    const other = peerOf(f);
    await f.owner.admit("first");
    await other.admit("second");
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const renaming = new Promise<void>((resolve) => (reached = resolve));
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      reached();
      await held;
      await actual.rename(...args);
    });
    const publishing = f.owner.publish(f.packed);
    await renaming;
    // The peer polls the held lease; cancellation ends its wait.
    const controller = new AbortController();
    const cancelled = other.publish(
      await edit(f, "second-initial"),
      controller.signal,
    );
    await waitFor(() =>
      expect(vi.mocked(acquireOwnedLease).mock.calls.length).toBeGreaterThan(2),
    );
    controller.abort({ caller: "stopped waiting" });
    await expect(cancelled).rejects.toBeInstanceOf(AnalysisCancelledError);
    expect(other.hasResources).toBe(false);
    // A second wait ends when the publication does, and adopts its result.
    const waiting = other.publish(await edit(f, "second-initial-retry"));
    await waitFor(() =>
      expect(vi.mocked(acquireOwnedLease).mock.calls.length).toBeGreaterThan(5),
    );
    release();
    await publishing;
    await waiting;
    expect(other.observation.source).toEqual(f.owner.observation.source);
    expect(await programs(f.selection.directory)).toHaveLength(1);
  },
);

it.skipIf(process.platform === "win32").each([
  {
    kind: "owner_unverified",
    reason: "owner closed without a complete response",
  },
  { kind: "recovery_busy", path: "/tmp/lease.sock.recovery" },
] as const)(
  "keeps waiting when a lease probe races the owner's release ($kind)",
  async (race) => {
    const f = await fixture();
    await f.owner.admit("first");
    const leases = await vi.importActual<
      typeof import("../process/OwnedLease.js")
    >("../process/OwnedLease.js");
    // The owner released while this probe read its identity, or another
    // waiter was recovering the released socket: both end within the wait.
    vi.mocked(acquireOwnedLease).mockImplementationOnce(async (input) => {
      throw input.failure(race);
    });
    await f.owner.publish(f.packed);
    expect(f.owner.observation.state).toEqual({ kind: "initial-analysis" });
    expect(vi.mocked(acquireOwnedLease)).toHaveBeenCalledTimes(2);
    // The same failure still surfaces once the wait is exhausted.
    const session = new GhidraCheckpoint(
      await resolveGhidraCheckpoint(f.root, target, profile, f.resources),
      f.resources,
      { waitMs: 50, source: "setting" },
    );
    owners.push(session);
    await session.admit("second");
    vi.mocked(acquireOwnedLease).mockImplementation(async (input) => {
      throw input.failure(race);
    });
    await expect(
      session.publish(await edit(f, "edited")),
    ).rejects.toMatchObject({
      settings: [
        {
          setting: "REA_GHIDRA_CHECKPOINT_DIR",
          constraint: expect.stringContaining(`lease ${race.kind}`),
        },
      ],
    });
    vi.mocked(acquireOwnedLease).mockImplementation(leases.acquireOwnedLease);
  },
);

it.skipIf(process.platform === "win32")(
  "reports a publication lease held for the whole wait as busy and keeps the checkpoint",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    const committed = await readFile(
      join(f.selection.directory, "current.json"),
      "utf8",
    );
    vi.mocked(acquireOwnedLease).mockResolvedValue({
      acquired: false,
      owner: { runId: "publisher", processId: 4242 },
    });
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValue(60_000);
    const busy = await f.owner
      .publish(await edit(f, "edited"))
      .catch((cause) => cause);
    expect(busy).toBeInstanceOf(GhidraCheckpointBusyError);
    expect(busy).toMatchObject({
      owner: { runId: "publisher", processId: 4242 },
    });
    expect(f.owner.hasResources).toBe(false);
    expect(
      await readFile(join(f.selection.directory, "current.json"), "utf8"),
    ).toBe(committed);
    now.mockRestore();
    const leases = await vi.importActual<
      typeof import("../process/OwnedLease.js")
    >("../process/OwnedLease.js");
    vi.mocked(acquireOwnedLease).mockImplementation(leases.acquireOwnedLease);
    await f.owner.publish(await edit(f, "edited-retry"));
    expect(f.owner.observation.state.kind).toBe("retained");
  },
);

it.skipIf(process.platform === "win32").each([
  // Past the 30 s default, a longer launch value keeps polling.
  // Each probe reads the clock to bound the owner response and again after
  // the refusal. A poll that continues also reads it once the delay returns.
  {
    waitMs: 120_000,
    clock: [0, 0, 60_000, 60_000, 60_000, 119_999, 119_999, 119_999, 120_000],
    attempts: 3,
  },
  // A shorter launch value reports busy where the default would still wait.
  { waitMs: 50, clock: [0, 0, 50], attempts: 1 },
  // Unset: the default bound.
  {
    waitMs: undefined,
    clock: [0, 0, 29_999, 29_999, 29_999, 30_000],
    attempts: 2,
  },
])(
  "holds a held lease for a save wait of $waitMs ms and names that bound when busy",
  async ({ waitMs, clock, attempts }) => {
    const f = await fixture();
    const wait =
      waitMs === undefined
        ? undefined
        : ({ waitMs, source: "setting" } as const);
    const session = new GhidraCheckpoint(f.selection, f.resources, wait);
    owners.push(session);
    await session.admit("waiting");
    vi.mocked(acquireOwnedLease)
      .mockClear()
      .mockResolvedValue({
        acquired: false,
        owner: { runId: "publisher", processId: 4242 },
      });
    // The deadline reads the clock to start, then once to bound each owner
    // probe, once after each refusal, and once when a poll delay returns.
    const now = vi.spyOn(performance, "now");
    for (const reading of clock.slice(0, -1)) now.mockReturnValueOnce(reading);
    now.mockReturnValue(clock.at(-1) ?? 0);
    const busy = await session.publish(f.packed).catch((cause) => cause);
    now.mockRestore();
    expect(busy).toBeInstanceOf(GhidraCheckpointBusyError);
    expect(vi.mocked(acquireOwnedLease)).toHaveBeenCalledTimes(attempts);
    expect(busy.wait).toEqual(wait ?? { waitMs: 30_000, source: "default" });
    expect(busy.message).toContain(
      `REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS is ${String(waitMs ?? 30_000)} ms (source ${waitMs === undefined ? "default" : "launch environment"}; default 30000, floor 50, maximum 600000)`,
    );
    expect(session.hasResources).toBe(false);
  },
);

it.skipIf(process.platform === "win32").each(["manifest", "packed"] as const)(
  "re-reads a checkpoint replaced while a lease-free reader had its %s open",
  async (stage) => {
    const f = await fixture();
    await f.owner.admit("writer");
    await f.owner.publish(f.packed);
    await f.owner.publish(await edit(f, "first-edit"));
    const superseded = f.owner.observation.source!;
    const next = await edit(f, "second-edit");
    let interleaved = false;
    controls.file = (handle, path) => {
      if (
        interleaved ||
        !path.endsWith(stage === "manifest" ? "current.json" : superseded.file)
      )
        return;
      interleaved = true;
      // A whole publication runs between the reader's admission of the
      // superseded file and its first read of it.
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(
        async (...args: Parameters<typeof handle.read>) => {
          await f.owner.publish(next);
          return read(...args);
        },
      );
    };
    const selection = await resolveGhidraCheckpoint(
      f.root,
      target,
      profile,
      f.resources,
    );
    controls.file = undefined;
    expect(interleaved).toBe(true);
    expect(f.owner.observation.source!.file).not.toBe(superseded.file);
    expect(selection.state).toEqual({
      kind: "retained",
      sha256: f.owner.observation.source!.sha256,
    });
    expect(f.resources.hasPending).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "explains a restore whose packed file was superseded after admission",
  async () => {
    const f = await fixture();
    await f.owner.admit("writer");
    await f.owner.publish(f.packed);
    const reader = peerOf(f);
    const restored = await reader.admit("reader");
    expect(await reader.supersededRestore()).toBeUndefined();
    await f.owner.publish(await edit(f, "edited"));
    await expect(access(restored!.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    const superseded = await reader.supersededRestore();
    expect(superseded).toBeInstanceOf(GhidraCheckpointSupersededError);
    expect(superseded).toMatchObject({ stage: "restore" });
  },
);

it.skipIf(process.platform === "win32")(
  "refuses state changed after profile resolution without replacing the current manifest",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    await f.owner.publish(await edit(f, "edited"));
    await f.owner.retryCleanup();
    const stale = peerOf(f);
    const bytes = await readFile(
      join(f.selection.directory, "current.json"),
      "utf8",
    );
    const refused = await stale.admit("stale").catch((cause) => cause);
    expect(refused).toBeInstanceOf(GhidraCheckpointSupersededError);
    expect(refused).toMatchObject({ stage: "restore" });
    await expect(stale.publish(f.packed)).rejects.toThrow(
      /no admitted session/,
    );
    expect(
      await readFile(join(f.selection.directory, "current.json"), "utf8"),
    ).toEqual(bytes);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects an unknown manifest version without rewriting it",
  async () => {
    const f = await fixture();
    await f.owner.admit("initial");
    await f.owner.publish(f.packed);
    await f.owner.retryCleanup();
    const path = join(f.selection.directory, "current.json");
    const record = JSON.parse(await readFile(path, "utf8"));
    const unknown = JSON.stringify({ ...record, version: 1 });
    await writeFile(path, unknown);
    await expect(
      resolveGhidraCheckpoint(f.root, target, profile, f.resources),
    ).rejects.toThrow(/manifest is malformed/);
    expect(await readFile(path, "utf8")).toBe(unknown);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects corruption, malformed manifests, and traversal rather than silently importing fresh",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    await f.owner.retryCleanup();
    const manifestPath = join(f.selection.directory, "current.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(
      join(f.selection.directory, manifest.source.file),
      "corrupt",
    );
    await expect(
      resolveGhidraCheckpoint(f.root, target, profile, f.resources),
    ).rejects.toThrow(/checksum/);
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        source: { ...manifest.source, file: "../../foreign.gzf" },
      }),
    );
    await expect(
      resolveGhidraCheckpoint(f.root, target, profile, f.resources),
    ).rejects.toThrow();
    await writeFile(manifestPath, "{");
    await expect(
      resolveGhidraCheckpoint(f.root, target, profile, f.resources),
    ).rejects.toThrow();
  },
);

it.skipIf(process.platform === "win32")(
  "keeps the prior checkpoint after a failed publication and succeeds on retry",
  async () => {
    const f = await fixture("previous packed bytes");
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    const directory = f.selection.directory;
    const previous = f.owner.observation.source!;
    const previousPath = join(directory, previous.file);
    const manifest = join(directory, "current.json");
    const committed = await readFile(manifest, "utf8");
    const files = (await readdir(directory)).sort();
    vi.mocked(rename).mockRejectedValueOnce(
      new Error("controlled publish failure"),
    );
    const next = join(f.root, "next.gzf");
    await writeFile(next, "new packed bytes");
    await expect(f.owner.publish(next)).rejects.toMatchObject({
      _tag: "ProviderAdapterError",
      diagnostics: { reason: "controlled publish failure" },
    });
    expect(await readFile(manifest, "utf8")).toBe(committed);
    expect(await readFile(previousPath, "utf8")).toBe("previous packed bytes");
    expect((await readdir(directory)).sort()).toEqual(files);

    await f.owner.publish(next);
    const replacement = f.owner.observation.source!;
    expect(JSON.parse(await readFile(manifest, "utf8"))).toMatchObject({
      source: replacement,
    });
    expect(await readFile(join(directory, replacement.file), "utf8")).toBe(
      "new packed bytes",
    );
    await expect(access(previousPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "retains publication and its old-file cleanup when cleanup fails, then retries without saving twice",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    const old = f.owner.observation.source!;
    const next = join(f.root, "next.gzf");
    await writeFile(next, "changed");
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === join(f.selection.directory, old.file))
        throw new Error("controlled cleanup failure");
      await actual.rm(path, options);
    });
    await expect(f.owner.publish(next)).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "controlled cleanup failure",
      }),
    });
    const committed = await readFile(
      join(f.selection.directory, "current.json"),
      "utf8",
    );
    expect(f.owner.hasResources).toBe(true);
    await expect(f.owner.retryCleanup()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "controlled cleanup failure",
      }),
    });
    // The retained file is not a publication: the lease is released, so
    // another session's save does not wait on this cleanup.
    expect(f.owner.cleanupResources).toEqual([
      join(f.selection.directory, old.file),
    ]);
    const peer = new GhidraCheckpoint(
      await resolveGhidraCheckpoint(f.root, target, profile, f.resources),
      f.resources,
      { waitMs: 50, source: "setting" },
    );
    owners.push(peer);
    await peer.admit("peer");
    vi.mocked(acquireOwnedLease).mockClear();
    await peer.publish(await edit(f, "peer-edited"));
    expect(vi.mocked(acquireOwnedLease)).toHaveBeenCalledTimes(1);
    const peerManifest = await readFile(
      join(f.selection.directory, "current.json"),
      "utf8",
    );
    expect(peerManifest).not.toEqual(committed);
    vi.mocked(rm).mockImplementation(actual.rm);
    // The owner's retry finishes its cleanup without saving `next` again.
    await f.owner.publish(next);
    expect(
      await readFile(join(f.selection.directory, "current.json"), "utf8"),
    ).toEqual(peerManifest);
    await f.owner.retryCleanup();
    expect(f.owner.hasResources).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "reports both a failed old-file removal and a failed lease release, keeping both owned",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    await f.owner.publish(f.packed);
    const old = join(f.selection.directory, f.owner.observation.source!.file);
    const next = join(f.root, "next.gzf");
    await writeFile(next, "changed");
    const leases = await vi.importActual<
      typeof import("../process/OwnedLease.js")
    >("../process/OwnedLease.js");
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
    const files =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path === old) throw new Error("controlled removal failure");
      await files.rm(path, options);
    });
    const failure = await f.owner.publish(next).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(ProviderCleanupError);
    const cleanup = failure as ProviderCleanupError;
    expect(cleanup.diagnostics?.reason).toMatch(
      /controlled removal failure.*controlled lease release failure/,
    );
    expect(cleanup.cleanupResources).toContain(old);
    expect(cleanup.cleanupResources).toHaveLength(2);
    expect(f.owner.hasResources).toBe(true);
    vi.mocked(rm).mockImplementation(files.rm);
    await f.owner.retryCleanup();
    expect(f.owner.hasResources).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "preserves a published checkpoint when cancellation is observed after the manifest commit",
  async () => {
    const f = await fixture();
    await f.owner.admit("first");
    const controller = new AbortController();
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rename).mockImplementationOnce(async (...args) => {
      await actual.rename(...args);
      controller.abort("after publication");
    });
    await expect(
      f.owner.publish(f.packed, controller.signal),
    ).rejects.toThrow();
    expect(f.owner.observation.source).not.toBeNull();
    expect(
      (await resolveGhidraCheckpoint(f.root, target, profile, f.resources))
        .state,
    ).toEqual({ kind: "initial-analysis" });
  },
);

it.skipIf(process.platform === "win32")(
  "does not adopt a public checkpoint directory",
  async () => {
    const f = await fixture();
    await mkdir(f.selection.directory, { mode: 0o755 });
    await chmod(f.selection.directory, 0o755);
    await expect(f.owner.admit("first")).rejects.toThrow(/private directory/);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps its lease socket short when checkpoint and inherited temporary paths are long",
  async () => {
    const f = await fixture();
    const selection = await resolveGhidraCheckpoint(
      join(f.root, "long-".repeat(24)),
      target,
      profile,
      f.resources,
    );
    const owner = new GhidraCheckpoint(selection, f.resources);
    owners.push(owner);
    expect(await owner.admit("long-directory")).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "preserves symlink/parent traversal and shares its lease with the physical directory",
  async () => {
    const f = await fixture();
    await mkdir(join(f.root, "physical", "child"), { recursive: true });
    await symlink(join(f.root, "physical", "child"), join(f.root, "link"));
    const selected = `${f.root}/link/../selected`;
    const selection = await resolveGhidraCheckpoint(
      selected,
      target,
      profile,
      f.resources,
    );
    expect(selection.directory.startsWith(selected)).toBe(true);
    const owner = new GhidraCheckpoint(selection, f.resources);
    owners.push(owner);
    await owner.admit("selected");
    await owner.publish(f.packed);
    await access(
      join(f.root, "physical", "selected", selection.key, "current.json"),
    );
    await expect(
      access(join(f.root, "selected", selection.key, "current.json")),
    ).rejects.toThrow();
    const alias = await resolveGhidraCheckpoint(
      join(f.root, "physical", "selected"),
      target,
      profile,
      f.resources,
    );
    const peer = new GhidraCheckpoint(alias, f.resources);
    owners.push(peer);
    expect((await peer.admit("physical"))?.sha256).toBe(
      owner.observation.source?.sha256,
    );
    // Both spellings publish under one lease identity: the physical directory.
    const identities: unknown[] = [];
    const leases = await vi.importActual<
      typeof import("../process/OwnedLease.js")
    >("../process/OwnedLease.js");
    vi.mocked(acquireOwnedLease).mockImplementation((input) => {
      identities.push(input.identity);
      return leases.acquireOwnedLease(input);
    });
    const selectedEdit = join(f.root, "selected-edit.gzf");
    await writeFile(selectedEdit, "selected edit");
    await owner.publish(selectedEdit);
    const physicalEdit = join(f.root, "physical-edit.gzf");
    await writeFile(physicalEdit, "physical edit");
    await expect(peer.publish(physicalEdit)).rejects.toBeInstanceOf(
      GhidraCheckpointSupersededError,
    );
    expect(identities).toHaveLength(2);
    expect(identities[1]).toEqual(identities[0]);
  },
);

/** A peer that accepts the lease socket and never sends its identity. */
const silentLeaseHolder = async (
  directory: string,
  onConnection?: () => void,
): Promise<() => Promise<void>> => {
  const canonical = await realpath(directory);
  const key = sha256Hex(
    JSON.stringify({
      kind: "ghidra-checkpoint-v1",
      directory: canonical,
    }),
  ).slice(0, 32);
  const leaseDirectory = join(
    "/tmp",
    `rea-ghidra-checkpoint-leases-${process.getuid?.() ?? "user"}`,
  );
  await mkdir(leaseDirectory, { recursive: true, mode: 0o700 });
  const socketPath = join(leaseDirectory, `${key}.sock`);
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    socket.resume();
    onConnection?.();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return () =>
    new Promise((resolve) => {
      server.close(() => resolve());
    });
};

/**
 * Record each lease probe's budget and every owner-probe failure reason, so a
 * test can check what bounded the wait instead of timing it.
 */
const recordLeaseProbes = async (): Promise<{
  readonly timeoutsMs: (number | undefined)[];
  readonly reasons: string[];
}> => {
  const leases = await vi.importActual<
    typeof import("../process/OwnedLease.js")
  >("../process/OwnedLease.js");
  const timeoutsMs: (number | undefined)[] = [];
  const reasons: string[] = [];
  vi.mocked(acquireOwnedLease).mockImplementation((input) => {
    timeoutsMs.push(input.probe?.timeoutMs);
    return leases.acquireOwnedLease({
      ...input,
      failure: (reason, cause) => {
        if (reason.kind === "owner_unverified") reasons.push(reason.reason);
        return input.failure(reason, cause);
      },
    });
  });
  return { timeoutsMs, reasons };
};

it.skipIf(process.platform === "win32")(
  "reports a save wait that ends during an unanswered owner probe as busy",
  async () => {
    const f = await fixture();
    const session = new GhidraCheckpoint(f.selection, f.resources, {
      waitMs: 50,
      source: "setting",
    });
    owners.push(session);
    await session.admit("waiter");
    const release = await silentLeaseHolder(f.selection.directory);
    onTestFinished(release);
    const probes = await recordLeaseProbes();
    const busy = await session
      .publish(f.packed)
      .catch((cause: unknown) => cause);
    expect(busy).toBeInstanceOf(GhidraCheckpointBusyError);
    expect(busy).toMatchObject({
      owner: undefined,
      wait: { waitMs: 50, source: "setting" },
    });
    // The probe was given the rest of the wait, not the owner's own
    // response budget, and the wait ended on its timeout.
    expect(probes.timeoutsMs[0]).toBeLessThanOrEqual(50);
    expect(probes.reasons.at(-1)).toBe(LEASE_OWNER_RESPONSE_TIMED_OUT);
  },
);

it.skipIf(process.platform === "win32")(
  "reports a wait-bounded probe timeout as busy even when its timer fires before the deadline reads expired",
  async () => {
    const f = await fixture();
    const session = new GhidraCheckpoint(f.selection, f.resources, {
      waitMs: 50,
      source: "setting",
    });
    owners.push(session);
    await session.admit("waiter");
    // Node timers run on the event loop's cached clock, which lags the
    // deadline's clock under load, so a probe timer can fire while the
    // deadline still has time left. Hold the deadline's clock still so the
    // probe's timeout always arrives with time left on it, then move the
    // clock past the wait before the save's next poll could observe it.
    const base = performance.now();
    let now = base;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.mocked(acquireOwnedLease).mockImplementation((input) => {
      // Due before the save's 50 ms poll timer, so the wait has ended by the
      // time that poll checks it.
      setTimeout(() => {
        now = base + 1000;
      }, 0);
      return Promise.reject(
        input.failure(
          { kind: "owner_unverified", reason: LEASE_OWNER_RESPONSE_TIMED_OUT },
          undefined,
        ),
      );
    });
    const busy = await session
      .publish(f.packed)
      .catch((cause: unknown) => cause);
    expect(busy).toBeInstanceOf(GhidraCheckpointBusyError);
    expect(busy).toMatchObject({
      owner: undefined,
      wait: { waitMs: 50, source: "setting" },
    });
  },
);

it.skipIf(process.platform === "win32")(
  "stops an unanswered owner probe when the save is cancelled",
  async () => {
    const f = await fixture();
    const session = new GhidraCheckpoint(f.selection, f.resources);
    owners.push(session);
    await session.admit("waiter");
    const controller = new AbortController();
    // Cancel once the probe has connected and is waiting for an identity,
    // rather than after a fixed delay.
    const release = await silentLeaseHolder(f.selection.directory, () =>
      controller.abort({ caller: "stop the probe" }),
    );
    onTestFinished(release);
    const probes = await recordLeaseProbes();
    await expect(
      session.publish(f.packed, controller.signal),
    ).rejects.toBeInstanceOf(AnalysisCancelledError);
    // The cancellation stopped the probe itself; it did not run on to the
    // owner's response budget.
    expect(probes.reasons).toEqual([LEASE_OWNER_PROBE_ABORTED]);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a directory-close failure when cancellation arrives during lease acquisition",
  async () => {
    const f = await fixture();
    const session = new GhidraCheckpoint(f.selection, f.resources, {
      waitMs: 50,
      source: "setting",
    });
    owners.push(session);
    await session.admit("waiter");
    const controller = new AbortController();
    vi.mocked(acquireOwnedLease).mockImplementation(async (input) => {
      controller.abort({ caller: "close failed" });
      throw input.failure(
        { kind: "directory_close" },
        new Error("directory handle close failed"),
      );
    });
    const rejected = await session
      .publish(f.packed, controller.signal)
      .catch((cause: unknown) => cause);
    expect(rejected).toMatchObject({
      settings: [
        {
          setting: "REA_GHIDRA_CHECKPOINT_DIR",
          constraint: expect.stringContaining("lease directory_close"),
        },
      ],
      secondaryFailures: [{ cause: { caller: "close failed" } }],
    });
  },
);

it.skipIf(process.platform === "win32")(
  "reports busy when the lease frees only after the save wait",
  async () => {
    const f = await fixture();
    const session = new GhidraCheckpoint(f.selection, f.resources, {
      waitMs: 50,
      source: "setting",
    });
    owners.push(session);
    await session.admit("waiter");
    vi.mocked(acquireOwnedLease).mockImplementation(async () =>
      vi.mocked(acquireOwnedLease).mock.calls.length === 1
        ? {
            acquired: false,
            owner: { runId: "publisher", processId: 7 },
          }
        : {
            acquired: true,
            lease: { release: async () => undefined },
          },
    );
    const now = vi.spyOn(performance, "now");
    now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(40)
      .mockReturnValue(50);
    const busy = await session
      .publish(f.packed)
      .catch((cause: unknown) => cause);
    now.mockRestore();
    expect(busy).toBeInstanceOf(GhidraCheckpointBusyError);
    expect(busy).toMatchObject({
      owner: { runId: "publisher", processId: 7 },
      wait: { waitMs: 50, source: "setting" },
    });
    expect(vi.mocked(acquireOwnedLease)).toHaveBeenCalledTimes(1);
    expect(session.observation.source).toBeNull();
  },
);

it.skipIf(process.platform === "win32")(
  "reports a handoff when the lease frees only after the save wait",
  async () => {
    const f = await fixture();
    const session = new GhidraCheckpoint(f.selection, f.resources, {
      waitMs: 50,
      source: "setting",
    });
    owners.push(session);
    await session.admit("waiter");
    vi.mocked(acquireOwnedLease).mockImplementation(async (input) => {
      if (vi.mocked(acquireOwnedLease).mock.calls.length === 1)
        throw input.failure({
          kind: "owner_unverified",
          reason: "owner closed without a complete response",
        });
      return { acquired: true, lease: { release: async () => undefined } };
    });
    const now = vi.spyOn(performance, "now");
    now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(40)
      .mockReturnValue(50);
    const rejected = await session
      .publish(f.packed)
      .catch((cause: unknown) => cause);
    now.mockRestore();
    expect(rejected).toMatchObject({
      settings: [
        {
          setting: "REA_GHIDRA_CHECKPOINT_DIR",
          constraint: expect.stringContaining("lease owner_unverified"),
        },
      ],
    });
    expect(vi.mocked(acquireOwnedLease)).toHaveBeenCalledTimes(1);
    expect(session.observation.source).toBeNull();
  },
);

it.skipIf(process.platform === "win32")(
  "publishes when the first uncontended acquire finishes after the save wait",
  async () => {
    const f = await fixture();
    const session = new GhidraCheckpoint(f.selection, f.resources, {
      waitMs: 50,
      source: "setting",
    });
    owners.push(session);
    await session.admit("writer");
    vi.mocked(acquireOwnedLease).mockImplementation(async () => ({
      acquired: true,
      lease: { release: async () => undefined },
    }));
    const now = vi.spyOn(performance, "now");
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(50);
    await session.publish(f.packed);
    now.mockRestore();
    expect(session.observation.source).toMatchObject({
      kind: "initial-analysis",
    });
    expect(vi.mocked(acquireOwnedLease)).toHaveBeenCalledTimes(1);
  },
);
