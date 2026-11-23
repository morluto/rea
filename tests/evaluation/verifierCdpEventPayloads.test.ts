import { describe, expect, it } from "vitest";
import { CdpConnection } from "../../src/browser/CdpConnection.js";
import type { CdpEventName } from "../../src/browser/protocol/CdpEvents.js";
import { startFakeCdpBrowser } from "../fixtures/fakeCdpBrowser.js";

describe("verifier CDP event subscribers", () => {
  it("refuses an unregistered event name before subscribing", async () => {
    const browser = await startFakeCdpBrowser();
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "inspect_web_page",
    );
    try {
      expect(() =>
        connection.onRegisteredEvent(
          "Page.notRegistered" as CdpEventName,
          () => undefined,
        ),
      ).toThrow(
        expect.objectContaining({
          _tag: "BrowserObservationError",
          reason: "protocol_error",
        }),
      );
      const received: string[] = [];
      connection.onRegisteredEvent("Page.lifecycleEvent", (registered) =>
        received.push(registered.payload.name ?? ""),
      );
      browser.emitEvent({
        method: "Page.frameDetached",
        params: { frameId: "main" },
      });
      browser.emitEvent({
        method: "Page.lifecycleEvent",
        params: { frameId: "main", loaderId: "loader", name: "load" },
      });
      await expect.poll(() => received).toEqual(["load"]);
    } finally {
      await connection.close();
      await browser.close();
    }
  });
});
