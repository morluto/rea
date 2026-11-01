import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { RELEASE_EXPOSURE_TOOL_CONTRACTS } from "../../src/contracts/releaseExposureToolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const PLANTED_SOURCE = "release-exposure-planted-secret-7c2e9a";
const releaseExposureContract = RELEASE_EXPOSURE_TOOL_CONTRACTS.find(
  (contract) => contract.name === "audit_release_exposure",
);
if (releaseExposureContract === undefined)
  throw new Error("Missing release exposure contract");
const outputSchema = releaseExposureContract.outputSchema;

cliTest(
  "exits 3 when a shipped source map embeds sources",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-release-exposure-cli-");
    await writeFile(join(root, "app.js"), "export const value = 1;\n");
    await writeFile(
      join(root, "app.js.map"),
      JSON.stringify({
        version: 3,
        file: "app.js",
        sources: ["app.js"],
        names: [],
        mappings: "",
        sourcesContent: [`export const value = "${PLANTED_SOURCE}";\n`],
      }),
    );
    const clean = await cli.run({
      arguments: ["audit-release-exposure", root, "--json"],
    });
    expect(clean.exitCode, clean.stderr).toBe(0);
    const evidence = outputSchema.parse(clean.json);
    const report = evidence.normalized_result;
    expect(
      report.checks.find(
        (check) => check.id === "javascript.source_map_sources",
      ),
    ).toMatchObject({ status: "exposed", severity: "high" });
    expect(
      report.checks.find((check) => check.id === "electron.run_as_node")
        ?.status,
    ).toBe("not_applicable");
    expect(
      report.checks.find((check) => check.id === "native.pdb_path")?.status,
    ).toBe("not_applicable");
    expect(
      report.checks.find((check) => check.id === "go.build_paths")?.status,
    ).toBe("not_applicable");
    expect(JSON.stringify(evidence)).not.toContain(PLANTED_SOURCE);
    const gated = await cli.run({
      arguments: [
        "audit-release-exposure",
        root,
        "--fail_on",
        "high",
        "--json",
      ],
    });
    expect(gated.exitCode, gated.stderr).toBe(3);
  },
  60_000,
);

cliTest(
  "gates a marker in a text file outside the extension list",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-release-exposure-key-");
    await writeFile(join(root, "hello.txt"), "hello\n");
    await writeFile(
      join(root, ".env.production"),
      "-----BEGIN PRIVATE KEY-----\n",
    );
    const result = await cli.run({
      arguments: [
        "audit-release-exposure",
        root,
        "--fail_on",
        "high",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(3);
    expect(
      outputSchema
        .parse(result.json)
        .normalized_result.checks.find(
          (check) => check.id === "text.credential_markers",
        ),
    ).toMatchObject({
      status: "exposed",
      locations: [
        { kind: "artifact-path", path: join(root, ".env.production") },
      ],
    });
  },
  60_000,
);

cliTest(
  "keeps a clean directory at exit 0 when the gate is high",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-release-exposure-clean-");
    await writeFile(join(root, "hello.txt"), "hello\n");
    const result = await cli.run({
      arguments: [
        "audit-release-exposure",
        root,
        "--fail_on",
        "high",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = outputSchema.parse(result.json).normalized_result;
    expect(report.summary.no_exposure_observed_in_assessed_checks).toBe(true);
    expect(report.summary.by_status.not_assessed).toBe(3);
  },
  60_000,
);
