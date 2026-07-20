import { describe, expect, it } from "vitest";

import { replayMachineSchema } from "../src/domain/replayMachine.js";

const loginMachine = () => ({
  initial_state: "waiting_for_login",
  states: [
    { name: "waiting_for_login" },
    { name: "waiting_for_api" },
    { name: "complete", terminal: true },
  ],
  transitions: [
    {
      id: "login",
      from: "waiting_for_login",
      to: "waiting_for_api",
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
      id: "api",
      from: "waiting_for_api",
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
});

describe("replay machine", () => {
  it("accepts a bounded, reachable, data-only login machine", () => {
    expect(replayMachineSchema.parse(loginMachine())).toMatchObject({
      initial_state: "waiting_for_login",
      max_transitions: 2,
    });
  });

  it.each([
    [
      "unreachable state",
      (machine: ReturnType<typeof loginMachine>) =>
        machine.states.push({ name: "orphan", terminal: false }),
      "unreachable",
    ],
    [
      "ambiguous transition",
      (machine: ReturnType<typeof loginMachine>) =>
        machine.transitions.push({ ...machine.transitions[0]!, id: "login_2" }),
      "ambiguous",
    ],
    [
      "outgoing terminal transition",
      (machine: ReturnType<typeof loginMachine>) =>
        machine.transitions.push({
          ...machine.transitions[0]!,
          id: "restart",
          from: "complete",
          to: "waiting_for_login",
          trigger: { protocol: "http", method: "POST", path: "/restart" },
        }),
      "terminal",
    ],
    [
      "unknown guard variable",
      (machine: ReturnType<typeof loginMachine>) => {
        machine.transitions[1]!.guards![0]!.variable = "missing";
      },
      "never captured",
    ],
    [
      "missing terminal state",
      (machine: ReturnType<typeof loginMachine>) => {
        machine.states[2]!.terminal = false;
      },
      "terminal state",
    ],
  ])("rejects %s", (_name, mutate, message) => {
    const machine = loginMachine();
    mutate(machine);
    expect(() => replayMachineSchema.parse(machine)).toThrow(message);
  });

  it("canonicalizes methods and headers while refusing persisted credential matchers", () => {
    const canonical = {
      ...loginMachine(),
      transitions: loginMachine().transitions.map((transition, index) =>
        index === 0
          ? {
              ...transition,
              trigger: {
                protocol: "http",
                method: "post",
                path: "/login",
                headers: { "X-Request-ID": "fixture" },
              },
            }
          : transition,
      ),
    };
    expect(
      replayMachineSchema.parse(canonical).transitions[0]?.trigger,
    ).toMatchObject({
      method: "POST",
      headers: { "x-request-id": "fixture" },
    });
    const credentialMatcher = {
      ...loginMachine(),
      transitions: loginMachine().transitions.map((transition, index) =>
        index === 0
          ? {
              ...transition,
              trigger: {
                protocol: "http",
                method: "POST",
                path: "/login",
                headers: { Authorization: "secret" },
              },
            }
          : transition,
      ),
    };
    expect(() => replayMachineSchema.parse(credentialMatcher)).toThrow(
      /secret alias/u,
    );
  });
});
