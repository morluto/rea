import { expect, it, onTestFinished } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { withCanonicalOutputSchema } from "../../fixtures/canonicalOutputSchema.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

const connect = async () => {
  const browser = await startFakeCdpBrowser({});
  onTestFinished(() => browser.close());
  const { client } = await createApplicationMcpHarness({
    serverOptions: { browserObservation: new CdpBrowserProvider() },
  });
  const definitions = (await client.listTools()).tools;
  const call = async (name: string, args: Record<string, unknown>) => {
    const definition = definitions.find((tool) => tool.name === name);
    if (definition === undefined) throw new Error(`Missing tool ${name}`);
    const reply = await client.callTool(
      { name, arguments: args },
      { toolDefinition: withCanonicalOutputSchema(definition) },
    );
    expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
    return parseEvidence(reply.structuredContent);
  };
  const page = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  return { call, page };
};

it("returns the analyze_web_bundle summary when detail summary names no view", async () => {
  const { call, page } = await connect();
  const summary = await call("analyze_web_bundle", {
    ...page,
    detail: "summary",
  });
  expect(summary).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "analyze_web_bundle",
    },
  });
});
