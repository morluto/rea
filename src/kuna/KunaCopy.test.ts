import { KunaProjectCache } from "./KunaProjectCache.js";
import type { KunaInstallation } from "./KunaInstallation.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { readFile, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { copyAndHash, kunaCopyFailureFacts } from "./KunaCommand.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";

vi.mock("node:fs/promises", { spy: true });

const copyGate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((acknowledge) => {
    resolve = acknowledge;
  });
  return { promise, resolve };
};

it.each([null, { caller: "active input copy" }])(
  "attributes cancellation after an actual copied chunk to its file owner (%j)",
  async (reason) => {
    const root = await createTestTempDirectory("rea-kuna-copy-cancel-");
    const source = join(root, "source");
    await writeFile(source, Buffer.alloc(3 * 65536 + 7, 0x61));
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const controller = new AbortController();
    let acknowledge!: () => void;
    const entered = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const copying = copyAndHash(source, join(root, "destination"), {
      signal: controller.signal,
      resources,
      keep: {
        probeBytes: 32,
        length: () => {
          acknowledge();
          return 32;
        },
      },
    });
    const result = copying.catch((cause: unknown) => cause);
    await awaitAcknowledgement(entered, result, "actual input prefix");
    controller.abort(reason);
    const failure = await result;
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({ reason: "cancelled" });
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("Missing typed file-copy cancellation");
    expect(failure.cancellation?.reason).toBe(reason);
  },
);

it.each([0, 12, 3 * 65536 + 7])(
  "copies exact bytes, digest and retained prefix (%i bytes)",
  async (length) => {
    const root = await createTestTempDirectory("rea-kuna-copy-facts-");
    const input = Buffer.from(
      Array.from({ length }, (_, index) => index % 251),
    );
    const source = join(root, "source");
    const destination = join(root, "destination");
    await writeFile(source, input);
    const resources = new ArtifactResourceScope();
    onTestFinished(() => resources.close());
    const copied = await copyAndHash(source, destination, {
      signal: new AbortController().signal,
      resources,
      keep: { probeBytes: 32, length: () => 65536 + 19 },
    });
    expect((await readFile(destination)).equals(input)).toBe(true);
    expect(copied.bytes).toBe(input.length);
    expect(copied.sha256).toBe(
      createHash("sha256").update(input).digest("hex"),
    );
    expect(copied.prefix.equals(input.subarray(0, 65536 + 19))).toBe(true);
    expect(resources.hasPending).toBe(false);
  },
);

it.each(["read", "write"] as const)(
  "joins pending native %s before cancellation and descriptor close",
  async (stage) => {
    const root = await createTestTempDirectory("rea-kuna-copy-join-");
    const source = join(root, "source");
    const destination = join(root, "destination");
    await writeFile(source, Buffer.alloc(100, 0x61));
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const entered = copyGate();
    const release = copyGate();
    const handles: FileHandle[] = [];
    const native =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await native.open(...args);
      handles.push(file);
      const selected =
        stage === "read" ? args[0] === source : args[0] === destination;
      if (selected) {
        const original = file[stage];
        vi.spyOn(file, stage).mockImplementationOnce(
          async (...ioArgs: unknown[]) => {
            entered.resolve();
            await release.promise;
            return Reflect.apply(original, file, ioArgs);
          },
        );
      }
      return file;
    });
    onTestFinished(async () => {
      release.resolve();
      vi.restoreAllMocks();
      await resources.close();
      for (const handle of handles) await handle.close();
    });
    let settled = false;
    const result = copyAndHash(source, destination, {
      signal: controller.signal,
      resources,
    })
      .catch((cause: unknown) => cause)
      .finally(() => {
        settled = true;
      });
    await awaitAcknowledgement(entered.promise, result, `native ${stage}`);
    const reason = { stage };
    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(handles.every(({ fd }) => fd >= 0)).toBe(true);
    release.resolve();
    const failure = await result;
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("Missing file failure");
    expect(failure.reason).toBe("cancelled");
    expect(failure.cancellation?.reason).toBe(reason);
    expect(handles.every(({ fd }) => fd < 0)).toBe(true);
  },
);

