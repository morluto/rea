import { createHash } from "node:crypto";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const publicationCancellation = vi.hoisted(() => ({
  controller: undefined as AbortController | undefined,
  directorySyncs: 0,
  commitController: undefined as AbortController | undefined,
  commitParent: undefined as string | undefined,
  failPublishedClose: false,
  publishedCloseAttempts: 0,
  cleanupController: undefined as AbortController | undefined,
  cleanupRoot: undefined as string | undefined,
  physicalFailure: undefined as Error | undefined,
  failRootCleanup: false,
  reportCleanup: false,
  allowCleanup: false,
  commandFailure: undefined as
    | "cancelled"
    | "timeout"
    | "output-limit"
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    rm: async (...args: Parameters<typeof filesystem.rm>) => {
      if (String(args[0]) === publicationCancellation.cleanupRoot) {
        publicationCancellation.cleanupController?.abort({
          stage: "workspace cleanup",
        });
        if (publicationCancellation.failRootCleanup)
          throw Object.assign(new Error("workspace cleanup denied"), {
            code: "EACCES",
          });
      }
      return filesystem.rm(...args);
    },
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args);
      if (
        publicationCancellation.commitController !== undefined &&
        String(args[0]) === publicationCancellation.commitParent
      ) {
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        let synced = false;
        handle.sync = async () => {
          await sync();
          synced = true;
        };
        handle.close = async () => {
          if (synced) {
            publicationCancellation.publishedCloseAttempts += 1;
            publicationCancellation.commitController?.abort({
              stage: "published parent close",
            });
            if (
              publicationCancellation.failPublishedClose &&
              publicationCancellation.publishedCloseAttempts === 1
            )
              throw Object.assign(new Error("close denied"), { code: "EIO" });
          }
          await close();
        };
      }
      if (publicationCancellation.controller !== undefined) {
        const stats = await handle.stat();
        if (stats.isDirectory()) {
          const sync = handle.sync.bind(handle);
          handle.sync = async () => {
            await sync();
            publicationCancellation.directorySyncs += 1;
            if (publicationCancellation.directorySyncs === 2)
              publicationCancellation.controller?.abort();
          };
        }
      }
      return handle;
    },
  };
});

vi.mock(
  "../../../src/javascript/recovery/WakaruCommand.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/javascript/recovery/WakaruCommand.js")
      >();
    return {
      ...actual,
      resolveWakaruCommand: async () => ({
        command: {
          invocationPath: "/unused/wakaru",
          resolvedPath: "/unused/wakaru",
        },
        limiter: {
          invocationPath: "/unused/prlimit",
          resolvedPath: "/unused/prlimit",
        },
        sha256: "a".repeat(64),
        bytes: 1,
      }),
    };
  },
);

vi.mock(
  "../../../src/javascript/recovery/WakaruExecution.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/javascript/recovery/WakaruExecution.js")
      >();
    const { createAnalysisExecution } =
      await import("../../../src/application/AnalysisProvider.js");
    return {
      ...actual,
      prepareWakaruExecution: async (
        context: Parameters<typeof actual.prepareWakaruExecution>[0],
      ) => {
        if (publicationCancellation.physicalFailure !== undefined) {
          publicationCancellation.cleanupRoot = context.root;
          throw publicationCancellation.physicalFailure;
        }
        if (publicationCancellation.commandFailure !== undefined) {
          const { runWakaruCommand } =
            await import("../../../src/javascript/recovery/WakaruCommand.js");
          const { RECOVERY_LIMITS } =
            await import("../../../src/javascript/recovery/WakaruRelease.js");
          const kind = publicationCancellation.commandFailure;
          return runWakaruCommand({
            resources: context.resources,
            command: "/unused/wakaru",
            limiter: "/unused/prlimit",
            arguments: [],
            cwd: context.root,
            environment: {},
            deadline: performance.now() + (kind === "timeout" ? 10 : 5000),
            ...(context.options?.signal === undefined
              ? {}
              : { signal: context.options.signal }),
            launcher: async (options) => {
              const child = Object.assign(new EventEmitter(), {
                stdout: new PassThrough(),
                stderr: new PassThrough(),
                exitCode: null,
                signalCode: null,
                kill: () => false,
              });
              setTimeout(
                () => {
                  child.stdout.end("finished command output");
                  child.stderr.end(
                    kind === "output-limit"
                      ? Buffer.alloc(RECOVERY_LIMITS.reportBytes + 1, 97)
                      : "finished diagnostic",
                  );
                  child.emit("exit", 0, null);
                  child.emit("close", 0, null);
                },
                kind === "timeout" ? 25 : 0,
              );
              return {
                process: child,
                ownership: {
                  runId: options.runId,
                  leaderPid: 12345,
                  processGroupId: 12345,
                  expectedParentPid: process.pid,
                },
                cleanup: async () => {
                  if (kind === "cancelled")
                    publicationCancellation.controller?.abort({
                      caller: "stop at owned command cleanup",
                    });
                  return publicationCancellation.allowCleanup
                    ? { cleaned: true as const, signaled: false }
                    : {
                        cleaned: false as const,
                        reason: "controlled command cleanup failure",
                      };
                },
              };
            },
          }).then(() => {
            throw new Error("Expected controlled command failure");
          });
        }
        if (publicationCancellation.reportCleanup) {
          const cleanup = await context.resources.release({
            kind: "lease",
            resource: "provenance descriptor",
            lease: {
              release: async () => {
                if (!publicationCancellation.allowCleanup)
                  throw new Error("close denied");
              },
            },
          });
          if (cleanup.kind !== "failed")
            throw new Error("Expected cleanup failure");
          const { WakaruReportReadFailure } =
            await import("../../../src/javascript/recovery/WakaruReport.js");
          throw new WakaruReportReadFailure(
            context.resources.cleanupFailure({ kind: "completed" }, [cleanup]),
            {
              stdout: "report output",
              stderr: "engine diagnostic",
              exit_code: 1,
              signal: null,
              truncated: false,
            },
          );
        }
        const source = context.sources[0];
        if (source === undefined) throw new Error("Missing recovery source");
        const bytes = Buffer.from("module.exports = 42;");
        await context.tree.write("module.js", Readable.from([bytes]), {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.byteLength,
        });
        return createAnalysisExecution(
          { status: "complete" },
          { id: "wakaru", name: "Wakaru", version: "1.14.0" },
          {
            subject: {
              path: source.path,
              sha256: source.sha256,
              format: "javascript",
            },
          },
        );
      },
    };
  },
);

