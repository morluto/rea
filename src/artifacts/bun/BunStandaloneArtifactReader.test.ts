import { open, writeFile, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import * as artifactPaths from "../ArtifactPaths.js";
import { BunStandaloneArtifactReader } from "../BunStandaloneArtifactReader.js";
import { ArtifactReaderFailure } from "../ArtifactReader.js";
import { inventoryArtifact } from "../inventory/ArtifactInventory.js";
import { ArtifactResourceScope } from "../ArtifactResourceScope.js";
import { resolveArtifactReaderLimits } from "../../domain/artifactReaderLimits.js";
import {
  bunModuleGraphPayload,
  bunPrefixedPayload,
  elfBunSection,
  elfPrefix,
  elfAppendedBunPayload,
} from "./BunStandalone.fixture.js";

it("keeps duplicate and unsafe names distinct while extracting exact bytes", async () => {
  const path = join(await createTestTempDirectory("rea-bun-reader-"), "app");
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [
          { name: "/$bunfs/a.js", contents: Buffer.from("first") },
          { name: "/$bunfs/a.js", contents: Buffer.from("second") },
          { name: "../../escape", contents: Buffer.from("third") },
        ],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  try {
    const entries = await collect(reader.entries());
    expect(entries.map((entry) => entry.path)).toEqual([
      "$bunfs/a.js",
      "$bunfs/a.js",
      "bun-modules/2",
    ]);
    expect(new Set(entries.map((entry) => entry.adapterKey)).size).toBe(3);
    for (const [index, entry] of entries.entries())
      expect((await buffer(await reader.open(entry))).toString()).toBe(
        ["first", "second", "third"][index],
      );
    const entry = entries[0]!;
    await expect(
      reader.open({ ...entry, byteOffset: 0 }),
    ).rejects.toMatchObject({ reason: "integrity" });
    const controller = new AbortController();
    controller.abort();
    await expect(reader.open(entry, controller.signal)).rejects.toMatchObject({
      reason: "cancelled",
    });
    await writeFile(path, "changed");
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
  await expect(collect(reader.entries())).rejects.toMatchObject({
    reason: "unavailable",
  });
});

it("retires buffered member bytes when cancellation arrives after production", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-abort-buffered-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ name: "main.js", contents: Buffer.from("buffered") }],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  try {
    const [entry] = await collect(reader.entries());
    if (entry === undefined) throw new Error("Expected one Bun member");
    const controller = new AbortController();
    const stream = await reader.open(entry, controller.signal);
    await vi.waitFor(() =>
      expect(stream.readableLength).toBe(Buffer.byteLength("buffered")),
    );
    const reason = { stop: "discard buffered member" };
    controller.abort(reason);
    await vi.waitFor(() => expect(stream.destroyed).toBe(true));
    expect(stream.errored).toBeInstanceOf(ArtifactReaderFailure);
    expect(stream.errored).toMatchObject({ reason: "cancelled" });
    expect(stream.errored?.cause).toBe(reason);
    expect(stream.readableEnded).toBe(false);
  } finally {
    await reader.close();
  }
});

it("keeps exhausted Bun recognition distinct from a native ELF inventory and recovers the same carrier", async () => {
  const path = join(await createTestTempDirectory("rea-bun-inventory-"), "app");
  const bytes = elfBunSection(
    bunPrefixedPayload(
      bunModuleGraphPayload({
        modules: [{ name: "main.js", contents: Buffer.from("retained") }],
      }),
    ),
  );
  await writeFile(path, bytes);
  const rootSha256 = createHash("sha256").update(bytes).digest("hex");
  const scan = async (recognitionTableBytes: number) => {
    const scope = new ArtifactResourceScope();
    try {
      return await inventoryArtifact(path, {
        resourceScope: scope,
        readerLimits: resolveArtifactReaderLimits({
          bun: { recognition_table_bytes: recognitionTableBytes },
        }),
      });
    } finally {
      await scope.close();
    }
  };
  const limited = await scan(191);
  expect(limited.manifest).toMatchObject({
    root_format: "elf",
    root_sha256: rootSha256,
    occurrence_count: 1,
  });
  expect(limited.limitations).toContainEqual(
    expect.stringContaining("Bun graph recognition remains unknown:"),
  );
  expect(limited.limitations).toContainEqual(
    expect.stringContaining(
      "artifact_limits.bun.recognition_table_bytes (191 bytes); requires 192 bytes",
    ),
  );
  const recovered = await scan(192);
  expect(recovered.manifest).toMatchObject({
    root_format: "bun-standalone",
    root_sha256: rootSha256,
    occurrence_count: 2,
  });
  expect(recovered.occurrences.map((entry) => entry.logical_path)).toContain(
    "main.js",
  );
  expect((await scan(191)).limitations).toEqual(limited.limitations);

  const nativeElf = elfPrefix();
  await writeFile(path, nativeElf);
  const ordinary = await scan(1);
  expect(ordinary.manifest).toMatchObject({
    root_format: "elf",
    root_sha256: createHash("sha256").update(nativeElf).digest("hex"),
    occurrence_count: 1,
  });
});

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

