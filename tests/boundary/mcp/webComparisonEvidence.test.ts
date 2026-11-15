import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webVerificationScenario } from "../../../src/domain/reconstructionWebVerification.fixture.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";

it("verifies one passive DOM dimension from observations through the production CDP adapter", async () => {
  const browser = await startFakeCdpBrowser();
  const harness = await createApplicationMcpHarness({
    serverOptions: { browserObservation: new CdpBrowserProvider() },
  });
  try {
    const capture = async () => {
      const response = await harness.client.callTool({
        name: "inspect_web_page",
        arguments: {
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          allowed_origins: [
            browser.allowedOrigin,
            "https://private.example.test",
          ],
          observation_ms: 1,
        },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      return parseEvidence(response.structuredContent);
    };
    const left = await capture();
    const right = await capture();
    expect(left.evidence_id).not.toBe(right.evidence_id);
    const compared = await harness.client.callTool({
      name: "compare_web_captures",
      arguments: { left, right },
    });
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    const comparison = parseEvidence(compared.structuredContent);
    const verified = await harness.client.callTool({
      name: "verify_reconstruction",
      arguments: {
        specification: {
          name: "Observed DOM",
          claims: [
            {
              claim_id: "page.dom",
              title: "Observed DOM structure",
              kind: "web-capture",
              dimension: "dom_structure",
              comparison_evidence_id: comparison.evidence_id,
            },
          ],
        },
      },
    });
    expect(verified.isError, JSON.stringify(verified)).not.toBe(true);
    expect(
      parseEvidence(verified.structuredContent).normalized_result,
      JSON.stringify(verified.structuredContent),
    ).toMatchObject({ status: "pass" });
  } finally {
    await harness.close();
    await browser.close();
  }
});
it("compares offline, retains inline sources and accepts exact retained references with valid advertised schemas", async () => {
  const harness = await createApplicationMcpHarness();
  try {
    const left = webVerificationScenario();
    const right = webVerificationScenario({ duration: 2 });
    const tools = (await harness.client.listTools()).tools;
    const advertised = tools.find(
      (tool) => tool.name === "compare_web_captures",
    );
    if (advertised === undefined)
      throw new Error("Missing web comparison contract");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    expect(ajv.validateSchema(advertised.inputSchema)).toBe(true);
    const validate = ajv.compile(advertised.inputSchema);
    expect(validate({ left, right }), JSON.stringify(validate.errors)).toBe(
      true,
    );
    const response = await harness.client.callTool({
      name: "compare_web_captures",
      arguments: { left, right },
    });
    expect(response.isError).not.toBe(true);
    const comparison = parseEvidence(response.structuredContent);
    expect(comparison).toMatchObject({
      confidence: "derived",
      authority: "analyst-inference",
      subject: null,
    });
    expect(comparison.evidence_links).toEqual(
      [left.evidence_id, right.evidence_id].sort(),
    );
    const storedIds = harness.session
      .exportEvidenceBundle()
      .records.map((record) => record.evidence_id);
    expect(storedIds).toEqual(
      expect.arrayContaining([
        ...comparison.evidence_links,
        comparison.evidence_id,
      ]),
    );
    expect(comparison.parameters).not.toHaveProperty("before_scenario");
    const references = {
      left: { kind: "retained-evidence", evidence_id: left.evidence_id },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
    };
    expect(validate(references), JSON.stringify(validate.errors)).toBe(true);
    const again = await harness.client.callTool({
      name: "compare_web_captures",
      arguments: references,
    });
    expect(again.isError).not.toBe(true);
    expect(parseEvidence(again.structuredContent).evidence_id).toBe(
      comparison.evidence_id,
    );
    const verified = await harness.client.callTool({
      name: "verify_reconstruction",
      arguments: {
        specification: {
          name: "Visible settings",
          claims: [
            {
              claim_id: "settings.dom",
              title: "Settings DOM matches",
              kind: "web-scenario",
              comparison_evidence_id: comparison.evidence_id,
              dimension: "dom",
              step_id: "wait",
            },
          ],
        },
      },
    });
    expect(verified.isError).not.toBe(true);
    expect(
      parseEvidence(verified.structuredContent).normalized_result,
    ).toMatchObject({ status: "pass", summary: { passed: 1 } });
    expect(harness.session.activeTarget()).toBeUndefined();
  } finally {
    await harness.close();
  }
});

it("rejects cross-session references, tampered source records and false origin correspondences without retaining comparisons", async () => {
  const harness = await createApplicationMcpHarness();
  try {
    const left = webVerificationScenario();
    const right = webVerificationScenario({
      origin: "http://localhost:8000",
      duration: 2,
    });
    const missing = await harness.client.callTool({
      name: "compare_web_captures",
      arguments: {
        left: { kind: "retained-evidence", evidence_id: left.evidence_id },
        right,
      },
    });
    expect(parseMcpToolError(missing).error.code).toBe(
      "evidence_integrity_mismatch",
    );
    const tampered = structuredClone(left);
    tampered.parameters.scenario_sha256 = "f".repeat(64);
    const corrupt = await harness.client.callTool({
      name: "compare_web_captures",
      arguments: { left: tampered, right },
    });
    expect(corrupt.isError).toBe(true);
    const mismapped = await harness.client.callTool({
      name: "compare_web_captures",
      arguments: {
        left,
        right,
        origin_mapping: {
          before_origin: "https://wrong.example.test",
          after_origin: "http://localhost:8000",
        },
      },
    });
    expect(mismapped.isError).toBe(true);
    expect(harness.session.exportEvidenceBundle().records).toHaveLength(0);
  } finally {
    await harness.close();
  }
});

it("keeps unavailable pixels unknown and retains their exact selected observations", async () => {
  const harness = await createApplicationMcpHarness();
  try {
    const left = webVerificationScenario({ screenshot: null });
    const right = webVerificationScenario({ screenshot: null, duration: 2 });
    const response = await harness.client.callTool({
      name: "compare_web_screenshots",
      arguments: { left, right, step_id: "wait" },
    });
    expect(response.isError).not.toBe(true);
    const comparison = parseEvidence(response.structuredContent);
    expect(comparison.normalized_result).toMatchObject({
      status: "unavailable",
    });
    const verified = await harness.client.callTool({
      name: "verify_reconstruction",
      arguments: {
        specification: {
          name: "Missing pixels",
          claims: [
            {
              claim_id: "settings.pixels",
              title: "Settings pixels match",
              kind: "web-screenshot",
              dimension: "pixels",
              maximum_changed_ratio: 0,
              comparison_evidence_id: comparison.evidence_id,
            },
          ],
        },
      },
    });
    expect(verified.isError, JSON.stringify(verified)).not.toBe(true);
    expect(
      parseEvidence(verified.structuredContent).normalized_result,
    ).toMatchObject({ status: "unknown", summary: { unknown: 1 } });
  } finally {
    await harness.close();
  }
});
