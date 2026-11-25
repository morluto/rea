import { describe, expect, expectTypeOf, it } from "vitest";

import { receiveCdpEvent, type CdpReceivedEvent } from "../CdpConnection.js";
import {
  cdpFrameEvent,
  type CdpEventName,
  type CdpProtocolEvent,
} from "./CdpEvents.js";

expectTypeOf<"Network.dataReceived">().toExtend<CdpProtocolEvent>();
expectTypeOf<"Network.dataReceived">().not.toExtend<CdpEventName>();
expectTypeOf<CdpReceivedEvent>().not.toHaveProperty("params");
expectTypeOf<CdpReceivedEvent>().not.toHaveProperty("method");

describe("registered CDP event payloads", () => {
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
});

describe("registered Runtime and Debugger event payloads", () => {
  it("derives tolerant script facts and the strict runtime declaration from one parse", () => {
    const params = {
      scriptId: "script-1",
      url: "https://app.test/café.js",
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
      value: 136, // The compact fixture has 135 code units and one two-byte character.
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
});

describe("registered Network event payloads", () => {
  it("keeps a partial request for passive capture while the runtime refuses it", () => {
    const event = receiveCdpEvent({
      method: "Network.requestWillBeSent",
      params: {
        requestId: "request-1",
        frameId: "main",
        request: { url: "https://app.test/", method: "GET" },
      },
    });
    if (event.registered?.method !== "Network.requestWillBeSent")
      throw new TypeError("expected a registered request event");
    expect(event.registered.payload.facts).toMatchObject({
      requestId: "request-1",
      frameId: "main",
      timestamp: undefined,
      redirect: { kind: "missing" },
    });
    expect(event.registered.payload.runtime.success).toBe(false);
  });
});

describe("registered Target and WebMCP event payloads", () => {
  it.each([
    [{ sessionId: "session-1" }, "session-1"],
    [{ sessionId: 7 }, undefined],
    [{}, undefined],
  ])(
    "reads a detached target's session %j without inventing one",
    (params, sessionId) => {
      expect(
        receiveCdpEvent({ method: "Target.detachedFromTarget", params })
          .registered,
      ).toEqual({
        method: "Target.detachedFromTarget",
        payload: { sessionId },
      });
    },
  );

  it("reads an attached target's session, target ID and type", () => {
    expect(
      receiveCdpEvent({
        method: "Target.attachedToTarget",
        params: {
          sessionId: "child",
          targetInfo: { targetId: "frame-1", type: "iframe" },
        },
      }).registered?.payload,
    ).toEqual({
      sessionId: "child",
      targetId: "frame-1",
      targetType: "iframe",
    });
  });

  it.each([
    ["a missing inventory", {}, undefined],
    ["a non-list inventory", { tools: {} }, undefined],
    [
      "malformed entries in place",
      { tools: [{ name: "a" }, "b"] },
      [{ name: "a" }, undefined],
    ],
  ])("keeps WebMCP %s explicit", (_label, params, tools) => {
    expect(
      receiveCdpEvent({ method: "WebMCP.toolsAdded", params }).registered
        ?.payload,
    ).toEqual({ tools });
  });
});
