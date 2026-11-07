import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { GhidraDiagnosticExport } from "./GhidraDiagnosticExport.js";

let failClose = false;
let failStderrOpen = false;
let failRemoval = false;
let allocationCloses = 0;
let pauseStdoutClose: (() => Promise<void>) | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (failStderrOpen && String(args[0]).endsWith("stderr.log"))
        throw new Error("stderr open failed");
      const handle = await actual.open(...args);
      const paused = String(args[0]).endsWith("stdout.log")
        ? pauseStdoutClose
        : undefined;
      const allocation =
        failStderrOpen && String(args[0]).endsWith("stdout.log");
      if (!failClose && !paused && !allocation) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await paused?.();
        if (failClose) throw new Error("close failed");
        await close();
        if (allocation) allocationCloses += 1;
      };
      return handle;
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (failRemoval && String(args[0]).includes("rea-ghidra-"))
        throw new Error("directory removal failed");
      return actual.rm(...args);
    },
  };
});

it("retains complete streams and logs after source deletion while redacting split credentials", async () => {
  const root = await createTestTempDirectory("ghidra-export-");
  const source = join(root, "source.log");
  await writeFile(source, "before secret after");
  const capture = await GhidraDiagnosticExport.create(
    root,
    "secret",
    {
      run_id: "run",
      target_sha256: "sha",
      profile_digest: "profile",
    },
    new ArtifactResourceScope(),
  );
  capture.write("stdout", Buffer.from("head sec"));
  capture.write("stdout", Buffer.from("ret tail"));
  capture.write("stderr", Buffer.from("err"));
  await capture.finish(
    { ghidraLogPath: source, scriptLogPath: join(root, "missing") },
    true,
  );
  await writeFile(source, "overwritten");
  expect(await readFile(join(capture.path, "stdout.log"), "utf8")).toBe(
    "head [REDACTED] tail",
  );
  expect(await readFile(join(capture.path, "ghidra.log"), "utf8")).toBe(
    "before [REDACTED] after",
  );
  const manifest = JSON.parse(
    await readFile(join(capture.path, "manifest.json"), "utf8"),
  );
  expect(manifest).toMatchObject({
    run_id: "run",
    target_sha256: "sha",
    profile_digest: "profile",
  });
  expect(manifest.files.stdout).toEqual({ status: "complete" });
  expect(manifest.files.script).toEqual({ status: "unavailable" });
});

it("records incomplete transport capture rather than calling it complete", async () => {
  const root = await createTestTempDirectory("ghidra-export-");
  const capture = await GhidraDiagnosticExport.create(
    root,
    "secret",
    {
      run_id: "run",
      target_sha256: "sha",
      profile_digest: "profile",
    },
    new ArtifactResourceScope(),
  );
  capture.write("stdout", Buffer.from("partial sec"));
  await capture.finish(undefined, false);
  const manifest = JSON.parse(
    await readFile(join(capture.path, "manifest.json"), "utf8"),
  );
  expect(manifest.files.stdout).toEqual({ status: "incomplete" });
  expect(await readFile(join(capture.path, "stdout.log"), "utf8")).toBe(
    "partial [REDACTED]",
  );
});

it("does not write late output while asynchronous finalization is closing streams", async () => {
  const root = await createTestTempDirectory("ghidra-export-late-");
  let entered!: () => void;
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueClose = new Promise<void>((resolve) => {
    release = resolve;
  });
  pauseStdoutClose = async () => {
    entered();
    await continueClose;
  };
  try {
    const capture = await GhidraDiagnosticExport.create(
      root,
      "secret",
      {
        run_id: "run",
        target_sha256: "sha",
        profile_digest: "profile",
      },
      new ArtifactResourceScope(),
    );
    capture.write("stdout", Buffer.from("before"));
    const finished = capture.finish(undefined, false);
    await closing;
    capture.write("stdout", Buffer.from("late"));
    release();
    await finished;
    expect(await readFile(join(capture.path, "stdout.log"), "utf8")).toBe(
      "before",
    );
    const manifest = JSON.parse(
      await readFile(join(capture.path, "manifest.json"), "utf8"),
    );
    expect(manifest.files.stdout).toEqual({ status: "incomplete" });
  } finally {
    pauseStdoutClose = undefined;
    release();
  }
});

