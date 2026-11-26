import { expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

/** A page whose console emits 400 events, so its capture exceeds the budget. */
const connect = async (
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const browser = await startFakeCdpBrowser({
    commandEvents(command, origin) {
      if (command.method !== "Runtime.enable") return undefined;
      const session =
        command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      return Array.from({ length: 400 }, (_, index) => ({
        ...session,
        method: "Runtime.consoleAPICalled",
        params: {
          type: "log",
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
  onTestFinished(() => browser.close());
  const { client } = await createApplicationMcpHarness({
    serverOptions: {
      browserObservation: new CdpBrowserProvider(),
      environment,
    },
    // Omitted detail delivers the retained summary these cases reference.
    testDelivery: "budgeted",
  });
  const definitions = (await client.listTools()).tools;
  const reply = async (name: string, args: Record<string, unknown>) => {
    const definition = definitions.find((tool) => tool.name === name);
    if (definition === undefined) throw new Error(`Missing tool ${name}`);
    return client.callTool(
      { name, arguments: args },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
  };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await reply(name, args);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return parseEvidence(result.structuredContent);
  };
  const page = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  return { call, reply, page };
};

const retained = (evidence_id: string | undefined) => {
  if (evidence_id === undefined) throw new Error("Expected an Evidence ID");
  return { kind: "retained-evidence", evidence_id };
};

it("compares retained captures named by summary or complete Evidence ID", async () => {
  const { call, page } = await connect();
  const before = await call("inspect_web_page", page);
  const after = await call("inspect_web_page", page);
  expect(before.operation).toBe("inspect_analysis_view");
  const beforeParent = before.evidence_links[0];
  const afterParent = after.evidence_links[0];

  const compared = await call("compare_web_captures", {
    before: { inspection: retained(before.evidence_id) },
    after: { inspection: retained(afterParent) },
  });
  expect(compared).toMatchObject({
    operation: "compare_web_captures",
    evidence_links: [beforeParent, afterParent],
  });
});

it("compares referenced captures exactly as the same captures inline", async () => {
  const { call, page } = await connect();
  const before = await call("inspect_web_page", {
    ...page,
    detail: "complete",
  });
  const after = await call("inspect_web_page", { ...page, detail: "complete" });
  const inline = await call("compare_web_captures", {
    before: { inspection: before.normalized_result },
    after: { inspection: after.normalized_result },
  });
  const referenced = await call("compare_web_captures", {
    before: { inspection: retained(before.evidence_id) },
    after: { inspection: retained(after.evidence_id) },
  });
  expect(referenced.normalized_result).toEqual(inline.normalized_result);
  expect(referenced.parameters).toEqual(inline.parameters);
  expect(inline.evidence_links).toEqual([]);
  expect(referenced.evidence_links).toEqual([
    before.evidence_id,
    after.evidence_id,
  ]);
});

it("refuses a reference to other Evidence or to nothing retained", async () => {
  const { call, reply, page } = await connect();
  const capture = await call("inspect_web_page", {
    ...page,
    detail: "complete",
  });
  const targets = await call("list_browser_targets", {
    cdp_endpoint: page.cdp_endpoint,
  });

  const foreign = await reply("compare_web_captures", {
    before: { inspection: retained(targets.evidence_id) },
    after: { inspection: retained(capture.evidence_id) },
  });
  expect(foreign.isError).toBe(true);
  expect(JSON.stringify(foreign.content)).toContain(
    "Select retained inspect_web_page Evidence or its inspect_analysis_view summary",
  );

  const missing = await reply("compare_web_captures", {
    before: { inspection: retained(`ev_${"0".repeat(64)}`) },
    after: { inspection: retained(capture.evidence_id) },
  });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing.content)).toContain(`ev_${"0".repeat(64)}`);
});

it("names retained references when inline captures exceed the input allowance", async () => {
  // The shipped allowance, which the shared test environment raises.
  const { call, reply, page } = await connect({
    ...process.env,
    REA_MCP_MAX_INPUT_ELEMENTS: "1024",
  });
  const capture = await call("inspect_web_page", {
    ...page,
    detail: "complete",
  });
  const refused = await reply("compare_web_captures", {
    before: { inspection: capture.normalized_result },
    after: { inspection: capture.normalized_result },
  });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toContain(
    "If the source Evidence is retained, use",
  );
  const referenced = await call("compare_web_captures", {
    before: { inspection: retained(capture.evidence_id) },
    after: { inspection: retained(capture.evidence_id) },
  });
  expect(referenced.operation).toBe("compare_web_captures");
});
