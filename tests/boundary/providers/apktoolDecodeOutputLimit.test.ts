import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ApktoolProvider } from "../../../src/apktool/ApktoolProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  DEFAULT_APKTOOL_DECODE_OUTPUT_BYTES,
  MAX_APKTOOL_DECODE_OUTPUT_BYTES,
} from "../../../src/domain/apktool/apktoolResourceAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const DECODE_OUTPUT = "I: decoding\n".repeat(200);

// A launcher that answers the version probe and writes a fixed amount of
// decode progress before exiting. The POSIX launcher shape is the one the
// sibling apktool boundary tests use.
it.skipIf(process.platform === "win32")(
  "refuses decode output above producer_limits.output_bytes with details.limit for that field",
  async () => {
    const root = await createTestTempDirectory("rea-apktool-decode-output-");
    const command = join(root, "apktool");
    await writeFile(
      command,
      [
        `#!${process.execPath}`,
        `if (process.argv[2] === "--version") process.stdout.write("2.9.3\\n");`,
        `else process.stdout.write(${JSON.stringify(DECODE_OUTPUT)});`,
        "",
      ].join("\n"),
      { mode: 0o700, flag: "wx" },
    );
    const apk = join(root, "probe.apk");
    await writeFile(apk, "apk-bytes");
    const provider = new ApktoolProvider({
      environment: { REA_APKTOOL_COMMAND: command },
    });
    try {
      const outcome = await provider.execute({
        operation: "decode_android_resources",
        input: {
          path: apk,
          include_strings: false,
          producer_limits: { output_bytes: 64 },
        },
      });
      if (outcome.ok) throw new Error("Expected the decode output refusal");
      const projected = projectAnalysisError(outcome.error);
      expect(projected).toMatchObject({
        code: "resource_constraint",
        details: { reported_limits: { max_output_bytes: 64 } },
      });
      expect(projected.details?.limit).toEqual({
        control_kind: "parameter",
        parameter: "producer_limits.output_bytes",
        effective_value: 64,
        unit: "bytes",
        minimum: 1,
        maximum: MAX_APKTOOL_DECODE_OUTPUT_BYTES,
        default_value: DEFAULT_APKTOOL_DECODE_OUTPUT_BYTES,
        applies_at: "next_call",
      });
      expect(projected.details).not.toHaveProperty("refusal");
    } finally {
      await provider.close();
    }
  },
);
