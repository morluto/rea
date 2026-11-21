import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { PrivateRuntimeRootUnavailableError } from "../../../src/domain/privateRuntimeRootUnavailableError.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { SourceMapDecoder } from "../../../src/javascript/sourceMaps/SourceMapDecoder.js";
import type { SourceMapDecoderDependencies } from "../../../src/javascript/sourceMaps/SourceMapCommand.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { assertProcessOwnershipInspectionActive } from "../../../src/process/ProcessInspectionCancellation.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";
import {
  webSourceLocationArgs,
  webSourceLocationFixture,
} from "../../fixtures/webSourceLocation.js";

const expectedProcessMemoryLimitBytes =
  process.platform === "win32" && process.versions.bun !== undefined
    ? 704 * 1024 * 1024
    : null;

const realDecoder = (dependencies: SourceMapDecoderDependencies = {}) =>
  new SourceMapDecoder({
    ...dependencies,
    launcher:
      dependencies.launcher ??
      ((options) =>
        spawnOwnedProviderProcess({
          ...options,
          arguments: options.arguments.map((argument) =>
            argument.endsWith("/SourceMapCodecProcess.js") ||
            argument.endsWith("\\SourceMapCodecProcess.js")
              ? fileURLToPath(
                  new URL(
                    "../../../dist/javascript/sourceMaps/SourceMapCodecProcess.js",
                    import.meta.url,
                  ),
                )
              : argument,
          ),
        })),
  });

const fixture = webSourceLocationFixture();
const input = {
  text: fixture.sourceMap.text,
  url: fixture.sourceMap.url,
  path: fixture.sourceMap.file.path,
  position: webSourceLocationArgs.generated_position,
};

it.each([
  { name: "null", reason: null },
  {
    name: "an opaque cleanup error",
    reason: new ProviderCleanupError("caller", ["caller-owned-resource"], {}),
  },
])(
  "preserves cancellation during ownership preparation with $name",
  async ({ reason }) => {
    const controller = new AbortController();
    const createRuntime = vi.fn(async () => {
      throw new Error("Cancelled preparation must not acquire a runtime");
    });
    const launcher = vi.fn(async () => {
      throw new Error("Cancelled preparation must not launch a codec");
    });
    const decoder = realDecoder({
      prepareOwnership: async (signal) => {
        controller.abort(reason);
        assertProcessOwnershipInspectionActive(signal);
      },
      createRuntime,
      launcher,
    });
    const result = await decoder.trace(input, { signal: controller.signal });
    if (result.ok) throw new Error("Expected preparation cancellation");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCancelledError",
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(result.error.cause).toBe(reason);
    await decoder.close();
    if (reason instanceof ProviderCleanupError) {
      expect(reason.cleanupIncomplete).toBe(true);
      expect(reason.cleanupResources).toEqual(["caller-owned-resource"]);
    }
    expect(createRuntime).not.toHaveBeenCalled();
    expect(launcher).not.toHaveBeenCalled();
  },
);

it("retains diagnostics for an unknown ownership preparation failure", async () => {
  const cause = new Error("unexpected ownership failure");
  const createRuntime = vi.fn(async () => {
    throw new Error("Failed preparation must not acquire a runtime");
  });
  const decoder = realDecoder({
    prepareOwnership: async () => {
      throw cause;
    },
    createRuntime,
  });
  const result = await decoder.trace(input);
  if (result.ok) throw new Error("Expected preparation failure");
  expect(result.error).toMatchObject({
    _tag: "ProviderAdapterError",
    cleanupIncomplete: false,
    diagnostics: {
      map_path: input.path,
      error_message: cause.message,
      phase: "process_ownership_preparation",
    },
  });
  expect(result.error.cause).toBe(cause);
  expect(createRuntime).not.toHaveBeenCalled();
});

