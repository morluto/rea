import { describe, expect, it } from "vitest";

import { replayMachineSchema } from "../src/domain/replayMachine.js";
import { ReplayMachineRuntime } from "../src/domain/replayMachineRuntime.js";

const machine = replayMachineSchema.parse({
  initial_state: "login",
  states: [
    { name: "login" },
    { name: "api" },
    { name: "complete", terminal: true },
  ],
  transitions: [
    {
      id: "capture_token",
      from: "login",
      to: "api",
      priority: 10,
      trigger: { protocol: "http", method: "POST", path: "/login" },
      captures: [
        {
          variable: "session_value",
          value: { source: "request_json", path: ["session_value"] },
          sensitive: true,
        },
      ],
      actions: [{ type: "http_response", status: 204, headers: {}, body: "" }],
      max_uses: 1,
    },
    {
      id: "authorize_api",
      from: "api",
      to: "complete",
      priority: 10,
      trigger: { protocol: "http", method: "GET", path: "/api" },
      guards: [
        {
          variable: "session_value",
          value: { source: "request_header", name: "authorization" },
        },
      ],
      actions: [
        { type: "http_response", status: 200, headers: {}, body: "done" },
      ],
      max_uses: 1,
    },
  ],
  max_transitions: 2,
});

const event = (
  method: string,
  path: string,
  body = "",
  headers: Readonly<Record<string, string>> = {},
) => ({
  protocol: "http" as const,
  connection: "not_applicable" as const,
  at_ms: 0,
  method,
  path,
  body,
  headers,
});

