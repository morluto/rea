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

// JavaScript verifiers can name any command or event; the session refuses an
// unregistered one before it reaches the browser or subscribes.
describe("Playwright CDP session registry", () => {
  const open = async () => {
    const raw = fakeSession();
    const session = await newPlaywrightCdpSession(
      {
        newCDPSession: async () => raw as unknown as CDPSession,
      } as Pick<BrowserContext, "newCDPSession">,
      {} as Page,
      "capture_browser_scenario",
    );
    return { raw, session };
  };

  it("refuses an unregistered command without sending it", async () => {
    const { raw, session } = await open();
    await expect(
      // @ts-expect-error This protocol command has no registered result schema.
      session.send("Accessibility.getPartialAXTree"),
    ).rejects.toMatchObject({
      _tag: "BrowserObservationError",
      reason: "protocol_error",
    });
    expect(raw.send).not.toHaveBeenCalled();
  });

  it("refuses an unregistered event without subscribing", async () => {
    const { raw, session } = await open();
    expect(() =>
      // @ts-expect-error This protocol event has no registered payload schema.
      session.on("Network.dataReceived", () => undefined),
    ).toThrow(expect.objectContaining({ reason: "protocol_error" }));
    expect(raw.listenerCount("Network.dataReceived")).toBe(0);
  });
});
