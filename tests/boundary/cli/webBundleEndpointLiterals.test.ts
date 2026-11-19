import { afterEach, expect } from "vitest";
import { z } from "zod";

import { webBundleAnalysisSchema } from "../../../src/domain/webBundleAnalysis.js";
import {
  WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
  WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
} from "../../../src/domain/webBundleEndpointLiteralBudget.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const browsers: FakeCdpBrowser[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

/** A literal route table, a base URL constant and one real request. */
const tableSource = [
  "const routes = ['/api/daily/stats', '/api/progress/complete', '/api/multiplayer/hint'];",
  "const BASE = 'https://api.example.test';",
  "fetch('/api/feedback');",
  "const settings = new Map(); settings.get('dpl');",
].join("\n");

const serveBundle = async (): Promise<FakeCdpBrowser> => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }) =>
      method === "Debugger.getScriptSource"
        ? { scriptSource: tableSource }
        : undefined,
  });
  browsers.push(browser);
  return browser;
};

const analyzeArguments = (browser: FakeCdpBrowser): string[] => [
  "analyze-web-bundle",
  browser.endpoint,
  "allowed-page",
  "--allowed-origins",
  browser.allowedOrigin,
  "--observation-ms",
  "0",
  "--json",
];

const normalized = (document: unknown) =>
  z.object({ normalized_result: webBundleAnalysisSchema }).parse(document)
    .normalized_result;

cliTest.for(["CLI", "stdio MCP"] as const)(
  "delivers literal endpoint candidates through %s without promoting them to observations",
  { timeout: 60_000 },
  async (surface, { cli }) => {
    const browser = await serveBundle();
    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: analyzeArguments(browser),
        environment: process.env,
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const call = await cli.sharedMcpCall!();
      const response = await call("analyze_web_bundle", {
        cdp_endpoint: browser.endpoint,
        target_id: "allowed-page",
        allowed_origins: [browser.allowedOrigin],
        observation_ms: 0,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const result = normalized(document);
    const candidates = result.inferences.filter(
      ({ kind }) => kind === "endpoint_candidate",
    );
    expect(candidates.map(({ value }) => value).sort()).toEqual([
      "/api/daily/stats",
      "/api/multiplayer/hint",
      "/api/progress/complete",
      "https://api.example.test",
    ]);
    for (const candidate of candidates) {
      expect(candidate.confidence).toBe("low");
      expect(candidate.basis[0]).toMatchObject({
        script_key: expect.any(String),
        artifact_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        line: expect.any(Number),
        column: expect.any(Number),
      });
    }
    expect(
      candidates.find(({ value }) => value === "/api/daily/stats")?.basis[0],
    ).toMatchObject({ detector: "literal:path-shaped", line: 1, column: 16 });
    // The literal table is inventory, not a request: the only observed endpoint
    // remains the one the script actually calls.
    expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
      "/api/feedback",
    ]);
    expect(result.endpoint_literal_candidates).toBeUndefined();
  },
);

cliTest(
  "applies the launch seed to the literal inventory",
  { timeout: 60_000 },
  async ({ cli }) => {
    const browser = await serveBundle();
    const response = await cli.run({
      arguments: analyzeArguments(browser),
      environment: {
        ...process.env,
        REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES: "1",
      },
      // A launch seed is a startup fact, so it cannot share the file's process.
      freshProcess: true,
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = normalized(response.json);
    // Source order decides which literal survives the one-candidate ceiling.
    expect(
      result.inferences
        .filter(({ kind }) => kind === "endpoint_candidate")
        .map(({ value }) => value),
    ).toEqual(["/api/daily/stats"]);
    expect(result.endpoint_literal_candidates).toMatchObject({
      coverage: "partial",
      code: WEB_BUNDLE_ENDPOINT_LITERAL_CODE,
      admitted_count: 1,
      omitted_by_result_budget: 0,
      ceiling: "adjustable",
      limit: {
        setting: WEB_BUNDLE_ENDPOINT_LITERAL_SETTING_ID,
        effective_value: 1,
        unit: "count",
      },
    });
    expect(result.completeness.status).toBe("partial");
    expect(result.unknowns).toContainEqual(
      expect.objectContaining({ dimension: "endpoint_literal_candidates" }),
    );
  },
);
