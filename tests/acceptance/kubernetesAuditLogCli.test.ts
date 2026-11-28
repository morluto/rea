import { writeFile } from "node:fs/promises";
import { expect } from "vitest";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { workspaceCliTest as test } from "../support/cli/workspaceCliFixture.js";

test("reports skipped Kubernetes audit lines and reads them with a raised allowance", async ({
  cli,
  workspace,
}) => {
  const path = workspace.path("kubernetes-audit.jsonl");
  const event = {
    apiVersion: "audit.k8s.io/v1",
    auditID: "example",
    stage: "RequestReceived",
  };
  const first = JSON.stringify(event);
  const second = JSON.stringify({
    ...event,
    stage: "ResponseComplete",
    responseObject: { text: "x".repeat(300) },
  });
  await writeFile(path, `${first}\n${second}\n`);

  const inspect = async (lineBytes: number) => {
    const result = await cli.run({
      arguments: [
        "inspect-artifact",
        path,
        "--json",
        "--artifact-limits",
        JSON.stringify({ kubernetes_audit_log: { line_bytes: lineBytes } }),
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    const inventory = artifactInventoryResultSchema.parse(
      inspection.substeps.find(
        (step) => step.operation === "inventory_artifact",
      )?.evidence?.normalized_result,
    );
    expect(inventory.effective_limits).toMatchObject({
      kubernetes_audit_log: { line_bytes: lineBytes },
    });
    return inventory.occurrences.find((row) => row.logical_path === ".")
      ?.format_metadata;
  };

  const smallAllowance = Buffer.byteLength(first);
  expect(await inspect(smallAllowance)).toMatchObject({
    kind: "kubernetes-audit-log",
    event_count: 1,
    line_bytes_limit: smallAllowance,
    malformed_line_count: 0,
    oversized_line_count: 1,
  });
  const measured = Buffer.byteLength(second);
  expect(await inspect(measured)).toMatchObject({
    kind: "kubernetes-audit-log",
    event_count: 2,
    line_bytes_limit: measured,
    malformed_line_count: 0,
    oversized_line_count: 0,
  });
});
