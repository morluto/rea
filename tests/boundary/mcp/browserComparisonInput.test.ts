import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  McpServer,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/server";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { compareWebCaptureEvidence } from "../../../src/application/BrowserObservationService.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  browserCaptureComparisonInputSchema,
  compareBrowserCaptures,
} from "../../../src/domain/browserCaptureComparison.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const contract = toolContract("compare_web_captures");

const comparisonCase =
  (expected: boolean, advertised = expected) =>
  (input: Record<string, unknown>) => ({ input, expected, advertised });

describe("browser comparison input boundary", () => {
  it("advertises complete producer captures and agrees with SDK validation on both comparison families", async () => {
    const browser = await startFakeCdpBrowser({ sensitiveShapes: true });
    const server = new McpServer({ name: "capture-input", version: "0" });
    const client = new Client({ name: "capture-input", version: "0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    let calls = 0;
    const provider = new CdpBrowserProvider();
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async (input) => {
        calls += 1;
        const compared = await compareWebCaptureEvidence(provider, input);
        return compared.ok
          ? delivery.toEvidenceToolResult(compared.value, contract, undefined)
          : delivery.toErrorToolResult(compared.error);
      },
    );
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const advertised = (await client.listTools()).tools.find(
        ({ name }) => name === contract.name,
      );
      if (advertised === undefined) throw new Error("Missing comparison tool");
      expect(advertised.inputSchema.type).toBe("object");
      // Anthropic tool input schemas reject root combinators.
      expect(advertised.inputSchema).not.toHaveProperty("anyOf");
      const ajv = new Ajv2020({ strict: false, validateFormats: false });
      expect(ajv.validateSchema(advertised.inputSchema)).toBe(true);
      const validate = ajv.compile(advertised.inputSchema);
      const produced = await provider.inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          target_id: "allowed-page",
          observation_ms: 0,
          include_json_body_shapes: true,
          include_websocket_shapes: true,
        }),
      );
      if (!produced.ok) throw produced.error;
      const passive = {
        before: { inspection: produced.value },
        after: { inspection: produced.value },
      };
      const scenario = contract.examples[0]?.input;
      if (scenario === undefined) throw new Error("Missing scenario example");
      const withoutNormalization = Object.fromEntries(
        Object.entries(scenario).filter(([key]) => key !== "normalization"),
      );
      const scenarioCapture = browserScenarioCaptureSchema.parse(
        scenario.before_scenario,
      );
      const invalid = [
        {},
        { before: passive.before },
        { before: { inspection: {} }, after: passive.after },
        {
          before: passive.before,
          after: { inspection: produced.value, webmcp: {} },
        },
        { before_scenario: {}, after_scenario: {} },
        { before_scenario: scenario.before_scenario },
        { ...passive, unexpected: true },
        {
          ...scenario,
          before_scenario: { ...scenarioCapture, steps: [{}] },
        },
        {
          ...scenario,
          normalization: {
            rules: [
              { rule_id: "bad", artifacts: [], match: "x", replacement: "y" },
            ],
          },
        },
      ];
      // The object root cannot express group exclusion; the SDK's canonical
      // parser still rejects mixed groups before the handler runs.
      const cases = [
        ...[passive, scenario, withoutNormalization].map(comparisonCase(true)),
        ...invalid.map(comparisonCase(false)),
        ...[
          { ...passive, ...scenario },
          { ...passive, normalization: { rules: [] } },
        ].map(comparisonCase(false, true)),
      ];
      for (const { input, expected, advertised } of cases) {
        expect(validate(input), JSON.stringify(validate.errors)).toBe(
          advertised,
        );
        expect(
          browserCaptureComparisonInputSchema.safeParse(input).success,
        ).toBe(expected);
        const beforeCalls = calls;
        const result = await client.callTool({
          name: contract.name,
          arguments: input,
        });
        expect(calls - beforeCalls).toBe(expected ? 1 : 0);
        expect(result.isError === true).toBe(!expected);
        if (expected)
          expect(result.structuredContent).toMatchObject({
            operation: contract.name,
            normalized_result: compareBrowserCaptures(
              browserCaptureComparisonInputSchema.parse(input),
            ),
          });
      }
      const parsedPassive = browserCaptureComparisonInputSchema.parse(passive);
      expect(parsedPassive).toEqual({
        before: { inspection: produced.value, webmcp: null },
        after: { inspection: produced.value, webmcp: null },
      });
      expect(compareBrowserCaptures(parsedPassive).overall_status).toBe(
        "unknown",
      );
      const parsedScenario =
        browserCaptureComparisonInputSchema.parse(withoutNormalization);
      expect(parsedScenario).toHaveProperty("normalization", { rules: [] });
      expect(compareBrowserCaptures(parsedScenario)).toMatchObject({
        comparison_kind: "browser_scenario",
        overall_status: "unchanged",
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        browser.close(),
      ]);
    }
  });
});
