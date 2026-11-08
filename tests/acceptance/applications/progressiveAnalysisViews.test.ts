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
import { TOOL_GUIDANCE } from "../../../src/toolGuidance.js";
import { parseGuidanceSections } from "../../../src/application/GuidanceSections.js";
import {
  searchGuidanceOutputSchema,
  readGuidanceSectionOutputSchema,
} from "../../../src/contracts/guidanceContracts.js";

const verifyGuidanceAndRetainedView = async (profile: "full" | "hot-cold") => {
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
    REA_MCP_TOOL_CATALOG_PROFILE: profile,
    REA_MCP_TOOL_FAMILIES: "application,session",
  });
  const names = async () =>
    (await client.listTools()).tools.map((tool) => tool.name);
  expect((await names()).includes("inspect_analysis_view")).toBe(
    profile === "full",
  );
  const changed = vi.fn();
  client.setNotificationHandler("notifications/tools/list_changed", changed);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  };
  const load = async (names: string[]) => {
    if (profile === "hot-cold") await call("discover_tools", { names });
  };
  await load(["inspect_api_contract"]);
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
  expect((await names()).includes("inspect_analysis_view")).toBe(
    profile === "full",
  );
  expect(changed).toHaveBeenCalledTimes(profile === "hot-cold" ? 1 : 0);
  await rm(path);
  await load(["search_guidance", "read_guidance_section"]);
  const found = await call("search_guidance", {
    query: "inspect_analysis_view OpenAPI",
  });
  // Legacy MCP wraps root unions; auto-negotiated results use the object directly.
  const unwrap = (value: unknown) =>
    typeof value === "object" && value !== null && "result" in value
      ? value.result
      : value;
  const matches = searchGuidanceOutputSchema.parse(
    unwrap(found.structuredContent),
  );
  if (matches.status !== "matches") throw new Error("Expected tool guidance");
  const selectedGuide = matches.matches[0];
  const guidance = TOOL_GUIDANCE.inspect_analysis_view!;
  expect(selectedGuide?.guide).toBe(guidance.guide);
  const read = await call("read_guidance_section", {
    locator: selectedGuide?.locator,
  });
  const section = readGuidanceSectionOutputSchema.parse(
    unwrap(read.structuredContent),
  );
  if (section.status !== "section") throw new Error("Expected a guide section");
  const owner = parseGuidanceSections(
    new Map([[guidance.guide, guidance.content]]),
  )?.find(({ heading }) => heading === selectedGuide?.heading);
  expect(owner).toBeDefined();
  expect(section.content).toBe(owner?.content);
  if (profile === "hot-cold") {
    const miss = await call("discover_tools", {
      query: "inspect_analysis_view qzxv",
    });
    expect(miss.structuredContent).toMatchObject({ total_matches: 0 });
    // A keyword formerly present only in the oversized description still finds the view.
    const foundView = await call("discover_tools", {
      query: "generic_method_issues",
    });
    expect(foundView.structuredContent).toMatchObject({
      tools: [expect.objectContaining({ name: "inspect_analysis_view" })],
    });
  }
  await load(["inspect_analysis_view", "export_evidence_bundle"]);
  const loaded = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_analysis_view",
  );
  expect(loaded?.outputSchema).toEqual(
    toolOutputSchemaWithMetadata(toolContract("inspect_analysis_view"))[
      "~standard"
    ].jsonSchema.output({ target: "draft-2020-12" }),
  );
  expect(loaded?.description).toBe(
    toolContract("inspect_analysis_view").description,
  );
  expect(changed).toHaveBeenCalledTimes(profile === "hot-cold" ? 4 : 0);
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
  await load(["inspect_analysis_view"]);
  expect(changed).toHaveBeenCalledTimes(profile === "hot-cold" ? 4 : 0);
};

it.each(["full", "hot-cold"] as const)(
  "retrieves view guidance and retained facts with the %s catalog, preserving complete schemas and Evidence",
  verifyGuidanceAndRetainedView,
);
