import { EventEmitter } from "node:events";

import type { BrowserContext, CDPSession, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";

import { newPlaywrightCdpSession } from "./PlaywrightCdpSession.js";

const fakeSession = (): EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
} =>
  Object.assign(new EventEmitter(), {
    send: vi.fn(async () => ({})),
    detach: vi.fn(async () => undefined),
  });

describe("Playwright CDP session event relay", () => {
  it("keeps a listener failure inside the session and rejects later commands with it", async () => {
    const raw = fakeSession();
    const session = await newPlaywrightCdpSession(
      {
        newCDPSession: async () => raw as unknown as CDPSession,
      } as Pick<BrowserContext, "newCDPSession">,
      {} as Page,
      "capture_browser_scenario",
    );
    const listenerFailure = new Error("listener rejected a malformed event");
    const listener = vi.fn(() => {
      throw listenerFailure;
    });
    session.on("Runtime.executionContextsCleared", listener);

    // Playwright emits from its connection callback; nothing may escape here.
    expect(() =>
      raw.emit("Runtime.executionContextsCleared", {}),
    ).not.toThrow();
    raw.emit("Runtime.executionContextsCleared", {});

    expect(listener).toHaveBeenCalledTimes(1);
    await expect(session.send("Page.enable")).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "protocol_error",
      cause: listenerFailure,
    });
    expect(raw.send).not.toHaveBeenCalled();
  });
});