it.each(["read", "write"] as const)(
  "preserves physical %s failure even when it is the caller abort reason",
  async (stage) => {
    const root = await createTestTempDirectory("rea-kuna-copy-physical-");
    const source = join(root, "source");
    const destination = join(root, "destination");
    await writeFile(source, Buffer.alloc(100, 0x61));
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const physical = Object.assign(new Error("physical I/O rejection"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    const native =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const file = await native.open(...args);
      if (
        (stage === "read" && args[0] === source) ||
        (stage === "write" && args[0] === destination)
      )
        vi.spyOn(file, stage).mockImplementationOnce(async () => {
          controller.abort(physical);
          throw physical;
        });
      return file;
    });
    onTestFinished(async () => {
      vi.restoreAllMocks();
      await resources.close();
    });
    const failure: unknown = await copyAndHash(source, destination, {
      signal: controller.signal,
      resources,
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure))
      throw new Error("Missing file failure");
    expect(failure.reason).toBe("io");
    expect(failure.cause).toBe(physical);
    expect(failure.cancellation).toBeUndefined();
  },
);

it("retains both failed descriptor owners until their exact successful retries", async () => {
  const root = await createTestTempDirectory("rea-kuna-copy-close-");
  const source = join(root, "source");
  const destination = join(root, "destination");
  await writeFile(source, "owned bytes");
  const resources = new ArtifactResourceScope();
  const owners = new Set<OwnedFileHandle>();
  const failing = new Set<OwnedFileHandle>();
  const original = OwnedFileHandle.prototype.close;
  vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
    this: OwnedFileHandle,
  ) {
    if (!owners.has(this)) {
      owners.add(this);
      failing.add(this);
    }
    return failing.has(this)
      ? Promise.reject(new Error("controlled close rejection"))
      : original.call(this);
  });
  onTestFinished(async () => {
    failing.clear();
    await resources.close();
    vi.restoreAllMocks();
  });
  const failure: unknown = await copyAndHash(source, destination, {
    signal: new AbortController().signal,
    resources,
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
  if (!(failure instanceof ArtifactFileCleanupFailure))
    throw new Error("Missing owned cleanup failure");
  expect(owners.size).toBe(2);
  expect(failure.cleanupLeases).toHaveLength(2);
  expect(new Set(resources.cleanupResources)).toEqual(
    new Set([source, destination]),
  );
  const projected = new ProviderCleanupError(
    "kuna",
    [source, destination],
    { reason: "copy descriptors" },
    { cause: failure, operation: "kuna:workspace" },
  );
  bindArtifactFileCleanup(failure, projected);
  expect(projected.cleanupIncomplete).toBe(true);
  const first = [...owners][0];
  if (first === undefined) throw new Error("Missing first owner");
  failing.delete(first);
  await expect(resources.close()).rejects.toBeInstanceOf(ArtifactReaderFailure);
  expect(projected.cleanupIncomplete).toBe(true);
  expect(projected.cleanupResources).toHaveLength(1);
  expect(first.handle.fd).toBe(-1);
  failing.clear();
  await resources.close();
  expect(projected.cleanupIncomplete).toBe(false);
  expect(projected.cleanupResources).toEqual([]);
  expect(resources.hasPending).toBe(false);
  expect([...owners].every(({ handle }) => handle.fd < 0)).toBe(true);
});

