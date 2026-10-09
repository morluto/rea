import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  createSystemProcessOwnershipHost,
  systemProcessOwnershipHost,
} from "../../../src/process/ProcessOwnershipObservation.js";
import { createDarwinProcessRunTokenReader } from "../../../src/process/DarwinProcessRunTokenReader.js";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { normalizeCaptureFailure } from "../../../src/process/capture/ProcessCaptureError.js";
import { PlaywrightElectronActiveProvider } from "../../../src/browser/PlaywrightElectronActiveProvider.js";
import { electronActiveObservationInputSchema } from "../../../src/domain/javascript/electronActiveObservation.js";

const execFileAsync = promisify(execFile);
const onDarwin = process.platform === "darwin";

const writeBlockingCompiler = async (directory: string) => {
  const executable = join(directory, "fake-xcrun");
  const statePath = join(directory, "compile-state.json");
  const releasePath = join(directory, "release-compiler");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const statePath = ${JSON.stringify(statePath)};
const releasePath = ${JSON.stringify(releasePath)};
const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : { calls: 0 };
state.calls += 1;
const outputIndex = process.argv.indexOf("-o");
state.output = process.argv[outputIndex + 1];
state.root = path.dirname(state.output);
state.arguments = process.argv.slice(2);
state.releasePath = releasePath;
fs.writeFileSync(statePath, JSON.stringify(state));
if (state.calls === 1) {
  const timer = setInterval(() => {
    if (!fs.existsSync(releasePath)) return;
    clearInterval(timer);
    fs.writeFileSync(state.output, "compiled");
  }, 10);
} else {
  fs.writeFileSync(state.output, "compiled");
}
`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  return { executable, statePath, releasePath };
};

const writeBlockingIdentityCompiler = async (directory: string) => {
  const executable = join(directory, "fake-identity-xcrun");
  const statePath = join(directory, "identity-helper-state.json");
  const helperSource = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
  root: __dirname,
}));
setInterval(() => {}, 1000);
`;
  const compilerSource = `#!/usr/bin/env node
const fs = require("node:fs");
const outputIndex = process.argv.indexOf("-o");
const output = process.argv[outputIndex + 1];
fs.writeFileSync(output, ${JSON.stringify(helperSource)});
fs.chmodSync(output, 0o755);
`;
  await writeFile(executable, compilerSource);
  await chmod(executable, 0o755);
  return { executable, statePath };
};

const waitForCompileState = async (statePath: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "calls" in parsed &&
        typeof parsed.calls === "number" &&
        "root" in parsed &&
        typeof parsed.root === "string" &&
        "output" in parsed &&
        typeof parsed.output === "string" &&
        "releasePath" in parsed &&
        typeof parsed.releasePath === "string"
      )
        return {
          calls: parsed.calls,
          root: parsed.root,
          output: parsed.output,
          releasePath: parsed.releasePath,
          arguments:
            "arguments" in parsed && Array.isArray(parsed.arguments)
              ? parsed.arguments
              : [],
        };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("fake compiler did not start");
};

const waitForIdentityHelper = async (statePath: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "root" in parsed &&
        typeof parsed.root === "string"
      )
        return { root: parsed.root };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("fake identity helper did not start");
};

type ElectronCaptureResult = Awaited<
  ReturnType<PlaywrightElectronActiveProvider["capture"]>
>;
type ElectronCaptureOutcome =
  | { readonly state: "result"; readonly value: ElectronCaptureResult }
  | { readonly state: "rejected"; readonly cause: unknown };

it("reports an actionable missing Swift compiler without installing it", async () => {
  const reader = createDarwinProcessRunTokenReader({
    xcrun: join(tmpdir(), "rea-no-such-xcrun"),
  });
  try {
    await expect(
      reader.read([
        {
          pid: 1,
          parentPid: 0,
          processGroupId: 1,
          state: "S",
          command: "fixture",
        },
      ]),
    ).rejects.toThrow(/requires the Apple Swift compiler via xcrun/u);
  } finally {
    await reader.close();
  }
});

it.skipIf(process.platform === "win32")(
  "preserves compiler diagnostics when Swift preparation fails",
  async () => {
    const directory = await createTestTempDirectory(
      "rea-process-token-compiler-failure-test-",
    );
    const executable = join(directory, "failing-xcrun");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.stderr.write("module cache is not writable\\n"); process.exitCode = 1;\n',
    );
    await chmod(executable, 0o755);
    const reader = createDarwinProcessRunTokenReader({ xcrun: executable });
    try {
      await expect(reader.prepare()).rejects.toThrow(
        /compilation failed.*module cache is not writable/su,
      );
    } finally {
      await reader.close();
    }
  },
);

