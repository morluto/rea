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
});

describe("registered Runtime and Debugger event payloads", () => {
  it("derives tolerant script facts and the strict runtime declaration from one parse", () => {
    const params = {
      scriptId: "script-1",
      url: "https://app.test/app.js",
      executionContextId: 3,
      startLine: 0,
      startColumn: 0,
      endLine: 1,
      endColumn: 4,
    };
    const event = receiveCdpEvent({ method: "Debugger.scriptParsed", params });
    if (event.registered?.method !== "Debugger.scriptParsed")
      throw new TypeError("expected a registered script event");
    expect(event.registered.payload.facts).toMatchObject({
      scriptId: "script-1",
      contextKey: "3",
    });
    expect(event.registered.payload.runtime.success).toBe(true);
    expect(event.registered.payload.declarationBytes).toEqual({
      ok: true,
      value: Buffer.byteLength(JSON.stringify(params)),
    });

    const partial = receiveCdpEvent({
      method: "Debugger.scriptParsed",
      params: { scriptId: "script-2", url: "https://app.test/b.js" },
    });
    if (partial.registered?.method !== "Debugger.scriptParsed")
      throw new TypeError("expected a registered script event");
    // Passive capture keeps the partial facts; the active runtime refuses them.
    expect(partial.registered.payload.facts.scriptId).toBe("script-2");
    expect(partial.registered.payload.facts.contextKey).toBeNull();
    expect(partial.registered.payload.runtime.success).toBe(false);
  });

  it("reports an unserializable declaration's size as a failure instead of throwing", () => {
    // Nesting that JSON.parse accepts but JSON.stringify cannot serialize.
    const nested = JSON.parse(
      `${'{"a":'.repeat(20_000)}0${"}".repeat(20_000)}`,
    ) as unknown;
    const event = receiveCdpEvent({
      method: "Debugger.scriptParsed",
      params: {
        scriptId: "script-1",
        url: "https://app.test/app.js",
        executionContextId: 3,
        unused: nested,
      },
    });
    if (event.registered?.method !== "Debugger.scriptParsed")
      throw new TypeError("expected a registered script event");
    expect(event.registered.payload.facts.scriptId).toBe("script-1");
    expect(event.registered.payload.declarationBytes).toMatchObject({
      ok: false,
      error: expect.any(RangeError),
    });
  });

  it("keeps an execution context's identity unknown when its id is malformed", () => {
    const created = receiveCdpEvent({
      method: "Runtime.executionContextCreated",
      params: { context: { id: "7", auxData: { frameId: "main" } } },
    });
    if (created.registered?.method !== "Runtime.executionContextCreated")
      throw new TypeError("expected a registered context event");
    expect(created.registered.payload.facts).toMatchObject({
      id: undefined,
      contextKey: null,
      frameClaim: { state: "observed", frameId: "main" },
    });
    expect(created.registered.payload.runtime.success).toBe(false);

    const destroyed = receiveCdpEvent({
      method: "Runtime.executionContextDestroyed",
      params: { executionContextId: 7 },
    });
    expect(destroyed.registered).toEqual({
      method: "Runtime.executionContextDestroyed",
      payload: { id: 7, contextKey: "7" },
    });
  });

  it("keeps console argument positions and a malformed call stack as facts", () => {
    const event = receiveCdpEvent({
      method: "Runtime.consoleAPICalled",
      params: {
        type: "log",
        timestamp: 12,
        args: [{ type: "string", value: "a" }, 5],
        stackTrace: { callFrames: "not-a-list" },
      },
    });
    if (event.registered?.method !== "Runtime.consoleAPICalled")
      throw new TypeError("expected a registered console event");
    expect(event.registered.payload).toEqual({
      topFrame: { ok: false, error: { _tag: "MalformedCdpCallFrame" } },
      arguments: [{ type: "string", value: "a" }, undefined],
      timestamp: 12,
      type: "log",
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
