import { describe, expect, it } from "vitest";

import { fakeCdpEvents } from "../../tests/fixtures/fakeCdpEvents.js";
import type { CdpEvent } from "./CdpConnection.js";
import { onCdpTargetEvent } from "./CdpTargetEvents.js";

const route = (
  sessionId: string | undefined,
  sent: readonly CdpEvent[],
): (string | undefined)[] => {
  const events = fakeCdpEvents();
  const received: (string | undefined)[] = [];
  const unsubscribe = onCdpTargetEvent(events, sessionId, (event) =>
    received.push(event.registered?.method ?? event.domain),
  );
  for (const event of sent) events.emit(event);
  unsubscribe();
  expect(events.listenerCount()).toBe(0);
  return received;
};

const navigated = (sessionId?: string): CdpEvent => ({
  method: "Page.frameNavigated",
  params: { frame: { id: "main", loaderId: "loader", url: "https://a.test/" } },
  ...(sessionId === undefined ? {} : { sessionId }),
});

const detached = (sessionId: string): CdpEvent => ({
  method: "Target.detachedFromTarget",
  params: { sessionId, targetId: "target" },
});

describe("target event routing", () => {
  it("delivers a flat session's events and its root detachment only", () => {
    expect(
      route("mine", [
        navigated("mine"),
        navigated("other"),
        navigated(),
        detached("other"),
        detached("mine"),
      ]),
    ).toEqual(["Page.frameNavigated", "Target.detachedFromTarget"]);
  });

  it("delivers a page socket's unscoped events, never another session's", () => {
    expect(
      route(undefined, [navigated(), navigated("other"), detached("other")]),
    ).toEqual(["Page.frameNavigated"]);
  });
});