import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { WakaruProvider } from "../../../src/javascript/recovery/WakaruProvider.js";
import { JavaScriptRecoveryService } from "../../../src/application/javascript/JavaScriptRecoveryService.js";
import {
  primaryAnalysisError,
  resolvedAnalysisError,
} from "../../../src/domain/analysisErrorBase.js";

it.each(["queued at close", "after clean close"])(
  "refuses Wakaru recovery %s without claiming cleanup ownership",
  async (stage) => {
    const provider = new WakaruProvider({});
    const input = {
      path: "/unused/source.js",
      output_directory: "/unused/output",
      extraction_mode: "structural" as const,
      rewrite_level: "standard" as const,
    };
    const queued =
      stage === "queued at close" ? provider.recover(input) : undefined;
    await provider.close();
    const result = await (queued ?? provider.recover(input));
    if (result.ok) throw new Error("Expected closed-provider refusal");
    expect(projectAnalysisError(result.error).code).toBe(
      "capability_unavailable",
    );
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupResources).toEqual([]);
  },
);

it.each(["cancelled", "timeout", "output-limit"] as const)(
  "preserves %s command output and cleanup primary through service retry",
  async (kind) => {
    const root = await createTestTempDirectory(
      "rea-wakaru-command-composition-",
    );
    const source = join(root, "source.js");
    await writeFile(source, "module.exports = 42;");
    publicationCancellation.commandFailure = kind;
    publicationCancellation.allowCleanup = false;
    const controller = new AbortController();
    publicationCancellation.controller = controller;
    const service = new JavaScriptRecoveryService(new WakaruProvider({}));
    try {
      const result = await service.recover(
        {
          path: source,
          output_directory: join(root, "output"),
          extraction_mode: "structural",
          rewrite_level: "standard",
        },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected command cleanup failure");
      expect(result.error.capturedOutput?.stdout).toBe(
        "finished command output",
      );
      expect(result.error.cleanupIncomplete).toBe(true);
      const primary = primaryAnalysisError(result.error);
      expect(primary._tag).toBe(
        kind === "cancelled"
          ? "AnalysisCancelledError"
          : kind === "timeout"
            ? "AnalysisTimeoutError"
            : "AnalysisOutputError",
      );
      if (kind === "cancelled")
        expect(primary.cause).toBe(controller.signal.reason);
      publicationCancellation.allowCleanup = true;
      await service.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(resolvedAnalysisError(result.error)).toBe(primary);
      expect(result.error.capturedOutput?.stdout).toBe(
        "finished command output",
      );
    } finally {
      publicationCancellation.allowCleanup = true;
      publicationCancellation.commandFailure = undefined;
      publicationCancellation.controller = undefined;
      await service.close();
    }
  },
);

it("retains report command output and cleanup ownership through provider retry", async () => {
  const root = await createTestTempDirectory("rea-wakaru-report-cleanup-");
  const sourcePath = join(root, "source.js");
  await writeFile(sourcePath, "module.exports = 42;");
  publicationCancellation.reportCleanup = true;
  publicationCancellation.allowCleanup = false;
  const provider = new WakaruProvider({});
  try {
    const result = await provider.recover({
      path: sourcePath,
      output_directory: join(root, "output"),
      extraction_mode: "structural",
      rewrite_level: "standard",
    });
    if (result.ok) throw new Error("Expected cleanup failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.capturedOutput).toMatchObject({
      stdout: "report output",
      stderr: "engine diagnostic",
      exit_code: 1,
      signal: null,
    });
    await expect(provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toContain("provenance descriptor");
    publicationCancellation.allowCleanup = true;
    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.capturedOutput?.stdout).toBe("report output");
  } finally {
    publicationCancellation.allowCleanup = true;
    publicationCancellation.reportCleanup = false;
    await provider.close();
  }
});

