import { describe, expect, it } from "vitest";

import {
  replayMachineRunInputSchema,
  runReplayMachine,
} from "../src/domain/replayMachineRun.js";

const loginRun = () =>
  replayMachineRunInputSchema.parse({
    machine: {
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
          actions: [
            {
              type: "http_response",
              status: 204,
              headers: { "x-token": "target-secret" },
              body: "target-secret",
            },
          ],
          max_uses: 1,
        },
        {
          id: "authorize",
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
            {
              type: "http_response",
              status: 200,
              headers: {},
              body: "done",
            },
          ],
          max_uses: 1,
        },
      ],
      max_transitions: 2,
      limits: {
        connections: 2,
        messages: 4,
        bytes: 1_000,
        duration_ms: 100,
      },
    },
    events: [
      {
        protocol: "http",
        connection: "not_applicable",
        at_ms: 1,
        method: "post",
        path: "/login",
        headers: {},
        body: '{"token":"target-secret"}',
      },
      {
        protocol: "http",
        connection: "not_applicable",
        at_ms: 2,
        method: "GET",
        path: "/api",
        headers: { Authorization: "target-secret" },
        body: "",
      },
    ],
  });

const parseMachineRun = (machine: unknown, events: unknown[]) =>
  replayMachineRunInputSchema.parse({ machine, events });

const httpEvent = (path: string, atMs = 0) => ({
  protocol: "http" as const,
  connection: "not_applicable" as const,
  at_ms: atMs,
  method: "GET",
  path,
  headers: {},
  body: "",
});

