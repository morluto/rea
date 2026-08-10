import { describe, expect, it } from "vitest";

import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";

const secret = (secret_id: string) => ({ source: "secret", secret_id });
const literal = (value: string) => ({
  source: "literal",
  value,
  classification: "public",
});

const baseScenario = () => ({
  schema_version: 1,
  browser: {
    mode: "launch",
    executable_path: "/opt/chromium/chrome",
    headless: true,
    user_data: "temporary-owned",
    cleanup: "close-and-delete-profile",
  },
  start_url: {
    url: "https://app.example.test/",
    query: [{ name: "token", value: secret("session") }],
  },
  allowed_origins: ["https://api.example.test", "https://app.example.test"],
  environment: {
    viewport: { width: 1_280, height: 720 },
    locale: "en-US",
    timezone: "UTC",
    color_scheme: "dark",
    reduced_motion: "reduce",
    service_workers: "block",
  },
  actions: [
    {
      step_id: "login",
      action: "fill",
      locator: { kind: "test_id", value: "password" },
      value: secret("login_input"),
    },
    {
      step_id: "submit",
      action: "click",
      locator: {
        kind: "role",
        role: "button",
        name: "Sign in",
        exact: true,
      },
    },
    {
      step_id: "dashboard",
      action: "goto",
      destination: { url: "https://app.example.test/dashboard" },
      wait_until: "load",
    },
  ],
  storage: {
    cookies: [
      {
        name: "sid",
        value: secret("cookie"),
        destination: { url: "https://app.example.test/" },
        http_only: true,
        secure: true,
        same_site: "Lax",
      },
    ],
    local_storage: [
      {
        origin: "https://app.example.test",
        entries: [{ name: "theme", value: literal("dark") }],
      },
    ],
  },
  request_replay: {
    mode: "exact",
    unmatched: "abort",
    routes: [
      {
        route_id: "profile",
        method: "GET",
        request: { url: "https://api.example.test/profile" },
        response: {
          kind: "response",
          status: 200,
          headers: [
            {
              name: "content-type",
              value: literal("application/json"),
            },
          ],
          body: literal('{"name":"Ada"}'),
        },
      },
    ],
  },
  secrets: [
    {
      secret_id: "session",
      environment_variable: "REA_TEST_SESSION",
      purpose: "input",
      redaction: "replace-with-secret-reference",
    },
    {
      secret_id: "login_input",
      environment_variable: "REA_TEST_PASSWORD",
      purpose: "input",
      redaction: "replace-with-secret-reference",
    },
    {
      secret_id: "cookie",
      environment_variable: "REA_TEST_COOKIE",
      purpose: "storage",
      redaction: "replace-with-secret-reference",
    },
  ],
  redaction: {
    secret_values: "replace-with-secret-reference",
    query_parameter_names: ["token"],
  },
  capture: {
    after_each_step: ["screenshot", "url", "accessibility"],
    at_end: ["dom", "storage"],
    events: ["console", "page-errors", "network", "websockets"],
  },
  limits: {
    max_duration_ms: 60_000,
    action_timeout_ms: 5_000,
    navigation_timeout_ms: 10_000,
    max_events: 2_000,
    max_frames: 100,
    max_workers: 20,
    max_popups: 10,
    max_websockets: 100,
    max_dom_nodes: 10_000,
    max_accessibility_nodes: 10_000,
    max_screenshots: 16,
    max_screenshot_bytes: 4 * 1_024 * 1_024,
    max_storage_entries: 256,
    max_total_metadata_bytes: 4 * 1_024 * 1_024,
  },
  approved: true,
});

