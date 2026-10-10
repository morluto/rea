import { afterEach, expect, it, vi } from "vitest";

import { browserScenarioSchema } from "../domain/browserScenario.js";
import * as browserBoundary from "./PlaywrightScenarioBrowser.js";
import { PlaywrightScenarioBrowserCleanupOwner } from "./PlaywrightScenarioBrowser.js";
import { PlaywrightScenarioEvents } from "./PlaywrightScenarioEvents.js";
import { PlaywrightScenarioSession } from "./PlaywrightScenarioSession.js";
import { PlaywrightScenarioStorage } from "./PlaywrightScenarioStorage.js";

afterEach(() => vi.restoreAllMocks());

it("retries storage cleanup independently of finalized events and browser cleanup", async () => {
  const closeStorage = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("storage cleanup failed"))
    .mockResolvedValue(undefined);
  const closeBrowser = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined);
  const finishEvents = vi.spyOn(PlaywrightScenarioEvents.prototype, "finish");
  vi.spyOn(PlaywrightScenarioStorage, "install").mockResolvedValue({
    close: closeStorage,
    settle: () => Promise.resolve(),
  } as unknown as PlaywrightScenarioStorage);
  vi.spyOn(browserBoundary, "openPlaywrightScenarioBrowser").mockResolvedValue({
    context: {
      addCookies: () => Promise.resolve(),
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
    },
    page: {
      url: () => "https://app.example.test/",
      goto: () => Promise.resolve(null),
    },
    browser: { version: () => "test" },
    cleanup: new PlaywrightScenarioBrowserCleanupOwner({
      closeBrowser,
      removeProfile: undefined,
    }),
  } as unknown as browserBoundary.OpenedScenarioBrowser);
  const scenario = browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: "/opt/chromium" },
    start_url: { url: "https://app.example.test/" },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
  });
  const session = await PlaywrightScenarioSession.open(scenario, {}, {});

  await expect(session.close()).rejects.toThrow("storage cleanup failed");
  await expect(session.close()).resolves.toBe("terminated-owned-process");
  expect(closeStorage).toHaveBeenCalledTimes(2);
  expect(finishEvents).toHaveBeenCalledTimes(1);
  expect(closeBrowser).toHaveBeenCalledTimes(1);
});
