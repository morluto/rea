import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";

processTest.for(["none", "client", "transport", "both", "early"])(
  "preserves native verifier failure and cleanup ownership (fault: $0)",
  async (fault, { processes }) => {
    const result = await processes.run(process.execPath, [
      "--experimental-vm-modules",
      fileURLToPath(
        new URL(
          "../../fixtures/nativeValueVerifierCleanup.mjs",
          import.meta.url,
        ),
      ),
      fault,
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      fault,
      primaryPreserved: true,
    });
  },
);

processTest(
  "finishes IDA verifier cleanup without replacing the analysis failure",
  async ({ processes }) => {
    const result = await processes.run(process.execPath, [
      "--experimental-vm-modules",
      fileURLToPath(
        new URL("../../fixtures/idaVerifierCleanup.mjs", import.meta.url),
      ),
    ]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(2);
  },
);
