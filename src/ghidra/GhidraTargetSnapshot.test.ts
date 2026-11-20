import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it, vi, type MockInstance } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";

import {
  createGhidraTargetSnapshot,
  ghidraCompanionDsymDigest,
} from "./GhidraTargetSnapshot.js";

const controls = vi.hoisted(() => ({
  read: undefined as
    | ((handle: import("node:fs/promises").FileHandle) => void)
    | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      // Hook every companion DWARF member open, source and staged; only the
      // source is chunk-read, so the read spy never affects the staged copy.
      // Match both separators: the fixture joins platform-native paths.
      if (/Contents[\\/]Resources[\\/]DWARF[\\/]/.test(String(args[0])))
        controls.read?.(handle);
      return handle;
    },
  };
});

const fixture = async () => {
  const root = await createTestTempDirectory("rea-ghidra-target-snapshot-");
  const runtime = join(root, "runtime");
  const source = join(root, "source.bin");
  const bytes = Buffer.from("staged ghidra target bytes");
  await writeFile(source, bytes);
  await mkdir(runtime);
  return {
    root,
    runtime,
    source,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const writeCompanionDwarf = async (root: string, bytes: Buffer) => {
  const dwarf = join(
    root,
    "source.bin.dSYM",
    "Contents",
    "Resources",
    "DWARF",
    "source.bin",
  );
  await mkdir(join(root, "source.bin.dSYM", "Contents", "Resources", "DWARF"), {
    recursive: true,
  });
  await writeFile(dwarf, bytes);
  return dwarf;
};

let spies: MockInstance[] = [];
afterEach(() => {
  controls.read = undefined;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

it("stages a sibling dSYM bundle with the DWARF member renamed to the staged binary", async () => {
  const { root, runtime, source, bytes, sha256 } = await fixture();
  const dwarfBytes = Buffer.from("mach-o dwarf companion");
  await writeCompanionDwarf(root, dwarfBytes);
  const snapshot = await createGhidraTargetSnapshot(source, runtime, sha256, {
    platform: "linux",
  });
  expect(Buffer.compare(await readFile(snapshot.path), bytes)).toBe(0);

  const expectedDwarf = join(
    `${snapshot.path}.dSYM`,
    "Contents",
    "Resources",
    "DWARF",
    "target-" + sha256.slice(0, 12) + ".bin",
  );
  expect(Buffer.compare(await readFile(expectedDwarf), dwarfBytes)).toBe(0);
});

it("keeps the snapshot unchanged when no sibling dSYM exists", async () => {
  const { runtime, source, bytes, sha256 } = await fixture();
  const snapshot = await createGhidraTargetSnapshot(source, runtime, sha256, {
    platform: "linux",
  });
  expect(Buffer.compare(await readFile(snapshot.path), bytes)).toBe(0);
  await expect(stat(`${snapshot.path}.dSYM`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("skips and cleans up when the sibling dSYM has an unexpected layout", async () => {
  const { root, runtime, source, sha256 } = await fixture();
  await mkdir(join(root, "source.bin.dSYM", "Contents", "Resources"), {
    recursive: true,
  });
  const snapshot = await createGhidraTargetSnapshot(source, runtime, sha256, {
    platform: "linux",
  });
  expect(snapshot.sha256).toBe(sha256);
  await expect(stat(`${snapshot.path}.dSYM`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("still skips silently when the staged companion bundle itself cannot be created", async () => {
  const { root, runtime, source, sha256 } = await fixture();
  await writeCompanionDwarf(root, Buffer.from("mach-o dwarf companion"));
  // An unexpected regular file at the staged bundle path makes the DWARF
  // member directory creation fail; the companion must stay optional.
  await writeFile(
    join(runtime, `target-${sha256.slice(0, 12)}.bin.dSYM`),
    "not a bundle",
  );
  const snapshot = await createGhidraTargetSnapshot(source, runtime, sha256, {
    platform: "linux",
  });
  expect(snapshot.sha256).toBe(sha256);
  await expect(
    stat(join(runtime, `target-${sha256.slice(0, 12)}.bin.dSYM`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("drops the partial companion and keeps the snapshot when the source changes mid-copy", async () => {
  const { root, runtime, source, sha256 } = await fixture();
  const dwarfBytes = Buffer.alloc(4 * 1024 * 1024, 0x64);
  const dwarf = await writeCompanionDwarf(root, dwarfBytes);
  let reads = 0;
  controls.read = (handle) => {
    const read = handle.read.bind(handle);
    spies.push(
      vi
        .spyOn(handle, "read")
        .mockImplementation(async (...args: Parameters<typeof read>) => {
          const result = await read(...args);
          if (++reads === 1)
            await writeFile(
              dwarf,
              Buffer.concat([dwarfBytes, Buffer.from("!")]),
            );
          return result;
        }),
    );
  };
  const snapshot = await createGhidraTargetSnapshot(source, runtime, sha256, {
    platform: "linux",
  });
  expect(snapshot.sha256).toBe(sha256);
  await expect(
    stat(join(runtime, `target-${sha256.slice(0, 12)}.bin.dSYM`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("propagates cancellation during the companion copy instead of skipping it", async () => {
  const { root, runtime, source, sha256 } = await fixture();
  const dwarfBytes = Buffer.alloc(4 * 1024 * 1024, 0x64);
  await writeCompanionDwarf(root, dwarfBytes);
  const controller = new AbortController();
  const reason = { caller: "stopped companion copy" };
  let reads = 0;
  controls.read = (handle) => {
    const read = handle.read.bind(handle);
    spies.push(
      vi
        .spyOn(handle, "read")
        .mockImplementation(async (...args: Parameters<typeof read>) => {
          const result = await read(...args);
          if (++reads === 2) controller.abort(reason);
          return result;
        }),
    );
  };
  const resources = new ArtifactResourceScope();
  try {
    await expect(
      createGhidraTargetSnapshot(source, runtime, sha256, {
        platform: "linux",
        signal: controller.signal,
        resourceScope: resources,
      }),
    ).rejects.toMatchObject({ reason: "cancelled" });
    await expect(
      stat(join(runtime, `target-${sha256.slice(0, 12)}.bin.dSYM`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await resources.retryCleanup();
  }
});

it("propagates cancellation while committing the companion dSYM digest", async () => {
  const { root, source } = await fixture();
  await writeCompanionDwarf(root, Buffer.from("mach-o dwarf companion"));
  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));

  await expect(
    ghidraCompanionDsymDigest(
      source,
      new ArtifactResourceScope(),
      controller.signal,
    ),
  ).rejects.toMatchObject({ reason: "cancelled" });
});
