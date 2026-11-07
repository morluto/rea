import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, onTestFinished } from "vitest";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { z } from "zod";

const workerRecord = z.object({
  kind: z.literal("worker"),
  root: z.string(),
  leaderPid: z.number().int().positive(),
  processGroupId: z.number().int().positive(),
  runId: z.string(),
});

cliTest.skipIf(process.platform === "win32").for([
  ["analyze", "deny"],
  ["analyze-javascript-application", "deny"],
  ["analyze", "cancel"],
  ["analyze-javascript-application", "cancel"],
  ["analyze", "normal"],
  ["analyze-javascript-application", "normal"],
] as const)(
  "finalizes %s before delivering its %s outcome",
  async ([command, mode], { processes }) => {
    const root = await createTestTempDirectory("rea-inspection-cli-");
    const trace = join(root, "inspection.txt");
    onTestFinished(async () => {
      const records = (await readFile(trace, "utf8")).trim().split("\n");
      for (const record of records) {
        const parsed = workerRecord.safeParse(JSON.parse(record));
        if (!parsed.success) continue;
        expect(await cleanupOwnedProcessGroup(parsed.data)).toMatchObject({
          cleaned: true,
        });
        await rm(parsed.data.root, { recursive: true, force: true });
      }
    });
    await writeFile(join(root, "app.mjs"), "export const observed = 7;");
    const result = await processes.run(
      process.execPath,
      [
        "--import",
        resolve("tests/fixtures/javascriptInspectionPreload.mjs"),
        resolve("scripts/rea.mjs"),
        command,
        root,
        "--json",
      ],
      {
        env: {
          ...process.env,
          REA_INSPECTION_TRACE: trace,
          REA_INSPECTION_MODE: mode,
        },
        timeoutMs: 30_000,
      },
    );
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stderr).not.toContain("Failed to close CLI resources:");
    if (mode === "normal") {
      expect(result.exitCode, result.stderr).toBe(0);
      expect(parseEvidence(JSON.parse(result.stdout)).operation).toBe(
        "analyze_javascript_application",
      );
      return;
    }
    expect(result.exitCode, result.stderr).toBe(mode === "deny" ? 1 : 130);
    const failure = analysisErrorProjectionSchema.parse(
      JSON.parse(result.stdout),
    );
    expect(failure.code).toBe(
      mode === "deny" ? "cleanup_incomplete" : "cancelled",
    );
    if (mode === "deny") {
      expect(await readFile(trace, "utf8")).toContain('"kind":"denied"');
      expect(failure.details).toMatchObject({
        cleanup: "incomplete",
        diagnostics: {
          inspection: {
            capability: "process_table",
            command: "ps",
            system_code: "EPERM",
          },
        },
      });
      expect(failure.remediation.action).toContain("ps");
    }
    expect(parseEvidence(failure.details?.partial_observation)).toMatchObject({
      operation: "analyze_javascript_application",
      subject: { local_path: root },
    });
  },
);
