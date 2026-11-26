import { fileURLToPath } from "node:url";
import { buffer, text } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { collectEntries } from "../../fixtures/artifactEntries.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { createTestTempFile } from "../../fixtures/temporaryDirectory.js";
import { buildUnityFs } from "../../fixtures/unityfs.js";
import { spawnFailure } from "../../support/process/spawnFailure.js";
import { UnityFsArtifactReader } from "../../../src/artifacts/UnityFsArtifactReader.js";
import { decodeUnityFsBlock } from "../../../src/artifacts/UnityFsStructures.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import * as providerProcess from "../../../src/process/ProviderProcess.js";
import { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";
import {
  LzmaFrameReader,
  type LzmaFrameReadOptions,
} from "../../../src/providers/LzmaProtocol.js";
import {
  ArtifactResourceScope,
  translateArtifactFailure,
} from "../../../src/resources/index.js";

const workerModulePath = fileURLToPath(
  new URL("../../../dist/providers/LzmaWorker.js", import.meta.url),
);
// Independently produced Python/liblzma FORMAT_RAW, LZMA1, 4 KiB dictionary.
const raw = Buffer.from("5d0010000000309888a44a8e9ffff6638000", "hex");
const openReader = async (bytes: Buffer) =>
  new UnityFsArtifactReader(
    await createTestTempFile("rea-unity-lzma-", "bundle", bytes),
    undefined,
    workerModulePath,
  );
const withReader = async (
  bytes: Buffer,
  use: (reader: UnityFsArtifactReader) => Promise<void>,
) => {
  const reader = await openReader(bytes);
  try {
    await use(reader);
  } finally {
    await reader.close();
  }
};

// One normal host frame read follows the request header and payload writes.
// Hook only the host-side response read, not the separately executed worker.
const isUnityFsWorker = (supervisor: ProviderProcessSupervisor): boolean =>
  supervisor.launch.ownsProcessLifetime &&
  supervisor.launch.ownership?.runId.startsWith("rea-unityfs-lzma-") === true;

const cancelOnReply = (controller: AbortController, reason: Error) => {
  const nativeRead = LzmaFrameReader.prototype.readExact;
  return vi
    .spyOn(LzmaFrameReader.prototype, "readExact")
    .mockImplementation(function (
      this: LzmaFrameReader,
      length: number,
      options?: LzmaFrameReadOptions,
    ) {
      if (length === 8 && options?.signal === controller.signal)
        controller.abort(reason);
      return Reflect.apply(nativeRead, this, [length, options]);
    } as typeof nativeRead);
};

describe("UnityFS through the shared LZMA subprocess", () => {
  it.each([6, 7, 8])(
    "reads all members from format %s, including concurrent streams",
    async (formatVersion) => {
      const members = [
        { path: "serialized", data: "bytes" },
        { path: "resource", data: "resource bytes" },
        { path: "empty", data: "" },
      ];
      await withReader(
        buildUnityFs(members, { blockCompression: 1, formatVersion }),
        async (reader) => {
          const entries = await collectEntries(reader);
          expect(entries.map(({ path }) => path)).toEqual(
            members.map(({ path }) => path),
          );
          expect(reader.formatMetadata()).toMatchObject({
            format_version: formatVersion,
            directory_status: "available",
          });
          expect(
            await Promise.all(
              entries.map(async (entry) => text(await reader.open(entry))),
            ),
          ).toEqual(members.map(({ data }) => data));
        },
      );
    },
  );

  it("reads independently generated raw LZMA across block boundaries", async () => {
    await withReader(
      buildUnityFs([{ path: "payload", data: "abcabc" }], {
        blockCompression: 1,
        blockSize: 3,
        encodeBlock: () => raw,
      }),
      async (reader) => {
        const [entry] = await collectEntries(reader);
        expect(await text(await reader.open(entry!))).toBe("abcabc");
      },
    );
  });

  it("refuses malformed framing, oversized dictionaries and unadmitted output", async () => {
    const resources = new ArtifactResourceScope();
    const context = { resources, workerModulePath };
    const invalid = Buffer.from(raw);
    invalid[0] = 255;
    const corrupt = Buffer.from(raw);
    corrupt[6] = 255; // Keep the header valid and corrupt the range coder state.
    const oversized = Buffer.from(raw);
    oversized.writeUInt32LE(128 * 1024 * 1024, 1);
    try {
      await expect(
        decodeUnityFsBlock(1, invalid, 3, context),
      ).rejects.toMatchObject({ reason: "malformed" });
      await expect(
        decodeUnityFsBlock(1, corrupt, 3, context),
      ).rejects.toMatchObject({ reason: "malformed" });
      await expect(
        decodeUnityFsBlock(1, oversized, 3, context),
      ).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
        parserLimit: {
          name: "dictionary_bytes",
          maximum: 64 * 1024 * 1024,
          required: 128 * 1024 * 1024,
        },
      });
      await expect(
        decodeUnityFsBlock(1, raw, 64 * 1024 * 1024 + 1, context),
      ).rejects.toMatchObject({
        reason: "limit",
        boundary: "memory",
        parserLimit: {
          name: "output_bytes",
          maximum: 64 * 1024 * 1024,
          required: 64 * 1024 * 1024 + 1,
        },
      });
      await expect(
        decodeUnityFsBlock(1, raw.subarray(0, 10), 3, context),
      ).rejects.toMatchObject({ reason: "malformed" });
      await expect(
        decodeUnityFsBlock(4, raw, 3, context),
      ).rejects.toMatchObject({ reason: "unavailable" });
    } finally {
      await resources.close();
    }
  });

  it("cancels an outstanding worker request and permits a subsequent decode", async () => {
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = new Error("cancel after request writes");
    const reply = cancelOnReply(controller, reason);
    const context = { resources, workerModulePath };
    try {
      await expect(
        decodeUnityFsBlock(1, raw, 3, {
          ...context,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        reason: "cancelled",
        cancellation: { reason },
      });
      expect(reply).toHaveBeenCalled();
      expect(resources.hasPending).toBe(false);
      expect(
        (await decodeUnityFsBlock(1, raw, 3, context)).equals(
          Buffer.from("abc"),
        ),
      ).toBe(true);
    } finally {
      reply.mockRestore();
      await resources.close();
    }
  });
});

