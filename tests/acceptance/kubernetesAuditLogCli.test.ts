import { writeFile } from "node:fs/promises";
import { expect } from "vitest";
import { parseBinaryTarget } from "../../src/application/BinaryTargetResolver.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { workspaceCliTest as test } from "../support/cli/workspaceCliFixture.js";

const readInventory = (reply: unknown) => {
  const inspection = artifactInspectionResultSchema.parse(
    parseEvidence(reply).normalized_result,
  );
  return artifactInventoryResultSchema.parse(
    inspection.substeps.find((step) => step.operation === "inventory_artifact")
      ?.evidence.normalized_result,
  );
};

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
    const inventory = readInventory(result.json);
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

test("recognizes audit fields after a long first property in file and directory routes", async ({
  cli,
  workspace,
}) => {
  const path = workspace.path("capture.data");
  const unrelated = workspace.path("ordinary.data");
  const shadowed = workspace.path("shadowed.data");
  const requestObject = { body: "x".repeat(10 * 1024) };
  const identity = { auditID: "recorded", stage: "ResponseComplete" };
  await writeFile(path, `${JSON.stringify({ requestObject, ...identity })}\n`);
  await writeFile(
    unrelated,
    `${JSON.stringify({ requestObject, payload: identity })}\n`,
  );
  const earlyIdentity = JSON.stringify({ ...identity, requestObject });
  await writeFile(
    shadowed,
    `${earlyIdentity.slice(0, -1)},"stage":"Unknown"}\n`,
  );

  const target = await parseBinaryTarget(path);
  expect(target).toMatchObject({
    ok: true,
    value: { kind: "archive", format: "kubernetes-audit-log" },
  });
  expect(await parseBinaryTarget(shadowed)).not.toMatchObject({
    ok: true,
    value: { format: "kubernetes-audit-log" },
  });

  const inspect = async (selected: string) => {
    const result = await cli.run({
      arguments: ["inspect-artifact", selected, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    return readInventory(result.json);
  };
  expect((await inspect(path)).occurrences[0]?.format_metadata).toMatchObject({
    kind: "kubernetes-audit-log",
    event_count: 1,
  });
  expect((await inspect(workspace.root)).occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        logical_path: "capture.data",
        artifact_format: "kubernetes-audit-log",
      }),
      expect.objectContaining({
        logical_path: "ordinary.data",
        artifact_format: "file",
      }),
      expect.objectContaining({
        logical_path: "shadowed.data",
        artifact_format: "file",
      }),
    ]),
  );
});

test("recognizes an oversized first event and inventories only admitted lines", async ({
  cli,
  workspace,
}) => {
  const path = workspace.path("capture.data");
  const defaultLineBytes = 4 * 1024 * 1024;
  const oversized = JSON.stringify({
    requestObject: { body: "x".repeat(defaultLineBytes) },
    auditID: "oversized",
    stage: "RequestReceived",
  });
  const admitted = JSON.stringify({
    auditID: "admitted",
    stage: "ResponseComplete",
  });
  await writeFile(path, `${oversized}\n${admitted}\n`);

  const result = await cli.run({
    arguments: ["inspect-artifact", path, "--json"],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(
    readInventory(result.json).occurrences[0]?.format_metadata,
  ).toMatchObject({
    kind: "kubernetes-audit-log",
    line_bytes_limit: defaultLineBytes,
    event_count: 1,
    oversized_line_count: 1,
    malformed_line_count: 0,
    events: [{ audit_id: "admitted" }],
  });
});
