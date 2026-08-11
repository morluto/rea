import { expect, it } from "vitest";

import { replayMachineSchema } from "./replayMachine.js";
import { ReplayMachineRuntime } from "./replayMachineRuntime.js";

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
