import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { adbDouble } from "../../../support/adb/adbProcessDouble.js";

import { AdbProvider } from "../../../../src/adb/AdbProvider.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { OwnedCommandFailure } from "../../../../src/process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../../../../src/process/ProviderProcess.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

// Exercise real filesystem publication; the Android process reply is simulated.
vi.mock("../../../../src/adb/AdbProcess.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../../src/adb/AdbProcess.js")
  >()),
  runAdbProcess: (await import("../../../support/adb/adbProcessDouble.js"))
    .runAdbProcessDouble,
}));
// A running adb server makes `adb start-server` a successful no-op.
vi.mock("../../../../src/adb/AdbServer.js", () => ({
  startAdbServer: async () => ({ ok: true, value: undefined }),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
    mkdtemp: vi.fn(actual.mkdtemp),
    open: vi.fn(actual.open),
    rm: vi.fn(actual.rm),
  };
});

afterEach(() => vi.restoreAllMocks());

const fixture = async (duringCollection?: (root: string) => Promise<void>) => {
  const root = await createTestTempDirectory("rea-adb-bugreport-");
  const binary = join(root, "adb");
  let reportedPath = "";
  adbDouble.version.mockImplementation(async (args) => {
    expect(args).toEqual(["version"]);
    const stdout = `Android Debug Bridge version 1.0.41\nVersion 34.0.5-stub\nInstalled as ${binary}\n`;
    return {
      stdout,
      stderr: "",
    };
  });
  adbDouble.device.mockImplementation(async (args) => {
    expect(args.slice(0, 3)).toEqual(["-s", "device", "bugreport"]);
    const staging = args[3]!;
    reportedPath = join(staging, "bugreport test.zip");
    await writeFile(reportedPath, "bugreport-bytes");
    await duringCollection?.(root);
    return {
      stdout: Buffer.from(`Bug report copied to ${reportedPath}\n`),
      stderr: Buffer.alloc(0),
    };
  });
  const provider = new AdbProvider({ environment: { REA_ADB_PATH: binary } });
  return {
    root,
    provider,
    reportedPath: () => reportedPath,
    request: {
      operation: "collect_adb_bugreport" as const,
      input: { serial: "device", output_directory: root },
    },
  };
};

test.each(["before", "during"] as const)(
  "preserves a same-name caller archive created %s collection",
  async (when) => {
    const existing = async (root: string) => {
      await writeFile(join(root, "bugreport test.zip"), "existing evidence");
      await writeFile(join(root, "bugreport test (1).zip"), "other evidence");
    };
    const f = await fixture(when === "during" ? existing : undefined);
    if (when === "before") await existing(f.root);
    const result = await f.provider.execute(f.request);
    if (!result.ok) throw result.error;
    const localPath = join(f.root, "bugreport test (2).zip");
    expect(result.value.result).toMatchObject({
      local_path: localPath,
      adb_reported_path: f.reportedPath(),
      bytes: 15,
      sha256: createHash("sha256").update("bugreport-bytes").digest("hex"),
    });
    expect(await readFile(join(f.root, "bugreport test.zip"), "utf8")).toBe(
      "existing evidence",
    );
    expect(await readFile(join(f.root, "bugreport test (1).zip"), "utf8")).toBe(
      "other evidence",
    );
    expect(await readFile(localPath, "utf8")).toBe("bugreport-bytes");
    expect((await readdir(f.root)).sort()).toEqual([
      "bugreport test (1).zip",
      "bugreport test (2).zip",
      "bugreport test.zip",
    ]);
    await f.provider.close();
  },
);

test("retains a completed archive after failed publication and later provider work", async () => {
  const f = await fixture();
  const existing = join(f.root, "bugreport test.zip");
  await writeFile(existing, "existing evidence");
  const publicationFailure = Object.assign(new Error("no space left"), {
    code: "ENOSPC",
  });
  vi.mocked(copyFile).mockRejectedValueOnce(publicationFailure);
  const failed = await f.provider.execute(f.request);
  if (failed.ok) throw new Error("expected publication failure");
  const retainedPath = f.reportedPath();
  expect(failed.error._tag).toBe("AnalysisOutputError");
  expect(failed.error.cause).toBe(publicationFailure);
  expect(
    projectAnalysisError(failed.error).details?.partial_observation,
  ).toMatchObject({
    provider_id: "adb",
    operation: f.request.operation,
    result: {
      serial: "device",
      local_path: retainedPath,
      adb_reported_path: retainedPath,
      digest_status: "unknown",
    },
  });
  expect(await readFile(retainedPath, "utf8")).toBe("bugreport-bytes");
  expect(await readFile(existing, "utf8")).toBe("existing evidence");

  // New work and terminal cleanup must not reclaim the retained acquisition.
  const next = await f.provider.execute(f.request);
  if (!next.ok) throw next.error;
  expect(next.value.result).toMatchObject({
    local_path: join(f.root, "bugreport test (1).zip"),
    bytes: 15,
    sha256: createHash("sha256").update("bugreport-bytes").digest("hex"),
  });
  await f.provider.close();
  expect(await readFile(retainedPath, "utf8")).toBe("bugreport-bytes");
  expect(await readFile(existing, "utf8")).toBe("existing evidence");
  expect(await readFile(join(f.root, "bugreport test (1).zip"), "utf8")).toBe(
    "bugreport-bytes",
  );
  expect((await readdir(f.root)).sort()).toEqual(
    [
      basename(dirname(retainedPath)),
      "bugreport test.zip",
      "bugreport test (1).zip",
    ].sort(),
  );
});

