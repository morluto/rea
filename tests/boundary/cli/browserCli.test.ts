import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const execute = promisify(execFile);
const browsers: FakeCdpBrowser[] = [];
const INTEGRATION_TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

describe("browser CLI parity", () => {
  it(
    "returns the same Evidence discovery and inspection contracts",
    async () => {
      const browser = await startFakeCdpBrowser({
        sessionTimeline: "same_origin",
        webMcpTools: true,
        sensitiveShapes: true,
      });
      browsers.push(browser);
      const listed = await runCli(
        ["list-browser-targets", browser.endpoint, "--json"],
        process.env,
      );
      expect(listed).toMatchObject({
        operation: "list_browser_targets",
        provider: { id: "rea-cdp-browser" },
        normalized_result: {
          targets: expect.arrayContaining([
            expect.objectContaining({ target_id: "allowed-page" }),
            expect.objectContaining({ target_id: "disallowed-page" }),
          ]),
        },
      });
      const inspected = await runCli(
        [
          "inspect-web-page",
          browser.endpoint,
          "allowed-page",
          "--observation-ms",
          "0",
          "--include-console-text",
          "--include-json-body-shapes",
          "--include-websocket-shapes",
          "--json",
        ],
        process.env,
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
        process.env,
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
      const scenarioCapture = completeScenarioCapture();
      const scenarioCompared = await runCli(
        [
          "compare-web-captures",
          JSON.stringify(scenarioCapture),
          JSON.stringify(scenarioCapture),
          "--normalization-json",
          '{"rules":[]}',
          "--json",
        ],
        process.env,
      );
      expect(scenarioCompared).toMatchObject({
        operation: "compare_web_captures",
        normalized_result: {
          comparison_kind: "browser_scenario",
          overall_status: "unchanged",
          alignment: { status: "aligned", aligned_steps: 2 },
        },
      });
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});

describe("browser CLI capture parity", () => {
  it(
    "runs analysis, session, WebMCP, screenshot, and comparison from explicit request scope",
    async () => {
      const browser = await startFakeCdpBrowser({
        sessionTimeline: "same_origin",
        webMcpTools: true,
        sensitiveShapes: true,
      });
      browsers.push(browser);
      const scopeArgs = ["--allowed-origins", browser.allowedOrigin];
      const analyzed = await runCli(
        [
          "analyze-web-bundle",
          browser.endpoint,
          "allowed-page",
          ...scopeArgs,
          "--observation-ms",
          "0",
          "--json",
        ],
        process.env,
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
          ...scopeArgs,
          "--observation-ms",
          "5",
          "--json",
        ],
        process.env,
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
          ...scopeArgs,
          "--observation-ms",
          "0",
          "--json",
        ],
        process.env,
      );
      expect(webMcp).toMatchObject({
        operation: "discover_webmcp_tools",
        normalized_result: {
          tools: {
            items: [expect.objectContaining({ name: "search_orders" })],
          },
        },
      });
      const screenshot = await runCli(
        [
          "capture-web-screenshot",
          browser.endpoint,
          "allowed-page",
          ...scopeArgs,
          "--json",
        ],
        process.env,
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
        process.env,
      );
      expect(visual).toMatchObject({
        operation: "compare_web_screenshots",
        normalized_result: { status: "identical", changed_pixels: 0 },
      });
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

const completeScenarioCapture = () => {
  const url = {
    url: "https://app.example.test/",
    origin: "https://app.example.test",
    query_parameter_names: [],
    redacted: false,
  };
  const completeness = {
    status: "complete",
    equality_eligible: true,
    missing_sections: [],
    truncated_sections: [],
  };
  const artifacts = {
    screenshot: { state: "not_requested" },
    dom: { state: "not_requested" },
    accessibility: { state: "not_requested" },
    url: { state: "captured", value: url },
    history: { state: "not_requested" },
    storage: { state: "not_requested" },
  };
  const step = (stepIndex: number, stepId: string, action: string) => ({
    step_index: stepIndex,
    step_id: stepId,
    action,
    status: "completed",
    elapsed_ms: stepIndex,
    before_url: url,
    after_url: url,
    error: null,
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts,
    completeness,
  });
  return {
    browser: {
      mode: "connect",
      process_ownership: "external",
      cleanup: "disconnected-external",
      product: "Chromium",
      version: "149",
    },
    scenario: {
      start_origin: "https://app.example.test",
      allowed_origins: ["https://app.example.test"],
      action_count: 1,
      secret_references: [],
    },
    duration_ms: 1,
    steps: [
      step(0, "scenario_start", "scenario_start"),
      step(1, "open-settings", "click"),
    ],
    events: { retained: 0, dropped: 0, items: [] },
    completeness,
    limitations: [],
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
