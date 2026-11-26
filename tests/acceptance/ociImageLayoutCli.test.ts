import { ociImageLayoutSchema } from "../../src/domain/oci/imageLayout.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { analysisResourceErrorProjectionSchema } from "../../src/domain/analysisErrorProjectionSchema.js";
import { jsonValueSchema } from "../../src/domain/jsonValue.js";
import { OCI_IMAGE_LAYOUT_TOOL_CONTRACTS } from "../../src/contracts/oci/ociImageLayoutToolContracts.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { contractNamed } from "../../src/cli/contractCliDescription.js";
import { writeOciImageLayoutFixture } from "../../src/oci/OciImageLayout.fixture.js";
import { OCI_IMAGE_LAYOUT_LIMITATIONS } from "../../src/oci/OciImageLayoutParser.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const layoutContract = contractNamed(
  OCI_IMAGE_LAYOUT_TOOL_CONTRACTS,
  "inspect_oci_image_layout",
);
const completeLayoutEvidenceSchema = layoutContract.outputSchema.safeExtend({
  normalized_result: ociImageLayoutSchema,
});

const budgetRefusalSchema = analysisResourceErrorProjectionSchema.safeExtend({
  details: z
    .object({
      reported_limits: z.object({
        boundary: z.string(),
        maximum: z.number(),
        required: z.number(),
      }),
      limit: z.record(z.string(), jsonValueSchema),
      refusal: z.record(z.string(), jsonValueSchema),
    })
    .catchall(jsonValueSchema),
});

cliTest(
  "keeps unfinished OCI budget counts out of exact retry requirements",
  async ({ cli }) => {
    const path = await createTestTempDirectory("rea-oci-cli-recovery-");
    await writeOciImageLayoutFixture(path);
    const successful = await cli.run({
      arguments: ["inspect-oci-image-layout", path, "--json"],
    });
    expect(successful.exitCode, successful.stderr).toBe(0);
    for (const [parameter, value] of [
      ["max_entries", 1],
      ["max_descriptors", 1],
      ["max_config_bytes", 16],
      ["max_descriptor_bytes", 16],
      ["max_json_bytes", 16],
    ] as const) {
      const flag = `--${parameter.replaceAll("_", "-")}`;
      const result = await cli.run({
        arguments: [
          "inspect-oci-image-layout",
          path,
          "--json",
          flag,
          String(value),
        ],
      });
      expect(result.exitCode).toBe(1);
      const error = budgetRefusalSchema.parse(result.json);
      expect(error.details.reported_limits).toMatchObject({
        boundary: parameter,
        maximum: value,
      });
      const observed = error.details.reported_limits.required;
      expect(observed).toBeGreaterThan(value);
      // Even a fully measured JSON document is only one of this layout's
      // documents. The stopped walk has not established the request's total.
      const retry = await cli.run({
        arguments: [
          "inspect-oci-image-layout",
          path,
          "--json",
          flag,
          String(observed),
        ],
      });
      expect(retry.exitCode).toBe(1);
      expect
        .soft(error.details.limit, parameter)
        .not.toHaveProperty("required_value");
      expect
        .soft(error.details.refusal, parameter)
        .not.toHaveProperty("required_value");
    }
  },
);

cliTest(
  "reports OCI image-layout identity and config through the public CLI",
  async ({ cli }) => {
    const path = await createTestTempDirectory("rea-oci-cli-");
    await writeOciImageLayoutFixture(path);
    const result = await cli.run({
      arguments: ["inspect-oci-image-layout", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = completeLayoutEvidenceSchema.parse(result.json);
    expect(evidence).toMatchObject({
      confidence: "observed",
      subject: { local_path: path, identity: { format: "directory" } },
    });
    expect(evidence.normalized_result.artifact.layout_version).toBe("1.0.0");
    expect(evidence.normalized_result.images[0]).toMatchObject({
      architecture: "amd64",
      os: "linux",
      user: "nobody",
    });
    expect(evidence.normalized_result.images[0]?.env).toEqual(
      expect.arrayContaining([
        { name: "PATH", value: "/usr/bin" },
        { name: "SECRET", value: "redact-me" },
      ]),
    );
    expect(evidence.normalized_result.limitations).not.toContain(
      OCI_IMAGE_LAYOUT_LIMITATIONS.envRedacted,
    );
    expect(evidence.normalized_result.coverage.status).toBe("complete");
  },
);

cliTest(
  "matches CLI and MCP observations for the same OCI image layout",
  async ({ cli }) => {
    const path = await createTestTempDirectory("rea-oci-cli-mcp-");
    await writeOciImageLayoutFixture(path);
    const output = await cli.run({
      arguments: ["inspect-oci-image-layout", path, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const report = completeLayoutEvidenceSchema.parse(
      output.json,
    ).normalized_result;
    const { call } = await connectLocalToolsMcp();
    const reply = await call("inspect_oci_image_layout", { path });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    expect(
      completeLayoutEvidenceSchema.parse(reply.structuredContent)
        .normalized_result,
    ).toEqual(report);
  },
);

cliTest("refuses a non-directory through the public CLI", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-oci-cli-invalid-");
  const path = join(root, "not-a-layout");
  await writeFile(path, "not a directory");
  const result = await cli.run({
    arguments: ["inspect-oci-image-layout", path, "--json"],
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.json).toMatchObject({
    details: { operation: "inspect_oci_image_layout" },
  });
});

cliTest(
  "preserves include_env_values through CLI, MCP and retained views",
  async ({ cli }) => {
    const path = await createTestTempDirectory("rea-oci-cli-env-");
    await writeOciImageLayoutFixture(path);
    const { call } = await connectLocalToolsMcp();
    const output = await cli.run({
      arguments: [
        "inspect-oci-image-layout",
        path,
        "--json",
        "--no-include-env-values",
      ],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const cliEvidence = completeLayoutEvidenceSchema.parse(output.json);
    expect(cliEvidence.parameters).toEqual({
      path,
      include_env_values: false,
    });
    expect(cliEvidence.normalized_result.images[0]?.env).toEqual(
      expect.arrayContaining([
        { name: "PATH", value: null },
        { name: "SECRET", value: null },
      ]),
    );
    expect(cliEvidence.normalized_result.limitations).toContain(
      OCI_IMAGE_LAYOUT_LIMITATIONS.envRedacted,
    );
    const reply = await call("inspect_oci_image_layout", {
      path,
      include_env_values: false,
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const evidence = completeLayoutEvidenceSchema.parse(
      reply.structuredContent,
    );
    expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
    const view = await call("inspect_analysis_view", {
      source: {
        kind: "retained-evidence",
        evidence_id: evidence.evidence_id,
      },
      view: { kind: "summary" },
    });
    expect(view.isError, JSON.stringify(view)).not.toBe(true);
    const retained = await call("get_evidence_bundle", {
      detail: "complete",
    });
    expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
    const bundle = parseEvidenceBundle(
      toolContract("get_evidence_bundle").outputSchema.parse(
        retained.structuredContent,
      ).result,
    );
    expect(
      bundle.records.find(
        (record) => record.evidence_id === evidence.evidence_id,
      ),
    ).toEqual(evidence);
  },
);