test("retains final and producer paths when digest verification is cancelled", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const actualCopy =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(copyFile).mockImplementationOnce(async (...args) => {
    await actualCopy.copyFile(...args);
    controller.abort();
  });
  const result = await f.provider.execute(f.request, {
    signal: controller.signal,
  });
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.partialObservation).toMatchObject({
    operation: f.request.operation,
    result: {
      local_path: join(f.root, "bugreport test.zip"),
      adb_reported_path: f.reportedPath(),
      digest_status: "unknown",
    },
  });
  expect(await readFile(join(f.root, "bugreport test.zip"), "utf8")).toBe(
    "bugreport-bytes",
  );
  expect(await readdir(f.root)).toEqual(["bugreport test.zip"]);
  await f.provider.close();
});

test("returns staging allocation failures without invoking device collection", async () => {
  const f = await fixture();
  vi.mocked(mkdtemp).mockRejectedValueOnce(new Error("staging denied"));
  const result = await f.provider.execute(f.request);
  if (result.ok) throw new Error("expected output failure");
  expect(result.error._tag).toBe("AnalysisOutputError");
  expect(adbDouble.device).not.toHaveBeenCalled();
  await f.provider.close();
});

test("retains published evidence and retries failed staging cleanup", async () => {
  const f = await fixture();
  vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup denied"));
  const result = await f.provider.execute(f.request);
  if (result.ok) throw new Error("expected cleanup failure");
  expect(result.error.cleanupResources).toContain(dirname(f.reportedPath()));
  expect(result.error.partialObservation).toMatchObject({
    operation: f.request.operation,
    result: {
      local_path: join(f.root, "bugreport test.zip"),
      adb_reported_path: f.reportedPath(),
      bytes: 15,
      sha256: createHash("sha256").update("bugreport-bytes").digest("hex"),
    },
  });
  expect(result.error.cleanupIncomplete).toBe(true);
  const originatingError = result.error;
  await f.provider.close();
  expect(originatingError.cleanupIncomplete).toBe(false);
  expect(await readdir(f.root)).toEqual(["bugreport test.zip"]);
});

test("provider close resolves the exact bugreport digest cleanup error", async () => {
  const f = await fixture();
  let allowClose = false;
  let closeAttempts = 0;
  const actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(open).mockImplementation(async (path, ...args) => {
    const handle = await actualFs.open(path, ...args);
    if (String(path) !== join(f.root, "bugreport test.zip")) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      closeAttempts += 1;
      if (!allowClose) throw new Error("controlled digest close fault");
      await close();
    };
    return handle;
  });

  const result = await f.provider.execute(f.request);
  if (result.ok) throw new Error("expected retained digest close failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.partialObservation).toMatchObject({
    operation: f.request.operation,
    result: {
      local_path: join(f.root, "bugreport test.zip"),
      bytes: 15,
      sha256: createHash("sha256").update("bugreport-bytes").digest("hex"),
    },
  });
  const originatingError = result.error;
  expect(closeAttempts).toBe(1);
  allowClose = true;
  await f.provider.close();
  expect(closeAttempts).toBe(2);
  expect(originatingError.cleanupIncomplete).toBe(false);
});

