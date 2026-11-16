import { expect, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliTest, type TestCli } from "../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { createApplicationMcpHarness } from "../fixtures/applicationMcpHarness.js";
import { advertisedMcpToolSchemas } from "../fixtures/advertisedMcpTool.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createMcpSchemaValidation } from "../fixtures/mcpSchemaValidation.js";
import {
  androidDeclarationEvidence,
  androidDeclarationFacts,
} from "../fixtures/android/declarations.js";
import { parseEvidence, type Evidence } from "../../src/domain/evidence.js";
import { androidDeclarationComparisonSchema } from "../../src/domain/android/androidDeclarationComparison.js";

const verifyPortableCli = async (
  cli: TestCli,
  {
    input,
    references,
    bundle,
    expected,
  }: {
    readonly input: unknown;
    readonly references: unknown;
    readonly bundle: unknown;
    readonly expected: Evidence;
  },
) => {
  const directory = await createTestTempDirectory(
    "rea-android-declaration-comparison-",
  );
  const requestPath = join(directory, "comparison.json");
  const bundlePath = join(directory, "observations.json");
  await writeFile(requestPath, JSON.stringify(references));
  await writeFile(bundlePath, JSON.stringify(bundle));
  const portable = await cli.run({
    arguments: [
      "compare-android-declarations",
      requestPath,
      "--evidence-bundle",
      bundlePath,
      "--json",
    ],
    environment: {
      REA_JADX_MCP_JAR: "/nonexistent/engine.jar",
      REA_LOG_LEVEL: "silent",
    },
  });
  expect(portable.exitCode, portable.stderr).toBe(0);
  const cliEvidence = parseEvidence(portable.json);
  expect(cliEvidence.evidence_id).toBe(expected.evidence_id);
  expect(cliEvidence.normalized_result).toEqual(expected.normalized_result);
  await writeFile(requestPath, JSON.stringify(input));
  const inline = await cli.run({
    arguments: ["compare-android-declarations", requestPath, "--json"],
  });
  expect(inline.exitCode, inline.stderr).toBe(0);
  expect(parseEvidence(inline.json).evidence_id).toBe(expected.evidence_id);
};

cliTest(
  "compares exact Android declarations through validating MCP and portable CLI without reopening an APK or running a provider",
  async ({ cli }) => {
    const left = androidDeclarationEvidence();
    const facts = androidDeclarationFacts(
      '<activity android:name=".Main" android:exported="true"/><service android:name=".New"/>',
    );
    facts.target_sdk = "36";
    facts.permissions.push("android.permission.CAMERA");
    const right = androidDeclarationEvidence(facts, "right");
    const execute = vi.fn(() => {
      throw new Error("Comparison must not execute JADX");
    });
    const inspectAvailability = vi.fn(() => {
      throw new Error("Comparison does not require engine readiness");
    });
    const harness = await createApplicationMcpHarness({
      schemaValidator: createMcpSchemaValidation(),
      serverOptions: {
        androidAnalysis: {
          execute,
          close: async () => {},
          inspectAvailability,
        },
        environment: {
          REA_JADX_MCP_JAR: "/nonexistent/engine.jar",
          REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
        },
      },
    });
    const schema = await advertisedMcpToolSchemas(
      harness.client,
      "compare_android_declarations",
    );
    const input = { left, right };
    const advertised = (await harness.client.listTools()).tools.find(
      ({ name }) => name === schema.name,
    );
    if (advertised?.outputSchema === undefined)
      throw new Error("Missing advertised compact output schema");
    expect(schema.ajv.validateSchema(advertised.outputSchema)).toBe(true);
    expect(schema.ajv.validate(schema.inputSchema, input)).toBe(true);
    expect(
      schema.ajv.validate(schema.canonicalInputSchema, {
        ...input,
        path: "/not-a-selector.apk",
      }),
    ).toBe(false);
    const response = await harness.client.callTool(
      { name: schema.name, arguments: input },
      { toolDefinition: advertised },
    );
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      schema.ajv.validate(schema.outputSchema, response.structuredContent),
    ).toBe(true);
    expect(
      schema.ajv.validate(advertised.outputSchema, response.structuredContent),
    ).toBe(true);
    const mcpEvidence = parseEvidence(response.structuredContent);
    const report = androidDeclarationComparisonSchema.parse(
      mcpEvidence.normalized_result,
    );
    expect(report).toMatchObject({
      sdk: { target_sdk: { state: "changed" } },
      permissions: {
        coverage: "unknown",
        observed_only_right: ["android.permission.CAMERA"],
      },
      components: { summary: { changed: 1, added: 1, removed: 0 } },
    });
    expect(mcpEvidence.evidence_links).toEqual([
      left.evidence_id,
      right.evidence_id,
    ]);
    for (const source of [left, right, mcpEvidence])
      expect(harness.session.evidenceById(source.evidence_id)).toEqual(source);
    const references = {
      left: { kind: "retained-evidence", evidence_id: left.evidence_id },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
    };
    const retained = await harness.client.callTool(
      { name: schema.name, arguments: references },
      { toolDefinition: schema.toolDefinition },
    );
    expect(parseEvidence(retained.structuredContent).evidence_id).toBe(
      mcpEvidence.evidence_id,
    );
    const missing = await harness.client.callTool({
      name: schema.name,
      arguments: {
        ...references,
        left: {
          kind: "retained-evidence",
          evidence_id: `ev_${"0".repeat(64)}`,
        },
      },
    });
    expect(missing.isError).toBe(true);
    expect(parseMcpToolError(missing).error.code).toBe(
      "evidence_integrity_mismatch",
    );
    const summary = await harness.client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: references.left,
        view: { kind: "summary" },
      },
    });
    const rejected = await harness.client.callTool({
      name: schema.name,
      arguments: {
        left: parseEvidence(summary.structuredContent),
        right,
      },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(parseMcpToolError(rejected))).toContain(
      left.evidence_id,
    );
    // The original source remains recoverable after a rejected summary or missing ID.
    const recovered = await harness.client.callTool(
      { name: schema.name, arguments: references },
      { toolDefinition: schema.toolDefinition },
    );
    expect(parseEvidence(recovered.structuredContent).evidence_id).toBe(
      mcpEvidence.evidence_id,
    );
    const bundle = harness.session.exportEvidenceBundle();
    expect(bundle.records.map(({ evidence_id }) => evidence_id)).toEqual(
      expect.arrayContaining([
        left.evidence_id,
        right.evidence_id,
        mcpEvidence.evidence_id,
      ]),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(inspectAvailability).not.toHaveBeenCalled();
    await harness.close();

    await verifyPortableCli(cli, {
      input,
      references,
      bundle,
      expected: mcpEvidence,
    });
  },
);
