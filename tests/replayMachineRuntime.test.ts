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
          variable: "token",
          value: { source: "request_json", path: ["token"] },
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
          variable: "token",
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
      runtime.dispatch(event("POST", "/login", '{"token":"secret"}')),
    ).toMatchObject({
      outcome: "matched",
      transition: {
        transition_id: "capture_token",
        sensitive_aliases: ["token"],
      },
    });
    expect(runtime.redact("Bearer secret")).toBe("Bearer <secret:token>");
    expect(
      runtime.dispatch(event("GET", "/api", "", { authorization: "secret" })),
    ).toMatchObject({ outcome: "matched" });
    expect(JSON.stringify(runtime.timeline)).not.toContain("secret");
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
    runtime.dispatch(event("POST", "/login", '{"token":"secret"}'));
    expect(
      runtime.dispatch(event("GET", "/api", "", { authorization: "wrong" })),
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
});
