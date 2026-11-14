import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "vitest";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  evidenceBundleSchema,
} from "../../../src/domain/evidenceBundle.js";
import {
  staticObservedEndpointComparisonSchema,
  type StaticObservedEndpointComparison,
} from "../../../src/domain/javascript/staticObservedEndpointSchemas.js";
import { analysisViewResultSchema } from "../../../src/domain/analysisView/analysisViewResult.js";
import { webNetworkCaptureSchema } from "../../../src/domain/webNetworkCapture.js";

const prepareInputs = async (cli: TestCli) => {
  const root = await createTestTempDirectory("rea-static-observed-endpoints-");
  const appPath = join(root, "app");
  await mkdir(appPath);
  const fixture = new URL(
    "../../fixtures/javascript-endpoint-capture/",
    import.meta.url,
  );
  const sourcePath = join(appPath, "app.js");
  const source = await readFile(new URL("app.js.txt", fixture), "utf8");
  await writeFile(sourcePath, source);
  await writeFile(
    join(appPath, "index.html"),
    await readFile(new URL("index.html.txt", fixture)),
  );
  const harPath = join(root, "capture.har");
  const harBytes = await readFile(
    new URL("recording.har.txt", fixture),
    "utf8",
  );
  expect(createHash("sha256").update(harBytes).digest("hex")).toBe(
    "f0e7d2c869c811d4272a7b2916c6531c8c6cc7938336a35575e2a6b7b6346714",
  );
  await writeFile(harPath, harBytes);
  const run = cli.run.bind(cli);
  const analyzed = await run({
    arguments: [
      "analyze-javascript-application",
      appPath,
      "--artifact-format",
      "directory",
      "--json",
    ],
  });
  expect(analyzed.exitCode, analyzed.stderr).toBe(0);
  const application = parseEvidence(analyzed.json);
  const inspected = await run({
    arguments: ["inspect-web-network-capture", harPath, "har", "--json"],
  });
  expect(inspected.exitCode, inspected.stderr).toBe(0);
  const capture = parseEvidence(inspected.json);
  const input = { application, capture, origin: "http://127.0.0.1:42845" };
  const inputPath = join(root, "comparison-input.json");
  await writeFile(inputPath, JSON.stringify(input));

  return {
    root,
    sourcePath,
    source,
    harPath,
    harBytes,
    run,
    application,
    capture,
    input,
    inputPath,
  };
};

type McpCall = Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"];
const assertPagedComparison = async (
  call: McpCall,
  report: StaticObservedEndpointComparison,
  complete: Evidence,
  input: Parameters<McpCall>[1],
) => {
  const pageRequest = {
    source: { kind: "retained-evidence", evidence_id: complete.evidence_id },
    view: {
      kind: "endpoint-comparison",
      collection: "static-endpoints",
      fields: ["path", "status", "reason"],
      offset: 0,
      limit: 2,
    },
  };
  const first = await call("inspect_analysis_view", pageRequest);
  const firstView = analysisViewResultSchema.parse(
    parseEvidence(first.structuredContent).normalized_result,
  );
  expect(firstView).toMatchObject({
    source_coverage: report.source_coverage,
    summary: report.summary,
    coverage: { examined: 2, total: 7, exhausted: false, next_offset: 2 },
  });
  if (firstView.kind !== "endpoint-comparison")
    throw new Error("Expected endpoint page");
  const inline = await call("compare_static_and_observed_endpoints", {
    ...input,
    detail: "complete",
    view: pageRequest.view,
  });
  expect(inline.isError, JSON.stringify(inline.content)).not.toBe(true);
  expect(parseEvidence(inline.structuredContent).normalized_result).toEqual(
    firstView,
  );
  expect(firstView.items).toEqual(
    report.static_endpoints
      .slice(0, 2)
      .map(
        ({ endpoint_id, node_id, observation_id, path, status, reason }) => ({
          endpoint_id,
          node_id,
          observation_id,
          path,
          status,
          reason,
        }),
      ),
  );
  const empty = await call("inspect_analysis_view", {
    ...pageRequest,
    view: { ...pageRequest.view, statuses: [], fields: [] },
  });
  expect(
    parseEvidence(empty.structuredContent).normalized_result,
  ).toMatchObject({
    items: [],
    coverage: { total: 0, exhausted: true },
    summary: report.summary,
  });
  const matchPage = await call("inspect_analysis_view", {
    source: pageRequest.source,
    view: { kind: "endpoint-comparison", collection: "matches", fields: [] },
  });
  expect(
    parseEvidence(matchPage.structuredContent).normalized_result,
  ).toMatchObject({
    items: report.matches.map(({ match_id, endpoint_id, group_id }) => ({
      match_id,
      endpoint_id,
      group_id,
    })),
  });

  return { firstView, pageRequest };
};

