import { afterEach, expect } from "vitest";
import { z } from "zod";

import { webBundleAnalysisSchema } from "../../../src/domain/webBundleAnalysis.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const browsers: FakeCdpBrowser[] = [];
afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

cliTest.for(["CLI", "stdio MCP"] as const)(
  "delivers literal endpoint candidates through %s without promoting them to observations",
  { timeout: 60_000 },
  async (surface, { cli }) => {
    const source = [
      "apiPostWithRetry('/api/daily/complete');",
      "const routes = ['/api/daily/stats', '/api/progress/complete', '/api/multiplayer/hint'];",
      "const BASE = 'https://api.example.test';",
      "fetch('/api/feedback');",
      "http.post('/api/verified-post', {});",
      "const settings = new Map(); settings.get('dpl');",
    ].join("\n");
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }) =>
        method === "Debugger.getScriptSource"
          ? { scriptSource: source }
          : undefined,
    });
    browsers.push(browser);
    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: [
          "analyze-web-bundle",
          browser.endpoint,
          "allowed-page",
          "--allowed-origins",
          browser.allowedOrigin,
          "--observation-ms",
          "0",
          "--json",
        ],
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
    const { normalized_result: result } = z
      .object({
        normalized_result: webBundleAnalysisSchema,
      })
      .parse(document);
    const candidates = result.inferences.filter(
      ({ kind }) => kind === "endpoint_candidate",
    );
    expect(candidates.map(({ value }) => value).sort()).toEqual([
      "/api/daily/complete",
      "/api/daily/stats",
      "/api/multiplayer/hint",
      "/api/progress/complete",
      "/api/verified-post",
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
      candidates.find(({ value }) => value === "/api/daily/complete")?.basis[0],
    ).toMatchObject({ detector: "literal:path-shaped", line: 1, column: 17 });
    expect(result.observations.endpoints.map(({ value }) => value)).toEqual([
      "/api/feedback",
    ]);
  },
);
