import { access, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { WabtArtifactProvider } from "./WabtArtifactProvider.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { PrivateRuntimeRootUnavailableError } from "../process/PrivateRuntimeRootUnavailableError.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

const fileCloseFailure = vi.hoisted(() => ({
  selectedPath: "",
  attempts: 0,
  failFirst: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]) !== fileCloseFailure.selectedPath) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        fileCloseFailure.attempts += 1;
        if (fileCloseFailure.failFirst) {
          fileCloseFailure.failFirst = false;
          throw new Error("injected WABT input close failure");
        }
        return close();
      };
      return handle;
    },
  };
});

const failureTags: Readonly<Record<string, string>> = {
  invalid: "AnalysisInputError",
  timeout: "AnalysisTimeoutError",
  cancelled: "AnalysisCancelledError",
  "changed-snapshot": "AnalysisArtifactChangedError",
  cleanup: "ProviderAdapterError",
  malformed: "AnalysisOutputError",
  "malformed-wat": "AnalysisOutputError",
  "wat-warning": "AnalysisOutputError",
};

const assertCleanupRecovery = async (options: {
  readonly provider: WabtArtifactProvider;
  readonly result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>;
  readonly path: string;
  readonly runtimePath: string;
  readonly cleanupAttempts: () => number;
  readonly runtimeCreations: () => number;
}): Promise<void> => {
  expect(options.result).toMatchObject({
    error: {
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
      partialObservation: { normalized_result: { validation: "valid" } },
    },
  });
  await expect(access(options.runtimePath)).resolves.toBeUndefined();
  const blocked = await options.provider.inspect({
    path: options.path,
    glue_paths: [],
    candidate_paths: [],
  });
  expect(blocked).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cleanupResources: [options.runtimePath],
    },
  });
  expect(options.cleanupAttempts()).toBe(2);
  expect(options.runtimeCreations()).toBe(1);
  await options.provider.close();
  expect(options.cleanupAttempts()).toBe(3);
  await expect(access(options.runtimePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
};

const assertModeOutcome = (
  mode: string,
  result: Awaited<ReturnType<WabtArtifactProvider["inspect"]>>,
  path: string,
): void => {
  if (mode === "success")
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: {
          artifact: { path, bytes: 76 },
          validation: "valid",
          runtime_execution: "not-performed",
        },
      },
    });
  else
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: failureTags[mode] },
    });
  if (mode === "invalid")
    expect(result).toMatchObject({
      error: { capturedOutput: { stderr: "module.wasm: invalid bytes\n" } },
    });
  if (mode === "malformed-wat" || mode === "wat-warning")
    expect(result).toMatchObject({
      error: {
        capturedOutput: {
          stdout:
            mode === "malformed-wat"
              ? "unexpected decoder output\n"
              : '(module (@custom "test" "payload"))\n',
          stderr: mode === "wat-warning" ? "decoder warning\n" : "",
        },
      },
    });
};

it("returns actionable unavailable without creating a workspace when tools are absent", async () => {
  const provider = new WabtArtifactProvider({}, undefined, () => {
    throw new Error("Must not allocate");
  });
  expect(
    await provider.inspect({
      path: "/module.wasm",
      glue_paths: [],
      candidate_paths: [],
    }),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisCapabilityUnavailableError",
      userMessage: expect.stringContaining("REA_WABT_BIN_DIRECTORY"),
    },
  });
});

it("retries a retained input descriptor before admitting the next WABT operation", async () => {
  const root = await createTestTempDirectory("rea-wabt-read-cleanup-");
  const path = join(root, "selected.wasm");
  await writeFile(path, Buffer.alloc(76, 1));
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(join(root, tool), "source-owned executable seam", {
      mode: 0o700,
    });
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: root },
    async (input) => {
      const version = input.arguments[0] === "--version";
      const stdout = version
        ? "1.0.42\n"
        : input.command.includes("wasm-objdump")
          ? dump
          : input.command.includes("wasm2wat")
            ? '(module (@custom "test" "payload"))\n'
            : "";
      const launched = await spawnOwnedProviderProcess({
        ...input,
        command: process.execPath,
        arguments: [
          "-e",
          `process.stdout.write(${JSON.stringify(stdout)}); process.exit(0);`,
        ],
        expectedCommand: null,
      });
      return launched;
    },
  );
  fileCloseFailure.selectedPath = path;
  fileCloseFailure.attempts = 0;
  fileCloseFailure.failFirst = true;
  try {
    const first = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [path],
        cause: { message: "injected WABT input close failure" },
      },
    });
    expect(fileCloseFailure.attempts).toBe(1);

    const retried = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(retried.ok).toBe(true);
    expect(fileCloseFailure.attempts).toBeGreaterThan(1);

    fileCloseFailure.failFirst = true;
    const closeRetry = await provider.inspect({
      path,
      candidate_paths: [],
      glue_paths: [],
    });
    expect(closeRetry).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true, cleanupResources: [path] },
    });
    const beforeClose = fileCloseFailure.attempts;
    await provider.close();
    expect(fileCloseFailure.attempts).toBeGreaterThan(beforeClose);
  } finally {
    fileCloseFailure.selectedPath = "";
    fileCloseFailure.failFirst = false;
    await provider.close();
  }
});

