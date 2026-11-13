import { renameSync, writeFileSync, type Dir } from "node:fs";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { createHash } from "node:crypto";
import { writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactFileCleanupFailure } from "../../artifacts/ArtifactFileOperation.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
} from "../../domain/analysisErrorCore.js";
import { parseWakaruReports, WakaruReportReadFailure } from "./WakaruReport.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  fingerprintRecoveryFile,
  inventoryRecoveryFiles,
  readRecoveryFile,
} from "./RecoveryFiles.js";

const closeFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  denied: false,
  replaceAfterRead: false,
  cancel: undefined as AbortController | undefined,
  handles: [] as FileHandle[],
  failure: new Error("controlled recovery descriptor close failure"),
}));

const directoryFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  readFailure: undefined as Error | undefined,
  cancel: undefined as AbortController | undefined,
  closeAttempts: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const handle: Dir = await actual.opendir(...args);
      if (args[0] === directoryFault.path) {
        const close = handle.close.bind(handle);
        onTestFinished(async () => {
          await close();
        });
        const read = handle.read.bind(handle);
        handle.read = async () => {
          if (directoryFault.readFailure !== undefined)
            throw directoryFault.readFailure;
          return read();
        };
        handle.close = async () => {
          directoryFault.closeAttempts++;
          directoryFault.cancel?.abort();
          throw new Error("controlled recovery directory close failure");
        };
      }
      return handle;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (args[0] === closeFault.path) {
        if (closeFault.replaceAfterRead) {
          const createStream = handle.createReadStream.bind(handle);
          handle.createReadStream = (...options) => {
            const stream = createStream(...options);
            stream.once("end", () => {
              renameSync(String(args[0]), `${String(args[0])}.original`);
              writeFileSync(String(args[0]), "replacement");
            });
            return stream;
          };
        }
        const close = handle.close.bind(handle);
        closeFault.handles.push(handle);
        onTestFinished(async () => {
          if (handle.fd >= 0) await close();
        });
        handle.close = async () => {
          closeFault.cancel?.abort();
          if (closeFault.denied) throw closeFault.failure;
          await close();
        };
      }
      return handle;
    },
  };
});

afterEach(() => {
  directoryFault.path = undefined;
  directoryFault.readFailure = undefined;
  directoryFault.cancel = undefined;
  directoryFault.closeAttempts = 0;
  closeFault.path = undefined;
  closeFault.denied = false;
  closeFault.replaceAfterRead = false;
  closeFault.cancel = undefined;
  closeFault.handles = [];
});

