import { expect, it, onTestFinished } from "vitest";
import { WebRuntimeService } from "../../../src/application/WebRuntimeService.js";
import { CdpWebRuntimeProvider } from "../../../src/browser/execution/CdpWebRuntimeProvider.js";
import { webExecutionPageViewResultSchema } from "../../../src/domain/analysisView/summarySchemas/webExecutionSummarySchemas.js";
import { webExecutionCollections } from "../../../src/domain/analysisView/webExecutionView.js";
import { canonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { listedEvidenceCaller } from "../../support/mcp/listedEvidenceCaller.js";
import {
  runtimeSourceA,
  startRuntimeBrowser,
} from "../../fixtures/webRuntime.js";

/** The fixture page, with script-a's source padded to `padding` characters. */
const connect = async (padding: number) => {
  const sourceA = runtimeSourceA + " ".repeat(padding);
  const browser = await startRuntimeBrowser({
    commandResult: (command) =>
      command.method === "Debugger.getScriptSource" &&
      command.params.scriptId === "script-a"
        ? { scriptSource: sourceA }
        : undefined,
  });
  onTestFinished(() => browser.close());
  const { client } = await createApplicationMcpHarness({
    serverOptions: {
      webRuntime: new WebRuntimeService(new CdpWebRuntimeProvider()),
    },
    // These cases cover the budget's choice for an omitted detail.
    testDelivery: "budgeted",
  });
  const call = listedEvidenceCaller(client, (await client.listTools()).tools);
  const observe = {
    cdp_endpoint: browser.endpoint,
    target_id: "allowed-page",
    observation_ms: 5,
  };
  return { call, observe, sourceA };
};

it("summarizes a large execution observation and pages functions and source text", async () => {
  const { call, observe, sourceA } = await connect(40_000);
  const summary = await call("observe_web_execution", observe);
  expect(summary).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "observe_web_execution",
      summary: {
        counts: { functions: 2, executed_functions: 1, sources: 2 },
      },
    },
  });
  const source = {
    kind: "retained-evidence",
    evidence_id: summary.evidence_links[0],
  };

  const executed = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "web-execution",
      collection: "functions",
      executed_only: true,
    },
  });
  expect(executed.normalized_result).toMatchObject({
    items: [{ name: "selected", script_id: "script-a", function_index: 0 }],
    coverage: { total: 1 },
    coverage_context: { state: "captured" },
    script_inventory: { coverage_absence: "unknown" },
  });

  const second = await call("inspect_analysis_view", {
    source,
    view: { kind: "web-execution", collection: "functions", offset: 1 },
  });
  expect(second.normalized_result).toMatchObject({
    items: [{ name: "untouched", script_id: "script-b", function_index: 0 }],
    coverage: { total: 2, examined: 1, exhausted: true },
  });
  const scriptB = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "web-execution",
      collection: "functions",
      script_ids: ["script-b"],
    },
  });
  expect(scriptB.normalized_result).toMatchObject({
    items: [{ name: "untouched" }],
    coverage: { total: 1 },
  });

  const sources = await call("inspect_analysis_view", {
    source,
    view: { kind: "web-execution", collection: "sources" },
  });
  expect(sources.normalized_result).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({
        script_id: "script-a",
        source: expect.objectContaining({
          state: "captured",
          utf16_units: sourceA.length,
        }),
      }),
    ]),
  });

  const text = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "web-execution",
      collection: "source-text",
      script_id: "script-a",
      limit: runtimeSourceA.length,
    },
  });
  expect(text.normalized_result).toMatchObject({
    items: [{ text: runtimeSourceA, script_id: "script-a" }],
    coverage: { total: sourceA.length, next_offset: runtimeSourceA.length },
  });

  const requestPage = await call("inspect_analysis_view", {
    source,
    view: { kind: "web-execution", collection: "requests" },
  });
  const pages = [executed, sources, text, requestPage].map((evidence) =>
    webExecutionPageViewResultSchema.parse(evidence.normalized_result),
  );
  // The fixture observed no requests. Give that collection a nonempty control
  // so swapping its rows exercises the item schema.
  const requestRow = {
    request_id: "request-1",
    url: "https://example.invalid/script.js",
    method: "GET",
    timestamp_seconds: 0,
    initiator_type: "other",
    reported_initiator: {},
    callsites: [],
    async_parent_ids: [],
    causal_attribution: "unknown",
  };
  const validation = createMcpSchemaValidation();
  onTestFinished(() => validation.clear());
  const validators = ["observe_web_execution", "inspect_analysis_view"].map(
    (name) => validation.getValidator(canonicalOutputSchema(name)),
  );
  const samples = pages.map(({ view, items }) => ({
    collection: view.collection,
    items: view.collection === "requests" ? [requestRow] : items,
  }));
  for (const sample of samples) expect(sample.items.length).toBeGreaterThan(0);
  for (const page of pages) {
    const check = (items: unknown, expected: boolean) => {
      const normalized_result = { ...page, items };
      expect(
        webExecutionPageViewResultSchema.safeParse(normalized_result).success,
      ).toBe(expected);
      for (const validate of validators)
        expect(validate({ ...executed, normalized_result }).valid).toBe(
          expected,
        );
    };
    check([], true);
    for (const sample of samples)
      check(sample.items, sample.collection === page.view.collection);
    if (page.view.collection === "sources") {
      const captured = webExecutionCollections.sources.items
        .parse(page.items)
        .find((row) => row.source.state === "captured");
      if (captured === undefined) throw new Error("Expected a captured source");
      check([{ ...captured, source: { ...captured.source, text: "" } }], false);
      for (const sha256 of ["abc", "A".repeat(64)])
        check([{ ...captured, source: { ...captured.source, sha256 } }], false);
      for (const state of ["unavailable", "excluded"]) {
        check(
          [{ ...captured, source: { state, reason: "not captured" } }],
          true,
        );
        check([{ ...captured, source: { state, reason: "" } }], false);
      }
    }
    if (page.view.collection === "source-text")
      check([{ ...page.items[0], script_id: "" }], false);
  }
});

it("returns a small execution observation inline unless summary is requested", async () => {
  const { call, observe } = await connect(0);
  expect(await call("observe_web_execution", observe)).toMatchObject({
    operation: "observe_web_execution",
  });
  expect(
    await call("observe_web_execution", { ...observe, detail: "summary" }),
  ).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "observe_web_execution",
    },
  });
});