it.each([false, true])(
  "reports an unavailable private runtime root with retryable=%s without a misleading WABT remediation",
  async (retryable) => {
    const toolRoot = await createTestTempDirectory("rea-wabt-tool-root-");
    for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
      await writeFile(
        join(toolRoot, tool + (process.platform === "win32" ? ".exe" : "")),
        "source-owned executable seam",
        { mode: 0o700 },
      );
    const provider = new WabtArtifactProvider(
      { REA_WABT_BIN_DIRECTORY: toolRoot },
      undefined,
      () => {
        throw new PrivateRuntimeRootUnavailableError(
          "REA Windows native controls are unavailable: probe failure",
          { retryable },
        );
      },
    );
    const result = await provider.inspect({
      path: "/module.wasm",
      glue_paths: [],
      candidate_paths: [],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
        retryable,
        userMessage: undefined,
        message: expect.stringContaining(
          "REA Windows native controls are unavailable",
        ),
      },
    });
    if (result.ok)
      throw new Error("Unavailable runtime must refuse inspection");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "capability_unavailable",
      retryable,
      category: retryable ? "unavailable" : "unsupported_provider",
    });
  },
);
it.each([
  "success",
  "invalid",
  "malformed",
  "timeout",
  "cancelled",
  "cleanup",
  "changed-snapshot",
  "malformed-wat",
  "wat-warning",
])("owns private artifact bytes and retains %s outcome", async (mode) => {
  const selectedRoot = await createTestTempDirectory("rea-wabt-seam-");
  const path = join(selectedRoot, "selected.wasm");
  const bytes = Buffer.alloc(76, 1);
  await writeFile(path, bytes);
  for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"])
    await writeFile(
      join(selectedRoot, tool + (process.platform === "win32" ? ".exe" : "")),
      "source-owned executable seam",
      { mode: 0o700 },
    );
  const dump = await readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
  let runtimePath = "";
  let runtimeCreations = 0;
  let acquiredPid: number | undefined;
  let cleanupAttempts = 0;
  const controller = new AbortController();
  const provider = new WabtArtifactProvider(
    { REA_WABT_BIN_DIRECTORY: selectedRoot },
    async (input) => {
      const version = input.arguments[0] === "--version";
      if (!version) {
        expect(await readFile(join(input.cwd ?? "", "module.wasm"))).toEqual(
          bytes,
        );
        if (mode === "changed-snapshot") {
          const snapshot = join(input.cwd ?? "", "module.wasm");
          await chmod(snapshot, 0o600);
          await writeFile(snapshot, Buffer.alloc(76, 2));
        }
        if (mode === "timeout")
          throw new OwnedCommandFailure(
            "timeout",
            "Source-owned deadline seam",
          );
      }
      const stdout = version
        ? "1.0.42\n"
        : input.command.includes("objdump")
          ? mode === "malformed"
            ? "unexpected producer output"
            : dump
          : input.command.includes("wasm2wat")
            ? mode === "malformed-wat"
              ? "unexpected decoder output\n"
              : '(module (@custom "test" "payload"))\n'
            : "";
      const invalid = !version && mode === "invalid";
      const stderr = invalid
        ? "module.wasm: invalid bytes\n"
        : !version &&
            input.command.includes("wasm2wat") &&
            mode === "wat-warning"
          ? "decoder warning\n"
          : "";
      const script =
        !version && mode === "cancelled"
          ? "setInterval(() => undefined, 1000)"
          : `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)}); process.exit(${invalid ? 1 : 0});`;
      const launched = await spawnOwnedProviderProcess({
        ...input,
        command: process.execPath,
        arguments: ["-e", script],
        expectedCommand: null,
      });
      if (!version && mode === "cancelled") {
        acquiredPid = launched.process.pid;
        setImmediate(() => controller.abort());
      }
      return launched;
    },
    async () => {
      runtimeCreations += 1;
      const root = await PrivateRuntimeRoot.create({
        prefix: "rea-wabt-owned-test-",
      });
      runtimePath = root.path;
      return {
        path: root.path,
        close: async () => {
          if (mode === "cleanup" && ++cleanupAttempts <= 2)
            throw new Error("Source-owned cleanup uncertainty");
          await root.close();
        },
      };
    },
  );
  const result = await provider.inspect(
    { path, glue_paths: [], candidate_paths: [] },
    { signal: controller.signal },
  );
  assertModeOutcome(mode, result, path);
  if (mode === "cleanup") {
    await assertCleanupRecovery({
      provider,
      result,
      path,
      runtimePath,
      cleanupAttempts: () => cleanupAttempts,
      runtimeCreations: () => runtimeCreations,
    });
  }
  await expect(access(runtimePath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path)).toEqual(bytes);
  if (acquiredPid !== undefined) {
    const pid = acquiredPid;
    expect(() => process.kill(pid, 0)).toThrow();
  }
});
