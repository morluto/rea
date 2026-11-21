import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { webBundleAnalysisSchema } from "../../../src/domain/webBundleAnalysis.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains semantic limits through capture, real workers, MCP and CLI recovery controls",
  async ({ cli }) => {
    const source =
      "const routes={get path(){return '/a';}};createBrowserRouter([{path:routes.path}]);fetch('/kept');";
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Debugger.getScriptSource"
          ? { scriptSource: source }
          : undefined,
    });
    onTestFinished(() => browser.close());
    const { client } = await createApplicationMcpHarness({
      serverOptions: { browserObservation: new CdpBrowserProvider() },
      schemaValidator: createMcpSchemaValidation(),
    });
    const parameters = {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    };
    const low = await client.callTool({
      name: "analyze_web_bundle",
      arguments: {
        ...parameters,
        semantic_precision: { getter_expansions: 1 },
      },
    });
    expect(low.isError, JSON.stringify(low.content)).not.toBe(true);
    const evidence = parseEvidence(low.structuredContent);
    const report = webBundleAnalysisSchema.parse(evidence.normalized_result);
    expect(report.completeness).toMatchObject({
      status: "partial",
      parse_failures: 0,
    });
    expect(report.observations.endpoints).toContainEqual(
      expect.objectContaining({ value: "/kept" }),
    );
    expect(report.unknowns).toContainEqual(
      expect.objectContaining({
        dimension: "javascript_analysis",
        affected_script_keys: [expect.any(String)],
        limit: expect.objectContaining({
          parameter: "semantic_precision.getter_expansions",
          effective_value: 1,
        }),
      }),
    );
    expect(evidence.parameters).toMatchObject({
      semantic_precision: { getter_expansions: 1 },
    });
    expect(JSON.stringify(report.unknowns)).not.toContain(
      "--semantic-precision",
    );

    const raised = await client.callTool({
      name: "analyze_web_bundle",
      arguments: parameters,
    });
    expect(raised.isError, JSON.stringify(raised.content)).not.toBe(true);
    const recovered = webBundleAnalysisSchema.parse(
      parseEvidence(raised.structuredContent).normalized_result,
    );
    // The fake also advertises sources excluded by capture policy. Raising
    // evaluator precision must clear this budget, not unrelated capture gaps.
    expect(
      recovered.unknowns.filter(
        (entry) =>
          entry.limit !== undefined &&
          "parameter" in entry.limit &&
          entry.limit.parameter === "semantic_precision.getter_expansions",
      ),
    ).toEqual([]);

    const output = await cli.run({
      arguments: [
        "analyze-web-bundle",
        browser.endpoint,
        "allowed-page",
        "--observation-ms",
        "0",
        "--semantic-precision",
        '{"getter_expansions":1}',
        "--format",
        "json",
        "--full-output",
      ],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const envelope = z
      .object({
        data: z.unknown(),
        meta: z.object({ cli_controls: z.record(z.string(), z.string()) }),
      })
      .parse(output.json);
    const cliReport = webBundleAnalysisSchema.parse(
      parseEvidence(envelope.data).normalized_result,
    );
    expect(cliReport.completeness.status).toBe("partial");
    expect(envelope.meta.cli_controls).toMatchObject({
      "semantic_precision.getter_expansions": "--semantic-precision",
    });
    expect(cliReport.unknowns).toContainEqual(
      expect.objectContaining({
        limit: expect.objectContaining({
          parameter: "semantic_precision.getter_expansions",
          effective_value: 1,
        }),
      }),
    );
    expect(browser.activeConnectionCount()).toBe(0);
  },
);
