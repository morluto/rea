import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { JavaScriptAnalysisWorker } from "../../../src/javascript/analysis/JavaScriptAnalysisWorker.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import type { OwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { javaScriptWorkerMemoryLimitBytes } from "../../../src/process/JavaScriptWorkerMemoryLimit.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";

const source = (path: string, value: string): JavaScriptArtifactFile => ({
  path,
  sha256: createHash("sha256").update(value).digest("hex"),
  container_sha256: "1".repeat(64),
  bytes: Buffer.byteLength(value),
  inventory_artifact_id: "fixture-source",
  kind: "javascript",
  unpacked: false,
  text: { included: true, value },
});

/** The Job Object limit the worker requests for its 128 MiB heap budget, if any. */
const processLimit = javaScriptWorkerMemoryLimitBytes(128);

it("reuses one real owned analyzer while retaining distinct source identities and exported returns", async () => {
  const launches: number[] = [];
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    async (request) => {
      const spawned = await spawnOwnedProviderProcess(request);
      const pid = spawned.process.pid;
      if (pid === undefined)
        throw new Error("Owned analyzer has no observed PID");
      launches.push(pid);
      return spawned;
    },
  );
  try {
    const first = source(
      "first.mjs",
      "export function create() { return { observed: 7 }; }",
    );
    const second = source(
      "second.mjs",
      "export function next() { return { observed: 8 }; }",
    );
    for (const [index, file] of [first, second].entries()) {
      const result = await worker.analyze(file, 100);
      if (!result.ok) throw result.error.error;
      expect(result.value.javascript.parse_status).toBe("complete");
      expect(
        result.value.module?.callables[0]?.returnSites[0]?.value,
      ).toMatchObject({
        status: "object",
        properties: [
          { name: "observed", value: { status: "literal", value: index + 7 } },
        ],
      });
      expect(
        result.value.projection?.nodes.every(
          ({ identity }) => identity.artifact_sha256 === file.sha256,
        ),
      ).toBe(true);
      expect(
        result.value.projection?.nodes.some(
          ({ identity }) => identity.module_path === file.path,
        ),
      ).toBe(true);
    }
    expect(launches).toHaveLength(1);
  } finally {
    await worker.close();
  }
});

it("reports an actual startup deadline and closes its owned resources before subsequent analysis", async () => {
  const file = source("app.mjs", "export const observed = 7;");
  const expired = new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 1 });
  try {
    const result = await expired.analyze(file, 100);
    if (result.ok)
      throw new Error(
        "A one-millisecond fresh process deadline unexpectedly completed",
      );
    expect(result.error.error).toMatchObject({
      _tag: "AnalysisTimeoutError",
      timeoutMs: 1,
    });
  } finally {
    await expired.close();
  }
  const next = new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 30_000 });
  try {
    const result = await next.analyze(file, 100);
    if (!result.ok) throw result.error.error;
    expect(result.value.javascript.parse_status).toBe("complete");
  } finally {
    await next.close();
  }
});

it("preserves a failed owned cleanup retry when the next caller cancels before acquisition", async () => {
  const controller = new AbortController();
  let releaseAllowed = false;
  let cleanupAttempts = 0;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    async (request) => {
      const launched = await spawnOwnedProviderProcess(request);
      return {
        ...launched,
        async cleanup() {
          cleanupAttempts += 1;
          if (!releaseAllowed) {
            if (cleanupAttempts > 1) controller.abort();
            throw new Error("Fixture owned cleanup is unavailable");
          }
          return launched.cleanup === undefined
            ? cleanupOwnedProcessGroup(launched.ownership)
            : launched.cleanup();
        },
      };
    },
  );
  const next = new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 30_000 });
  try {
    const file = source("app.mjs", "export const observed = 7;");
    const first = await worker.analyze(file, 100);
    if (!first.ok) throw first.error.error;
    const closing = worker.close();
    await expect(closing).rejects.toBeInstanceOf(ProviderCleanupError);
    await expect(closing).rejects.toMatchObject({
      cause: { message: "Fixture owned cleanup is unavailable" },
    });
    const interrupted = await next.analyze(file, 100, controller.signal);
    if (interrupted.ok)
      throw new Error("Unreleased ownership must block subsequent analysis");
    expect(controller.signal.aborted).toBe(true);
    expect(projectAnalysisError(interrupted.error.error)).toMatchObject({
      code: "cleanup_incomplete",
    });
    releaseAllowed = true;
    await worker.close();
    const recovered = await next.analyze(file, 100);
    if (!recovered.ok) throw recovered.error.error;
    expect(recovered.value.javascript.parse_status).toBe("complete");
  } finally {
    releaseAllowed = true;
    await worker.close();
    await next.close();
  }
});

