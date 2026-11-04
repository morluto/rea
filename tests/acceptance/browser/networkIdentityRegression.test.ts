import { expect, it } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webBundleAnalysisSchema } from "../../../src/domain/webBundleAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

it("reports uncertain fetch identity after opaque code", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Debugger.getScriptSource"
        ? { scriptSource: "eval(code); fetch('/candidate');" }
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
    expect(report.inferences).toContainEqual(
      expect.objectContaining({
        kind: "endpoint_candidate",
        value: "/candidate",
      }),
    );
    expect(report.completeness.status).toBe("partial");
    const candidate = report.inferences.find(
      ({ value }) => value === "/candidate",
    );
    expect(candidate?.basis.length).toBeGreaterThan(0);
    expect(report.unknowns).toContainEqual(
      expect.objectContaining({
        dimension: "network_identity",
        affected_script_keys: [candidate!.basis[0]!.script_key],
      }),
    );
    const summary = await call("inspect_analysis_view", {
      source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
      view: { kind: "web-bundle", collection: "summary" },
    });
    expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
    expect(
      parseEvidence(summary.structuredContent).normalized_result,
    ).toMatchObject({
      summary: { completeness: { status: "partial" } },
    });
  } finally {
    await browser.close();
  }
}, 120_000);

it("does not reclassify a replaced browser API through MCP", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Debugger.getScriptSource"
        ? {
            scriptSource:
              "globalThis.navigator.sendBeacon('/first','');globalThis.navigator.sendBeacon=custom;globalThis.navigator.sendBeacon('/second','');client.sendBeacon('/candidate','');",
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
    expect(report.observations.endpoints.map(({ value }) => value)).toContain(
      "/first",
    );
    const candidates = report.inferences
      .filter(({ kind }) => kind === "endpoint_candidate")
      .map(({ value }) => value);
    expect(candidates).toContain("/candidate");
    expect(candidates).not.toContain("/second");
  } finally {
    await browser.close();
  }
}, 120_000);