it
  .skipIf(!onDarwin || process.getuid?.() === 0)
  .each(["file", "read-only directory"])(
  "ignores unusable inherited Swift module cache: %s",
  async (kind) => {
    const directory = await createTestTempDirectory(
      "rea-process-token-inherited-cache-test-",
    );
    const cacheParent = join(directory, "cache-parent");
    if (kind === "file") await writeFile(cacheParent, "not a directory");
    else {
      await mkdir(cacheParent);
      await chmod(cacheParent, 0o500);
    }
    const cachePath = join(cacheParent, "modules");
    vi.stubEnv("CLANG_MODULE_CACHE_PATH", cachePath);
    const reader = createDarwinProcessRunTokenReader();
    try {
      const executable = await reader.prepare();
      const { stdout } = await execFileOutput(
        executable,
        ["--identities", String(process.pid)],
        { timeout: 15_000 },
      );
      expect(JSON.parse(stdout)).toMatchObject({
        results: [{ pid: process.pid, state: "readable" }],
      });
      expect(process.env.CLANG_MODULE_CACHE_PATH).toBe(cachePath);
    } finally {
      vi.unstubAllEnvs();
      if (kind === "read-only directory") await chmod(cacheParent, 0o700);
      await reader.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "uses the compiler-managed module cache instead of rebuilding system modules per REA process",
  async () => {
    const directory = await createTestTempDirectory(
      "rea-process-token-module-cache-test-",
    );
    const fakeCompiler = await writeBlockingCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: fakeCompiler.executable,
    });
    const preparation = reader.prepare();
    try {
      const state = await waitForCompileState(fakeCompiler.statePath);
      expect(state.arguments).not.toContain("-module-cache-path");
      await writeFile(fakeCompiler.releasePath, "release");
      await preparation;
    } finally {
      await Promise.all([reader.close(), Promise.allSettled([preparation])]);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "rethrows compile cancellation, removes its temporary root, and permits retry",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-process-token-abort-test-"),
    );
    const fakeCompiler = await writeBlockingCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: fakeCompiler.executable,
    });
    const controller = new AbortController();
    const compilation = reader.prepare(controller.signal).then(
      () => ({ state: "fulfilled" as const }),
      (cause: unknown) => ({ state: "rejected" as const, cause }),
    );
    try {
      const firstAttempt = await waitForCompileState(fakeCompiler.statePath);
      controller.abort();
      const outcome = await compilation;

      expect(outcome.state).toBe("rejected");
      if (outcome.state !== "rejected")
        throw new Error(
          "aborted native reader compilation unexpectedly succeeded",
        );
      expect(outcome.cause).toMatchObject({ name: "AbortError" });
      expect(
        normalizeCaptureFailure(outcome.cause, controller.signal),
      ).toMatchObject({ reason: "cancelled", userCategory: "cancelled" });
      await expect(access(firstAttempt.root)).rejects.toThrow();

      await reader.prepare();
      const retry = await waitForCompileState(fakeCompiler.statePath);
      expect(retry).toMatchObject({ calls: 2 });
      await expect(access(retry.output)).resolves.toBeUndefined();
      await reader.close();
      await expect(access(retry.root)).rejects.toThrow();
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await compilation;
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

const temporaryStateSchema = z.object({
  root: z.string(),
  temporary: z.string(),
});

/**
 * A compiler that behaves like swift-driver: a job in its own process group
 * writes an object under TMPDIR, SIGINT stops the job and deletes the object,
 * and any other signal leaves the job writing after the driver exits.
 */
const writeTemporaryObjectCompiler = async (directory: string) => {
  const executable = join(directory, "fake-temporary-xcrun");
  const statePath = join(directory, "temporary-state.json");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "TemporaryDirectory."));
const object = path.join(temporary, "ProcessRunTokenReader-1.o");
const job = spawn(process.execPath, ["-e",
  "setTimeout(() => { const fs = require('node:fs'); fs.mkdirSync(" + JSON.stringify(temporary) +
  ", { recursive: true }); fs.writeFileSync(" + JSON.stringify(object) + ", 'object'); }, 300)"],
  { detached: true, stdio: "ignore" });
