import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { dirname } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type { BrowserScenarioCapturePort } from "../../../src/application/BrowserScenarioCapturePort.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { loadConfiguredPermissionAuthority } from "../../../src/application/PermissionConfiguration.js";
import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../../../src/application/AnalysisProvider.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { parseConfig } from "../../../src/config.js";
import { sanitizeBrowserUrl } from "../../../src/domain/browserObservation.js";
import type { BrowserScenario } from "../../../src/domain/browserScenario.js";
import {
  browserScenarioCaptureSchema,
  type BrowserScenarioCapture,
} from "../../../src/domain/browserScenarioCapture.js";
import type { AnalysisError } from "../../../src/domain/errors.js";
import { ok, type Result } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

const providerIdentity: ProviderIdentity = {
  id: "test-browser-scenario",
  name: "Test browser scenario provider",
  version: "1",
};

class FakeBrowserScenarioProvider implements BrowserScenarioCapturePort {
  readonly scenarios: BrowserScenario[] = [];

  identity(): ProviderIdentity {
    return providerIdentity;
  }

  captureScenario(
    scenario: BrowserScenario,
    _options?: ExecutionOptions,
  ): Promise<Result<BrowserScenarioCapture, AnalysisError>> {
    this.scenarios.push(scenario);
    return Promise.resolve(ok(captureFor(scenario)));
  }
}

const artifacts = {
  screenshot: { state: "not_requested" },
  dom: { state: "not_requested" },
  accessibility: { state: "not_requested" },
  url: { state: "not_requested" },
  history: { state: "not_requested" },
  storage: { state: "not_requested" },
} as const;

const captureFor = (scenario: BrowserScenario): BrowserScenarioCapture => {
  const start = scenario.start_url.url;
  const step = (stepIndex: number, stepId: string, action: string) => ({
    step_index: stepIndex,
    step_id: stepId,
    action,
    status: "completed",
    elapsed_ms: 1,
    before_url: sanitizeBrowserUrl(start),
    after_url: sanitizeBrowserUrl(start),
    error: null,
    event_sequence_start: 1,
    event_sequence_end: 0,
    artifacts,
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
  });
  return browserScenarioCaptureSchema.parse({
    schema_version: 1,
    browser: {
      mode: scenario.browser.mode,
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Test Browser",
      version: "1",
    },
    scenario: {
      start_origin: new URL(start).origin,
      allowed_origins: scenario.allowed_origins,
      action_count: scenario.actions.length,
      secret_references: scenario.secrets.map(({ secret_id: id }) => id),
    },
    duration_ms: 2,
    steps: [
      step(0, "scenario_start", "goto_start"),
      ...scenario.actions.map((action, index) =>
        step(index + 1, action.step_id, action.action),
      ),
    ],
    events: { retained: 0, dropped: 0, items: [] },
    completeness: {
      status: "complete",
      equality_eligible: true,
      missing_sections: [],
      truncated_sections: [],
    },
    limitations: [],
  });
};

const scenario = (origin = "https://app.example.test") => ({
  schema_version: 1,
  browser: {
    mode: "launch",
    executable_path: process.execPath,
    headless: true,
    user_data: "temporary-owned",
    cleanup: "close-and-delete-profile",
  },
  start_url: { url: `${origin}/`, query: [] },
  allowed_origins: [origin],
  environment: {
    viewport: { width: 1_280, height: 720 },
    locale: "en-US",
    timezone: "UTC",
    color_scheme: "light",
    reduced_motion: "reduce",
    service_workers: "block",
  },
  actions: [
    {
      step_id: "login-input",
      action: "fill",
      locator: { kind: "test_id", value: "password" },
      value: { source: "secret", secret_id: "login_input" },
    },
  ],
  storage: {},
  request_replay: { mode: "disabled" },
  secrets: [
    {
      secret_id: "login_input",
      environment_variable: "REA_TEST_PASSWORD",
      purpose: "input",
      redaction: "replace-with-secret-reference",
    },
  ],
  redaction: {
    secret_values: "replace-with-secret-reference",
    query_parameter_names: [],
  },
  capture: { after_each_step: [], at_end: [], events: [] },
  limits: {
    max_duration_ms: 10_000,
    action_timeout_ms: 1_000,
    navigation_timeout_ms: 1_000,
    max_events: 100,
    max_frames: 10,
    max_workers: 5,
    max_popups: 2,
    max_websockets: 10,
    max_dom_nodes: 1_000,
    max_accessibility_nodes: 1_000,
    max_screenshots: 2,
    max_screenshot_bytes: 1_048_576,
    max_storage_entries: 100,
    max_total_metadata_bytes: 1_048_576,
  },
  approved: true,
});

