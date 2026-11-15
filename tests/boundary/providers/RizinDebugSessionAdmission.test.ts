import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RizinDebugSessionManager } from "../../../src/rizin/RizinDebugSessionManager.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { AnalysisSettings } from "../../../src/application/AnalysisSettings.js";
import { createRizinCoverageHarness } from "./RizinDebugSessionCoverage.fixtures.js";

it.skipIf(process.platform === "win32")(
  "identifies the rejected TTY field and physical reason before spawning Rizin",
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
      [join(root, "missing"), "ENOENT"],
      [regular, "not a character TTY"],
      ["/dev/null", "not a character TTY"],
    ]) {
      const result = await manager.start({
        path: regular,
        inferior_tty: path!,
      });
      if (result.ok) throw new Error("Invalid terminal was admitted");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["inferior_tty"],
              message: expect.stringContaining(reason!),
            },
          ],
        },
      });
    }
  },
);

it.skipIf(process.platform === "win32").each([
  ["debugger.command_deadline_ms", "REA_DEBUGGER_COMMAND_DEADLINE_MS", 5000],
  [
    "debugger.max_command_output_bytes",
    "REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES",
    4096,
  ],
] as const)(
  "releases command capacity after an invalid %s is reset",
  async (setting, environmentName, value) => {
    const harness = createRizinCoverageHarness();
    const environment = {
      [environmentName]: "invalid",
      REA_DEBUGGER_MAX_PENDING_COMMANDS: "1",
    };
    const settings = new AnalysisSettings(environment);
    const set = () =>
      settings.update({ changes: [{ setting, action: "set", value }] });
    expect(set().ok).toBe(true);
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
  else if (line === "dr") process.stdout.write("ok\\0");
 }
});`);
      const { manager, sessionId } = await harness.start(
        provider,
        {},
        environment,
      );
      expect(
        (await settings.run(() => manager.execute(sessionId, "dr"))).ok,
      ).toBe(true);
      expect(
        settings.update({ changes: [{ setting, action: "reset" }] }).ok,
      ).toBe(true);
      await expect(
        settings.run(() => manager.execute(sessionId, "dr")),
      ).resolves.toMatchObject({
        ok: false,
        error: { _tag: "ConfigurationError" },
      });
      expect(set().ok).toBe(true);
      const retried = await settings.run(() =>
        manager.execute(sessionId, "dr"),
      );
      expect(retried).toMatchObject({
        ok: true,
        value: { result: { output: "ok" } },
      });
    } finally {
      await harness.cleanup();
    }
  },
);
