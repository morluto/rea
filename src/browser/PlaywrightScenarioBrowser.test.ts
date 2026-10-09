import { afterEach, expect, it, vi } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import {
  closePlaywrightScenarioBrowser,
  openPlaywrightScenarioBrowser,
} from "./PlaywrightScenarioBrowser.js";

afterEach(() => vi.unstubAllEnvs());

it("passes the selected environment to the actual browser launch boundary", async () => {
  vi.stubEnv("LANG", "ambient-language");
  const selected = {
    LANG: "selected-language",
    PATH: "/selected/bin",
    REA_PRIVATE_VALUE: "not-a-launch-setting",
  };
  let launchedEnvironment: unknown;
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: "https://example.test" },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
  });
  await expect(
    openPlaywrightScenarioBrowser(scenario, selected, {
      connectOverCDP: async () => {
        throw new Error("Unexpected connection");
      },
      launchPersistentContext: async (_profile, options) => {
        launchedEnvironment = options?.env;
        throw new Error("launch boundary reached");
      },
    }),
  ).rejects.toThrow("launch boundary reached");
  expect(launchedEnvironment).toEqual({
    LANG: "selected-language",
    PATH: "/selected/bin",
  });
});

it("returns cancellation instead of success when an attached browser hangs on close", async () => {
  const controller = new AbortController();
  let closeStarted = false;
  const closing = closePlaywrightScenarioBrowser(
    {
      browser: {
        close: () => {
          closeStarted = true;
          return new Promise<void>(() => undefined);
        },
      },
      context: { close: async () => undefined },
      profilePath: undefined,
    },
    controller.signal,
  );

  controller.abort();
  expect(closeStarted).toBe(true);
  await expect(closing).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "cleanup_failed",
    cleanupIncomplete: true,
    userCategory: "cancelled",
  });
});