it.each([
  { retryable: true, category: "unavailable" },
  { retryable: false, category: "unsupported_provider" },
])(
  "preserves private-runtime rejection as $category",
  async ({ retryable, category }) => {
    const reason = "Native runtime self-test failed with a sharing violation";
    const launcher = vi.fn(async () => {
      throw new Error("A refused runtime must not launch a codec");
    });
    const decoder = realDecoder({
      prepareOwnership: async () => {},
      createRuntime: async () => {
        throw new PrivateRuntimeRootUnavailableError(reason, { retryable });
      },
      launcher,
    });
    const result = await decoder.trace(input);
    if (result.ok) throw new Error("Expected runtime refusal");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      category,
      retryable,
      details: {
        provider_id: "source-map-decoder",
        operation: "trace_web_source_location",
        reason,
      },
    });
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(launcher).not.toHaveBeenCalled();
  },
);

it.each([
  { name: "default", selected: undefined, expectedMs: 20_000 },
  { name: "selected", selected: 250, expectedMs: 250 },
])(
  "starts the $name codec deadline after ownership preparation",
  async ({ selected, expectedMs }) => {
    const deadlineStates: (boolean | undefined)[] = [];
    let path: string | undefined;
    const decoder = realDecoder({
      prepareOwnership: async () => {
        await vi.advanceTimersByTimeAsync(20_001);
      },
      createRuntime: async () => {
        const root = await PrivateRuntimeRoot.create();
        path = root.path;
        return root;
      },
      launcher: async ({ signal }) => {
        await vi.advanceTimersByTimeAsync(expectedMs - 1);
        deadlineStates.push(signal?.aborted);
        await vi.advanceTimersByTimeAsync(1);
        deadlineStates.push(signal?.aborted);
        assertProcessOwnershipInspectionActive(signal);
        throw new Error(
          "Expected the codec deadline to interrupt the launcher",
        );
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const response = await decoder.trace({
        ...input,
        ...(selected === undefined ? {} : { decodeTimeoutMs: selected }),
      });
      expect(deadlineStates).toEqual([false, true]);
      if (response.ok) throw new Error("Expected decode deadline");
      expect(response.error).toMatchObject({
        _tag: "AnalysisTimeoutError",
        timeoutMs: expectedMs,
        userMessage: expect.stringContaining("decode_timeout_ms"),
        secondaryFailures: [],
      });
      if (path === undefined) throw new Error("Runtime not acquired");
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.useRealTimers();
      await decoder.close();
    }
  },
);

it.each([
  { heap: undefined, effectiveHeap: 192 },
  { heap: 384, effectiveHeap: 384 },
])(
  "runs the real pinned codec with selected heap $heap and removes its private request directory",
  async ({ heap, effectiveHeap }) => {
    let path: string | undefined;
    const environment = {
      ...process.env,
      NODE_OPTIONS: "--require=/rea-file-that-does-not-exist",
    };
    const decoder = realDecoder({
      environment,
      createRuntime: async () => {
        const root = await PrivateRuntimeRoot.create();
        path = root.path;
        return root;
      },
    });
    const response = await decoder.trace({
      ...input,
      ...(heap === undefined ? {} : { limits: { codec_heap_mib: heap } }),
    });
    if (!response.ok) throw response.error;
    expect(response.value).toMatchObject({
      engine: { id: "jridgewell-trace-mapping", version: "0.3.31" },
      source_map_sha256: fixture.sourceMap.file.sha256,
      url_context: input.url,
      lookup: { requested: input.position },
      matches: [{ state: "mapped", content: { text: "original" } }],
    });
    if (process.versions.bun === undefined) {
      expect(response.value.runtime).toMatchObject({
        id: "node-v8",
        version: process.version,
      });
      expect(response.value.runtime.v8_heap_limit_bytes).toBeGreaterThan(
        (effectiveHeap - 1) * 1024 * 1024,
      );
      expect(response.value.runtime.v8_heap_limit_bytes).toBeLessThanOrEqual(
        (effectiveHeap + 64) * 1024 * 1024,
      );
    } else
      expect(response.value.runtime).toEqual({
        id: "bun",
        version: process.versions.bun,
        node_compatibility_version: process.versions.node,
        v8_heap_limit_bytes: null,
        // Windows enforces a Job Object commit limit in place of the heap flags.
        process_memory_limit_bytes:
          process.platform === "win32"
            ? (effectiveHeap + 512) * 1024 * 1024
            : null,
      });
    expect(environment.NODE_OPTIONS).toBe(
      "--require=/rea-file-that-does-not-exist",
    );
    if (path === undefined) throw new Error("runtime not acquired");
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([
  { cancel: true, denyCleanup: false },
  { cancel: false, denyCleanup: true },
  { cancel: true, denyCleanup: true },
])(
  "retains completed real-codec matches through finalization (cancel=$cancel, denied=$denyCleanup)",
  async ({ cancel, denyCleanup }) => {
    const controller = new AbortController();
    const reason = { phase: "source-map root finalization" };
    let path: string | undefined;
    let denyNextClose = denyCleanup;
    const decoder = realDecoder({
      createRuntime: async () => {
        const root = await PrivateRuntimeRoot.create();
        path = root.path;
        return {
          path: root.path,
          close: async () => {
            if (cancel) controller.abort(reason);
            if (denyNextClose) {
              denyNextClose = false;
              throw new Error("controlled source-map cleanup denial");
            }
            await root.close();
          },
        };
      },
    });
    try {
      const response = await decoder.trace(input, {
        signal: controller.signal,
      });
      if (response.ok) throw new Error("Expected interrupted finalization");
      const { error } = response;
      const report = error.partialObservation;
      expect(report).toMatchObject({
        source_map_sha256: fixture.sourceMap.file.sha256,
        url_context: input.url,
        lookup: { requested: input.position },
        matches: [{ state: "mapped", content: { text: "original" } }],
      });
      expect(error).toMatchObject({ operation: "trace_web_source_location" });
      expect(projectAnalysisError(error)).toMatchObject({
        details: { partial_observation: report },
      });
      if (cancel) {
        const primary = error.cleanupPrimary ?? error;
        expect(primary._tag).toBe("AnalysisCancelledError");
        expect(primary.cause).toBe(reason);
      }
      if (path === undefined) throw new Error("runtime not acquired");
      expect(error.cleanupIncomplete).toBe(denyCleanup);
      if (denyCleanup) {
        expect(error.cleanupResources).toEqual([path]);
        await expect(access(path)).resolves.toBeUndefined();
        await decoder.close();
        expect(error.cleanupIncomplete).toBe(false);
        expect(error.cleanupResources).toEqual([]);
        expect(error.partialObservation).toEqual(report);
      }
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await decoder.close();
    }
  },
);

it.each([false, true])(
  "keeps the completed codec refusal primary over late cancellation (denied=%s)",
  async (denyCleanup) => {
    const controller = new AbortController();
    const reason = new Error("cancel after codec refusal");
    let path: string | undefined;
    let denyNextClose = denyCleanup;
    const decoder = realDecoder({
      createRuntime: async () => {
        const root = await PrivateRuntimeRoot.create();
        path = root.path;
        return {
          path: root.path,
          close: async () => {
            controller.abort(reason);
            if (denyNextClose) {
              denyNextClose = false;
              throw new Error("controlled refusal cleanup denial");
            }
            await root.close();
          },
        };
      },
    });
    try {
      const response = await decoder.trace(
        { ...input, text: "{" },
        { signal: controller.signal },
      );
      if (response.ok) throw new Error("Expected malformed-map refusal");
      const { error } = response;
      const primary = error.cleanupPrimary ?? error;
      expect(primary).toMatchObject({
        _tag: "AnalysisInputError",
        operation: "trace_web_source_location",
        issues: [{ reason: "invalid_format" }],
      });
      const cancellation = primary.secondaryFailures.find(
        ({ _tag }) => _tag === "AnalysisCancelledError",
      );
      expect(cancellation?.cause).toBe(reason);
      expect(error.partialObservation).toBeUndefined();
      if (path === undefined) throw new Error("runtime not acquired");
      expect(error.cleanupIncomplete).toBe(denyCleanup);
      if (denyCleanup) {
        expect(error.cleanupResources).toEqual([path]);
        await expect(access(path)).resolves.toBeUndefined();
        await decoder.close();
        expect(error.cleanupIncomplete).toBe(false);
        expect(error.cleanupResources).toEqual([]);
      }
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await decoder.close();
    }
  },
);

it.each([
  {
    failure: "external section",
    text: JSON.stringify({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          url: "https://app.test/external.map",
        },
      ],
    }),
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      reason: "unsupported_source_map_profile",
      userMessage: expect.stringContaining("https://app.test/external.map"),
    },
  },
  {
    failure: "malformed embedded map before row admission",
    text: JSON.stringify({
      version: 3,
      sections: [
        {
          offset: { line: 1000000000, column: 0 },
          map: { version: "3", sections: [] },
        },
      ],
    }),
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          reason: "invalid_format",
          message: expect.stringContaining("not a version 3 map"),
        },
      ],
    },
  },
  {
    failure: "indexed row limit",
    text: JSON.stringify({
      version: 3,
      sections: [
        {
          offset: { line: 1000000000, column: 0 },
          map: JSON.parse(fixture.sourceMap.text) as unknown,
        },
      ],
    }),
    error: {
      _tag: "ArtifactOperationError",
      reason: "limit",
      detail: expect.stringContaining("generated-row decoder budget"),
    },
  },
  {
    failure: "invalid section list with regular-map fields",
    text: JSON.stringify({
      version: 3,
      sections: null,
      sources: ["ignored.ts"],
      mappings: "AAAA",
    }),
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          reason: "invalid_format",
          message: expect.stringContaining("sections"),
        },
      ],
    },
  },
  {
    failure: "overlapping indexed mappings",
    text: JSON.stringify({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: { version: 3, sources: ["a.js"], mappings: "AAAA,EAAA" },
        },
        {
          offset: { line: 0, column: 1 },
          map: { version: 3, sources: ["b.js"], mappings: "AAAA" },
        },
      ],
    }),
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          reason: "invalid_format",
          message: expect.stringContaining("overlap"),
        },
      ],
    },
  },
])("preserves actual producer failures: $failure", async ({ text, error }) => {
  const response = await realDecoder().trace({ ...input, text });
  if (response.ok) throw new Error("expected failed map");
  expect(response.error).toMatchObject({
    operation: "trace_web_source_location",
    ...error,
  });
});