test("keeps a bugreport error unresolved until digest and staging owners recover", async () => {
  const f = await fixture();
  const actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  let allowDigestClose = false;
  let digestCloseAttempts = 0;
  let stagingRemovalAttempts = 0;
  vi.mocked(open).mockImplementation(async (path, ...args) => {
    const handle = await actualFs.open(path, ...args);
    if (String(path) !== join(f.root, "bugreport test.zip")) return handle;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      digestCloseAttempts += 1;
      if (!allowDigestClose) throw new Error("controlled digest close fault");
      await close();
    };
    return handle;
  });
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (
      basename(String(path)).startsWith(".rea-bugreport-") &&
      ++stagingRemovalAttempts === 1
    )
      throw new Error("controlled staging removal fault");
    return actualFs.rm(path, options);
  });

  const result = await f.provider.execute(f.request);
  if (result.ok) throw new Error("expected digest and staging cleanup failure");
  const originatingError = result.error;
  const stagingDirectory = dirname(f.reportedPath());
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toContain(stagingDirectory);
  expect(result.error.cleanupResources).toContain(
    `${join(f.root, "bugreport test.zip")} (ADB digest handle)`,
  );
  expect(result.error.partialObservation).toMatchObject({
    operation: f.request.operation,
    result: {
      local_path: join(f.root, "bugreport test.zip"),
      bytes: 15,
      sha256: createHash("sha256").update("bugreport-bytes").digest("hex"),
    },
  });
  expect(digestCloseAttempts).toBe(1);
  expect(stagingRemovalAttempts).toBe(1);

  const closeError = await f.provider.close().catch((cause: unknown) => cause);
  expect(closeError).toMatchObject({ cleanupIncomplete: true });
  expect(digestCloseAttempts).toBe(2);
  expect(stagingRemovalAttempts).toBe(2);
  expect(originatingError.cleanupIncomplete).toBe(true);
  await expect(readFile(stagingDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(join(f.root, "bugreport test.zip"), "utf8")).toBe(
    "bugreport-bytes",
  );

  allowDigestClose = true;
  await f.provider.close();
  expect(digestCloseAttempts).toBe(3);
  expect(stagingRemovalAttempts).toBe(2);
  expect(originatingError.cleanupIncomplete).toBe(false);
  expect(closeError).toMatchObject({ cleanupIncomplete: false });
});

test("refuses an archive reported outside the owned staging directory", async () => {
  const f = await fixture();
  const existing = join(f.root, "bugreport test.zip");
  await writeFile(existing, "existing evidence");
  adbDouble.device.mockResolvedValueOnce({
    stdout: Buffer.from(`Bug report copied to ${existing}\n`),
    stderr: Buffer.alloc(0),
  });
  const result = await f.provider.execute(f.request);
  if (result.ok) throw new Error("expected protocol refusal");
  expect(result.error._tag).toBe("AnalysisProtocolError");
  expect(await readFile(existing, "utf8")).toBe("existing evidence");
  expect(await readdir(f.root)).toEqual(["bugreport test.zip"]);
  await f.provider.close();
});

test("preserves the primary protocol failure when staging cleanup also fails", async () => {
  const f = await fixture();
  adbDouble.device.mockResolvedValueOnce({
    stdout: Buffer.from("unsupported completion format\n"),
    stderr: Buffer.alloc(0),
  });
  vi.mocked(rm).mockRejectedValueOnce(new Error("cleanup denied"));
  const result = await f.provider.execute(f.request);
  if (result.ok) throw new Error("expected protocol and cleanup failure");
  expect(result.error.cause).toMatchObject({
    errors: [
      {
        _tag: "AnalysisProtocolError",
        message: expect.stringContaining("did not report an archive path"),
      },
      expect.any(Error),
    ],
  });
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toHaveLength(1);
  await f.provider.close();
  expect(await readdir(f.root)).toEqual([]);
});

test("reports caller cancellation when staging removal fails after the archive is published", async () => {
  const controller = new AbortController();
  const reason = { request: "stop bugreport" };
  const f = await fixture();
  vi.mocked(rm).mockImplementationOnce(async () => {
    controller.abort(reason);
    throw new Error("cleanup denied");
  });
  const result = await f.provider.execute(f.request, {
    signal: controller.signal,
  });
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupPrimary).toMatchObject({
    _tag: "AnalysisCancelledError",
  });
  expect(result.error.cleanupPrimary?.cause).toBe(reason);
  await f.provider.close();
  expect(projectAnalysisError(result.error).code).toBe("cancelled");
});

