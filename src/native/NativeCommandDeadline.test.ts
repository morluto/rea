import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { fat } from "../domain/binaryTarget.fixture.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  NativeFixtureRunner,
  nativeMachoTargetForFile,
} from "../../tests/fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import type {
  NativeCommandOptions,
  NativeCommandRunner,
} from "./CommandRunner.js";
import { XcrunCommandRunner } from "./CommandRunner.js";
import { DEFAULT_NATIVE_COMMAND_TIMEOUT_MS } from "../domain/native/nativeDeadlines.js";
import { NativeMacOSProvider } from "./NativeMacOSProvider.js";

vi.mock("../process/OwnedCommand.js", async (original) => ({
  ...(await original<typeof import("../process/OwnedCommand.js")>()),
  runOwnedCommand: vi.fn(),
}));

afterEach(() => {
  vi.mocked(runOwnedCommand).mockReset();
});

class RecordingRunner implements NativeCommandRunner {
  readonly calls: { tool: string; timeoutMs: number | undefined }[] = [];
  readonly #inner = new NativeFixtureRunner();

  run(
    tool: string,
    arguments_: readonly string[],
    options: NativeCommandOptions,
  ) {
    this.calls.push({ tool, timeoutMs: options.timeoutMs });
    return this.#inner.run(tool, arguments_, options);
  }
}

const execute = async (
  runner: NativeCommandRunner,
  parameters: Readonly<Record<string, JsonValue>>,
  operation: "list_architectures" | "inspect_signature" = "list_architectures",
) => {
  const root = await createTestTempDirectory("rea-native-deadline-");
  const path = join(root, "app");
  await writeFile(path, fat([0x01000007, 0x0100000c]));
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    await nativeMachoTargetForFile(path),
  );
  try {
    return await client.execute(operation, parameters);
  } finally {
    expect((await client.close()).ok).toBe(true);
  }
};

// Signature inspection reads display, requirements and entitlements, then both
// architecture states in the authored universal Mach-O fixture.
const commandCases = [
  { operation: "list_architectures", tools: ["lipo"] },
  {
    operation: "inspect_signature",
    tools: ["codesign", "codesign", "codesign", "codesign", "codesign"],
  },
] as const;

describe("native_command_timeout_ms", () => {
  it.each(commandCases)(
    "uses 60000 ms for every $operation command when the caller omits the setting",
    async ({ operation, tools }) => {
      const runner = new RecordingRunner();
      const result = await execute(runner, {}, operation);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(runner.calls).toEqual(
        tools.map((tool) => ({ tool, timeoutMs: 60_000 })),
      );
      expect(DEFAULT_NATIVE_COMMAND_TIMEOUT_MS).toBe(60_000);
    },
  );

  it.each(commandCases)(
    "passes a selected deadline through every $operation command",
    async ({ operation, tools }) => {
      const runner = new RecordingRunner();
      const result = await execute(
        runner,
        { native_command_timeout_ms: 1_500 },
        operation,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(runner.calls).toEqual(
        tools.map((tool) => ({ tool, timeoutMs: 1_500 })),
      );
    },
  );

  it("passes the selected deadline through production xcrun resolution", async () => {
    const calls: {
      command: string;
      arguments: readonly string[];
      timeoutMs: number | null;
    }[] = [];
    vi.mocked(runOwnedCommand).mockImplementation(async (spawn, limits) => {
      calls.push({
        command: spawn.command,
        arguments: spawn.arguments,
        timeoutMs: limits.timeoutMs,
      });
      throw new OwnedCommandFailure("timeout", "Command deadline elapsed.");
    });
    const runner = new XcrunCommandRunner({});
    const result = await runner.run("lipo", ["-info", "/fixture/app"], {
      timeoutMs: 120_000,
    });
    if (result.ok) throw new Error("expected resolution timeout");
    expect(result.error.reason).toBe("timeout");
    expect(calls).toEqual([
      {
        command: "/usr/bin/xcrun",
        arguments: ["--find", "lipo"],
        timeoutMs: 120_000,
      },
    ]);
  });

  it("uses 60000 ms for xcrun resolution when the caller omits the deadline", async () => {
    const timeouts: (number | null)[] = [];
    vi.mocked(runOwnedCommand).mockImplementation(async (_spawn, limits) => {
      timeouts.push(limits.timeoutMs);
      throw new OwnedCommandFailure("timeout", "Command deadline elapsed.");
    });
    const runner = new XcrunCommandRunner({});
    const result = await runner.run("file", ["--brief", "/fixture/app"], {});
    expect(result.ok).toBe(false);
    expect(timeouts).toEqual([60_000]);
  });

  it("rejects an out-of-range deadline before launching a command", async () => {
    const runner = new RecordingRunner();
    const result = await execute(runner, { native_command_timeout_ms: 0 });
    if (result.ok) throw new Error("expected an invalid deadline");
    expect(runner.calls).toEqual([]);
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["native_command_timeout_ms"],
            reason: "out_of_range",
            minimum: 1,
            maximum: 2_147_483_647,
          },
        ],
      },
    });
  });
});