it("allows an uncancelled inventory after a cancelled graph preparation", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-cancel-retry-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ name: "/$bunfs/a.js", contents: Buffer.from("source") }],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const reason = { stop: "first inventory" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const original = prototype.read;
  let stopped = false;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof original>
  ) {
    const result = await original.apply(this, args);
    if (!stopped) {
      stopped = true;
      controller.abort(reason);
    }
    return result;
  });
  try {
    await expect(
      collect(reader.entries(controller.signal)),
    ).rejects.toMatchObject({ reason: "cancelled" });
    spy.mockRestore();
    const entries = await collect(reader.entries());
    expect(entries.map((entry) => entry.path)).toEqual(["$bunfs/a.js"]);
    expect((await buffer(await reader.open(entries[0]!))).toString()).toBe(
      "source",
    );
  } finally {
    spy.mockRestore();
    await observed.close();
    await reader.close();
  }
});

it("keeps another caller's in-flight inventory independent of cancelled preparation", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-concurrent-cancel-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ name: "/$bunfs/a.js", contents: Buffer.from("source") }],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const reason = { stop: "first inventory" };
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const original = prototype.read;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let firstRead = true;
  const spy = vi.spyOn(prototype, "read").mockImplementation(async function (
    this: FileHandle,
    ...args: Parameters<typeof original>
  ) {
    const result = await original.apply(this, args);
    if (firstRead) {
      firstRead = false;
      entered();
      await gate;
    }
    return result;
  });
  try {
    const first = collect(reader.entries(controller.signal));
    const rejected = first.then(
      () => {
        throw new Error("Expected cancellation");
      },
      (cause: unknown) => cause,
    );
    await started;
    const second = collect(reader.entries());
    controller.abort(reason);
    resume();
    expect(await rejected).toMatchObject({
      reason: "cancelled",
      cause: reason,
    });
    expect((await second).map((entry) => entry.path)).toEqual(["$bunfs/a.js"]);
  } finally {
    resume();
    spy.mockRestore();
    await observed.close();
    await reader.close();
  }
});

it("keeps an independent physical read failure when its caller also aborts", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-physical-failure-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [{ name: "/$bunfs/a.js", contents: Buffer.from("source") }],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const failure = Object.assign(new Error("physical graph read failed"), {
    code: "EIO",
  });
  const observed = await open(path, "r");
  const prototype = Object.getPrototypeOf(observed) as FileHandle;
  const spy = vi.spyOn(prototype, "read").mockImplementationOnce(async () => {
    controller.abort(failure);
    throw failure;
  });
  try {
    await expect(collect(reader.entries(controller.signal))).rejects.toBe(
      failure,
    );
    spy.mockRestore();
    expect(
      (await collect(reader.entries())).map((entry) => entry.path),
    ).toEqual(["$bunfs/a.js"]);
  } finally {
    spy.mockRestore();
    await observed.close();
    await reader.close();
  }
});

it("does not publish partially built entries when preparation is cancelled", async () => {
  const path = join(
    await createTestTempDirectory("rea-bun-partial-build-"),
    "app",
  );
  await writeFile(
    path,
    elfAppendedBunPayload(
      bunModuleGraphPayload({
        modules: [
          { name: "/$bunfs/a.js", contents: Buffer.from("a") },
          { name: "/$bunfs/b.js", contents: Buffer.from("b") },
          { name: "/$bunfs/c.js", contents: Buffer.from("c") },
        ],
      }),
    ),
  );
  const reader = new BunStandaloneArtifactReader(path);
  const control = new BunStandaloneArtifactReader(path);
  const controller = new AbortController();
  const reason = { stop: "during inventory construction" };
  const normalize = artifactPaths.normalizeArtifactPath;
  const expected = await collect(control.entries());
  const spy = vi
    .spyOn(artifactPaths, "normalizeArtifactPath")
    .mockImplementation((name) => {
      if (name === "$bunfs/b.js") controller.abort(reason);
      return normalize(name);
    });
  try {
    await expect(
      collect(reader.entries(controller.signal)),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    spy.mockRestore();
    await expect(reader.open(expected[0]!)).rejects.toMatchObject({
      reason: "integrity",
    });
    expect(
      (await collect(reader.entries())).map((entry) => entry.path),
    ).toEqual(["$bunfs/a.js", "$bunfs/b.js", "$bunfs/c.js"]);
  } finally {
    spy.mockRestore();
    await reader.close();
    await control.close();
  }
});