it.skipIf(process.platform === "win32")(
  "keeps mid-commit output-tree cancellation typed through the provider",
  async () => {
    const root = await createTestTempDirectory("rea-wakaru-cancel-");
    const sourcePath = join(root, "source.js");
    const output = join(root, "output");
    await writeFile(sourcePath, "module.exports = 42;");
    const controller = new AbortController();
    publicationCancellation.controller = controller;
    publicationCancellation.directorySyncs = 0;
    const provider = new WakaruProvider({});
    try {
      const result = await provider.recover(
        {
          path: sourcePath,
          output_directory: output,
          extraction_mode: "structural",
          rewrite_level: "standard",
        },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected publication cancellation");
      expect(result.error).toBeInstanceOf(AnalysisCancelledError);
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
      expect(publicationCancellation.directorySyncs).toBe(2);
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      publicationCancellation.controller = undefined;
      publicationCancellation.directorySyncs = 0;
      await provider.close();
    }
  },
);

it.each([false, true])(
  "retains a physical failure and later workspace-cleanup cancellation (cleanup fails: %s)",
  async (cleanupFails) => {
    const root = await createTestTempDirectory("rea-recovery-late-cancel-");
    const source = join(root, "source.js");
    await writeFile(source, "module.exports = 42;");
    const controller = new AbortController();
    const physical = new Error("physical recovery failure");
    publicationCancellation.cleanupController = controller;
    publicationCancellation.physicalFailure = physical;
    publicationCancellation.failRootCleanup = cleanupFails;
    const provider = new WakaruProvider({});
    try {
      const result = await provider.recover(
        {
          path: source,
          output_directory: join(root, "output"),
          extraction_mode: "structural",
          rewrite_level: "standard",
        },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected physical failure");
      expect(controller.signal.aborted).toBe(true);
      const primary = primaryAnalysisError(result.error);
      expect(primary).toMatchObject({
        _tag: "ProviderAdapterError",
        cause: physical,
      });
      expect(
        primary.secondaryFailures.some(
          (failure) =>
            failure instanceof AnalysisCancelledError &&
            failure.cause === controller.signal.reason,
        ),
      ).toBe(true);
      expect(result.error.cleanupIncomplete).toBe(cleanupFails);
      if (cleanupFails) {
        await expect(provider.close()).rejects.toMatchObject({
          cleanupIncomplete: true,
        });
        publicationCancellation.failRootCleanup = false;
        await provider.close();
        expect(result.error.cleanupIncomplete).toBe(false);
        expect(resolvedAnalysisError(result.error)).toBe(primary);
        expect(
          primary.secondaryFailures.some(
            (failure) =>
              failure instanceof AnalysisCancelledError &&
              failure.cause === controller.signal.reason,
          ),
        ).toBe(true);
      }
    } finally {
      publicationCancellation.failRootCleanup = false;
      publicationCancellation.cleanupController = undefined;
      await provider.close();
      publicationCancellation.cleanupRoot = undefined;
      publicationCancellation.physicalFailure = undefined;
    }
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "preserves committed recovery when cancellation arrives during parent close (first close fails: %s)",
  async (failFirstClose) => {
    const root = await createTestTempDirectory("rea-recovery-commit-cancel-");
    const source = join(root, "source.js");
    const output = join(root, "output");
    await writeFile(source, "module.exports = 42;");
    const controller = new AbortController();
    publicationCancellation.commitController = controller;
    publicationCancellation.commitParent = root;
    publicationCancellation.failPublishedClose = failFirstClose;
    publicationCancellation.publishedCloseAttempts = 0;
    const provider = new WakaruProvider({});
    try {
      const result = await provider.recover(
        {
          path: source,
          output_directory: output,
          extraction_mode: "structural",
          rewrite_level: "standard",
        },
        { signal: controller.signal },
      );
      if (!result.ok) throw result.error;
      expect(controller.signal.aborted).toBe(true);
      expect(publicationCancellation.publishedCloseAttempts).toBe(
        failFirstClose ? 2 : 1,
      );
      await expect(access(join(output, "module.js"))).resolves.toBeUndefined();
    } finally {
      publicationCancellation.commitController = undefined;
      publicationCancellation.commitParent = undefined;
      publicationCancellation.failPublishedClose = false;
      await provider.close();
    }
  },
);
