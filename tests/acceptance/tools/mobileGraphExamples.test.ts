import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import {
  ANDROID_APPLICATION_GRAPH_EXAMPLE,
  APPLE_APPLICATION_GRAPH_EXAMPLE,
  HARMONY_APPLICATION_GRAPH_EXAMPLE,
  MACOS_APPLICATION_GRAPH_EXAMPLE,
} from "../../../src/contracts/mobileApplicationGraphExamples.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInventoryResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const graphExamples = [
  {
    name: "Android",
    command: "project-android-application-graph",
    operation: "project_android_application_graph",
    example: ANDROID_APPLICATION_GRAPH_EXAMPLE,
  },
  {
    name: "IPA",
    command: "project-apple-application-graph",
    operation: "project_apple_application_graph",
    example: APPLE_APPLICATION_GRAPH_EXAMPLE,
  },
  {
    name: "macOS",
    command: "project-apple-application-graph",
    operation: "project_apple_application_graph",
    example: MACOS_APPLICATION_GRAPH_EXAMPLE,
  },
  {
    name: "Harmony",
    command: "project-harmony-application-graph",
    operation: "project_harmony_application_graph",
    example: HARMONY_APPLICATION_GRAPH_EXAMPLE,
  },
] as const;

cliTest.for(graphExamples)(
  "CLI executes the canonical $name graph example without target files",
  async ({ command, operation, example }, { cli }) => {
    const root = await createTestTempDirectory("rea-mobile-graph-example-");
    const input = JSON.stringify(example);
    const path = join(root, "example.json");
    await writeFile(path, input);
    for (const argument of [input, path]) {
      const result = await cli.run({
        arguments: [command, argument, "--json"],
        cwd: root,
      });
      expect(result.exitCode, result.stdout).toBe(0);
      const evidence = parseEvidence(result.json);
      expect(evidence.operation).toBe(operation);
      expect(evidence.normalized_result).toMatchObject({
        coverage: { status: "partial", inventory_complete: true },
      });
    }
  },
);

cliTest.for(graphExamples)(
  "CLI classifies malformed $name source Evidence separately from request errors",
  async ({ command, example }, { cli }) => {
    const source = example.inventory_evidence[0]!;
    for (const { input, code } of [
      {
        input: {
          inventory_evidence: [{ ...source, evidence_id: "not-a-digest" }],
        },
        code: "evidence_integrity_mismatch",
      },
      {
        input: { inventory_evidence: [source], unexpected: true },
        code: "invalid_request",
      },
      { input: { inventory_evidence: [] }, code: "invalid_request" },
    ]) {
      const result = await cli.run({
        arguments: [command, JSON.stringify(input), "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code,
      });
    }
  },
);

cliTest(
  "CLI still rejects an unsupported inventory coverage status",
  async ({ cli }) => {
    const original = ANDROID_APPLICATION_GRAPH_EXAMPLE.inventory_evidence[0]!;
    const inventory = artifactInventoryResultSchema.parse(
      original.normalized_result,
    );
    const evidence = createEvidence(
      { path: "Fixture.apk", sha256: "a".repeat(64), format: "apk" },
      original.provider,
      {
        operation: "inventory_artifact",
        parameters: {},
        result: {
          ...inventory,
          coverage: { scope: "root", status: "invalid" },
        },
        confidence: "observed",
        authority: "shipped-artifact",
      },
    );
    const result = await cli.run({
      arguments: [
        "project-android-application-graph",
        JSON.stringify({ inventory_evidence: [evidence] }),
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    const projected = result.json;
    expect(projected).toMatchObject({
      code: "evidence_integrity_mismatch",
      category: "integrity_mismatch",
    });
    const reason = inventoryIntegrityReason(projected);
    expect(JSON.parse(reason)).toMatchObject([
      {
        code: "invalid_value",
        values: ["complete", "unknown"],
        path: ["coverage", "status"],
      },
    ]);
    expect(projected).toMatchObject({
      message: reason,
      details: { reason },
    });
  },
);

const inventoryIntegrityReason = (projected: unknown): string => {
  if (
    projected === null ||
    typeof projected !== "object" ||
    !("details" in projected) ||
    projected.details === null ||
    typeof projected.details !== "object" ||
    !("reason" in projected.details) ||
    typeof projected.details.reason !== "string"
  )
    throw new Error("Inventory rejection omitted an integrity reason");
  return projected.details.reason;
};
