import { readdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../../../src/process/ProviderProcess.js";
import { UnicornClient } from "../../../src/unicorn/UnicornClient.js";
import type { UnicornBridgeLauncher } from "../../../src/unicorn/UnicornBridge.js";
import { UNICORN_PYTHON_ENV_VAR } from "../../../src/unicorn/UnicornRelease.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

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
  stderrText: string,
  exitCode: number | null,
): ProviderProcessSnapshot => ({
  stdout: { text: "", bytes: 0, observedBytes: 0 },
  stderr: {
    text: stderrText,
    bytes: Buffer.byteLength(stderrText),
    observedBytes: Buffer.byteLength(stderrText),
  },
  exitCode,
  signal: null,
});

/** Fake launcher writing `reply` into the runner's reply path. */
const replyingLauncher = (
  reply: string | null,
  exitCode = 0,
  stderr = "",
): UnicornBridgeLauncher => {
  return async (spawn) => {
    const requestPath = spawn.arguments[3] as string;
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      reply_path: string;
    };
    if (reply !== null)
      await writeFile(request.reply_path, reply, { flag: "wx", mode: 0o600 });
    return snapshot(stderr, exitCode);
  };
};

describe("Unicorn bridge boundary", () => {
  it("rejects malformed bridge output as an output error", async () => {
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      { launcher: replyingLauncher("{not json") },
    );
    const result = await client.execute("emulate_function", addInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  });

  it("rejects a reply whose engine version is not the pinned one", async () => {
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      {
        launcher: replyingLauncher(
          JSON.stringify({
            ok: true,
            stop_reason: "returned",
            return_value: 0,
            registers: {},
            memory_writes: [],
            memory_diff_truncated: false,
            calls_hit: [],
            instructions_executed: 1,
            engine: { name: "unicorn", version: "2.0.0" },
          }),
        ),
      },
    );
    const result = await client.execute("emulate_function", addInput());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisOutputError");
  });

  it("converts a mid-run abort into a cancelled error", async () => {
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
    controller.abort(new Error("boundary abort"));
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
  });

  it("converts a bridge timeout into a timeout error", async () => {
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
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AnalysisTimeoutError);
      if (result.error instanceof AnalysisTimeoutError)
        expect(result.error.timeoutMs).toBe(30_000);
    }
  });

  it("removes the run directory when the bridge crashes", async () => {
    const dir = await createTestTempDirectory("rea-unicorn-boundary-");
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      {
        launcher: replyingLauncher(null, 1, "Traceback: boom"),
        runtimeDirBase: dir,
      },
    );
    const result = await client.execute("emulate_function", addInput());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error._tag).toBe("AnalysisOutputError");
      expect(result.error.capturedOutput?.stderr).toContain("boom");
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a target-identity digest mismatch before spawning", async () => {
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
      function_sha256: "f".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  });

  it("rejects a function image above the input cap", async () => {
    const client = new UnicornClient(
      {},
      {
        launcher: () => {
          throw new Error("must not spawn on oversized input");
        },
      },
    );
    const result = await client.execute("emulate_function", {
      ...addInput(),
      function_bytes: "00".repeat(32 * 1024 * 1024 + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  });

  it("rejects a run whose budgets exceed the address-space cap", async () => {
    const client = new UnicornClient(
      {},
      {
        launcher: () => {
          throw new Error("must not spawn on budget violation");
        },
      },
    );
    const result = await client.execute("emulate_function", {
      ...addInput(),
      budgets: {
        instruction_cap: 1_000_000,
        timeout_ms: 30_000,
        address_space_bytes: 0x1000,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  });
});
