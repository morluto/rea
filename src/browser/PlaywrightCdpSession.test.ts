import { EventEmitter } from "node:events";

import type { CDPSession, Page } from "playwright-core";
import { expect, it, vi } from "vitest";

import { newPlaywrightCdpSession } from "./PlaywrightCdpSession.js";

const open = async () => {
  const raw = Object.assign(new EventEmitter(), {
    send: vi.fn(async () => ({})),
  });
  const session = await newPlaywrightCdpSession(
    { newCDPSession: async () => raw as unknown as CDPSession },
    {} as Page,
    "capture_browser_scenario",
  );
  return { raw, session };
};

it("keeps a listener failure inside the session and rejects later commands with it", async () => {
  const { raw, session } = await open();
  const listenerFailure = new Error("listener rejected a valid event");
  const listener = vi.fn(() => {
    throw listenerFailure;
  });
  session.on("Runtime.executionContextsCleared", listener);

  // Playwright emits from its connection callback; nothing may escape here.
  raw.emit("Runtime.executionContextsCleared", {});
  raw.emit("Runtime.executionContextsCleared", {});

  expect(listener).toHaveBeenCalledOnce();
  const failure = await session
    .send("Page.enable")
    .catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    _tag: "BrowserObservationError",
    reason: "protocol_error",
  });
  expect(failure).toHaveProperty("cause", listenerFailure);
  expect(raw.send).not.toHaveBeenCalled();
});

it("refuses unregistered commands and events before they reach Playwright", async () => {
  const { raw, session } = await open();
  await expect(
    // @ts-expect-error This protocol command has no registered result schema.
    session.send("Accessibility.getPartialAXTree"),
  ).rejects.toMatchObject({
    _tag: "BrowserObservationError",
    reason: "protocol_error",
  });
  expect(raw.send).not.toHaveBeenCalled();
  expect(() =>
    // @ts-expect-error This protocol event has no registered payload schema.
    session.on("Network.dataReceived", () => undefined),
  ).toThrow(expect.objectContaining({ reason: "protocol_error" }));
  expect(raw.listenerCount("Network.dataReceived")).toBe(0);

  await expect(session.send("Page.enable")).resolves.toEqual({});
  expect(raw.send).toHaveBeenCalledExactlyOnceWith("Page.enable", undefined);
});
