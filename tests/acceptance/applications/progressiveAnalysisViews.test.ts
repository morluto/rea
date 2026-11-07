import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { apiContractSchema } from "../../../src/domain/apiContract/apiContract.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisView.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { toolOutputSchemaWithMetadata } from "../../../src/contracts/toolSchemaMetadata.js";

it("loads retained analysis views only when needed, preserving complete schemas, source facts and Evidence", async () => {
  const root = await createTestTempDirectory("rea-progressive-api-");
  const path = join(root, "api.json");
  await writeFile(
    path,
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Fixture", version: "1" },
      paths: { "/items": { get: { operationId: "listItems" } } },
    }),
  );
  const { client } = await connectLocalToolsMcp({
    REA_MCP_TOOL_CATALOG_PROFILE: "hot-cold",
    REA_MCP_TOOL_FAMILIES: "application,session",
  });
  const names = async () =>
    (await client.listTools()).tools.map((tool) => tool.name);
  expect(await names()).not.toContain("inspect_analysis_view");
  const changed = vi.fn();
  client.setNotificationHandler("notifications/tools/list_changed", changed);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  };
  await call("discover_tools", { names: ["inspect_api_contract"] });
  expect(await names()).toContain("inspect_api_contract");
  const view = {
    kind: "api-contract",
    collection: "operations",
    paths: ["/items"],
    fields: ["method", "path"],
  };
  const first = parseEvidence(
    (await call("inspect_api_contract", { path, view })).structuredContent,
  );
  const selected = analysisViewResultSchema.parse(first.normalized_result);
  expect(selected).toMatchObject({
    kind: "api-contract",
    items: [{ method: "GET", path: "/items", state: "declared" }],
  });
  expect(await names()).not.toContain("inspect_analysis_view");
  expect(changed).toHaveBeenCalledTimes(1);
  await rm(path);
  await call("discover_tools", {
    names: ["inspect_analysis_view", "export_evidence_bundle"],
  });
  const loaded = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  expect(loaded?.outputSchema).toEqual(
    toolOutputSchemaWithMetadata(toolContract("inspect_analysis_view"))[
      "~standard"
    ].jsonSchema.output({ target: "draft-2020-12" }),
  );
  expect(changed).toHaveBeenCalledTimes(2);
  const source = {
    kind: "retained-evidence",
    evidence_id: selected.parent_evidence_id,
  };
  const follow = await call("inspect_analysis_view", { source, view });
  expect(parseEvidence(follow.structuredContent)).toEqual(first);
  const bundlePath = join(root, "complete.json");
  await call("export_evidence_bundle", { path: bundlePath });
  const bundle = evidenceBundleSchema.parse(
    JSON.parse(await readFile(bundlePath, "utf8")),
  );
  const parent = bundle.records.find(
    (record) => record.evidence_id === selected.parent_evidence_id,
  );
  expect(parent).toBeDefined();
  const report = apiContractSchema.parse(parent?.normalized_result);
  expect(report.operations).toMatchObject([
    {
      method: "GET",
      path: "/items",
      declared_id: "listItems",
      source_pointer: "/paths/~1items/get",
    },
  ]);
  expect(follow.structuredContent).toHaveProperty("evidence_links", [
    selected.parent_evidence_id,
  ]);
  await call("discover_tools", { names: ["inspect_analysis_view"] });
  expect(changed).toHaveBeenCalledTimes(2);
});