const assertCliPublication = async (
  context: Awaited<ReturnType<typeof prepareInputs>>,
  comparison: {
    readonly complete: Evidence;
    readonly summary: Awaited<ReturnType<McpCall>>;
    readonly views: Awaited<ReturnType<typeof assertPagedComparison>>;
  },
) => {
  const { root, run, inputPath, application, capture } = context;
  const {
    complete,
    summary,
    views: { firstView, pageRequest },
  } = comparison;
  const bundlePath = join(root, "comparison.bundle.json");
  const cliSummary = await run({
    arguments: [
      "compare-static-and-observed-endpoints",
      inputPath,
      "--detail",
      "summary",
      "--evidence_output",
      bundlePath,
      "--json",
    ],
  });
  expect(cliSummary.exitCode, cliSummary.stderr).toBe(0);
  expect(cliSummary.json).toMatchObject({
    summary: summary.structuredContent,
  });
  const bundle = evidenceBundleSchema.parse(
    JSON.parse(await readFile(bundlePath, "utf8")),
  );
  expect(new Set(bundle.records.map(({ evidence_id }) => evidence_id))).toEqual(
    new Set([
      application.evidence_id,
      capture.evidence_id,
      complete.evidence_id,
    ]),
  );
  const fileViewPath = join(root, "page-input.json");
  await writeFile(
    fileViewPath,
    JSON.stringify({
      ...pageRequest,
      source: {
        kind: "evidence-file",
        path: bundlePath,
        evidence_id: complete.evidence_id,
      },
    }),
  );
  const cliPage = await run({
    arguments: ["inspect-analysis-view", fileViewPath, "--json"],
  });
  expect(cliPage.exitCode, cliPage.stderr).toBe(0);
  expect(parseEvidence(cliPage.json).normalized_result).toEqual(firstView);
  const inlineCli = await run({
    arguments: [
      "compare-static-and-observed-endpoints",
      inputPath,
      "--detail",
      "summary",
      "--view",
      JSON.stringify(pageRequest.view),
      "--evidence_output",
      join(root, "selected.bundle.json"),
      "--json",
    ],
  });
  expect(inlineCli.exitCode, inlineCli.stderr).toBe(0);
  expect(inlineCli.json).toMatchObject({
    summary: { normalized_result: firstView },
  });
  const invalidView = await run({
    arguments: [
      "compare-static-and-observed-endpoints",
      inputPath,
      "--view",
      JSON.stringify(pageRequest.view),
      "--json",
    ],
  });
  expect(invalidView.exitCode).not.toBe(0);
  expect(invalidView.json).toMatchObject({ code: "invalid_request" });
  const missingSink = await run({
    arguments: [
      "compare-static-and-observed-endpoints",
      inputPath,
      "--detail",
      "summary",
      "--json",
    ],
  });
  expect(missingSink.exitCode).not.toBe(0);
  expect(missingSink.json).toMatchObject({ code: "invalid_request" });
};