it("ends worker stdin and unreferences process handles when cleanup reports inspection uncertainty", async () => {
  let stdinEnded = false;
  let unreferenced = false;
  let permitCleanup = false;
  let childStdin: typeof process.stdin | undefined;
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 30_000 },
    async (request) => {
      const launched = await spawnOwnedProviderProcess(request);
      const originalUnref = launched.process.unref;
      launched.process.unref = () => {
        unreferenced = true;
        originalUnref?.call(launched.process);
      };
      childStdin = launched.process.stdin as unknown as typeof process.stdin;
      launched.process.stdin?.once("finish", () => {
        stdinEnded = true;
      });
      return {
        ...launched,
        cleanup: async () =>
          permitCleanup
            ? launched.cleanup === undefined
              ? cleanupOwnedProcessGroup(launched.ownership)
              : launched.cleanup()
            : {
                cleaned: false,
                reason: "process table could not be inspected: spawn EPERM",
              },
      };
    },
  );
  try {
    const file = source("app.mjs", "export const observed = 7;");
    const result = await worker.analyze(file, 100);
    if (!result.ok) throw result.error.error;
    const closing = worker.close();
    await expect(closing).rejects.toBeInstanceOf(ProviderCleanupError);
    await expect(closing).rejects.toMatchObject({
      cause: {
        message: "process table could not be inspected: spawn EPERM",
      },
    });
    expect(childStdin?.writableEnded || stdinEnded).toBe(true);
    expect(unreferenced).toBe(true);
    const errorListeners = childStdin?.listenerCount("error");
    for (let retry = 0; retry < 3; retry++)
      await expect(worker.close()).rejects.toBeInstanceOf(ProviderCleanupError);
    expect(childStdin?.listenerCount("error")).toBeLessThanOrEqual(
      errorListeners ?? 0,
    );
    permitCleanup = true;
    await worker.close();
  } finally {
    permitCleanup = true;
    await worker.close().catch(() => {});
  }
});

it("lets a separate host exit while its live worker cleanup remains incomplete", async () => {
  const root = await createTestTempDirectory("rea-worker-incomplete-host-");
  const ownershipPath = join(root, "ownership.json");
  const workerUrl = new URL(
    "../../../dist/javascript/analysis/JavaScriptAnalysisWorker.js",
    import.meta.url,
  ).href;
  const launcherUrl = new URL(
    "../../../dist/process/ProviderProcess.js",
    import.meta.url,
  ).href;
  const script = `
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { JavaScriptAnalysisWorker } from ${JSON.stringify(workerUrl)};
import { spawnOwnedProviderProcess } from ${JSON.stringify(launcherUrl)};
const worker = new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 10000 }, async request => {
  const entry = pathToFileURL(request.arguments.at(-1)).href;
  const launched = await spawnOwnedProviderProcess({ ...request, arguments: [
    ...request.arguments.slice(0, -1), "--input-type=module", "-e",
    "const interval = setInterval(() => {}, 1000); setTimeout(() => clearInterval(interval), 60000); await import(" + JSON.stringify(entry) + ");"
  ] });
  // The launcher is deliberately orphaned when this host exits; cleanup still
  // requires its run token and executable identity, rather than its old parent.
  const { expectedParentPid, ...ownership } = launched.ownership;
  await writeFile(${JSON.stringify(ownershipPath)}, JSON.stringify(ownership));
  return { ...launched, cleanup: async () => ({ cleaned: false, reason: "fixture inspection unavailable" }) };
});
const analyzed = await worker.analyze(${JSON.stringify(source("app.mjs", "export const value = 1;"))}, 100);
if (!analyzed.ok) throw analyzed.error.error;
try { await worker.close(); throw new Error("cleanup unexpectedly completed"); }
catch (error) {
  if (error.cleanupIncomplete !== true) throw error;
  process.stdout.write(JSON.stringify({ code: "cleanup_incomplete", reason: error.cause.message }) + "\\n");
}
`;
  try {
    const result = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 10_000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "cleanup_incomplete",
      reason: "fixture inspection unavailable",
    });
  } finally {
    const ownership = JSON.parse(
      await readFile(ownershipPath, "utf8"),
    ) as OwnedProcessGroup;
    expect(await cleanupOwnedProcessGroup(ownership)).toMatchObject({
      cleaned: true,
    });
  }
});