it("keeps staging until both copy descriptors close, then retires the exact workspace", async () => {
  const root = await createTestTempDirectory("rea-kuna-copy-staging-");
  const targetPath = join(root, "source");
  await writeFile(targetPath, "owned input");
  const cacheRoot = join(root, "cache");
  const installation: KunaInstallation = {
    executable: join(root, "never-launched"),
    version: "0.1",
    verified: false,
    sha256: "0".repeat(64),
    bytes: 0,
    script: false,
    configuration: {
      command: join(root, "never-launched"),
      cacheRoot,
      cacheMaxBytes: 1024 * 1024,
      jobs: 1,
      projectTimeoutMs: 1000,
      projectTimeoutSource: "default",
      functionTimeoutMs: 1000,
      functionTimeoutSource: "default",
    },
  };
  const cache = new KunaProjectCache(cacheRoot, { maxBytes: 1024 * 1024 });
  const failing = new Set<OwnedFileHandle>();
  const owners = new Set<OwnedFileHandle>();
  const original = OwnedFileHandle.prototype.close;
  vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(function (
    this: OwnedFileHandle,
  ) {
    if (!owners.has(this)) {
      owners.add(this);
      failing.add(this);
    }
    return failing.has(this)
      ? Promise.reject(new Error("held copy descriptor"))
      : original.call(this);
  });
  onTestFinished(async () => {
    failing.clear();
    await cache.close();
    vi.restoreAllMocks();
  });
  const built = await cache.build({
    installation,
    targetPath,
    targetSha256: createHash("sha256").update("owned input").digest("hex"),
  });
  if (built.ok)
    throw new Error(
      "Expected copy descriptor cleanup failure before any engine call",
    );
  expect(built.error.cleanupIncomplete).toBe(true);
  expect(owners.size).toBe(2);
  expect(await fs.readdir(join(cacheRoot, "staging"))).toHaveLength(1);
  expect(await fs.readdir(join(cacheRoot, "trash"))).toEqual([]);
  const closed = await cache.close();
  expect(closed.ok).toBe(false);
  expect(await fs.readdir(join(cacheRoot, "staging"))).toHaveLength(1);
  const first = [...owners][0];
  if (first === undefined) throw new Error("Missing copy descriptor");
  failing.delete(first);
  expect((await cache.close()).ok).toBe(false);
  expect(await fs.readdir(join(cacheRoot, "staging"))).toHaveLength(1);
  failing.clear();
  const retries = await Promise.all([cache.close(), cache.close()]);
  expect(retries.every(({ ok }) => ok)).toBe(true);
  expect(await fs.readdir(join(cacheRoot, "staging"))).toEqual([]);
  expect(await fs.readdir(join(cacheRoot, "trash"))).toEqual([]);
  expect(built.error.cleanupIncomplete).toBe(false);
  if (closed.ok) throw new Error("Missing retained cache cleanup report");
  expect(closed.error.cleanupIncomplete).toBe(false);
  expect([...owners].every(({ handle }) => handle.fd < 0)).toBe(true);
});

it.each([false, true])(
  "preserves completed copy facts when final close observes abort (refuse=%j)",
  async (refuse) => {
    const root = await createTestTempDirectory("rea-kuna-copy-final-close-");
    const source = join(root, "source");
    const destination = join(root, "destination");
    const input = Buffer.from("complete physical copy");
    await writeFile(source, input);
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const entered = copyGate();
    const release = copyGate();
    const original = OwnedFileHandle.prototype.close;
    let first = true;
    let rejectClose = refuse;
    vi.spyOn(OwnedFileHandle.prototype, "close").mockImplementation(
      async function (this: OwnedFileHandle) {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        if (rejectClose) throw new Error("final descriptor close refused");
        await original.call(this);
      },
    );
    onTestFinished(async () => {
      release.resolve();
      rejectClose = false;
      await resources.close();
      vi.restoreAllMocks();
    });
    const result = copyAndHash(source, destination, {
      signal: controller.signal,
      resources,
      keep: { probeBytes: 1, length: () => 8 },
    }).catch((cause: unknown) => cause);
    await awaitAcknowledgement(
      entered.promise,
      result,
      "final copy descriptor close",
    );
    expect((await readFile(destination)).equals(input)).toBe(true);
    const reason = { phase: "final copy close" };
    controller.abort(reason);
    release.resolve();
    const failure = await result;
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    const { completion } = kunaCopyFailureFacts(failure);
    expect(completion?.cancellation?.reason).toBe(reason);
    expect(completion?.value).toMatchObject({
      sha256: createHash("sha256").update(input).digest("hex"),
      bytes: input.length,
    });
    const value = completion?.value;
    if (
      value === null ||
      typeof value !== "object" ||
      !("prefix" in value) ||
      !Buffer.isBuffer(value.prefix)
    )
      throw new Error("Missing completed copy prefix");
    expect(value.prefix.equals(input.subarray(0, 8))).toBe(true);
    if (refuse) {
      expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
      if (!(failure instanceof ArtifactFileCleanupFailure))
        throw new Error("Missing FD cleanup");
      expect(failure.cleanupLeases).toHaveLength(2);
      expect(resources.hasPending).toBe(true);
    } else expect(resources.hasPending).toBe(false);
  },
);