it("retains command output when the provenance file changes during its read", async () => {
  const { path } = await selectedFile();
  closeFault.replaceAfterRead = true;
  const stdout = JSON.stringify({
    detected_formats: [],
    safety: "safe",
    modules: [],
    warnings: [],
    total: 0,
    failed: 0,
    elapsed_ms: 1,
  });
  const failure: unknown = await parseWakaruReports({
    execution: {
      exit_code: 0,
      signal: null,
      stdout,
      stderr: "engine diagnostic",
      command: "/wakaru",
      arguments: [],
      resource_limiter: "/prlimit",
    },
    provenancePath: path,
    snapshots: new Map(),
    files: [],
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisArtifactChangedError);
  if (!(failure instanceof AnalysisArtifactChangedError))
    throw new Error("Expected changed artifact");
  expect(failure.path).toBe(path);
  expect(failure.capturedOutput).toMatchObject({
    stdout,
    stderr: "engine diagnostic",
    exit_code: 0,
    signal: null,
  });
});

const selectedFile = async () => {
  const root = await createTestTempDirectory("rea-recovery-file-owner-");
  const path = join(root, "bundle.js");
  const bytes = Buffer.from("module.exports = 42;\n");
  await writeFile(path, bytes);
  closeFault.path = path;
  return { path, bytes };
};

it("retains report output and observed file hash when cancellation arrives during provenance close", async () => {
  const root = await createTestTempDirectory("rea-recovery-provenance-cancel-");
  const path = join(root, "provenance.json");
  const bytes = Buffer.from(
    '{"format":"unknown","strategy":"safe","modules":{}}',
  );
  await writeFile(path, bytes);
  closeFault.path = path;
  const controller = new AbortController();
  closeFault.cancel = controller;
  const stdout = JSON.stringify({
    detected_formats: [],
    safety: "safe",
    modules: [],
    warnings: [],
    total: 0,
    failed: 0,
    elapsed_ms: 1,
  });
  const failure: unknown = await parseWakaruReports({
    execution: {
      exit_code: 0,
      signal: null,
      stdout,
      stderr: "",
      command: "/wakaru",
      arguments: [],
      resource_limiter: "/prlimit",
    },
    provenancePath: path,
    snapshots: new Map(),
    files: [{ relativePath: "provenance.json" }],
    signal: controller.signal,
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  if (!(failure instanceof AnalysisCancelledError))
    throw new Error("Expected cancellation");
  expect(failure.cause).toBe(controller.signal.reason);
  expect(failure.partialObservation).toMatchObject({
    kind: "file-snapshot-hash",
    path,
    bytes: bytes.length,
  });
  expect(failure.capturedOutput).toMatchObject({
    stdout,
    stderr: "",
    exit_code: 0,
  });
});

it("retains command output and the exact provenance cleanup owner", async () => {
  const { path } = await selectedFile();
  closeFault.denied = true;
  const resources = new ArtifactResourceScope();
  const stdout = JSON.stringify({
    detected_formats: [],
    safety: "safe",
    modules: [],
    warnings: [],
    total: 0,
    failed: 0,
    elapsed_ms: 1,
  });
  const failure: unknown = await parseWakaruReports({
    execution: {
      exit_code: 0,
      signal: null,
      stdout,
      stderr: "engine diagnostic",
      command: "/wakaru",
      arguments: [],
      resource_limiter: "/prlimit",
    },
    provenancePath: path,
    snapshots: new Map(),
    files: [],
    resources,
  }).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    capturedOutput: {
      stdout,
      stderr: "engine diagnostic",
      exit_code: 0,
      signal: null,
    },
  });
  expect(failure).toBeInstanceOf(WakaruReportReadFailure);
  if (!(failure instanceof WakaruReportReadFailure))
    throw new Error("Expected retained report failure");
  expect(failure.failure).toBeInstanceOf(ArtifactFileCleanupFailure);
  expect(resources.hasPending).toBe(true);
  closeFault.denied = false;
  await resources.retryCleanup();
  expect(resources.hasPending).toBe(false);
});

it.each(["completed", "size-limit"] as const)(
  "retains the exact descriptor and %s read outcome through a failed close",
  async (mode) => {
    const { path, bytes } = await selectedFile();
    const resources = new ArtifactResourceScope();
    closeFault.denied = true;
    const failure = await readRecoveryFile(
      path,
      mode === "completed" ? 1024 : 0,
      undefined,
      resources,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactFileCleanupFailure);
    if (!(failure instanceof ArtifactFileCleanupFailure)) return;
    const physical = failure.fileCleanupFailure;
    expect(physical.owner.handle).toBe(closeFault.handles[0]);
    expect(physical.cleanupCause).toBe(closeFault.failure);
    if (mode === "completed")
      expect(physical.outcome).toEqual({
        kind: "completed",
        value: {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
      });
    else
      expect(physical.outcome).toMatchObject({
        kind: "failed",
        cause: { maximum: 0 },
      });
    expect(resources.hasPending).toBe(true);
    await expect(resources.retryCleanup()).rejects.toBeDefined();
    expect(closeFault.handles[0]?.fd).toBeGreaterThanOrEqual(0);
    closeFault.denied = false;
    await resources.retryCleanup();
    expect(resources.hasPending).toBe(false);
    expect(closeFault.handles[0]?.fd).toBe(-1);
  },
);

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  "retains an uncertain directory close and its primary read outcome (read denied: %s, cancel on close: %s)",
  async (readDenied, cancelOnClose) => {
    const { path } = await selectedFile();
    const root = dirname(path);
    directoryFault.path = root;
    const readFailure = new Error("controlled directory read failure");
    if (readDenied) directoryFault.readFailure = readFailure;
    const resources = new ArtifactResourceScope();
    const controller = new AbortController();
    if (cancelOnClose) directoryFault.cancel = controller;
    const failure = await inventoryRecoveryFiles(
      root,
      controller.signal,
      resources,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure)) return;
    expect(failure.cleanup?.resources).toContain(root);
    if (readDenied) {
      expect(failure.cause).toBeInstanceOf(ArtifactReaderFailure);
      expect((failure.cause as ArtifactReaderFailure).cause).toBe(readFailure);
    }
    if (cancelOnClose && !readDenied) {
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(controller.signal.reason);
    }
    expect(resources.hasPending).toBe(true);
    expect(directoryFault.closeAttempts).toBe(1);
    await expect(resources.retryCleanup()).rejects.toBeDefined();
    // Node has no public directory validity signal, so an unconfirmed close cannot be retried as if it were open.
    expect(directoryFault.closeAttempts).toBe(1);
    expect(resources.hasPending).toBe(true);
  },
);

it("retains completed hash facts and the exact reason when cancellation arrives during file close", async () => {
  const { path, bytes } = await selectedFile();
  const controller = new AbortController();
  const resources = new ArtifactResourceScope();
  closeFault.cancel = controller;
  const failure: unknown = await fingerprintRecoveryFile(
    path,
    1024,
    controller.signal,
    resources,
  ).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: controller.signal.reason,
    cleanupIncomplete: false,
    partialObservation: {
      kind: "file-snapshot-hash",
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  expect(closeFault.handles[0]?.fd).toBe(-1);
  await resources.close();
});
