import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { AnalysisSettings } from "../../../src/application/AnalysisSettings.js";
import { createRizinCoverageHarness } from "./RizinDebugSessionCoverage.fixtures.js";

it.skipIf(process.platform === "win32")(
  "identifies missing or unusable inferior terminals before spawning Rizin",
  async () => {
    const root = await createTestTempDirectory("rea-rizin-tty-rejection-");
    const regular = join(root, "regular");
    await writeFile(regular, "not a terminal");
    const manager = new RizinDebugSessionManager(
      {},
      {
        platform: "linux",
        spawnProcess: () => {
          throw new Error("TTY refusal must precede spawn");
        },
      },
    );
    for (const [path, reason] of [
      [undefined, "An explicit non-empty inferior_tty path is required"],
      ["", "An explicit non-empty inferior_tty path is required"],
      [join(root, "missing"), "ENOENT"],
      [regular, "not a character TTY"],
      ["/dev/null", "not a character TTY"],
    ] as const) {
      const input = {
        path: regular,
        ...(path === undefined ? {} : { inferior_tty: path }),
      } as Parameters<RizinDebugSessionManager["start"]>[0];
      const result = await manager.start(input);
      if (result.ok) throw new Error("Invalid terminal was admitted");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["inferior_tty"],
              reason: "invalid_value",
              message: expect.stringContaining(reason),
            },
          ],
        },
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "recovers Rizin command capacity after either runtime cap exposes an invalid seed",
  async () => {
    const harness = createRizinCoverageHarness();
    const environment = {
      REA_DEBUGGER_COMMAND_DEADLINE_MS: "invalid",
      REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES: "invalid",
      REA_DEBUGGER_MAX_PENDING_COMMANDS: "1",
    };
    const caps = [
      {
        setting: "debugger.command_deadline_ms",
        seed: "REA_DEBUGGER_COMMAND_DEADLINE_MS",
        value: 5000,
      },
      {
        setting: "debugger.max_command_output_bytes",
        seed: "REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES",
        value: 4096,
      },
    ];
    const settings = new AnalysisSettings(environment);
    const set = ({ setting, value }: (typeof caps)[number]) =>
      expect(
        settings.update({ changes: [{ setting, action: "set", value }] }).ok,
      ).toBe(true);
    for (const cap of caps) set(cap);
    try {
      const provider = await harness.makeProvider(`process.stdout.write("\\0");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
 input += chunk;
 for (;;) {
  const end = input.indexOf("\\n"); if (end < 0) break;
  const line = input.slice(0,end); input = input.slice(end+1);
  if (line.startsWith("!echo ")) process.stdout.write(line.slice(6) + "\\0");
  else if (line === "refused") process.stdout.write("unexpected command\\0");
  else if (line === "dr") process.stdout.write("ok\\0");
 }
});`);
      const { manager, sessionId } = await harness.start(
        provider,
        {},
        environment,
      );
      const execute = (command: string) =>
        settings.run(() => manager.execute(sessionId, command));
      for (const { setting, seed, value } of caps) {
        expect(
          settings.update({ changes: [{ setting, action: "reset" }] }).ok,
        ).toBe(true);
        expect(await execute("refused")).toMatchObject({
          ok: false,
          error: { _tag: "ConfigurationError", settings: [{ setting: seed }] },
        });
        set({ setting, seed, value });
        const retried = await execute("dr");
        if (!retried.ok) throw retried.error;
        expect(retried.value.result.output).toBe("ok");
      }
      expect(manager.status(sessionId)?.recent_output).not.toContain(
        "unexpected command",
      );
    } finally {
      await harness.cleanup();
    }
  },
);