test("preserves a finished bugreport archive and retains its staging directory while command cleanup remains unconfirmed", async () => {
  const f = await fixture();
  let allowCommandStop = false;
  let stopAttempts = 0;
  let reportedPath = "";
  const supervisor = {
    stop: async () => {
      stopAttempts += 1;
      return allowCommandStop
        ? { status: "stopped" as const }
        : {
            status: "incomplete" as const,
            reason: "adb bugreport process group still running",
          };
    },
  } as unknown as ProviderProcessSupervisor;

  adbDouble.device.mockImplementationOnce(async (args) => {
    const staging = args[3]!;
    reportedPath = join(staging, "bugreport test.zip");
    await writeFile(reportedPath, "bugreport-bytes");
    const stdoutText = `Bug report copied to ${reportedPath}\n`;
    throw new OwnedCommandFailure(
      "process",
      "Command cleanup failed.",
      {
        exitCode: 0,
        signal: null,
        stdout: {
          text: stdoutText,
          bytes: Buffer.byteLength(stdoutText),
          observedBytes: Buffer.byteLength(stdoutText),
        },
        stderr: {
          text: "",
          bytes: 0,
          observedBytes: 0,
        },
        diagnosticTruncated: false,
      },
      "adb bugreport process group still running",
      undefined,
      ["rea-adb-bugreport", "pid:7171"],
      supervisor,
    );
  });

  const result = await f.provider.execute(f.request);
  if (result.ok) throw new Error("expected bugreport command cleanup failure");
  const stagingDirectory = dirname(reportedPath);
  const publishedPath = join(f.root, "bugreport test.zip");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(
    expect.arrayContaining([stagingDirectory, "rea-adb-bugreport", "pid:7171"]),
  );
  expect(result.error.partialObservation).toMatchObject({
    provider_id: "adb",
    operation: f.request.operation,
    result: {
      serial: "device",
      local_path: publishedPath,
      adb_reported_path: reportedPath,
      bytes: 15,
      sha256: createHash("sha256").update("bugreport-bytes").digest("hex"),
    },
  });
  expect(await readFile(publishedPath, "utf8")).toBe("bugreport-bytes");
  await expect(lstat(stagingDirectory)).resolves.toBeDefined();
  expect(stopAttempts).toBe(0);

  const failedClose = await f.provider.close().catch((cause: unknown) => cause);
  expect(failedClose).toMatchObject({ cleanupIncomplete: true });
  expect(stopAttempts).toBe(1);
  await expect(lstat(stagingDirectory)).resolves.toBeDefined();

  const actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  allowCommandStop = true;
  vi.mocked(rm).mockImplementationOnce(async (path, options) => {
    if (String(path) === stagingDirectory)
      throw new Error("controlled staging removal failure after command stop");
    return actualFs.rm(path, options);
  });
  const secondClose = await f.provider.close().catch((cause: unknown) => cause);
  expect(secondClose).toMatchObject({ cleanupIncomplete: true });
  expect(stopAttempts).toBe(2);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual([stagingDirectory]);

  await f.provider.close();
  expect(stopAttempts).toBe(2);
  expect(result.error.cleanupIncomplete).toBe(false);
  await expect(lstat(stagingDirectory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(publishedPath, "utf8")).toBe("bugreport-bytes");
});

test("preserves command cleanup failure when archive digest readback also fails", async () => {
  const f = await fixture();
  let allowCommandStop = false;
  let reportedPath = "";
  const supervisor = {
    stop: async () =>
      allowCommandStop
        ? { status: "stopped" as const }
        : {
            status: "incomplete" as const,
            reason: "adb bugreport process group still running",
          },
  } as unknown as ProviderProcessSupervisor;

  adbDouble.device.mockImplementationOnce(async (args) => {
    const staging = args[3]!;
    reportedPath = join(staging, "bugreport test.zip");
    await writeFile(reportedPath, "bugreport-bytes");
    const stdoutText = `Bug report copied to ${reportedPath}\n`;
    throw new OwnedCommandFailure(
      "process",
      "Command cleanup failed.",
      {
        exitCode: 0,
        signal: null,
        stdout: {
          text: stdoutText,
          bytes: Buffer.byteLength(stdoutText),
          observedBytes: Buffer.byteLength(stdoutText),
        },
        stderr: {
          text: "",
          bytes: 0,
          observedBytes: 0,
        },
        diagnosticTruncated: false,
      },
      "adb bugreport process group still running",
      undefined,
      ["rea-adb-bugreport", "pid:7272"],
      supervisor,
    );
  });
  vi.mocked(open).mockRejectedValueOnce(
    new Error("controlled digest readback failure"),
  );

  const result = await f.provider.execute(f.request);
  if (result.ok)
    throw new Error("expected bugreport command and readback failure");
  const stagingDirectory = dirname(reportedPath);
  const publishedPath = join(f.root, "bugreport test.zip");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(
    expect.arrayContaining([stagingDirectory, "rea-adb-bugreport", "pid:7272"]),
  );
  expect(result.error.partialObservation).toMatchObject({
    provider_id: "adb",
    operation: f.request.operation,
    result: {
      serial: "device",
      local_path: publishedPath,
      adb_reported_path: reportedPath,
      digest_status: "unknown",
    },
  });

  allowCommandStop = true;
  await f.provider.close();
  expect(result.error.cleanupIncomplete).toBe(false);
});