describe("UnityFS supervised subprocess cleanup", () => {
  it("retains a launch constraint through late cancellation and an owned cleanup retry", async () => {
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const launch = vi
      .spyOn(providerProcess, "spawnOwnedProviderProcess")
      .mockRejectedValueOnce(spawnFailure("EAGAIN", process.execPath));
    const close = vi.spyOn(PrivateRuntimeRoot.prototype, "close");
    close.mockImplementationOnce(async () => {
      controller.abort(new Error("cancel during cleanup"));
      throw new Error("controlled worker root cleanup refusal");
    });
    try {
      const cause = await decodeUnityFsBlock(1, raw, 3, {
        resources,
        workerModulePath,
        signal: controller.signal,
      }).then(
        () => {
          throw new Error("Expected worker launch to fail");
        },
        (cause: unknown) => cause,
      );
      const translated = translateArtifactFailure(
        "extract_artifact",
        "/bundle",
        cause,
      );
      expect(launch).toHaveBeenCalledOnce();
      const [root] = close.mock.contexts;
      if (!(root instanceof PrivateRuntimeRoot))
        throw new Error("Expected cleanup of the worker's runtime root");
      expect(resources.hasPending).toBe(true);
      expect(projectAnalysisError(translated)).toMatchObject({
        code: "cleanup_incomplete",
        category: "resource_constraint",
        details: {
          operation: "extract_artifact",
          execution_failure: "resource_constraint",
          resource: "capacity",
          resources: [root.path],
          diagnostics: { system_code: "EAGAIN" },
        },
      });
      await resources.retryCleanup();
      expect(close.mock.contexts).toEqual([root, root]);
      expect(resources.hasPending).toBe(false);
      expect(projectAnalysisError(translated)).toMatchObject({
        code: "resource_constraint",
        retryable: true,
        details: { operation: "extract_artifact", resource: "capacity" },
      });
    } finally {
      launch.mockRestore();
      close.mockRestore();
      await resources.close();
    }
  });

  it("keeps a caller's timeout-shaped abort reason opaque during worker startup", async () => {
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = new AnalysisTimeoutError("caller", 123);
    const create = PrivateRuntimeRoot.create;
    const root = vi
      .spyOn(PrivateRuntimeRoot, "create")
      .mockImplementationOnce(async (options) => {
        const created = await create(options);
        controller.abort(reason);
        return created;
      });
    try {
      const cause = await decodeUnityFsBlock(1, raw, 3, {
        resources,
        workerModulePath,
        signal: controller.signal,
      }).then(
        () => {
          throw new Error("Expected worker startup to cancel");
        },
        (cause: unknown) => cause,
      );
      const translated = translateArtifactFailure(
        "inspect_artifact",
        "/bundle",
        cause,
      );
      expect(translated.cause).toBe(reason);
      expect(projectAnalysisError(translated)).toMatchObject({
        code: "cancelled",
        details: { operation: "inspect_artifact" },
      });
      expect(resources.hasPending).toBe(false);
    } finally {
      root.mockRestore();
      await resources.close();
    }
  });

  it.each(["cancelled", "malformed"] as const)(
    "preserves %s and retries the same supervisor after failed cleanup",
    async (primary) => {
      const resources = new ArtifactResourceScope();
      const controller = new AbortController();
      const reason = new Error("cancel after request writes");
      const reply =
        primary === "cancelled" ? cancelOnReply(controller, reason) : undefined;
      const nativeStop = ProviderProcessSupervisor.prototype.stop;
      const stops: ProviderProcessSupervisor[] = [];
      const stop = vi
        .spyOn(ProviderProcessSupervisor.prototype, "stop")
        .mockImplementation(function (
          this: ProviderProcessSupervisor,
          options,
        ) {
          if (!isUnityFsWorker(this)) return nativeStop.call(this, options);
          stops.push(this);
          if (stops.length <= 2)
            return Promise.resolve({
              status: "incomplete",
              reason: "controlled worker cleanup refusal",
            });
          return nativeStop.call(this, options);
        });
      const context = { resources, workerModulePath };
      try {
        const input = primary === "malformed" ? raw.subarray(0, 10) : raw;
        await expect(
          decodeUnityFsBlock(1, input, 3, {
            ...context,
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({
          reason: primary,
          ...(primary === "cancelled" ? { cancellation: { reason } } : {}),
          cleanup: {
            reason: expect.stringContaining(
              "controlled worker cleanup refusal",
            ),
            resources: expect.arrayContaining([
              expect.stringMatching(/^rea-unityfs-lzma-/u),
              expect.stringMatching(/^pid:/u),
            ]),
          },
          cleanupLeases: [
            expect.objectContaining({ release: expect.any(Function) }),
          ],
        });
        expect(resources.hasPending).toBe(true);
        expect(stops).toHaveLength(1);
        await expect(resources.retryCleanup()).rejects.toMatchObject({
          reason: "unavailable",
          cleanup: {
            reason: expect.stringContaining(
              "controlled worker cleanup refusal",
            ),
          },
        });
        expect(resources.hasPending).toBe(true);
        expect(stops[1]).toBe(stops[0]);
        await resources.retryCleanup();
        expect(stops[2]).toBe(stops[0]);
        expect(resources.hasPending).toBe(false);
        expect(
          (await decodeUnityFsBlock(1, raw, 3, context)).equals(
            Buffer.from("abc"),
          ),
        ).toBe(true);
      } finally {
        try {
          await resources.close();
        } finally {
          stop.mockRestore();
          reply?.mockRestore();
        }
      }
    },
  );

  it("preserves cancellation arriving during a successful decode's failed cleanup", async () => {
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    const reason = new Error("cancel during worker shutdown");
    const nativeStop = ProviderProcessSupervisor.prototype.stop;
    let owner: ProviderProcessSupervisor | undefined;
    const stop = vi
      .spyOn(ProviderProcessSupervisor.prototype, "stop")
      .mockImplementation(function (this: ProviderProcessSupervisor, options) {
        if (isUnityFsWorker(this) && owner === undefined) {
          owner = this;
          controller.abort(reason);
          return Promise.resolve({
            status: "incomplete",
            reason: "controlled stop refusal",
          });
        }
        return nativeStop.call(this, options);
      });
    try {
      await expect(
        decodeUnityFsBlock(1, raw, 3, {
          resources,
          workerModulePath,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        reason: "cancelled",
        cancellation: { reason },
        cleanup: { reason: expect.stringContaining("controlled stop refusal") },
      });
      expect(resources.hasPending).toBe(true);
      await resources.retryCleanup();
      expect(resources.hasPending).toBe(false);
    } finally {
      try {
        await resources.close();
      } finally {
        stop.mockRestore();
      }
    }
  });

  it("retains the failed supervisor through reader-level cleanup and retries close", async () => {
    const reader = await openReader(
      buildUnityFs([{ path: "x", data: "abc" }], {
        blockCompression: 1,
        encodeBlock: () => raw.subarray(0, 10),
      }),
    );
    const nativeStop = ProviderProcessSupervisor.prototype.stop;
    const stops: ProviderProcessSupervisor[] = [];
    const stop = vi
      .spyOn(ProviderProcessSupervisor.prototype, "stop")
      .mockImplementation(function (this: ProviderProcessSupervisor, options) {
        if (!isUnityFsWorker(this)) return nativeStop.call(this, options);
        stops.push(this);
        if (stops.length <= 2)
          return Promise.resolve({
            status: "incomplete",
            reason: "controlled reader stop refusal",
          });
        return nativeStop.call(this, options);
      });
    try {
      const [entry] = await collectEntries(reader);
      const stream = await reader.open(entry!);
      await expect(buffer(stream)).rejects.toMatchObject({
        reason: "malformed",
        cleanup: {
          reason: expect.stringContaining("controlled reader stop refusal"),
        },
      });
      await expect(reader.close()).rejects.toMatchObject({
        reason: "unavailable",
        cleanup: {
          reason: expect.stringContaining("controlled reader stop refusal"),
        },
      });
      await reader.close();
      expect(stops).toHaveLength(3);
      expect(stops[1]).toBe(stops[0]);
      expect(stops[2]).toBe(stops[0]);
    } finally {
      try {
        await reader.close();
      } finally {
        stop.mockRestore();
      }
    }
  });

  it("joins a supervised LZMA stop before reader close completes", async () => {
    const reader = await openReader(
      buildUnityFs([{ path: "x", data: "abc" }], { blockCompression: 1 }),
    );
    const reached = createDeferred<void>();
    const release = createDeferred<void>();
    const nativeStop = ProviderProcessSupervisor.prototype.stop;
    const stop = vi
      .spyOn(ProviderProcessSupervisor.prototype, "stop")
      .mockImplementation(async function (
        this: ProviderProcessSupervisor,
        options,
      ) {
        if (!isUnityFsWorker(this)) return nativeStop.call(this, options);
        reached.resolve();
        await release.promise;
        return nativeStop.call(this, options);
      });
    let consumed: Promise<Buffer> | undefined;
    try {
      const [entry] = await collectEntries(reader);
      const stream = await reader.open(entry!);
      consumed = buffer(stream);
      void consumed.catch(() => undefined);
      await awaitAcknowledgement(
        reached.promise,
        consumed,
        "LZMA subprocess cleanup",
      );
      let closed = false;
      const closing = reader.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect(stream.closed).toBe(true);
    } finally {
      release.resolve();
      try {
        await reader.close();
        await consumed?.catch(() => undefined);
      } finally {
        stop.mockRestore();
      }
    }
  });
});

it("retains a framed output refusal when its worker shutdown fails", async () => {
  const resources = new ArtifactResourceScope();
  const controller = new AbortController();
  const nativeRead = LzmaFrameReader.prototype.readExact;
  const reply = vi
    .spyOn(LzmaFrameReader.prototype, "readExact")
    .mockImplementation(function (
      this: LzmaFrameReader,
      length: number,
      options?: LzmaFrameReadOptions,
    ) {
      if (length === 8 && options?.signal === controller.signal) {
        const header = Buffer.alloc(8);
        header.writeUInt32BE(1, 0);
        header.writeUInt32BE(4, 4);
        return Promise.resolve(header);
      }
      return Reflect.apply(nativeRead, this, [length, options]);
    } as typeof nativeRead);
  const nativeStop = ProviderProcessSupervisor.prototype.stop;
  let denied = true;
  const stop = vi
    .spyOn(ProviderProcessSupervisor.prototype, "stop")
    .mockImplementation(function (this: ProviderProcessSupervisor, options) {
      if (isUnityFsWorker(this) && denied)
        return Promise.resolve({
          status: "incomplete",
          reason: "controlled frame cleanup refusal",
        });
      return nativeStop.call(this, options);
    });
  try {
    await expect(
      decodeUnityFsBlock(1, raw, 3, {
        resources,
        workerModulePath,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      reason: "limit",
      boundary: "memory",
      parserLimit: { name: "output_bytes", maximum: 3, required: 4 },
      cleanup: {
        reason: expect.stringContaining("controlled frame cleanup refusal"),
      },
      cleanupLeases: [
        expect.objectContaining({ release: expect.any(Function) }),
      ],
    });
    expect(resources.hasPending).toBe(true);
    denied = false;
    reply.mockRestore();
    await resources.retryCleanup();
    expect(resources.hasPending).toBe(false);
    expect(
      (
        await decodeUnityFsBlock(1, raw, 3, { resources, workerModulePath })
      ).equals(Buffer.from("abc")),
    ).toBe(true);
  } finally {
    denied = false;
    reply.mockRestore();
    try {
      await resources.close();
    } finally {
      stop.mockRestore();
    }
  }
});