// The handshake mirrors the real server: only Node.js reports an enforced V8 heap limit.
const resourceFailureWorker = (heapLimit: string) =>
  new JavaScriptAnalysisWorker({ heapMb: 128, timeoutMs: 30_000 }, (request) =>
    spawnOwnedProviderProcess({
      ...request,
      arguments: [
        "-e",
        `const heap = ${heapLimit};
process.stdout.write(JSON.stringify({ kind: "ready", heap_limit_bytes: heap }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).once("line", (line) => {
  const { id } = JSON.parse(line);
  process.stdout.write(JSON.stringify({ kind: "failure", id, reason: "resource", resource: "memory", limits: null, message: "fixture" }) + "\\n");
});`,
      ],
    }),
  );

it("reports the worker heap limit only when the runtime enforces V8 heap flags", async () => {
  const worker = resourceFailureWorker(
    'process.versions.bun === undefined ? require("node:v8").getHeapStatistics().heap_size_limit : null',
  );
  try {
    const result = await worker.analyze(
      source("app.mjs", "export const observed = 7;"),
      100,
    );
    if (result.ok) throw new Error("expected a reported resource failure");
    expect(result.error.error).toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      reportedLimits:
        process.versions.bun === undefined
          ? {
              worker_old_space_mb: 128,
              worker_heap_limit_bytes: expect.any(Number),
              worker_timeout_ms: 30_000,
            }
          : {
              worker_heap_limit_bytes: null,
              ...(processLimit === null
                ? {}
                : { worker_process_memory_limit_bytes: processLimit }),
              worker_timeout_ms: 30_000,
            },
    });
  } finally {
    await worker.close();
  }
});

it("rejects a worker heap report that contradicts the launching runtime", async () => {
  const worker = resourceFailureWorker(
    "process.versions.bun === undefined ? null : 1",
  );
  try {
    const result = await worker.analyze(
      source("app.mjs", "export const observed = 7;"),
      100,
    );
    if (result.ok) throw new Error("expected a handshake failure");
    expect(result.error.error._tag).toBe("AnalysisOutputError");
  } finally {
    await worker.close();
  }
});

// The launcher runs a real child without a job limit, so any artifact can run
// it, and its handle reports the notification an owned Windows job records
// before exit. Bun exits 3 (panic) or 1 (exception) at a reached job limit.
it.each([true, false])(
  "classifies a worker exit by the job memory notification (reached: %s)",
  async (reached) => {
    const worker = new JavaScriptAnalysisWorker(
      { heapMb: 128, timeoutMs: 30_000 },
      async ({ memoryLimitBytes, ...request }) => {
        expect(memoryLimitBytes).toBe(processLimit ?? undefined);
        const spawned = await spawnOwnedProviderProcess({
          ...request,
          arguments: [
            "-e",
            `const heap = process.versions.bun === undefined ? require("node:v8").getHeapStatistics().heap_size_limit : null;
process.stdout.write(JSON.stringify({ kind: "ready", heap_limit_bytes: heap }) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).once("line", () => {
  process.stderr.write("panic: out of memory");
  process.exit(3);
});`,
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
    );
    try {
      const result = await worker.analyze(
        source("app.mjs", "export const observed = 7;"),
        100,
      );
      if (result.ok) throw new Error("expected the worker to fail");
      expect(result.error.error).toMatchObject(
        reached
          ? {
              _tag: "AnalysisResourceConstraintError",
              resource: "memory",
              reason: expect.stringContaining("process memory limit"),
              reportedLimits:
                processLimit === null
                  ? expect.not.objectContaining({
                      worker_process_memory_limit_bytes: expect.anything(),
                    })
                  : { worker_process_memory_limit_bytes: processLimit },
              capturedOutput: { stderr: "panic: out of memory" },
            }
          : {
              _tag: "ProviderAdapterError",
              diagnostics: { exit_code: 3 },
            },
      );
    } finally {
      await worker.close();
    }
  },
);