job.unref();
process.on("SIGINT", () => {
  job.kill("SIGKILL");
  fs.rmSync(object, { force: true });
  process.exit(130);
});
const output = process.argv[process.argv.indexOf("-o") + 1];
fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({ root: path.dirname(output), temporary }));
setInterval(() => {}, 1000);
`;
  await writeFile(executable, source);
  await chmod(executable, 0o755);
  return { executable, statePath };
};

it.skipIf(process.platform === "win32")(
  "removes cancelled compiler temporaries with the helper root",
  async () => {
    const directory = await createTestTempDirectory(
      "rea-process-token-temporary-test-",
    );
    const compiler = await writeTemporaryObjectCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: compiler.executable,
    });
    const controller = new AbortController();
    const preparation = reader.prepare(controller.signal).then(
      () => undefined,
      (cause: unknown) => cause,
    );
    let temporary: string | undefined;
    try {
      const deadline = Date.now() + 5_000;
      let state: z.infer<typeof temporaryStateSchema> | undefined;
      while (state === undefined && Date.now() < deadline) {
        const parsed = temporaryStateSchema.safeParse(
          await readFile(compiler.statePath, "utf8").then(
            (text): unknown => JSON.parse(text),
            () => undefined,
          ),
        );
        if (parsed.success) state = parsed.data;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (state === undefined) throw new Error("fake compiler did not start");
      temporary = state.temporary;
      expect(state.temporary.startsWith(`${state.root}/`)).toBe(true);

      controller.abort();
      expect(await preparation).toMatchObject({ name: "AbortError" });
      await reader.close();
      // A job that outlived the compiler would recreate the root by now.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await expect(access(state.root)).rejects.toThrow();
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await preparation;
      await reader.close();
      if (temporary !== undefined)
        await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32").each(["first", "second"] as const)(
  "keeps shared compilation alive when the %s waiter cancels",
  async (cancelledWaiter) => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-process-token-shared-compile-test-"),
    );
    const fakeCompiler = await writeBlockingCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: fakeCompiler.executable,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstWaiter = reader.prepare(firstController.signal).then(
      (value) => ({ state: "fulfilled" as const, value }),
      (cause: unknown) => ({ state: "rejected" as const, cause }),
    );
    const secondWaiterPromise = (async () => {
      const state = await waitForCompileState(fakeCompiler.statePath);
      const secondWaiter = reader.prepare(secondController.signal).then(
        (value) => ({ state: "fulfilled" as const, value }),
        (cause: unknown) => ({ state: "rejected" as const, cause }),
      );
      const cancelled =
        cancelledWaiter === "first" ? firstWaiter : secondWaiter;
      const surviving =
        cancelledWaiter === "first" ? secondWaiter : firstWaiter;
      (cancelledWaiter === "first"
        ? firstController
        : secondController
      ).abort();
      const firstOutcome = await cancelled;
      expect(firstOutcome.state).toBe("rejected");
      if (firstOutcome.state !== "rejected")
        throw new Error("cancelled compilation waiter unexpectedly succeeded");
      expect(firstOutcome.cause).toMatchObject({ name: "AbortError" });
      await expect(access(state.root)).resolves.toBeUndefined();
      await writeFile(fakeCompiler.releasePath, "release");
      return { state, outcome: await surviving };
    })();

    try {
      const { state, outcome } = await secondWaiterPromise;
      expect(state.calls).toBe(1);
      expect(outcome.state).toBe("fulfilled");
      if (outcome.state !== "fulfilled") throw outcome.cause;
      expect(outcome.value).toBe(state.output);
      await reader.close();
      await expect(access(state.root)).rejects.toThrow();
    } finally {
      if (!firstController.signal.aborted) firstController.abort();
      if (!secondController.signal.aborted) secondController.abort();
      await Promise.allSettled([firstWaiter, secondWaiterPromise]);
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "retains a failed compilation cleanup for a later close retry",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-process-token-cleanup-retry-test-"),
    );
    const fakeCompiler = await writeBlockingCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: fakeCompiler.executable,
    });
    const controller = new AbortController();
    const preparation = reader.prepare(controller.signal).then(
      () => ({ state: "fulfilled" as const }),
      (cause: unknown) => ({ state: "rejected" as const, cause }),
    );
    let compilationRoot: string | undefined;
    try {
      const state = await waitForCompileState(fakeCompiler.statePath);
      compilationRoot = state.root;
      await writeFile(
        join(state.root, "retained.txt"),
        "cleanup must remain tracked",
      );
      await chmod(state.root, 0o000);
      controller.abort();
      expect((await preparation).state).toBe("rejected");
      await expect(reader.close()).rejects.toThrow();
      await chmod(state.root, 0o700);
      await reader.close();
      await expect(access(state.root)).rejects.toThrow();
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await preparation;
      if (compilationRoot !== undefined)
        await chmod(compilationRoot, 0o700).catch(() => undefined);
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "aborts and cleans an active compilation when the reader closes",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-process-token-close-compile-test-"),
    );
    const fakeCompiler = await writeBlockingCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: fakeCompiler.executable,
    });
    const preparation = reader.prepare().then(
      () => ({ state: "fulfilled" as const }),
      (cause: unknown) => ({ state: "rejected" as const, cause }),
    );
    try {
      const state = await waitForCompileState(fakeCompiler.statePath);
      await reader.close();
      const outcome = await preparation;
      expect(outcome.state).toBe("rejected");
      if (outcome.state !== "rejected")
        throw new Error("closed reader compilation unexpectedly succeeded");
      expect(outcome.cause).toMatchObject({ name: "AbortError" });
      await expect(access(state.root)).rejects.toThrow();
      await expect(reader.prepare()).rejects.toThrow(/reader is closed/u);
      await expect(reader.close()).resolves.toBeUndefined();
    } finally {
      await Promise.allSettled([preparation]);
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "maps cancellation during native preparation before Electron path resolution",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-electron-token-abort-test-"),
    );
    const fakeCompiler = await writeBlockingCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: fakeCompiler.executable,
    });
    const prepareSpy = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockImplementation(async (signal) => {
        await reader.prepare(signal);
      });
    const launchSpy = vi.spyOn(electron, "launch");
    const controller = new AbortController();
    let captureOutcome: Promise<ElectronCaptureOutcome> | undefined;
    try {
      const input = electronActiveObservationInputSchema.parse({
        executable_path: "/missing/electron",
        application_path: "/missing/application.js",
      });
      captureOutcome = new PlaywrightElectronActiveProvider({})
        .capture(input, { signal: controller.signal })
        .then(
          (value) => ({ state: "result" as const, value }),
          (cause: unknown) => ({ state: "rejected" as const, cause }),
        );
      const compileState = await waitForCompileState(fakeCompiler.statePath);
      controller.abort();
      const outcome = await captureOutcome;

      expect(outcome.state).toBe("result");
      if (outcome.state !== "result") throw outcome.cause;
      expect(outcome.value).toMatchObject({
        ok: false,
        error: { reason: "cancelled", userCategory: "cancelled" },
      });
      expect(launchSpy).not.toHaveBeenCalled();
      await expect(access(compileState.root)).rejects.toThrow();
    } finally {
      if (!controller.signal.aborted) controller.abort();
      if (captureOutcome !== undefined) await captureOutcome;
      prepareSpy.mockRestore();
      launchSpy.mockRestore();
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "preserves cancellation through system-host baseline identity inspection",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-process-baseline-abort-test-"),
    );
    const fakeCompiler = await writeBlockingIdentityCompiler(directory);
    const host = createSystemProcessOwnershipHost("darwin", process.env, {
      darwinXcrun: fakeCompiler.executable,
    });
    const controller = new AbortController();
    let helperRoot: string | undefined;
    const baseline =
      host.captureBaseline?.(controller.signal).then(
        () => ({ state: "fulfilled" as const }),
        (cause: unknown) => ({ state: "rejected" as const, cause }),
      ) ?? Promise.resolve({ state: "missing" as const });
    try {
      if (host.captureBaseline === undefined)
        throw new Error("Darwin host did not expose process baselines");
      const helper = await waitForIdentityHelper(fakeCompiler.statePath);
      helperRoot = helper.root;
      controller.abort();
      const outcome = await baseline;

      expect(outcome.state).toBe("rejected");
      if (outcome.state !== "rejected")
        throw new Error("aborted identity inspection unexpectedly succeeded");
      expect(outcome.cause).toMatchObject({ name: "AbortError" });
      expect(
        normalizeCaptureFailure(outcome.cause, controller.signal),
      ).toMatchObject({ reason: "cancelled", userCategory: "cancelled" });
      await expect(access(helper.root)).resolves.toBeUndefined();
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await baseline;
      await host.close?.();
      if (helperRoot !== undefined)
        await expect(access(helperRoot)).rejects.toThrow();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "passes Electron cancellation into capture-local baseline inspection",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "rea-electron-baseline-abort-test-"),
    );
    const fakeCompiler = await writeBlockingIdentityCompiler(directory);
    const reader = createDarwinProcessRunTokenReader({
      xcrun: fakeCompiler.executable,
    });
    const prepareSpy = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockResolvedValue();
    const baselineSpy = vi
      .spyOn(systemProcessOwnershipHost, "captureBaseline")
      .mockImplementation(async (signal) => {
        await reader.identities(
          [
            {
              pid: process.pid,
              parentPid: process.ppid,
              processGroupId: process.pid,
              state: "S",
              command: process.execPath,
            },
          ],
          signal,
        );
        return [];
      });
    const launchSpy = vi.spyOn(electron, "launch");
    const controller = new AbortController();
    let captureOutcome: Promise<ElectronCaptureOutcome> | undefined;
    try {
      const input = electronActiveObservationInputSchema.parse({
        executable_path: process.execPath,
        application_path: fileURLToPath(import.meta.url),
        application_root: process.cwd(),
      });
      captureOutcome = new PlaywrightElectronActiveProvider({})
        .capture(input, { signal: controller.signal })
        .then(
          (value) => ({ state: "result" as const, value }),
          (cause: unknown) => ({ state: "rejected" as const, cause }),
        );
      const helper = await waitForIdentityHelper(fakeCompiler.statePath);
      controller.abort();
      const outcome = await captureOutcome;

      expect(outcome.state).toBe("result");
      if (outcome.state !== "result") throw outcome.cause;
      expect(outcome.value).toMatchObject({
        ok: false,
        error: { reason: "cancelled", userCategory: "cancelled" },
      });
      expect(launchSpy).not.toHaveBeenCalled();
      await expect(access(helper.root)).resolves.toBeUndefined();
    } finally {
      if (!controller.signal.aborted) controller.abort();
      if (captureOutcome !== undefined) await captureOutcome;
      prepareSpy.mockRestore();
      baselineSpy.mockRestore();
      launchSpy.mockRestore();
      await reader.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(!onDarwin)(
  "parses exact NUL-delimited token records and rejects truncated argv",
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rea-process-token-parser-test-"),
    );
    const executable = join(root, "parser-test");
    const core = fileURLToPath(
      new URL(
        "../../../bridge/process/ProcessRunTokenReader.swift",
        import.meta.url,
      ),
    );
    const fixture = fileURLToPath(
      new URL(
        "../../fixtures/processRunTokenParserProbe.swift",
        import.meta.url,
      ),
    );
    try {
      await execFileOutput(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-module-cache-path",
          join(root, "modules"),
          core,
          fixture,
          "-o",
          executable,
        ],
        { timeout: 60_000 },
      );
      const { stdout } = await execFileAsync(executable, [], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toEqual({
        argvDecoyIgnored: true,
        alternatePaddingRead: true,
        appleVectorTokenFailsClosed: true,
        clearedAppleVectorTokenFailsClosed: true,
        callerPfzBeforeTokenRead: true,
        emptyLaterArgumentRead: true,
        emptyArgv0Read: true,
        emptyEnvironmentRecordsBeforeTokenFailClosed: true,
        duplicateTokenFailsClosed: true,
        finalAssignmentArgumentRead: true,
        missingAppleBoundaryFailsClosed: true,
        nonAsciiPathRead: true,
        realTokenRead: true,
        reservedArgumentIgnored: true,
        truncatedArgvFailsClosed: true,
        zeroArgumentsRead: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!onDarwin)(
  "retries a growing process table after ENOMEM and preserves other sysctl errors",
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), "rea-process-snapshot-retry-test-"),
    );
    const executable = join(root, "snapshot-probe");
    const core = fileURLToPath(
      new URL(
        "../../../bridge/process/ProcessRunTokenReader.swift",
        import.meta.url,
      ),
    );
    const fixture = fileURLToPath(
      new URL(
        "../../fixtures/processRunTokenSnapshotProbe.swift",
        import.meta.url,
      ),
    );
    try {
      await execFileOutput(
        "/usr/bin/xcrun",
        [
          "swiftc",
          "-module-cache-path",
          join(root, "modules"),
          core,
          fixture,
          "-o",
          executable,
        ],
        { timeout: 60_000 },
      );
      const { stdout } = await execFileAsync(executable, [], {
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toEqual({
        preservedOtherErrno: true,
        retriedAfterFreshSize: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!onDarwin)(
  "reads exact ownership keys and preserves unknowns after process title changes",
  async () => {
    const host = createSystemProcessOwnershipHost("darwin");
    const children: Awaited<ReturnType<typeof startNodeChild>>[] = [];
    try {
      const decoy = await startNodeChild({
        DECOY: "words REA_PROCESS_RUN_ID=synthetic-decoy",
      });
      children.push(decoy);
      const owned = await startNodeChild({
        REA_PROCESS_RUN_ID: "synthetic-owned",
      });
      children.push(owned);
      const titleMutated = await startNodeChild(
        { REA_PROCESS_RUN_ID: "synthetic-title-mutated" },
        process.execPath,
        ["-e", 'process.title = "npm run check"; setInterval(() => {}, 1_000)'],
      );
      children.push(titleMutated);
      await expect
        .poll(async () => {
          const process = (await host.listProcesses()).find(
            ({ pid }) => pid === titleMutated.pid,
          );
          return process?.command ?? "";
        })
        .toMatch(/^npm run check/u);

      const processes = await host.listProcesses();
      const entries = [decoy, owned, titleMutated].map(({ pid }) => {
        const entry = processes.find((process) => process.pid === pid);
        if (entry === undefined)
          throw new Error("test child is absent from process table");
        return entry;
      });
      const observations = await host.runTokens?.(entries);
      const identities = await host.processIdentities?.(entries);
      expect(observations?.get(decoy.pid)).toEqual({
        state: "readable",
        runId: undefined,
      });
      expect(observations?.get(owned.pid)).toEqual({
        state: "readable",
        runId: "synthetic-owned",
      });
      expect(observations?.get(titleMutated.pid)).toMatchObject({
        state: "unavailable",
        reason: expect.stringMatching(/\S/u),
      });
      expect(identities?.get(decoy.pid)?.state).toBe("readable");
      expect(identities?.get(owned.pid)?.state).toBe("readable");
      expect(identities?.get(titleMutated.pid)?.state).toBe("readable");
    } finally {
      try {
        await Promise.all(children.map(({ child }) => stopNodeChild(child)));
      } finally {
        await host.close?.();
      }
    }
  },
);

it.skipIf(!onDarwin)(
  "reads owned tokens across executable padding and distinguishes a real empty environment",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-process-token-padding-"));
    const host = createSystemProcessOwnershipHost("darwin");
    const children: Awaited<ReturnType<typeof startNodeChild>>[] = [];
    try {
      const executables = [join(root, "n"), join(root, "node")];
      for (const executable of executables)
        await symlink(process.execPath, executable);
      for (let index = 0; index < executables.length; index += 1) {
        const executable = executables[index];
        if (executable === undefined)
          throw new Error("test executable is missing");
        children.push(
          await startNodeChild(
            { REA_PROCESS_RUN_ID: `synthetic-padding-${String(index)}` },
            executable,
            ["-e", "setInterval(() => {}, 1_000)", "", "FOO=bar"],
            index === 0 ? "" : undefined,
          ),
        );
      }
      children.push(await startNodeChild({}));
      const processes = await host.listProcesses();
      const entries = children.map(({ pid }) => {
        const entry = processes.find((process) => process.pid === pid);
        if (entry === undefined)
          throw new Error("owned test child is absent from process table");
        return entry;
      });
      const observations = await host.runTokens?.(entries);
      expect(children.map(({ pid }) => observations?.get(pid))).toEqual([
        { state: "readable", runId: "synthetic-padding-0" },
        { state: "readable", runId: "synthetic-padding-1" },
        { state: "readable" },
      ]);
    } finally {
      for (const { child } of children) await stopNodeChild(child);
      await host.close?.();
      await rm(root, { recursive: true, force: true });
    }
  },
);

const startNodeChild = async (
  environment: NodeJS.ProcessEnv,
  command = process.execPath,
  arguments_: readonly string[] = ["-e", "setInterval(() => {}, 1_000)"],
  argv0?: string,
) => {
  const child = spawn(command, [...arguments_], {
    env: environment,
    stdio: "ignore",
    ...(argv0 === undefined ? {} : { argv0 }),
  });
  if (child.pid === undefined)
    throw new Error("test child did not receive a PID");
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { child, pid: child.pid };
};

const stopNodeChild = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
};