it("publishes a partial manifest and reports a failed log copy", async () => {
  const root = await createTestTempDirectory("ghidra-export-");
  const source = join(root, "source.log");
  await writeFile(source, "source");
  const capture = await GhidraDiagnosticExport.create(
    root,
    "secret",
    {
      run_id: "run",
      target_sha256: "sha",
      profile_digest: "profile",
    },
    new ArtifactResourceScope(),
  );
  await writeFile(join(capture.path, "ghidra.log"), "occupied");
  await expect(
    capture.finish(
      { ghidraLogPath: source, scriptLogPath: join(root, "missing") },
      true,
    ),
  ).rejects.toThrow("diagnostic export failed");
  const manifest = JSON.parse(
    await readFile(join(capture.path, "manifest.json"), "utf8"),
  );
  expect(manifest.files.ghidra.status).toBe("error");
  expect(manifest.files.script.status).toBe("unavailable");
});

it("publishes the manifest and reports a log whose descriptor failed to close", async () => {
  const root = await createTestTempDirectory("ghidra-export-");
  const source = join(root, "source.log");
  await writeFile(source, "source");
  const resources = new ArtifactResourceScope();
  const capture = await GhidraDiagnosticExport.create(
    root,
    "secret",
    { run_id: "run", target_sha256: "sha", profile_digest: "profile" },
    resources,
  );
  failClose = true;
  try {
    await expect(
      capture.finish(
        { ghidraLogPath: source, scriptLogPath: join(root, "missing") },
        true,
      ),
    ).rejects.toThrow("diagnostic export failed");
    expect(resources.hasPending).toBe(true);
    expect(resources.cleanupResources).toContain(
      `Ghidra diagnostic source log ${source}`,
    );
    expect(resources.cleanupResources).toContain(
      `Ghidra diagnostic output ${join(capture.path, "ghidra.log")}`,
    );
    await expect(resources.retryCleanup()).rejects.toThrow();
    expect(resources.hasPending).toBe(true);
    const manifest = JSON.parse(
      await readFile(join(capture.path, "manifest.json"), "utf8"),
    );
    expect(manifest.files.ghidra).toEqual({
      status: "error",
      reason: "Error: close failed; source close: Error: close failed",
    });
  } finally {
    failClose = false;
    await resources.retryCleanup();
  }
  expect(resources.hasPending).toBe(false);
});

it("retains an output handle when allocation rollback cannot close it", async () => {
  const root = await createTestTempDirectory("ghidra-export-allocation-");
  const resources = new ArtifactResourceScope();
  failClose = true;
  failStderrOpen = true;
  try {
    await expect(
      GhidraDiagnosticExport.create(
        root,
        "secret",
        { run_id: "run", target_sha256: "sha", profile_digest: "profile" },
        resources,
      ),
    ).rejects.toThrow("stderr open failed");
    expect(resources.hasPending).toBe(true);
    expect(resources.cleanupResources).toEqual(
      expect.arrayContaining([expect.stringContaining("stdout.log")]),
    );
    const [directory] = await readdir(root);
    if (directory === undefined) throw new Error("Missing retained directory");
    const path = join(root, directory);
    expect(resources.cleanupResources).toContain(
      `Ghidra diagnostic export directory ${path}`,
    );
    await expect(resources.retryCleanup()).rejects.toThrow();
    await expect(access(path)).resolves.toBeUndefined();
  } finally {
    failClose = false;
    failStderrOpen = false;
    await resources.retryCleanup();
  }
  expect(resources.hasPending).toBe(false);
  expect(await readdir(root)).toEqual([]);
});

it("retries directory removal without reclosing an already released output", async () => {
  const root = await createTestTempDirectory("ghidra-export-removal-");
  const resources = new ArtifactResourceScope();
  failStderrOpen = true;
  failRemoval = true;
  allocationCloses = 0;
  try {
    await expect(
      GhidraDiagnosticExport.create(
        root,
        "secret",
        { run_id: "run", target_sha256: "sha", profile_digest: "profile" },
        resources,
      ),
    ).rejects.toThrow("stderr open failed");
    expect(allocationCloses).toBe(1);
    expect(resources.cleanupResources).toEqual([
      expect.stringContaining("Ghidra diagnostic export directory"),
    ]);
    await expect(resources.retryCleanup()).rejects.toThrow();
    expect(allocationCloses).toBe(1);
  } finally {
    failStderrOpen = false;
    failRemoval = false;
    await resources.retryCleanup();
  }
  expect(allocationCloses).toBe(1);
  expect(await readdir(root)).toEqual([]);
});
