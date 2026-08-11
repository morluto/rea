import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { BrowserScenarioCaptureBudget } from "./PlaywrightScenarioArtifacts.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";

describe("PlaywrightScenarioEvents", () => {
  it("bounds oversized page errors before validating captured events", () => {
    const listeners = new Map<string, (value: Error) => void>();
    const page = {
      url: () => "https://app.example.test/",
      on: (name: string, listener: (value: Error) => void) => {
        listeners.set(name, listener);
      },
    } as unknown as Page;
    const scenario = browserScenarioSchema.parse({
      schema_version: 1,
      browser: {
        mode: "launch",
        executable_path: "/opt/chromium",
        headless: true,
        user_data: "temporary-owned",
        cleanup: "close-and-delete-profile",
      },
      start_url: { url: "https://app.example.test/" },
      allowed_origins: ["https://app.example.test"],
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
          step_id: "wait",
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
      storage: {},
      request_replay: { mode: "disabled" },
      secrets: [],
      redaction: {
        secret_values: "replace-with-secret-reference",
        query_parameter_names: [],
      },
      capture: {
        after_each_step: [],
        at_end: [],
        events: ["page-errors"],
      },
      limits: {
        max_duration_ms: 10_000,
        action_timeout_ms: 1_000,
        navigation_timeout_ms: 1_000,
        max_events: 10,
        max_frames: 10,
        max_workers: 10,
        max_popups: 10,
        max_websockets: 10,
        max_dom_nodes: 100,
        max_accessibility_nodes: 100,
        max_screenshots: 1,
        max_screenshot_bytes: 1_024,
        max_storage_entries: 10,
        max_total_metadata_bytes: 1_000_000,
      },
      approved: true,
    });
    const secrets = BrowserScenarioSecrets.resolve(scenario, {});
    if (secrets === undefined) throw new Error("Expected resolved secrets");
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["page-errors"]),
      limits: scenario.limits,
      secrets,
      budget: new BrowserScenarioCaptureBudget(1, 1_000_000),
      allowedOrigins: scenario.allowed_origins,
    });
    const error = new Error("m".repeat(70_000));
    error.stack = "s".repeat(300_000);

    expect(() => listeners.get("pageerror")?.(error)).not.toThrow();
    expect(events.result().items[0]).toMatchObject({
      kind: "page-error",
      message: "m".repeat(65_536),
      stack: "s".repeat(262_144),
    });
  });
});
