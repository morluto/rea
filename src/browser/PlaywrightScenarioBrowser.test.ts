import { expect, it } from "vitest";

import { closePlaywrightScenarioBrowser } from "./PlaywrightScenarioBrowser.js";

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
