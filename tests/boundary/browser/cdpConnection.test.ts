import { afterEach, describe, expect, it, vi } from "vitest";

import { CdpConnection } from "../../../src/browser/CdpConnection.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const INVALID_REPLIES = [
  ["missing result and error", (id: number) => ({ id })],
  [
    "both result and error",
    (id: number) => ({
      id,
      result: {},
      error: { code: -32_602, message: "Invalid params" },
    }),
  ],
  [
    "malformed error",
    (id: number) => ({
      id,
      error: { code: "bad", message: "Invalid params" },
    }),
  ],
  ["invalid result", (id: number) => ({ id, result: [] })],
  ["invalid session id", (id: number) => ({ id, result: {}, sessionId: 7 })],
  [
    "foreign session id",
    (id: number) => ({ id, result: {}, sessionId: "foreign-session" }),
  ],
] as const;

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
      browser.emitRawMessage(JSON.stringify({ id: 999 }));
      await expect(connection.send("Runtime.enable")).resolves.toEqual({});
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

  it("surfaces an unmodeled fake command as a CDP method rejection", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "observe_web_session",
    );
    try {
      await expect(
        connection.send("Fixture.unmodeledMethod"),
      ).rejects.toMatchObject({
        _tag: "BrowserObservationError",
        command: "Fixture.unmodeledMethod",
        code: -32_601,
        reportedMessage: "Method not found: Fixture.unmodeledMethod",
      });
    } finally {
      await connection.close();
    }
  });

  it.each(INVALID_REPLIES)(
    "fails the connection for a correlated reply with %s",
    async (_case, reply) => {
      const browser = await startFakeCdpBrowser({
        hangOnMethod: "Page.enable",
      });
      browsers.push(browser);
      const connection = await CdpConnection.connect(
        browser.browserWebSocketUrl,
        "observe_web_session",
      );
      try {
        const pending = connection.send("Page.enable", {}, "selected-session");
        const rejection = expect(pending).rejects.toMatchObject({
          _tag: "BrowserObservationError",
          reason: "protocol_error",
        });
        await vi.waitFor(() => expect(browser.commands).toHaveLength(1));
        const command = browser.commands[0];
        if (command === undefined)
          throw new Error("Fake browser received no command");
        browser.emitRawMessage(JSON.stringify(reply(command.id)));
        await rejection;
        await expect(connection.send("Runtime.enable")).rejects.toMatchObject({
          reason: "protocol_error",
        });
      } finally {
        await connection.close();
      }
    },
  );

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
