import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { LABVIEW_TOOL_CONTRACTS } from "../../../src/contracts/labview/labviewToolContracts.js";
import { labviewArtifactSchema } from "../../../src/domain/labview/labviewArtifact.js";
import { labviewContainer } from "../../fixtures/labview/rsrc.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const contract = (() => {
  const found = LABVIEW_TOOL_CONTRACTS.find(
    (item) => item.name === "inspect_labview_artifact",
  );
  if (found === undefined)
    throw new Error("Missing inspect_labview_artifact contract");
  return found;
})();

cliTest(
  "inventories a LabVIEW RSRC container through the CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-labview-cli-");
    const path = join(root, "fixture.vi");
    const bytes = labviewContainer();
    await writeFile(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");

    const result = await cli.run({
      arguments: ["inspect-labview-artifact", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);

    const call = await cli.sharedMcpCall!();
    const response = await call("inspect_labview_artifact", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);

    for (const value of [result.json, response.structuredContent]) {
      // The advertised output admits complete or summary detail; this small
      // container is delivered complete, so read it as the complete report.
      const evidence = contract.outputSchema.parse(value);
      const report = labviewArtifactSchema.parse(evidence.normalized_result);
      expect(report.artifact).toMatchObject({
        path,
        sha256: digest,
        bytes: bytes.length,
      });
      expect(report.container).toMatchObject({
        kind: "rsrc",
        embedded_containers: 1,
        file_type: "LVAR",
        creator: "LBVW",
      });
      expect(report.labview_version).toBe("11.0");
      expect(report.version_coverage).toBe("observed");
      expect(report.blocks.map(({ identifier }) => identifier)).toEqual([
        "vers",
        "DFDS",
      ]);
      expect(report.blocks[1]?.sections).toMatchObject([
        { coding: "zlib", decoded_bytes: 5 },
        { coding: "none", decoded_bytes: null, stored_bytes: 4 },
      ]);
    }
  },
);
