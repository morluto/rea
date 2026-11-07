import { afterEach, expect, it, vi } from "vitest";
import {
  chmod,
  access,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { acquireOwnedLease } from "../process/OwnedLease.js";
import {
  GhidraCheckpoint,
  resolveGhidraCheckpoint,
} from "./GhidraCheckpoint.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

vi.mock("../process/OwnedLease.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../process/OwnedLease.js")>();
  return { ...actual, acquireOwnedLease: vi.fn(actual.acquireOwnedLease) };
});

const roots: string[] = [];
const owners: GhidraCheckpoint[] = [];
afterEach(async () => {
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
  for (const owner of owners.splice(0)) await owner.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
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
    await f.owner.acquire("original");
    const retained = [...f.owner.cleanupResources];
    expect(retained).toHaveLength(1);
    await expect(f.owner.close()).rejects.toThrow(
      "controlled lease release failure",
    );
    expect(f.owner.cleanupResources).toEqual(retained);
    expect(f.owner.hasResources).toBe(true);
    await f.owner.close();
    expect(f.owner.cleanupResources).toEqual([]);
    const peer = new GhidraCheckpoint(f.selection, f.resources);
    owners.push(peer);
    expect(await peer.acquire("replacement")).toBeUndefined();
  },
);
const profile = createAnalysisProfile(
  { id: "ghidra", name: "Ghidra", version: "12.1.4" },
  { import_mode: "test" },
);
const target = "1".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rea-checkpoint-test-"));
  roots.push(root);
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
  await writeFile(packed, "controlled packed bytes");
  return { root, resources, selection, owner, packed };
}

it.skipIf(process.platform === "win32")(
  "publishes a verified state, reopens it, and separates target and analysis identities",
  async () => {
    const f = await fixture();
    expect(f.selection.source).toBeNull();
    expect(await f.owner.acquire("first")).toBeUndefined();
    await f.owner.publish(f.packed);
    await f.owner.close();
    const loaded = await resolveGhidraCheckpoint(
      f.root,
      target,
      profile,
      f.resources,
    );
    expect(loaded.source?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const resumed = new GhidraCheckpoint(loaded, f.resources);
    owners.push(resumed);
    expect(await resumed.acquire("second")).toEqual({
      path: join(loaded.directory, loaded.source!.file),
      sha256: loaded.source!.sha256,
    });
    expect(
      (
        await resolveGhidraCheckpoint(
          f.root,
          "2".repeat(64),
          profile,
          f.resources,
        )
      ).source,
    ).toBeNull();
    expect(
      (
        await resolveGhidraCheckpoint(
          f.root,
          target,
          createAnalysisProfile(profile.provider, { import_mode: "other" }),
          f.resources,
        )
      ).source,
    ).toBeNull();
  },
);

it.skipIf(process.platform === "win32")(
  "refuses a concurrent owner and admits it after the original owner closes",
  async () => {
    const f = await fixture();
    await f.owner.acquire("first");
    const other = new GhidraCheckpoint(f.selection, f.resources);
    owners.push(other);
    await expect(other.acquire("second")).rejects.toThrow(
      /another REA session.*first/,
    );
    await f.owner.close();
    expect(await other.acquire("second")).toBeUndefined();
  },
);

it.skipIf(process.platform === "win32")(
  "refuses state changed after profile resolution without replacing the current manifest",
  async () => {
    const f = await fixture();
    await f.owner.acquire("first");
    await f.owner.publish(f.packed);
    await f.owner.close();
    const stale = new GhidraCheckpoint(f.selection, f.resources);
    owners.push(stale);
    const bytes = await readFile(
      join(f.selection.directory, "current.json"),
      "utf8",
    );
    await expect(stale.acquire("stale")).rejects.toThrow(
      /changed after profile selection/,
    );
    expect(
      await readFile(join(f.selection.directory, "current.json"), "utf8"),
    ).toEqual(bytes);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects corruption, malformed manifests, and traversal rather than silently importing fresh",
  async () => {
    const f = await fixture();
    await f.owner.acquire("first");
    await f.owner.publish(f.packed);
    await f.owner.close();
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
    const f = await fixture();
    await f.owner.acquire("first");
    await f.owner.publish(f.packed);
    const path = join(f.selection.directory, "current.json"),
      before = await readFile(path, "utf8");
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(rename).mockRejectedValueOnce(
      new Error("controlled publish failure"),
    );
    const next = join(f.root, "next.gzf");
    await writeFile(next, "new packed bytes");
    await expect(f.owner.publish(next)).rejects.toThrow(
      "controlled publish failure",
    );
    expect(await readFile(path, "utf8")).toEqual(before);
    vi.mocked(rename).mockImplementation(actual.rename);
    await f.owner.publish(next);
    expect(await readFile(path, "utf8")).not.toEqual(before);
  },
);

it.skipIf(process.platform === "win32")(
  "retains publication and its old-file cleanup when cleanup fails, then retries without saving twice",
  async () => {
    const f = await fixture();
    await f.owner.acquire("first");
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
    await expect(f.owner.close()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "controlled cleanup failure",
      }),
    });
    vi.mocked(rm).mockImplementation(actual.rm);
    await f.owner.publish(next);
    expect(
      await readFile(join(f.selection.directory, "current.json"), "utf8"),
    ).toEqual(committed);
    await f.owner.close();
    expect(f.owner.hasResources).toBe(false);
  },
);

it.skipIf(process.platform === "win32")(
  "preserves a published checkpoint when cancellation is observed after the manifest commit",
  async () => {
    const f = await fixture();
    await f.owner.acquire("first");
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
        .source,
    ).toEqual(f.owner.observation.source);
  },
);

it.skipIf(process.platform === "win32")(
  "does not adopt a public checkpoint directory",
  async () => {
    const f = await fixture();
    await mkdir(f.selection.directory, { mode: 0o755 });
    await chmod(f.selection.directory, 0o755);
    await expect(f.owner.acquire("first")).rejects.toThrow(/private directory/);
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
    expect(await owner.acquire("long-directory")).toBeUndefined();
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
    await owner.acquire("selected");
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
    await expect(peer.acquire("physical")).rejects.toThrow(
      /another REA session/,
    );
    await owner.close();
    expect((await peer.acquire("physical"))?.sha256).toBe(alias.source?.sha256);
  },
);