describe("browserScenarioSchema", () => {
  it("accepts and normalizes a bounded declared scenario", () => {
    const parsed = browserScenarioSchema.parse(baseScenario());
    expect(parsed.allowed_origins).toEqual([
      "https://api.example.test",
      "https://app.example.test",
    ]);
    expect(parsed.environment.viewport.device_scale_factor).toBe(1);
    expect(parsed.redaction.header_names).toEqual([
      "authorization",
      "cookie",
      "proxy-authorization",
      "set-cookie",
    ]);
  });

  it("redacts overlapping secrets longest-first", () => {
    const scenario = browserScenarioSchema.parse(baseScenario());
    const secrets = BrowserScenarioSecrets.resolve(scenario, {
      REA_TEST_SESSION: "prefix",
      REA_TEST_PASSWORD: "prefix-suffix",
      REA_TEST_COOKIE: "cookie",
    });
    expect(secrets?.redact("prefix-suffix")).toBe("[REDACTED:login_input]");
  });

  it("rejects unsupported actions", () => {
    const scenario = baseScenario();
    scenario.actions = [
      {
        step_id: "script",
        action: "evaluate",
        expression: "document.cookie",
      } as never,
    ];
    expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects every undeclared navigation, storage, and replay origin", () => {
    for (const mutate of [
      (scenario: ReturnType<typeof baseScenario>) => {
        scenario.start_url.url = "https://other.example.test/";
      },
      (scenario: ReturnType<typeof baseScenario>) => {
        scenario.actions[2] = {
          ...scenario.actions[2],
          destination: { url: "https://other.example.test/" },
        } as never;
      },
      (scenario: ReturnType<typeof baseScenario>) => {
        scenario.storage.local_storage[0]!.origin =
          "https://other.example.test";
      },
      (scenario: ReturnType<typeof baseScenario>) => {
        scenario.request_replay.routes[0]!.request.url =
          "https://other.example.test/data";
      },
    ]) {
      const scenario = baseScenario();
      mutate(scenario);
      expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
    }
  });

  it("rejects redirects outside declared origins", () => {
    const scenario = baseScenario();
    scenario.request_replay.routes[0]!.response = {
      kind: "redirect",
      status: 302,
      destination: { url: "https://other.example.test/" },
    } as never;
    expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects missing, duplicate, and unused secret declarations", () => {
    const missing = baseScenario();
    missing.secrets = missing.secrets.filter(
      ({ secret_id }) => secret_id !== "login_input",
    );
    expect(browserScenarioSchema.safeParse(missing).success).toBe(false);

    const duplicate = baseScenario();
    duplicate.secrets.push({ ...duplicate.secrets[0]! });
    expect(browserScenarioSchema.safeParse(duplicate).success).toBe(false);

    const unused = baseScenario();
    unused.secrets.push({
      secret_id: "unused",
      environment_variable: "REA_TEST_UNUSED",
      purpose: "input",
      redaction: "replace-with-secret-reference",
    });
    expect(browserScenarioSchema.safeParse(unused).success).toBe(false);
  });

  it("rejects secret query values without named redaction", () => {
    const scenario = baseScenario();
    scenario.redaction.query_parameter_names = [];
    expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects literal credential headers and provider-owned headers", () => {
    for (const name of ["authorization", "content-length"]) {
      const scenario = baseScenario();
      scenario.request_replay.routes[0]!.response = {
        kind: "response",
        status: 200,
        headers: [{ name, value: literal("raw") }],
      } as never;
      expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
    }
  });

  it("rejects duplicate replay response headers case-insensitively", () => {
    const scenario = baseScenario();
    const response = scenario.request_replay.routes[0]!.response;
    if (response.kind !== "response")
      throw new Error("Expected replay response fixture");
    response.headers.push({
      name: "Content-Type",
      value: literal("text/plain"),
    });
    expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects raw secret-shaped action values", () => {
    const scenario = baseScenario();
    scenario.actions[0] = {
      ...scenario.actions[0],
      value: "literal-input",
    } as never;
    expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects embedded URL credentials and query values", () => {
    const credentialedUrl = new URL("https://app.example.test/");
    credentialedUrl.username = String.fromCodePoint(120);
    for (const url of [
      credentialedUrl.href,
      "https://app.example.test/?token=raw",
    ]) {
      const scenario = baseScenario();
      scenario.start_url.url = url;
      expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
    }
  });

  it("requires explicit external ownership for CDP connections", () => {
    const scenario = baseScenario();
    scenario.browser = {
      mode: "connect",
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "page-1",
      ownership: "external",
      cleanup: "disconnect-only",
    } as never;
    expect(browserScenarioSchema.safeParse(scenario).success).toBe(true);

    scenario.browser.cleanup = "close-browser" as never;
    expect(browserScenarioSchema.safeParse(scenario).success).toBe(false);
  });
});
