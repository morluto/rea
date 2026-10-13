import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import { BrowserScenarioSecrets } from "./BrowserScenarioSecrets.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";

describe("declared secrets in scenario events", () => {
  it("redacts encoded declared secrets from text evidence and fingerprints", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const socketListeners = new Map<string, (value: unknown) => void>();
    const page = {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, listener);
      },
    } as unknown as Page;
    const secret = "a/b&c\n d";
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/opt/chromium" },
      start_url: { url: "https://app.example.test/" },
      actions: [
        { step_id: "wait", action: "wait_for_timeout", duration_ms: 1 },
      ],
      secrets: [
        { secret_id: "login_input", environment_variable: "REA_TEST_TOKEN" },
      ],
      capture: { events: ["console", "page-errors", "websockets"] },
    });
    const secrets = BrowserScenarioSecrets.resolve(scenario, {
      REA_TEST_TOKEN: secret,
    });
    if (secrets === undefined) throw new Error("Expected resolved secrets");
    const events = new PlaywrightScenarioEvents({
      page,
      enabled: new Set(["console", "page-errors", "websockets"]),
      secrets,
    });

    listeners.get("console")?.({
      type: () => "log",
      text: () => encodeURIComponent(secret),
      location: () => ({ url: "https://app.example.test/app.js" }),
    });
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    const error = new Error(`failure ${escapedSecret}`);
    error.stack = `failure ${escapedSecret}`;
    listeners.get("pageerror")?.(error);
    listeners.get("websocket")?.({
      url: () => "wss://app.example.test/socket",
      on: (name: string, listener: (value: unknown) => void) => {
        socketListeners.set(name, listener);
      },
    });
    const formEncodedSecret = new URLSearchParams([["value", secret]])
      .toString()
      .slice("value=".length);
    socketListeners.get("framesent")?.({ payload: formEncodedSecret });

    const items = events.result().items;
    expect(items).toMatchObject([
      { kind: "console", text: "[REDACTED:login_input]" },
      {
        kind: "page-error",
        message: "failure [REDACTED:login_input]",
        stack: "failure [REDACTED:login_input]",
      },
      { kind: "websocket-opened" },
      {
        kind: "websocket-frame-sent",
        payload_text: "[REDACTED:login_input]",
      },
    ]);
    expect(secrets.fingerprint(`stored ${encodeURIComponent(secret)}`)).toEqual(
      { value_state: "redacted-secret", value_sha256: null },
    );
  });
});

describe("PlaywrightScenarioEvents", () => {
  it("observes requested popup page errors independently of popup lifecycle events", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    const popupListeners = new Map<string, (value: unknown) => void>();
    const page = {
      on: (name: string, listener: (value: unknown) => void) => {
        listeners.set(name, listener);
      },
    } as unknown as Page;
    const popup = {
      url: () => "https://app.example.test/popup",
      on: (name: string, listener: (value: unknown) => void) => {
        popupListeners.set(name, listener);
      },
    } as unknown as Page;
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: "/opt/chromium" },
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
    listeners.get("popup")?.(popup);
    popupListeners.get("pageerror")?.(new Error("popup application failure"));
    expect(events.result().items).toMatchObject([
      { kind: "page-error", message: "popup application failure" },
    ]);
  });

  it("retains oversized page errors without truncating their text", () => {
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

    listeners.get("pageerror")?.(error);
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
