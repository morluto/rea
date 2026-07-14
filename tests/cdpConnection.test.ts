import { afterEach, describe, expect, it, vi } from "vitest";

import { CdpConnection } from "../src/browser/CdpConnection.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";

describe("CDP connection", () => {
  const browsers: FakeCdpBrowser[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      browsers.splice(0).map(async (browser) => browser.close()),
    );
  });

  it("correlates concurrent command responses over a real WebSocket", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const connection = await CdpConnection.connect(browser.browserWebSocketUrl);
    try {
      const [attached, frames] = await Promise.all([
        connection.send("Target.attachToTarget"),
        connection.send("Page.getFrameTree"),
      ]);
      expect(attached).toMatchObject({ sessionId: "session-1" });
      expect(frames).toMatchObject({
        frameTree: { frame: { id: "frame-main" } },
      });
    } finally {
      await connection.close();
    }
  });

  it("returns a typed timeout for an unresponsive CDP command", async () => {
    const browser = await startFakeCdpBrowser({ hangOnMethod: "Page.enable" });
    browsers.push(browser);
    const connection = await CdpConnection.connect(browser.browserWebSocketUrl);
    vi.useFakeTimers();
    try {
      const pending = connection.send("Page.enable");
      const assertion = expect(pending).rejects.toMatchObject({
        _tag: "AnalysisTimeoutError",
        operation: "inspect_web_page",
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
    } finally {
      vi.useRealTimers();
      await connection.close();
    }
  });
});