describe("direct replay machine runner", () => {
  it("returns actions, aliases, terminal state, and exact limit use", () => {
    const result = runReplayMachine(loginRun());

    expect(result).toMatchObject({
      schema_version: 1,
      initial_state: "login",
      final_state: "complete",
      terminal: true,
      decisions: [
        { event_sequence: 0, outcome: "matched", transition_sequence: 0 },
        { event_sequence: 1, outcome: "matched", transition_sequence: 1 },
      ],
      transition_journal: [
        {
          transition_id: "capture_token",
          captured_aliases: [{ name: "token", sensitive: true }],
        },
        {
          transition_id: "authorize",
          captured_aliases: [],
        },
      ],
      transition_actions: [
        {
          transition_id: "capture_token",
          actions: [
            {
              type: "http_response",
              status: 204,
              headers: { "x-token": "<secret:token>" },
              body: "<secret:token>",
            },
          ],
        },
        {
          transition_id: "authorize",
          actions: [
            {
              type: "http_response",
              status: 200,
              headers: {},
              body: "done",
            },
          ],
        },
      ],
      limits: {
        configured: {
          transitions: 2,
          connections: 2,
          messages: 4,
          bytes: 1_000,
          duration_ms: 100,
        },
        usage: {
          offered_events: 2,
          admitted_events: 2,
          transitions: 2,
          connections: 0,
          messages: 0,
          bytes: 25,
          last_at_ms: 2,
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("target-secret");
  });

  it("classifies unmatched and guard-failed events without aborting", () => {
    const input = loginRun();
    const result = runReplayMachine({
      ...input,
      events: [httpEvent("/missing"), input.events[0]!, httpEvent("/api", 2)],
    });

    expect(result.decisions.map(({ outcome }) => outcome)).toEqual([
      "unmatched",
      "matched",
      "guard_failed",
    ]);
  });

  it("classifies exhausted transitions", () => {
    const input = parseMachineRun(
      {
        initial_state: "active",
        states: [
          { name: "active", max_visits: 3 },
          { name: "done", terminal: true },
        ],
        transitions: [
          {
            id: "retry_once",
            from: "active",
            to: "active",
            trigger: { protocol: "http", method: "GET", path: "/retry" },
            actions: [{ type: "http_response", status: 200, body: "retry" }],
            max_uses: 1,
          },
          {
            id: "finish",
            from: "active",
            to: "done",
            trigger: { protocol: "http", method: "GET", path: "/done" },
            actions: [{ type: "http_response", status: 200, body: "done" }],
            max_uses: 1,
          },
        ],
        max_transitions: 3,
      },
      [httpEvent("/retry"), httpEvent("/retry", 1)],
    );

    expect(
      runReplayMachine(input).decisions.map(({ outcome }) => outcome),
    ).toEqual(["matched", "transition_exhausted"]);
  });

  it("classifies reconnects that arrive in the wrong state", () => {
    const input = parseMachineRun(
      {
        initial_state: "connected",
        states: [
          { name: "connected" },
          { name: "reconnecting" },
          { name: "done", terminal: true },
        ],
        transitions: [
          {
            id: "disconnect",
            from: "connected",
            to: "reconnecting",
            trigger: {
              protocol: "websocket_message",
              path: "/socket",
              body: "disconnect",
            },
            actions: [{ type: "disconnect" }],
            max_uses: 1,
          },
          {
            id: "reconnect",
            from: "reconnecting",
            to: "done",
            trigger: { protocol: "websocket_connect", path: "/socket" },
            actions: [{ type: "websocket_send", data: "ready" }],
            max_uses: 1,
          },
        ],
        max_transitions: 2,
      },
      [
        {
          protocol: "websocket_connect",
          connection: "reconnect",
          at_ms: 0,
          method: null,
          path: "/socket",
          headers: {},
          body: "",
        },
      ],
    );

    expect(runReplayMachine(input).decisions[0]?.outcome).toBe(
      "unexpected_reconnect",
    );
  });

  it("rejects protocol-inconsistent events at the boundary", () => {
    const input = loginRun();
    expect(
      replayMachineRunInputSchema.safeParse({
        ...input,
        events: [{ ...httpEvent("/login"), method: null }],
      }).success,
    ).toBe(false);
    expect(
      replayMachineRunInputSchema.safeParse({
        ...input,
        events: [
          {
            ...httpEvent("/login"),
            protocol: "websocket_connect",
            connection: "reconnect",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      replayMachineRunInputSchema.safeParse({
        ...input,
        events: [
          {
            ...httpEvent("/login"),
            headers: { Authorization: "first", authorization: "second" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("reports limit refusals without committing rejected usage", () => {
    const input = loginRun();
    const result = runReplayMachine({
      ...input,
      machine: {
        ...input.machine,
        limits: { ...input.machine.limits, bytes: 1 },
      },
      events: [input.events[0]!],
    });

    expect(result.decisions).toEqual([
      {
        event_sequence: 0,
        outcome: "limit_exhausted",
        transition_sequence: null,
      },
    ]);
    expect(result.limits.usage).toMatchObject({
      offered_events: 1,
      admitted_events: 0,
      transitions: 0,
      bytes: 0,
    });
  });

  it("records large repeated actions once instead of amplifying each match", () => {
    const largeBody = "x".repeat(1_000_000);
    const input = parseMachineRun(
      {
        initial_state: "active",
        states: [
          { name: "active", max_visits: 11 },
          { name: "done", terminal: true },
        ],
        transitions: [
          {
            id: "repeat",
            from: "active",
            to: "active",
            trigger: { protocol: "http", method: "GET", path: "/repeat" },
            actions: [{ type: "http_response", status: 200, body: largeBody }],
            max_uses: 10,
          },
          {
            id: "finish",
            from: "active",
            to: "done",
            trigger: { protocol: "http", method: "GET", path: "/done" },
            actions: [{ type: "http_response", status: 204, body: "" }],
            max_uses: 1,
          },
        ],
        max_transitions: 11,
      },
      Array.from({ length: 10 }, (_, index) => httpEvent("/repeat", index)),
    );

    const result = runReplayMachine(input);
    expect(result.transition_journal).toHaveLength(10);
    expect(result.transition_actions).toHaveLength(1);
    expect(JSON.stringify(result).length).toBeLessThan(1_100_000);
  });

  it("rejects aggregate action output above four MiB", () => {
    const largeBody = "x".repeat(1_000_000);
    const parsed = replayMachineRunInputSchema.safeParse({
      machine: {
        initial_state: "waiting",
        states: [{ name: "waiting" }, { name: "done", terminal: true }],
        transitions: [
          {
            id: "send",
            from: "waiting",
            to: "done",
            trigger: { protocol: "websocket_connect", path: "/socket" },
            actions: Array.from({ length: 5 }, () => ({
              type: "websocket_send",
              data: largeBody,
            })),
            max_uses: 1,
          },
        ],
        max_transitions: 1,
      },
      events: [],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["machine", "transitions"] }),
        ]),
      );
  });

  it("bounds action-field and sensitive-redaction work structurally", () => {
    const input = loginRun();
    const excessiveCaptures = replayMachineRunInputSchema.safeParse({
      ...input,
      events: Array.from({ length: 1_025 }, () => input.events[0]),
    });
    expect(excessiveCaptures.success).toBe(false);
    if (!excessiveCaptures.success)
      expect(excessiveCaptures.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["events"] })]),
      );

    const excessiveFields = replayMachineRunInputSchema.safeParse({
      machine: {
        initial_state: "waiting",
        states: [{ name: "waiting" }, { name: "done", terminal: true }],
        transitions: [
          {
            id: "respond",
            from: "waiting",
            to: "done",
            trigger: { protocol: "http", method: "GET", path: "/done" },
            actions: [
              {
                type: "http_response",
                status: 200,
                headers: Object.fromEntries(
                  Array.from({ length: 1_024 }, (_, index) => [
                    `x-field-${String(index)}`,
                    "",
                  ]),
                ),
                body: "",
              },
            ],
            max_uses: 1,
          },
        ],
        max_transitions: 1,
      },
      events: [],
    });
    expect(excessiveFields.success).toBe(false);
    if (!excessiveFields.success)
      expect(excessiveFields.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["machine", "transitions"] }),
        ]),
      );
  });
});
