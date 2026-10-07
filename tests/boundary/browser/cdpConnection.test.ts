import { afterEach, describe, expect, it, vi } from "vitest";

import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

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
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "inspect_web_page",
    );
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

  it("waits for an unresponsive command until caller cancellation", async () => {
    const browser = await startFakeCdpBrowser({ hangOnMethod: "Page.enable" });
    browsers.push(browser);
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "observe_web_session",
    );
    try {
      const controller = new AbortController();
      const pending = connection.send(
        "Page.enable",
        {},
        undefined,
        controller.signal,
      );
      const assertion = expect(pending).rejects.toMatchObject({
        _tag: "AnalysisCancelledError",
        operation: "observe_web_session",
      });
      controller.abort();
      await assertion;
    } finally {
      await connection.close();
    }
  });
  it("preserves the selected payload limit reason for pending and subsequent commands", async () => {
    const browser = await startFakeCdpBrowser({
      commandResult: () => ({ oversized: "x".repeat(2_048) }),
    });
    browsers.push(browser);
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "observe_web_execution",
      undefined,
      { maxPayloadBytes: 512 },
    );
    try {
      for (const method of ["Runtime.enable", "Debugger.enable"]) {
        await expect(connection.send(method)).rejects.toMatchObject({
          reason: "payload_limit",
          userMessage: expect.stringContaining("512 byte protocol budget"),
        });
      }
    } finally {
      await connection.close();
    }
  });
});
