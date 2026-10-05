import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
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
      browser: {
        mode: "launch",
        executable_path: "/opt/chromium",
      },
      start_url: { url: "https://app.example.test/" },
      environment: {
        viewport: { width: 1_280, height: 720 },
        locale: "en-US",
        timezone: "UTC",
        color_scheme: "light",
        reduced_motion: "reduce",
      },
      actions: [
        {
          step_id: "wait",
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
      storage: {},
      secrets: [],
      capture: {
        after_each_step: [],
        at_end: [],
        events: ["page-errors"],
      },
    });
    const secrets = BrowserScenarioSecrets.resolve(scenario, {});
    if (secrets === undefined) throw new Error("Expected resolved secrets");
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["page-errors"]),
      secrets,
    });
    const error = new Error("m".repeat(70_000));
    error.stack = "s".repeat(300_000);

    expect(() => listeners.get("pageerror")?.(error)).not.toThrow();
    expect(events.result().items[0]).toMatchObject({
      kind: "page-error",
      message: "m".repeat(70_000),
      stack: "s".repeat(300_000),
    });
  });

  it("retains every observed event without a collection count ceiling", () => {
    const listeners = new Map<string, ((value: Error) => void)[]>();
    const page = {
      url: () => "https://app.example.test/",
      on: (name: string, listener: (value: Error) => void) => {
        const registered = listeners.get(name) ?? [];
        registered.push(listener);
        listeners.set(name, registered);
      },
    } as unknown as Page;
    const scenario = browserScenarioSchema.parse({
      browser: {
        mode: "launch",
        executable_path: "/opt/chromium",
      },
      start_url: { url: "https://app.example.test/" },
      actions: [
        { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      ],
      capture: { events: ["page-errors"] },
    });
    const secrets = BrowserScenarioSecrets.resolve(scenario, {});
    if (secrets === undefined) throw new Error("Expected resolved secrets");
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["page-errors"]),
      secrets,
    });
    for (let index = 0; index < 2_001; index += 1)
      listeners
        .get("pageerror")
        ?.forEach((listener) => listener(new Error(`failure-${index}`)));
    expect(events.result()).toMatchObject({ retained: 2_001, dropped: 0 });
    expect(events.result().items.at(-1)).toMatchObject({
      kind: "page-error",
      message: "failure-2000",
    });
  });
});
