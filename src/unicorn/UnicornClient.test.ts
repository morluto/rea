import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { UNICORN_PYTHON_ENV_VAR } from "./UnicornRelease.js";
import { UnicornClient } from "./UnicornClient.js";
import type { UnicornBridgeLauncher } from "./UnicornBridge.js";

const CODE = 0x1000000;
const STACK = 0x7f000000;

const addInput = () => ({
  architecture: "x86_64",
  function_bytes: "89f801f0c3",
  code_address: CODE,
  registers: { rdi: 40, rsi: 2 },
  stack_address: STACK,
  stack_size: 65536,
});

const snapshot = (
  stdoutText: string,
  stderrText: string,
  exitCode: number | null,
): ProviderProcessSnapshot => ({
  stdout: {
    text: stdoutText,
    bytes: Buffer.byteLength(stdoutText),
    observedBytes: Buffer.byteLength(stdoutText),
  },
  stderr: {
    text: stderrText,
    bytes: Buffer.byteLength(stderrText),
    observedBytes: Buffer.byteLength(stderrText),
  },
  exitCode,
  signal: null,
});

const successReply = (overrides: Record<string, unknown> = {}) => ({
  ok: true,
  stop_reason: "returned",
  return_value: 42,
  registers: {
    rax: 42,
    rdi: 40,
    rsi: 2,
    rsp: STACK + 65536 - 8,
    rip: 0x0badf00d,
  },
  memory_writes: [],
  memory_diff_truncated: false,
  calls_hit: [],
  instructions_executed: 3,
  engine: { name: "unicorn", version: "2.1.2" },
  ...overrides,
});