describe("browser scenario MCP tool", () => {
  const resources: Array<{ close(): Promise<unknown> }> = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map((item) => item.close()));
  });

  test("authorizes exact scope, records Evidence, and retains no secret value", async () => {
    const configured = parseConfig({
      REA_BROWSER_SCENARIO_ENABLED: "true",
      REA_BROWSER_SCENARIO_AUTO_GRANT: "true",
      REA_BROWSER_SCENARIO_EXECUTABLE_ROOTS_JSON: JSON.stringify([
        dirname(process.execPath),
      ]),
      REA_BROWSER_SCENARIO_ALLOWED_ORIGINS_JSON: '["https://app.example.test"]',
      REA_BROWSER_SCENARIO_ALLOWED_ENV_JSON: '["REA_TEST_PASSWORD"]',
    });
    if (!configured.ok) throw configured.error;
    const authority = await loadConfiguredPermissionAuthority(configured.value);
    if (!authority.ok) throw authority.error;
    const provider = new FakeBrowserScenarioProvider();
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session, {
      browserObservation: new CdpBrowserProvider(),
      browserScenarioCapture: provider,
      permissionAuthority: authority.value,
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
        evidenceFileRoots: 0,
        investigationInputRoots: 0,
        browserObservationEnabled: true,
        browserScenarioEnabled: true,
      }),
    });
    const client = new Client({ name: "browser-scenario-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(client, server, session);
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const captured = await client.callTool({
      name: "capture_browser_scenario",
      arguments: scenario(),
    });
    expect(captured.isError, JSON.stringify(captured)).not.toBe(true);
    expect(captured.structuredContent).toMatchObject({
      result: {
        scenario: {
          secret_references: ["login_input"],
        },
      },
    });
    expect(provider.scenarios).toHaveLength(1);
    expect(JSON.stringify(captured.structuredContent)).not.toContain(
      "correct horse battery staple",
    );
    const evidenceId = Reflect.get(
      captured.structuredContent ?? {},
      "evidence_id",
    );
    expect(session.evidenceById(String(evidenceId))).toMatchObject({
      predicate_type: "rea.browser-scenario-capture/v1",
    });
    const captureResult = Reflect.get(
      captured.structuredContent ?? {},
      "result",
    );
    const compared = await client.callTool({
      name: "compare_web_captures",
      arguments: {
        before_scenario: captureResult,
        after_scenario: captureResult,
        normalization: { rules: [] },
      },
    });
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    expect(compared.structuredContent).toMatchObject({
      result: {
        comparison_kind: "browser_scenario",
        overall_status: "unchanged",
        alignment: { status: "aligned", aligned_steps: 2 },
      },
    });

    const denied = await client.callTool({
      name: "capture_browser_scenario",
      arguments: scenario("https://other.example.test"),
    });
    expect(denied.isError).toBe(true);
    expect(provider.scenarios).toHaveLength(1);

    const unapprovedEnvironment = scenario();
    const secretDeclaration = unapprovedEnvironment.secrets.at(0);
    if (secretDeclaration === undefined)
      throw new Error("Scenario secret fixture disappeared");
    secretDeclaration.environment_variable = "REA_UNAPPROVED_SECRET";
    const deniedSecret = await client.callTool({
      name: "capture_browser_scenario",
      arguments: unapprovedEnvironment,
    });
    expect(deniedSecret.isError).toBe(true);
    expect(provider.scenarios).toHaveLength(1);
  });
});
