import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
} as const;

describe.skipIf(process.platform !== "darwin")(
  "inspect-macho Evidence delivery",
  () => {
    cliTest(
      "delivers a summary beside the complete Evidence bundle the contract's detail selects",
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-macho-delivery-");
        const target = join(root, "program");
        await copyFile("/usr/bin/true", target);
        const destination = join(root, "inspection.json");
        const result = await cli.run({
          arguments: [
            "inspect-macho",
            target,
            "--detail",
            "summary",
            "--evidence_output",
            destination,
            "--json",
          ],
          environment,
        });
        expect(result.exitCode, result.stdout).toBe(0);
        const bytes = await readFile(destination);
        const [record] = parseEvidenceBundle(
          JSON.parse(bytes.toString()),
        ).records;
        expect(record).toMatchObject({ operation: "inspect_macho" });
        expect(result.json).toMatchObject({
          evidence_bundle: { path: destination, bytes: bytes.length },
          summary: { operation: "inspect_analysis_view" },
        });
      },
    );

    cliTest(
      "refuses summary delivery without a bundle before opening the target",
      async ({ cli }) => {
        const result = await cli.run({
          arguments: [
            "inspect-macho",
            join(await createTestTempDirectory("rea-macho-delivery-"), "x"),
            "--detail",
            "summary",
            "--json",
          ],
          environment,
        });
        expect(result.exitCode).toBe(1);
        expect(result.json).toMatchObject({ code: "invalid_request" });
      },
    );
  },
);