it("cancels a real owned process and removes the runtime request", async () => {
  const reason = { caller: "cancel active codec" };
  const controller = new AbortController();
  let path: string | undefined;
  const response = await realDecoder({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create();
      path = root.path;
      return root;
    },
    launcher: async (options) => {
      const child = await spawnOwnedProviderProcess({
        ...options,
        arguments: [
          "-e",
          'process.stdout.write("ready\\n"); setInterval(() => undefined, 1000)',
        ],
      });
      await waitForProviderProcessReady(child.process);
      setImmediate(() => controller.abort(reason));
      return child;
    },
  }).trace(input, { signal: controller.signal });
  if (response.ok) throw new Error("expected cancellation");
  expect(response.error._tag).toBe("AnalysisCancelledError");
  expect(response.error.cause).toBe(reason);
  if (path === undefined) throw new Error("runtime not acquired");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});
it("returns all point matches when they fit and reports output exhaustion otherwise", async () => {
  const embedded = "a".repeat(1_800);
  const text = `\uFEFF)]}'transport prefix\r${JSON.stringify({
    version: 3,
    sources: ["original.ts"],
    sourcesContent: [embedded],
    names: [],
    mappings: "AAAA,AAAC,AAAC,AAAC",
  })}`;
  const trace = (outputBytes: number) =>
    realDecoder().trace({
      ...input,
      text,
      limits: { output_bytes: outputBytes },
    });

  const complete = await trace(14_000);
  if (!complete.ok) throw complete.error;
  expect(complete.value.source_map_sha256).toBe(
    createHash("sha256").update(text).digest("hex"),
  );
  expect(complete.value.matches).toMatchObject(
    [0, 1, 2, 3].map((column) => ({
      reported_source: "original.ts",
      original_position: { line: 1, column },
      content: { state: "embedded", text: embedded },
    })),
  );

  const budget = 5_500;
  expect(Buffer.byteLength(JSON.stringify(complete.value))).toBeGreaterThan(
    budget,
  );
  const limited = await trace(budget);
  if (limited.ok) throw new Error("expected complete-evidence budget failure");
  expect(limited.error).toMatchObject({
    _tag: "ArtifactOperationError",
    reason: "limit",
    detail: expect.stringContaining("source_map_limits.output_bytes is 5500"),
  });
  expect(limited.error.partialObservation).toBeUndefined();
});
it("rejects a malformed actual subprocess reply", async () => {
  const response = await realDecoder({
    launcher: (options) =>
      spawnOwnedProviderProcess({
        ...options,
        arguments: ["-e", 'process.stdout.write("not JSON")'],
      }),
  }).trace(input);
  if (response.ok) throw new Error("expected malformed reply");
  expect(response.error._tag).toBe("AnalysisOutputError");
  expect(response.error.partialObservation).toBeUndefined();
});
it("rejects a codec report from a runtime other than the launching one", async () => {
  const actual = await realDecoder().trace(input);
  if (!actual.ok) throw actual.error;
  const replay = (report: unknown) =>
    realDecoder({
      launcher: (options) =>
        spawnOwnedProviderProcess({
          ...options,
          arguments: [
            "-e",
            `process.stdout.write(${JSON.stringify(JSON.stringify({ state: "success", report }))})`,
          ],
        }),
    }).trace(input);
  const unchanged = await replay(actual.value);
  if (!unchanged.ok) throw unchanged.error;
  expect(unchanged.value).toEqual(actual.value);
  const response = await replay({
    ...actual.value,
    runtime:
      actual.value.runtime.id === "bun"
        ? { id: "node-v8", version: "v24.18.0", v8_heap_limit_bytes: 1 }
        : {
            id: "bun",
            version: "1.4.2",
            node_compatibility_version: "24.18.0",
            v8_heap_limit_bytes: null,
            process_memory_limit_bytes: null,
          },
  });
  if (response.ok) throw new Error("expected runtime mismatch");
  expect(response.error._tag).toBe("AnalysisOutputError");
  expect(response.error.partialObservation).toBeUndefined();
  if (actual.value.runtime.id !== "bun") return;
  // A Bun codec must report exactly the process limit its launcher enforced.
  const limit = await replay({
    ...actual.value,
    runtime: {
      ...actual.value.runtime,
      process_memory_limit_bytes:
        expectedProcessMemoryLimitBytes === null ? 4096 : null,
    },
  });
  if (limit.ok) throw new Error("expected process limit mismatch");
  expect(limit.error.message).toContain("process memory limit");
});
it.each([true, false])(
  "classifies a codec exit by the job memory notification (reached: %s)",
  async (reached) => {
    const response = await realDecoder({
      launcher: async ({ memoryLimitBytes, ...options }) => {
        expect(memoryLimitBytes).toBe(
          expectedProcessMemoryLimitBytes ?? undefined,
        );
        // Without a job limit any artifact runs the child; its handle reports
        // the notification an owned Windows job records before exit.
        const spawned = await spawnOwnedProviderProcess({
          ...options,
          arguments: [
            "-e",
            'process.stderr.write("panic: out of memory"); process.exit(3)',
          ],
        });
        let exited = false;
        spawned.process.once("exit", () => {
          exited = true;
        });
        Object.defineProperty(spawned.process, "memoryLimitReached", {
          get: () => reached && exited,
        });
        return spawned;
      },
    }).trace(input);
    if (response.ok) throw new Error("expected codec failure");
    expect(response.error).toMatchObject(
      reached
        ? {
            _tag: "AnalysisResourceConstraintError",
            resource: "memory",
            reason: expect.stringContaining("process memory limit"),
            reportedLimits: {
              codec_process_memory_limit_bytes: expectedProcessMemoryLimitBytes,
            },
            capturedOutput: { stderr: "panic: out of memory" },
          }
        : { diagnostics: { exit_code: 3, stderr: "panic: out of memory" } },
    );
  },
);
it("removes the private request when launching the codec fails", async () => {
  let path: string | undefined;
  const response = await realDecoder({
    createRuntime: async () => {
      const root = await PrivateRuntimeRoot.create();
      path = root.path;
      return root;
    },
    launcher: () => Promise.reject(new Error("observed launch failure")),
  }).trace(input);
  if (response.ok) throw new Error("expected launch failure");
  expect(response.error).toMatchObject({
    diagnostics: { error_message: "observed launch failure" },
  });
  if (path === undefined) throw new Error("runtime not acquired");
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
});
