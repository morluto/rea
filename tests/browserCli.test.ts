import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";

const execute = promisify(execFile);
const browsers: FakeCdpBrowser[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 40_000;

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

const startBrowserContext = async (): Promise<{
  readonly browser: FakeCdpBrowser;
  readonly environment: NodeJS.ProcessEnv;
}> => {
  const browser = await startFakeCdpBrowser({
    sessionTimeline: "same_origin",
    webMcpTools: true,
    sensitiveShapes: true,
  });
  browsers.push(browser);
  return {
    browser,
    environment: {
      ...process.env,
      REA_BROWSER_OBSERVE_ENABLED: "true",
      REA_BROWSER_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
      REA_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([browser.allowedOrigin]),
    },
  };
};

describe("browser CLI parity", () => {
  it(
    "returns matching discovery, inspection, and comparison contracts",
    async () => {
      const { browser, environment } = await startBrowserContext();
      const listed = await runCli(
        ["list-browser-targets", browser.endpoint, "--approved", "--json"],
        environment,
      );
      expect(listed).toMatchObject({
        operation: "list_browser_targets",
        provider: { id: "rea-cdp-browser" },
        normalized_result: {
          targets: { items: [{ target_id: "allowed-page" }] },
        },
      });
      const inspected = await runCli(
        [
          "inspect-web-page",
          browser.endpoint,
          "allowed-page",
          "--approved",
          "--observation-ms",
          "0",
          "--include-console-text",
          "--console-text-approved",
          "--include-json-body-shapes",
          "--json-body-schema-approved",
          "--include-websocket-shapes",
          "--websocket-shape-approved",
          "--json",
        ],
        environment,
      );
      expect(inspected).toMatchObject({
        operation: "inspect_web_page",
        provider: { id: "rea-cdp-browser" },
        normalized_result: {
          target: { target_id: "allowed-page" },
          network: {
            prior_activity_available: false,
            requests: [
              expect.objectContaining({
                body_shapes: expect.objectContaining({ status: "included" }),
              }),
            ],
          },
        },
      });
      const inspection = normalizedResult(inspected);
      const compared = await runCli(
        [
          "compare-web-captures",
          JSON.stringify({ inspection }),
          JSON.stringify({ inspection }),
          "--json",
        ],
        environment,
      );
      expect(compared).toMatchObject({
        operation: "compare_web_captures",
        normalized_result: {
          overall_status: "unknown",
          dimensions: {
            network: { status: "unknown", total_changes: 0 },
          },
        },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "returns bundle, session, and WebMCP contracts",
    async () => {
      const { browser, environment } = await startBrowserContext();
      const analyzed = await runCli(
        [
          "analyze-web-bundle",
          browser.endpoint,
          "allowed-page",
          "--approved",
          "--source-capture-approved",
          "--observation-ms",
          "0",
          "--json",
        ],
        environment,
      );
      expect(analyzed).toMatchObject({
        operation: "analyze_web_bundle",
        normalized_result: {
          capture: { scripts_analyzed: 1 },
          observations: { source_maps: { status: "not_requested" } },
        },
      });
      const observedSession = await runCli(
        [
          "observe-web-session",
          browser.endpoint,
          "allowed-page",
          "--approved",
          "--observation-ms",
          "5",
          "--json",
        ],
        environment,
      );
      expect(observedSession).toMatchObject({
        operation: "observe_web_session",
        normalized_result: {
          window: { end_reason: "window_elapsed" },
          timeline: expect.arrayContaining([
            expect.objectContaining({ type: "same_origin_reload" }),
          ]),
        },
      });
      const webMcp = await runCli(
        [
          "discover-webmcp-tools",
          browser.endpoint,
          "allowed-page",
          "--approved",
          "--observation-ms",
          "0",
          "--json",
        ],
        environment,
      );
      expect(webMcp).toMatchObject({
        operation: "discover_webmcp_tools",
        normalized_result: {
          tools: {
            items: [expect.objectContaining({ name: "search_orders" })],
          },
        },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "returns screenshot, visual comparison, and policy contracts",
    async () => {
      const { browser, environment } = await startBrowserContext();
      const screenshot = await runCli(
        [
          "capture-web-screenshot",
          browser.endpoint,
          "allowed-page",
          "--approved",
          "--screenshot-approved",
          "--json",
        ],
        environment,
      );
      const artifact = screenshotArtifact(screenshot);
      expect(artifact).toMatchObject({ media_type: "image/png", bytes: 70 });
      const visual = await runCli(
        [
          "compare-web-screenshots",
          JSON.stringify(artifact),
          JSON.stringify(artifact),
          "--json",
        ],
        environment,
      );
      expect(visual).toMatchObject({
        operation: "compare_web_screenshots",
        normalized_result: { status: "identical", changed_pixels: 0 },
      });
      const policy = await runCli(
        [
          "policy",
          "explain",
          "browser_observe",
          "--origins",
          browser.endpoint,
          "--origins",
          browser.allowedOrigin,
          "--network",
          "loopback",
          "--json",
        ],
        environment,
      );
      expect(policy).toEqual({
        allowed: true,
        grant_id: "administrator:browser_observe",
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );

  it(
    "requires explicit approval before opening the CDP endpoint",
    async () => {
      const browser = await startFakeCdpBrowser();
      browsers.push(browser);
      const result = await runCli(
        ["list-browser-targets", browser.endpoint, "--json"],
        {
          ...process.env,
          REA_BROWSER_OBSERVE_ENABLED: "true",
          REA_BROWSER_CDP_ENDPOINTS_JSON: JSON.stringify([browser.endpoint]),
          REA_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([
            browser.allowedOrigin,
          ]),
        },
      );
      expect(result).toMatchObject({
        error: "Browser observation failed",
        code: "invalid_request",
        category: "invalid_input",
      });
      expect(browser.commands).toHaveLength(0);
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<unknown> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      {
        cwd: process.cwd(),
        env: environment,
        maxBuffer: 16 * 1_024 * 1_024,
      },
    );
    return JSON.parse(stdout);
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return JSON.parse(cause.stdout);
    throw cause;
  }
};

const screenshotArtifact = (value: unknown): Record<string, unknown> => {
  if (
    !isRecord(value) ||
    !isRecord(value.normalized_result) ||
    !isRecord(value.normalized_result.artifact)
  )
    throw new TypeError("Missing CLI screenshot artifact");
  return value.normalized_result.artifact;
};

const normalizedResult = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value) || !isRecord(value.normalized_result))
    throw new TypeError("Missing CLI normalized result");
  return value.normalized_result;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
