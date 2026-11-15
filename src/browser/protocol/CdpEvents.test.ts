import { describe, expect, it } from "vitest";

import { receiveCdpEvent } from "../CdpConnection.js";
import { cdpFrameEvent } from "./CdpEvents.js";

describe("registered CDP event payloads", () => {
  it("parses a frame event's identity and URL once, keeping the raw payload", () => {
    const params = {
      frame: {
        id: "main",
        loaderId: "loader",
        url: "https://app.test/page",
        urlFragment: "#section",
      },
    };
    const event = receiveCdpEvent({ method: "Page.frameNavigated", params });
    expect(event.params).toBe(params);
    expect(cdpFrameEvent(event)).toEqual({
      facts: expect.objectContaining({
        kind: "navigated",
        frameId: "main",
        loaderId: "loader",
        identityIssue: null,
      }),
      url: {
        kind: "observed",
        url: "https://app.test/page#section",
        scopeUrl: "https://app.test/page",
      },
    });
  });

  it.each([
    ["a missing payload", undefined, "missing_params"],
    ["a non-object payload", "frame", "invalid_params"],
    [
      "a non-string frame id",
      { frameId: 7, url: "https://app.test/" },
      "invalid_id",
    ],
  ])(
    "keeps %s as an explicit identity issue, never as absence",
    (_label, params, issue) => {
      const frame = cdpFrameEvent(
        receiveCdpEvent({ method: "Page.navigatedWithinDocument", params }),
      );
      expect(frame?.facts.identityIssue).toBe(issue);
    },
  );

  it("records a malformed fragment as unreadable identity with its scope URL", () => {
    const frame = cdpFrameEvent(
      receiveCdpEvent({
        method: "Page.frameNavigated",
        params: {
          frame: { id: "main", url: "https://app.test/", urlFragment: 3 },
        },
      }),
    );
    expect(frame?.url).toEqual({
      kind: "invalid_fragment",
      scopeUrl: "https://app.test/",
    });
  });

  it("leaves an unregistered event unparsed", () => {
    const event = receiveCdpEvent({
      method: "Network.dataReceived",
      params: { requestId: "1" },
    });
    expect(event.registered).toBeUndefined();
    expect(cdpFrameEvent(event)).toBeUndefined();
  });
});
