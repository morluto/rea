import { expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { listedEvidenceCaller } from "../../support/mcp/listedEvidenceCaller.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

/** A page whose console emits `count` events, one error among them. */
const consolePage = (count: number) =>
  startFakeCdpBrowser({
    commandEvents(command, origin) {
      if (command.method !== "Runtime.enable") return undefined;
      const session =
        command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      return Array.from({ length: count }, (_, index) => ({
        ...session,
        method: "Runtime.consoleAPICalled",
        params: {
          type: index === count - 1 ? "error" : "log",
          timestamp: index + 1,
          args: [],
          stackTrace: {
            callFrames: [
              { url: `${origin}/app.js`, lineNumber: 1, columnNumber: 1 },
            ],
          },
        },
      }));
    },
  });

const connect = async (count: number) => {
  const browser = await consolePage(count);
  onTestFinished(() => browser.close());
  const { client } = await createApplicationMcpHarness({
    serverOptions: { browserObservation: new CdpBrowserProvider() },
    // These cases cover the budget's choice for an omitted detail.
    testDelivery: "budgeted",
  });
  const call = listedEvidenceCaller(client, (await client.listTools()).tools);
  const page = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  return { call, page };
};

it("summarizes a large page capture and pages its console through the web-page view", async () => {
  const { call, page } = await connect(400);
  const summary = await call("inspect_web_page", page);
  expect(summary).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "inspect_web_page",
      summary: {
        counts: {
          console_events: 400,
          console_events_by_type: { log: 399, error: 1 },
        },
      },
    },
  });
  const parent = summary.evidence_links[0];
  if (parent === undefined) throw new Error("Expected a retained parent");

  const errors = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: parent },
    view: { kind: "web-page", collection: "console", types: ["error"] },
  });
  expect(errors.normalized_result).toMatchObject({
    kind: "web-page",
    items: [{ type: "error", timestamp: 400 }],
    coverage: { total: 1, exhausted: true },
  });
  const firstPage = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: parent },
    view: { kind: "web-page", collection: "console", limit: 2 },
  });
  expect(firstPage.normalized_result).toMatchObject({
    items: [{ timestamp: 1 }, { timestamp: 2 }],
    coverage: { total: 400, next_offset: 2 },
    // The capture's completeness and the section's own context travel with
    // every page, apart from the page's coverage.
    completeness: { status: expect.any(String) },
    section: { console: { prior_activity_available: false } },
  });

  const complete = await call("inspect_web_page", {
    ...page,
    detail: "complete",
  });
  expect(complete).toMatchObject({ operation: "inspect_web_page" });
  expect(complete.parameters).not.toHaveProperty("detail");
});

it("returns a small page capture inline when detail is omitted", async () => {
  const { call, page } = await connect(2);
  const inline = await call("inspect_web_page", page);
  expect(inline).toMatchObject({
    operation: "inspect_web_page",
    normalized_result: { console: { events: [{}, {}] } },
  });
});

it("pages a captured script's metadata without its text, and the text separately", async () => {
  const body = "x".repeat(60_000);
  const browser = await startFakeCdpBrowser({
    commandEvents: ({ method }, origin) =>
      method === "Debugger.enable"
        ? [
            {
              method: "Debugger.scriptParsed",
              sessionId: "session-1",
              params: {
                scriptId: "big-script",
                url: `${origin}/app.js`,
                executionContextId: 1,
                length: body.length,
                scriptLanguage: "JavaScript",
              },
            },
          ]
        : undefined,
    commandResult: (command) =>
      command.method === "Debugger.getScriptSource"
        ? { scriptSource: body }
        : undefined,
  });
  onTestFinished(() => browser.close());
  const { client } = await createApplicationMcpHarness({
    serverOptions: { browserObservation: new CdpBrowserProvider() },
    testDelivery: "budgeted",
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await client.callTool({ name, arguments: args });
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    return parseEvidence(reply.structuredContent);
  };
  const summary = await call("inspect_web_page", {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
    include_script_sources: true,
  });
  expect(summary.normalized_result).toMatchObject({ kind: "summary" });
  const source = {
    kind: "retained-evidence",
    evidence_id: summary.evidence_links[0],
  };
  const scripts = await call("inspect_analysis_view", {
    source,
    view: { kind: "web-page", collection: "scripts" },
  });
  const script = (
    scripts.normalized_result as {
      items: { script_key: string; source: Record<string, unknown> }[];
    }
  ).items[0];
  if (script === undefined) throw new Error("Expected a captured script");
  expect(script.source).toMatchObject({ included: true });
  expect(script.source.artifact).not.toHaveProperty("text");

  const text = await call("inspect_analysis_view", {
    source,
    view: {
      kind: "web-page",
      collection: "script-source",
      script_key: script.script_key,
      limit: 10,
    },
  });
  expect(text.normalized_result).toMatchObject({
    items: [{ text: "x".repeat(10), script_key: script.script_key }],
    coverage: { total: body.length, next_offset: 10 },
  });
});