describe("replay machine runtime", () => {
  it("captures secret values in memory and journals aliases only", () => {
    const runtime = new ReplayMachineRuntime(machine);
    expect(
      runtime.dispatch(
        event("POST", "/login", '{"session_value":"test-auth-token"}'),
      ),
    ).toMatchObject({
      outcome: "matched",
      transition: {
        transition_id: "capture_token",
        sensitive_aliases: ["session_value"],
      },
    });
    const expectedRedaction = ["Bearer <", "secret", ":session_value>"].join(
      "",
    );
    expect(runtime.redact("Bearer test-auth-token")).toBe(expectedRedaction);
    expect(
      runtime.dispatch(
        event("GET", "/api", "", { Authorization: "test-auth-token" }),
      ),
    ).toMatchObject({ outcome: "matched" });
    expect(JSON.stringify(runtime.timeline)).not.toContain("test-auth-token");
    expect(runtime.state).toBe("complete");
  });

  it("classifies wrong-state, guard, capture, and exhaustion failures", () => {
    expect(
      new ReplayMachineRuntime(machine).dispatch(event("GET", "/api")),
    ).toMatchObject({ outcome: "invalid_state" });
    expect(
      new ReplayMachineRuntime(machine).dispatch(event("POST", "/login", "{}")),
    ).toMatchObject({ outcome: "invalid_capture" });
    const runtime = new ReplayMachineRuntime(machine);
    runtime.dispatch(
      event("POST", "/login", '{"session_value":"test-auth-token"}'),
    );
    expect(
      runtime.dispatch(
        event("GET", "/api", "", {
          authorization: "test-token-placeholder",
        }),
      ),
    ).toMatchObject({
      outcome: "guard_failed",
    });
    const bounded = new ReplayMachineRuntime(
      replayMachineSchema.parse({
        initial_state: "active",
        states: [{ name: "active" }, { name: "done", terminal: true }],
        transitions: [
          {
            id: "once",
            from: "active",
            to: "active",
            trigger: { protocol: "http", method: "GET", path: "/once" },
            actions: [
              { type: "http_response", status: 200, headers: {}, body: "ok" },
            ],
            max_uses: 1,
          },
          {
            id: "finish",
            from: "active",
            to: "done",
            trigger: { protocol: "http", method: "GET", path: "/done" },
            actions: [
              { type: "http_response", status: 200, headers: {}, body: "ok" },
            ],
            max_uses: 1,
          },
        ],
        max_transitions: 2,
      }),
    );
    expect(bounded.dispatch(event("GET", "/once"))).toMatchObject({
      outcome: "matched",
    });
    expect(bounded.dispatch(event("GET", "/once"))).toMatchObject({
      outcome: "transition_exhausted",
    });
  });

  it("matches bounded headers and bodies and distinguishes wrong-state reconnects", () => {
    const runtime = new ReplayMachineRuntime(
      replayMachineSchema.parse({
        initial_state: "connected",
        states: [{ name: "connected" }, { name: "done", terminal: true }],
        transitions: [
          {
            id: "finish",
            from: "connected",
            to: "done",
            trigger: {
              protocol: "http",
              method: "POST",
              path: "/finish",
              headers: { "content-type": "application/json" },
              body: '{"done":true}',
            },
            actions: [
              { type: "http_response", status: 204, headers: {}, body: "" },
            ],
            max_uses: 1,
          },
          {
            id: "initial_socket",
            from: "connected",
            to: "connected",
            trigger: { protocol: "websocket_connect", path: "/ws" },
            actions: [{ type: "disconnect" }],
            max_uses: 1,
          },
        ],
        max_transitions: 2,
      }),
    );
    expect(runtime.dispatch(event("POST", "/finish", "wrong"))).toMatchObject({
      outcome: "unmatched",
    });
    expect(
      runtime.dispatch({
        protocol: "websocket_connect",
        connection: "initial",
        at_ms: 0,
        method: null,
        path: "/ws",
        headers: {},
        body: "",
      }),
    ).toMatchObject({ outcome: "matched" });
    expect(
      runtime.dispatch({
        protocol: "websocket_connect",
        connection: "reconnect",
        at_ms: 0,
        method: null,
        path: "/ws",
        headers: {},
        body: "",
      }),
    ).toMatchObject({ outcome: "transition_exhausted" });
    expect(
      runtime.dispatch(
        event("POST", "/finish", '{"done":true}', {
          "content-type": "application/json",
        }),
      ),
    ).toMatchObject({ outcome: "matched" });
    expect(
      runtime.dispatch({
        protocol: "websocket_connect",
        connection: "reconnect",
        at_ms: 0,
        method: null,
        path: "/ws",
        headers: {},
        body: "",
      }),
    ).toMatchObject({ outcome: "unexpected_reconnect" });
  });

  it("enforces state, connection, message, byte, and duration limits", () => {
    const limitedMachine = replayMachineSchema.parse({
      initial_state: "active",
      states: [
        { name: "active", max_visits: 1 },
        { name: "done", terminal: true },
      ],
      transitions: [
        {
          id: "loop",
          from: "active",
          to: "active",
          trigger: { protocol: "websocket_message", path: "/ws" },
          actions: [{ type: "websocket_send", data: "ack" }],
          max_uses: 2,
        },
        {
          id: "finish",
          from: "active",
          to: "done",
          trigger: { protocol: "http", method: "GET", path: "/done" },
          actions: [
            { type: "http_response", status: 200, headers: {}, body: "ok" },
          ],
          max_uses: 1,
        },
      ],
      max_transitions: 3,
      limits: { connections: 1, messages: 1, bytes: 100, duration_ms: 10 },
    });
    const stateLimited = new ReplayMachineRuntime(limitedMachine);
    expect(
      stateLimited.dispatch({
        protocol: "websocket_message",
        connection: "not_applicable",
        at_ms: 0,
        method: null,
        path: "/ws",
        headers: {},
        body: "one",
      }),
    ).toMatchObject({ outcome: "limit_exhausted" });
    const messageLimited = new ReplayMachineRuntime(
      replayMachineSchema.parse({
        ...limitedMachine,
        states: limitedMachine.states.map((state) =>
          state.name === "active" ? { ...state, max_visits: 3 } : state,
        ),
      }),
    );
    const message = {
      protocol: "websocket_message" as const,
      connection: "not_applicable" as const,
      at_ms: 0,
      method: null,
      path: "/ws",
      headers: {},
      body: "one",
    };
    expect(messageLimited.dispatch(message)).toMatchObject({
      outcome: "matched",
    });
    expect(messageLimited.dispatch(message)).toMatchObject({
      outcome: "limit_exhausted",
    });
    const durationLimited = new ReplayMachineRuntime(limitedMachine);
    expect(
      durationLimited.dispatch({ ...event("GET", "/done"), at_ms: 11 }),
    ).toMatchObject({ outcome: "limit_exhausted" });
    expect(
      new ReplayMachineRuntime(limitedMachine).dispatch({
        ...event("GET", "/done"),
        at_ms: Number.NaN,
      }),
    ).toMatchObject({ outcome: "limit_exhausted" });
    const monotonic = new ReplayMachineRuntime(limitedMachine);
    expect(
      monotonic.dispatch({ ...event("GET", "/missing"), at_ms: 5 }),
    ).toMatchObject({ outcome: "unmatched" });
    expect(
      monotonic.dispatch({ ...event("GET", "/missing"), at_ms: 4 }),
    ).toMatchObject({ outcome: "limit_exhausted" });
    const byteLimited = new ReplayMachineRuntime(
      replayMachineSchema.parse({
        ...limitedMachine,
        limits: { ...limitedMachine.limits, bytes: 4 },
      }),
    );
    expect(
      byteLimited.dispatch(event("GET", "/missing", "12345")),
    ).toMatchObject({ outcome: "limit_exhausted" });
    const connectionLimited = new ReplayMachineRuntime(limitedMachine);
    const connect = {
      protocol: "websocket_connect" as const,
      connection: "initial" as const,
      at_ms: 0,
      method: null,
      path: "/unknown",
      headers: {},
      body: "",
    };
    expect(connectionLimited.dispatch(connect)).toMatchObject({
      outcome: "unmatched",
    });
    expect(
      connectionLimited.dispatch({ ...connect, connection: "reconnect" }),
    ).toMatchObject({ outcome: "limit_exhausted" });
  });

  it("compares captured JSON values canonically", () => {
    const objectMachine = replayMachineSchema.parse({
      initial_state: "capture",
      states: [
        { name: "capture" },
        { name: "guard" },
        { name: "done", terminal: true },
      ],
      transitions: [
        {
          id: "capture_profile",
          from: "capture",
          to: "guard",
          trigger: { protocol: "http", method: "POST", path: "/capture" },
          captures: [
            {
              variable: "profile",
              value: { source: "request_json", path: ["profile"] },
            },
          ],
          actions: [
            { type: "http_response", status: 204, headers: {}, body: "" },
          ],
          max_uses: 1,
        },
        {
          id: "guard_profile",
          from: "guard",
          to: "done",
          trigger: { protocol: "http", method: "POST", path: "/guard" },
          guards: [
            {
              variable: "profile",
              value: { source: "request_json", path: ["profile"] },
            },
          ],
          actions: [
            { type: "http_response", status: 204, headers: {}, body: "" },
          ],
          max_uses: 1,
        },
      ],
      max_transitions: 2,
    });
    const runtime = new ReplayMachineRuntime(objectMachine);

    expect(
      runtime.dispatch(
        event("POST", "/capture", '{"profile":{"name":"A","id":1}}'),
      ),
    ).toMatchObject({ outcome: "matched" });
    expect(
      runtime.dispatch(
        event("POST", "/guard", '{"profile":{"id":1,"name":"A"}}'),
      ),
    ).toMatchObject({ outcome: "matched" });
  });

  it("does not traverse inherited properties in JSON capture paths", () => {
    const inheritedPathMachine = replayMachineSchema.parse({
      ...machine,
      transitions: machine.transitions.map((transition, index) =>
        index === 0
          ? {
              ...transition,
              captures: [
                {
                  variable: "session_value",
                  value: {
                    source: "request_json" as const,
                    path: ["__proto__", "toString"],
                  },
                  sensitive: true,
                },
              ],
            }
          : transition,
      ),
    });

    expect(
      new ReplayMachineRuntime(inheritedPathMachine).dispatch(
        event("POST", "/login", "{}"),
      ),
    ).toMatchObject({ outcome: "invalid_capture" });
  });

  it("rejects non-string sensitive captures and retains rotated values", () => {
    expect(
      new ReplayMachineRuntime(machine).dispatch(
        event("POST", "/login", '{"session_value":1234}'),
      ),
    ).toMatchObject({ outcome: "invalid_capture" });

    const rotatingMachine = replayMachineSchema.parse({
      initial_state: "active",
      states: [
        { name: "active", max_visits: 3 },
        { name: "done", terminal: true },
      ],
      transitions: [
        {
          id: "rotate",
          from: "active",
          to: "active",
          trigger: { protocol: "http", method: "POST", path: "/rotate" },
          captures: [
            {
              variable: "session_value",
              value: { source: "request_json", path: ["value"] },
              sensitive: true,
            },
          ],
          actions: [
            { type: "http_response", status: 204, headers: {}, body: "" },
          ],
          max_uses: 2,
        },
        {
          id: "finish",
          from: "active",
          to: "done",
          trigger: { protocol: "http", method: "GET", path: "/done" },
          actions: [
            { type: "http_response", status: 204, headers: {}, body: "" },
          ],
          max_uses: 1,
        },
      ],
      max_transitions: 3,
    });
    const rotating = new ReplayMachineRuntime(rotatingMachine);
    rotating.dispatch(event("POST", "/rotate", '{"value":"alpha"}'));
    rotating.dispatch(event("POST", "/rotate", '{"value":"beta"}'));
    const alias = ["<", "secret", ":session_value>"].join("");

    expect(rotating.redact("alpha beta")).toBe(`${alias} ${alias}`);
  });

  it("falls back to a lower-priority transition after a preferred one is exhausted", () => {
    const fallbackMachine = replayMachineSchema.parse({
      initial_state: "active",
      states: [
        { name: "active", max_visits: 2 },
        { name: "done", terminal: true },
      ],
      transitions: [
        {
          id: "preferred",
          from: "active",
          to: "active",
          priority: 10,
          trigger: { protocol: "http", method: "GET", path: "/next" },
          actions: [
            { type: "http_response", status: 200, headers: {}, body: "again" },
          ],
          max_uses: 1,
        },
        {
          id: "fallback",
          from: "active",
          to: "done",
          priority: 20,
          trigger: { protocol: "http", method: "GET", path: "/next" },
          actions: [
            { type: "http_response", status: 200, headers: {}, body: "done" },
          ],
          max_uses: 1,
        },
      ],
      max_transitions: 2,
    });
    const runtime = new ReplayMachineRuntime(fallbackMachine);

    expect(runtime.dispatch(event("GET", "/next"))).toMatchObject({
      outcome: "matched",
      transition: { transition_id: "preferred" },
    });
    expect(runtime.dispatch(event("GET", "/next"))).toMatchObject({
      outcome: "matched",
      transition: { transition_id: "fallback" },
    });
  });

  it("rejects non-finite parsed JSON captures and guard values", () => {
    const jsonMachine = replayMachineSchema.parse({
      initial_state: "capture",
      states: [
        { name: "capture" },
        { name: "guard" },
        { name: "done", terminal: true },
      ],
      transitions: [
        {
          id: "capture_value",
          from: "capture",
          to: "guard",
          trigger: { protocol: "http", method: "POST", path: "/capture" },
          captures: [
            {
              variable: "value",
              value: { source: "request_json", path: ["value"] },
            },
          ],
          actions: [
            { type: "http_response", status: 204, headers: {}, body: "" },
          ],
          max_uses: 1,
        },
        {
          id: "guard_value",
          from: "guard",
          to: "done",
          trigger: { protocol: "http", method: "POST", path: "/guard" },
          guards: [
            {
              variable: "value",
              value: { source: "request_json", path: ["value"] },
            },
          ],
          actions: [
            { type: "http_response", status: 204, headers: {}, body: "" },
          ],
          max_uses: 1,
        },
      ],
      max_transitions: 2,
    });

    expect(
      new ReplayMachineRuntime(jsonMachine).dispatch(
        event("POST", "/capture", '{"value":1e400}'),
      ),
    ).toMatchObject({ outcome: "invalid_capture" });

    const guarded = new ReplayMachineRuntime(jsonMachine);
    expect(
      guarded.dispatch(event("POST", "/capture", '{"value":null}')),
    ).toMatchObject({ outcome: "matched" });
    expect(
      guarded.dispatch(event("POST", "/guard", '{"value":1e400}')),
    ).toMatchObject({ outcome: "guard_failed" });
  });
});
