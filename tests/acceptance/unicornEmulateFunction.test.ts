import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { auxiliaryAnalysisProviderDeclarations } from "../../src/composition/auxiliaryAnalysisProviders.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  emulateFunctionInputSchema,
  emulateFunctionOutputSchema,
} from "../../src/contracts/unicorn/unicornToolContracts.js";
import type { ProviderProcessSnapshot } from "../../src/process/ProviderProcess.js";
import { UnicornClient } from "../../src/unicorn/UnicornClient.js";
import type { UnicornBridgeLauncher } from "../../src/unicorn/UnicornBridge.js";
import { UNICORN_PYTHON_ENV_VAR } from "../../src/unicorn/UnicornRelease.js";

const CODE = 0x1000000;
const STACK = 0x7f000000;

const snapshot = (): ProviderProcessSnapshot => ({
  stdout: { text: "", bytes: 0, observedBytes: 0 },
  stderr: { text: "", bytes: 0, observedBytes: 0 },
  exitCode: 0,
  signal: null,
});

/** Fake launcher: runs no engine; writes the canned reply into the reply path. */
const replyingLauncher = (reply: unknown): UnicornBridgeLauncher => {
  return async (spawn) => {
    const requestPath = spawn.arguments[3] as string;
    const request = JSON.parse(await readFile(requestPath, "utf8")) as {
      reply_path: string;
    };
    await writeFile(request.reply_path, JSON.stringify(reply), {
      flag: "wx",
      mode: 0o600,
    });
    return snapshot();
  };
};

describe("emulate_function acceptance", () => {
  it("is a registered native-provider contract that needs no active target", () => {
    const contract = toolContract("emulate_function");
    expect(contract.name).toBe("emulate_function");
    expect(contract.kind).toBe("native-provider");
    expect(contract.requiresActiveTarget).toBe(false);
  });

  it("is declared by the unicorn auxiliary provider", () => {
    const declaration = auxiliaryAnalysisProviderDeclarations({}, "linux").find(
      (entry) => entry.identity.id === "unicorn",
    );
    expect(declaration).toBeDefined();
    expect(
      declaration!.capabilities.map((capability) => capability.operation),
    ).toEqual(["emulate_function"]);
  });

  it("runs the contract example through the client and validates the output", async () => {
    const contract = toolContract("emulate_function");
    const input = emulateFunctionInputSchema.parse(contract.examples[0]!.input);
    const registers: Record<string, number> = {};
    for (const [name, value] of Object.entries(input.registers))
      if (value !== undefined) registers[name] = value;
    const client = new UnicornClient(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      {
        launcher: replyingLauncher({
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
        }),
      },
    );
    const result = await client.execute("emulate_function", {
      architecture: input.architecture,
      function_bytes: input.function_bytes,
      code_address: input.code_address,
      registers,
      stack_address: input.stack_address,
      stack_size: input.stack_size,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = emulateFunctionOutputSchema.parse(result.value.result);
    expect(output.stop_reason).toBe("returned");
    expect(output.return_value).toBe(42);
    expect(result.value.provider.id).toBe("unicorn");
    expect(result.value.limitations.length).toBeGreaterThan(0);
    void CODE;
  });
});
