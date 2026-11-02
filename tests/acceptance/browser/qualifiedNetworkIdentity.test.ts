import { expect, it } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webBundleAnalysisSchema } from "../../../src/domain/webBundleAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it("retains a qualified intrinsic WebSocket destination through MCP", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Debugger.getScriptSource"
        ? {
            scriptSource:
              "new globalThis.WebSocket('wss://example.test/socket'); new window['WebSocket']('wss://example.test/computed'); globalThis.WebSocket = custom; new globalThis.WebSocket('wss://example.test/replaced');",
          }
        : undefined,
  });
  try {
    const { call } = await connectLocalToolsMcp();
    const response = await call("analyze_web_bundle", {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_script_sources: true,
      fetch_source_maps: false,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const report = webBundleAnalysisSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    expect(report.observations.endpoints).toContainEqual(
      expect.objectContaining({
        value: "wss://example.test/socket",
        location: expect.objectContaining({ script_key: expect.any(String) }),
      }),
    );
    expect(report.observations.endpoints.map(({ value }) => value)).toContain(
      "wss://example.test/computed",
    );
    expect(JSON.stringify(report)).not.toContain("wss://example.test/replaced");
  } finally {
    await browser.close();
  }
}, 120_000);

it("keeps conditional WebSocket identity uncertain without confirming unrelated objects", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Debugger.getScriptSource"
        ? {
            scriptSource: `if (flag) globalThis.WebSocket = custom;
          new globalThis.WebSocket('wss://example.test/uncertain');
          function local(globalThis) { new globalThis.WebSocket('wss://example.test/shadowed'); }
          new service.WebSocket('wss://example.test/unrelated');
          new globalThis[key]('wss://example.test/dynamic');`,
          }
        : undefined,
  });
  try {
    const { call } = await connectLocalToolsMcp();
    const response = await call("analyze_web_bundle", {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_script_sources: true,
      fetch_source_maps: false,
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = parseEvidence(response.structuredContent);
    const report = webBundleAnalysisSchema.parse(evidence.normalized_result);
    expect(report.completeness.status).toBe("partial");
    expect(report.inferences).toContainEqual(
      expect.objectContaining({
        kind: "endpoint_candidate",
        value: "wss://example.test/uncertain",
      }),
    );
    expect(report.observations.endpoints).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("wss://example.test/shadowed");
    expect(JSON.stringify(report)).not.toContain(
      "wss://example.test/unrelated",
    );
    expect(JSON.stringify(report)).not.toContain("wss://example.test/dynamic");
    const summary = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
      view: { kind: "web-bundle", collection: "summary" },
    });
    expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
    expect(
      parseEvidence(summary.structuredContent).normalized_result,
    ).toMatchObject({ summary: { completeness: { status: "partial" } } });
  } finally {
    await browser.close();
  }
}, 120_000);