cliTest(
  "compares real source and decoded HAR through CLI/MCP, retains complete facts and pages stable identities",
  async ({ cli }) => {
    const context = await prepareInputs(cli);
    const {
      root,
      sourcePath,
      source,
      harPath,
      harBytes,
      run,
      application,
      capture,
      input,
      inputPath,
    } = context;
    const compared = await run({
      arguments: ["compare-static-and-observed-endpoints", inputPath, "--json"],
    });
    expect(compared.exitCode, compared.stderr).toBe(0);
    const complete = parseEvidence(compared.json);
    const report = staticObservedEndpointComparisonSchema.parse(
      complete.normalized_result,
    );
    expect(report.summary).toMatchObject({
      static_network_endpoint_observations: 7,
      matched: 3,
      not_observed_in_capture: 1,
      unknown: 3,
      observed_without_static_match: 3,
    });
    expect(new Set(report.matches.map(({ basis }) => basis))).toEqual(
      new Set(["exact", "template-compatible"]),
    );
    expect(complete.evidence_links).toEqual(
      [application.evidence_id, capture.evidence_id].sort(),
    );
    expect(JSON.stringify(report)).not.toMatch(/kept-source-only|fragment|KEY/);
    const { client, call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: "full",
      REA_MCP_TOOL_FAMILIES: "application,session",
    });
    const schemas = await advertisedMcpToolSchemas(
      client,
      "compare_static_and_observed_endpoints",
    );
    expect(schemas.ajv.validate(schemas.inputSchema, input)).toBe(true);
    expect(
      schemas.ajv.validate(schemas.inputSchema, { ...input, detail: "wrong" }),
    ).toBe(false);
    const retained = {
      application: {
        kind: "retained-evidence",
        evidence_id: application.evidence_id,
      },
      capture: { kind: "retained-evidence", evidence_id: capture.evidence_id },
      origin: input.origin,
    };
    let bundleNumber = 0;
    const importRecords = async (
      records: Parameters<typeof createEvidenceBundle>[0],
    ) => {
      const path = join(root, `sources-${bundleNumber++}.bundle.json`);
      await writeFile(path, JSON.stringify(createEvidenceBundle(records)));
      const response = await call("import_evidence_bundle", { path });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    };
    await importRecords([application, capture]);
    const fullMcp = await call("compare_static_and_observed_endpoints", {
      ...retained,
      detail: "complete",
    });
    expect(fullMcp.isError, JSON.stringify(fullMcp.content)).not.toBe(true);
    expect(parseEvidence(fullMcp.structuredContent)).toEqual(complete);
    const summary = await call(
      "compare_static_and_observed_endpoints",
      retained,
    );
    expect(summary.isError).not.toBe(true);
    const summaryView = analysisViewResultSchema.parse(
      parseEvidence(summary.structuredContent).normalized_result,
    );
    expect(summaryView).toMatchObject({
      kind: "summary",
      parent_evidence_id: complete.evidence_id,
      summary: {
        summary: report.summary,
        source_coverage: report.source_coverage,
      },
    });
    expect(summaryView).not.toHaveProperty("static_endpoints");

    const views = await assertPagedComparison(call, report, complete, retained);
    await assertCliPublication(context, { complete, summary, views });
    const tampered = await call("compare_static_and_observed_endpoints", {
      ...retained,
      capture: { ...capture, normalized_result: {} },
    });
    expect(parseMcpToolError(tampered).error).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
    const sourceCapture = webNetworkCaptureSchema.parse(
      capture.normalized_result,
    );
    const replacement = (parameters: object, result: unknown) =>
      createEvidence(undefined, capture.provider, {
        operation: capture.operation,
        parameters,
        result,
        confidence: "observed",
      });
    const declared = replacement(
      { ...capture.parameters, sensitive_value_count: 1 },
      sourceCapture,
    );
    await importRecords([declared]);
    const refused = await call("compare_static_and_observed_endpoints", {
      ...retained,
      capture: { kind: "retained-evidence", evidence_id: declared.evidence_id },
    });
    expect(parseMcpToolError(refused).error).toMatchObject({
      code: "unsupported_target",
    });
    expect(JSON.stringify(refused)).toContain("sensitive_values_unretained");
    const subset = replacement(capture.parameters, {
      ...sourceCapture,
      records: sourceCapture.records.slice(0, 1),
    });
    await importRecords([subset]);
    const limited = await call("compare_static_and_observed_endpoints", {
      ...retained,
      capture: { kind: "retained-evidence", evidence_id: subset.evidence_id },
      detail: "complete",
    });
    expect(limited.isError).not.toBe(true);
    expect(
      staticObservedEndpointComparisonSchema
        .parse(parseEvidence(limited.structuredContent).normalized_result)
        .static_endpoints.find(({ path }) => path === "/api/admin/export"),
    ).toMatchObject({ status: "unknown", reason: "capture-incomplete" });
    expect(await readFile(sourcePath, "utf8")).toBe(source);
    expect(
      createHash("sha256")
        .update(await readFile(harPath))
        .digest("hex"),
    ).toBe(createHash("sha256").update(harBytes).digest("hex"));
  },
);