/** Fake launcher: writes the canned reply into the runner's reply path. */
const replyingLauncher = (
  reply: unknown,
  options: { exitCode?: number; stderr?: string } = {},
): UnicornBridgeLauncher => {
  return async (spawn) => {
    const requestPath = spawn.arguments[3] as string;
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      reply_path: string;
    };
    if (options.exitCode === undefined || options.exitCode === 0)
      await writeFile(
        request.reply_path,
        typeof reply === "string" ? reply : JSON.stringify(reply),
        { flag: "wx", mode: 0o600 },
      );
    return snapshot("", options.stderr ?? "", options.exitCode ?? 0);
  };
};

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "rea-unicorn-client-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("UnicornClient", () => {
  it("maps a successful run to an AnalysisExecution with baseline limitations", async () => {
    await withTempDir(async (dir) => {
      const client = new UnicornClient(
        { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
        { launcher: replyingLauncher(successReply()), runtimeDirBase: dir },
      );
      const result = await client.execute("emulate_function", addInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = result.value.result as Record<string, unknown>;
      expect(output["stop_reason"]).toBe("returned");
      expect(output["return_value"]).toBe(42);
      expect(result.value.provider.id).toBe("unicorn");
      expect(result.value.limitations.join(" ")).toMatch(/No operating system/);
      expect(result.value.limitations.join(" ")).not.toMatch(/stopped early/);
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("adds run-specific limitations for early stops and stubbed calls", async () => {
    await withTempDir(async (dir) => {
      const client = new UnicornClient(
        { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
        {
          launcher: replyingLauncher(
            successReply({
              stop_reason: "unmapped_access",
              return_value: null,
              calls_hit: [
                {
                  kind: "syscall",
                  address: null,
                  number: 60,
                  arguments: { rdi: 0 },
                  stubbed: true,
                  returned: 0,
                },
              ],
            }),
          ),
          runtimeDirBase: dir,
        },
      );
      const result = await client.execute("emulate_function", addInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const limitations = result.value.limitations.join(" ");
      expect(limitations).toMatch(/stopped early: unmapped_access/);
      expect(limitations).toMatch(/1 import\/syscall call\(s\) were stubbed/);
    });
  });

  it("answers health with the provider identity and no run", async () => {
    const client = new UnicornClient(
      {},
      {
        launcher: () => {
          throw new Error("health must not spawn");
        },
      },
    );
    const result = await client.execute("health", {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.provider.id).toBe("unicorn");
    expect(result.value.result).toBeNull();
  });
});

describe("UnicornClient failures", () => {
  it("rejects unknown operations", async () => {
    const client = new UnicornClient({});
    const result = await client.execute("analyze_function", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
  });

  it("rejects schema-invalid input without spawning", async () => {
    const client = new UnicornClient(
      {},
      {
        launcher: () => {
          throw new Error("must not spawn on invalid input");
        },
      },
    );
    const result = await client.execute("emulate_function", {
      ...addInput(),
      architecture: "aarch64",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  });

  it("rejects a function digest mismatch without spawning", async () => {
    const client = new UnicornClient(
      {},
      {
        launcher: () => {
          throw new Error("must not spawn on digest mismatch");
        },
      },
    );
    const result = await client.execute("emulate_function", {
      ...addInput(),
      function_sha256: "0".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  });

  it("maps a bridge version-mismatch reply to unavailable", async () => {
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      {
        launcher: replyingLauncher({
          ok: false,
          reason: "version_mismatch",
          message: "unicorn version 2.0.0 does not match the pinned 2.1.2",
        }),
      },
    );
    const result = await client.execute("emulate_function", addInput());
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
  });

  it("maps a malformed bridge reply to an output error", async () => {
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      { launcher: replyingLauncher("this is not json{") },
    );
    const result = await client.execute("emulate_function", addInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  });

  it("maps a bridge crash to an output error carrying stderr", async () => {
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      {
        launcher: replyingLauncher(null, {
          exitCode: 1,
          stderr: "Traceback: boom",
        }),
      },
    );
    const result = await client.execute("emulate_function", addInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisOutputError");
      expect(result.error.capturedOutput?.stderr).toContain("boom");
    }
  });
});

describe("UnicornClient lifecycle", () => {
  it("maps a bridge timeout to a timeout error", async () => {
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      {
        launcher: () => {
          throw new OwnedCommandFailure("timeout", "deadline elapsed", null);
        },
      },
    );
    const result = await client.execute("emulate_function", addInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisTimeoutError");
  });

  it("maps mid-run cancellation to a cancelled error", async () => {
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      {
        launcher: (_spawn, _timeoutMs, signal) =>
          new Promise<never>((_resolve, reject) => {
            const fail = () => {
              reject(
                new OwnedCommandFailure("cancelled", "cancelled", null, null, {
                  cancellation: { reason: signal?.reason },
                }),
              );
            };
            if (signal?.aborted === true) {
              fail();
              return;
            }
            signal?.addEventListener("abort", fail, { once: true });
          }),
      },
    );
    const controller = new AbortController();
    const pending = client.execute("emulate_function", addInput(), {
      signal: controller.signal,
    });
    controller.abort(new Error("test abort"));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
  });

  it("maps a pre-aborted signal to a cancelled error without spawning", async () => {
    const client = new UnicornClient(
      {},
      {
        launcher: () => {
          throw new Error("must not spawn when already aborted");
        },
      },
    );
    const controller = new AbortController();
    controller.abort();
    const result = await client.execute("emulate_function", addInput(), {
      signal: controller.signal,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
  });

  it("removes its run directory after a bridge crash", async () => {
    await withTempDir(async (dir) => {
      const client = new UnicornClient(
        { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
        {
          launcher: replyingLauncher(null, { exitCode: 1, stderr: "boom" }),
          runtimeDirBase: dir,
        },
      );
      const result = await client.execute("emulate_function", addInput());
      expect(result.ok).toBe(false);
      expect(await readdir(dir)).toEqual([]);
    });
  });

  it("closes cleanly", async () => {
    const client = new UnicornClient({});
    expect((await client.close()).ok).toBe(true);
  });
});
