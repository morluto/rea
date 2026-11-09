import { expect, it } from "vitest";
import { jsonObjectSchema } from "../../../domain/jsonValue.js";
import { runOwnedCommand } from "../../../process/OwnedCommand.js";
import { validateNativeAotReport } from "./NativeAotReport.js";

it.skipIf(!process.env.JAVA_HOME || !process.env.GSON_JAR)(
  "accepts transaction reports from the Java producer with controlled APIs",
  async () => {
    const output = await runOwnedCommand(
      {
        command: "python3",
        arguments: ["-S", "tests/fixtures/nativeaot-producer/run.py", "--json"],
        runId: "rea-nativeaot-producer-test",
        expectedCommand: null,
      },
      { timeoutMs: 75_000, diagnosticBytes: 1024 * 1024 },
    );
    const reports = JSON.parse(output.stdout.text) as Array<{
      status: "failed" | "partial" | "complete";
      reason: string | null;
      [key: string]: unknown;
    }>;
    expect(reports.map(({ status }) => status)).toEqual([
      "failed",
      "failed",
      "complete",
      "partial",
    ]);
    for (const report of reports)
      expect(
        validateNativeAotReport({
          id: "nativeaot",
          sha256: "0".repeat(64),
          status: report.status,
          reason: report.reason,
          result: jsonObjectSchema.parse(report),
        }),
      ).toBeNull();
  },
  90_000,
);
