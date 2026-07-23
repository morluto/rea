import { describe, expect, it } from "vitest";

import {
  PROCESS_REACTIVE_LIMITS,
  processReactiveScenarioSchema,
} from "../src/domain/processReactiveScenario.js";

const terminalTrigger = () => ({
  kind: "terminal_text" as const,
  view: "decoded" as const,
  encoding: "utf8" as const,
  literal: "Ready",
  case_sensitive: true,
  control_sequences: "include" as const,
  occurrence: 1,
  since: { kind: "scenario_start" as const },
  consume: false,
});

const finishTransition = () => ({
  id: "finish",
  priority: 100,
  max_uses: 1,
  when: terminalTrigger(),
  actions: [{ type: "checkpoint" as const, name: "ready" }],
  target: { kind: "finish" as const, outcome: "passed" as const },
});

const baseScenario = () => ({
  version: 1 as const,
  initial_state: "starting",
  deadline_ms: 30_000,
  states: [
    {
      id: "starting",
      max_visits: 1,
      deadline_ms: 5_000,
      on: [finishTransition()],
    },
  ],
});

describe("process reactive scenario schema", () => {
  it("parses the bounded v1 terminal scenario", () => {
    expect(processReactiveScenarioSchema.parse(baseScenario())).toMatchObject({
      version: 1,
      initial_state: "starting",
    });
    expect(PROCESS_REACTIVE_LIMITS.triggerDepth).toBe(6);
  });

  it.each([
    ["unknown major version", { ...baseScenario(), version: 2 }],
    [
      "missing state bound",
      {
        ...baseScenario(),
        states: [
          { id: "starting", deadline_ms: 5_000, on: [finishTransition()] },
        ],
      },
    ],
    [
      "missing transition bound",
      {
        ...baseScenario(),
        states: [
          {
            id: "starting",
            max_visits: 1,
            deadline_ms: 5_000,
            on: [{ ...finishTransition(), max_uses: undefined }],
          },
        ],
      },
    ],
    [
      "unsupported trigger",
      {
        ...baseScenario(),
        states: [
          {
            id: "starting",
            max_visits: 1,
            deadline_ms: 5_000,
            on: [{ ...finishTransition(), when: { kind: "callback" } }],
          },
        ],
      },
    ],
    [
      "zero-minimum event absence predicate",
      {
        ...baseScenario(),
        states: [
          {
            ...baseScenario().states[0],
            on: [
              {
                ...finishTransition(),
                when: {
                  kind: "event",
                  source: "shim",
                  exact: { name: "missing" },
                  ignore_fields: [],
                  since: { kind: "scenario_start" },
                  consume: false,
                  cardinality: { min: 0, max: 1 },
                },
              },
            ],
          },
        ],
      },
    ],
    [
      "unsupported terminal interpretation",
      {
        ...baseScenario(),
        states: [
          {
            ...baseScenario().states[0],
            on: [
              {
                ...finishTransition(),
                when: {
                  ...terminalTrigger(),
                  control_sequences: "strip_ansi",
                },
              },
            ],
          },
        ],
      },
    ],
  ])("rejects %s", (_name, input) => {
    expect(processReactiveScenarioSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown targets, unreachable states, and duplicate transition ids", () => {
    const input = {
      ...baseScenario(),
      states: [
        {
          id: "starting",
          max_visits: 1,
          deadline_ms: 5_000,
          on: [
            {
              ...finishTransition(),
              target: { kind: "goto" as const, state: "missing" },
            },
          ],
        },
        {
          id: "unreachable",
          max_visits: 1,
          deadline_ms: 5_000,
          on: [finishTransition()],
        },
      ],
    };
    const result = processReactiveScenarioSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          "transition target state is not declared",
          "state is unreachable from the initial state",
          "transition ids must be unique",
        ]),
      );
  });

  it("accepts only explicitly bounded cycles", () => {
    const cycle = {
      version: 1 as const,
      initial_state: "one",
      deadline_ms: 10_000,
      states: [
        {
          id: "one",
          max_visits: 2,
          deadline_ms: 2_000,
          on: [
            {
              ...finishTransition(),
              id: "to_two",
              max_uses: 2,
              actions: [],
              target: { kind: "goto" as const, state: "two" },
            },
          ],
        },
        {
          id: "two",
          max_visits: 2,
          deadline_ms: 2_000,
          on: [
            {
              ...finishTransition(),
              id: "to_one",
              max_uses: 2,
              actions: [],
              target: { kind: "goto" as const, state: "one" },
            },
          ],
        },
      ],
    };
    expect(processReactiveScenarioSchema.safeParse(cycle).success).toBe(true);
    const unbounded = {
      ...cycle,
      states: cycle.states.map((state) => ({
        ...state,
        max_visits: undefined,
      })),
    };
    expect(processReactiveScenarioSchema.safeParse(unbounded).success).toBe(
      false,
    );
  });

  it("rejects impossible checkpoint frontiers and volatile exact fields", () => {
    const exact = {
      kind: "event" as const,
      source: "http" as const,
      exact: { sequence: 0, path: "/ready" },
      ignore_fields: ["sequence" as const],
      since: { kind: "checkpoint" as const, name: "missing" },
      consume: false,
      cardinality: { min: 1, max: 1 },
    };
    const input = {
      ...baseScenario(),
      states: [
        {
          ...baseScenario().states[0],
          on: [{ ...finishTransition(), when: exact, actions: [] }],
        },
      ],
    };
    const result = processReactiveScenarioSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          "exact payload must omit every ignored field",
          "checkpoint frontier is not definitely available before this transition",
        ]),
      );
  });

  it("rejects checkpoint frontiers produced only by self or later transitions", () => {
    const checkpointTrigger = (name: string) => ({
      ...terminalTrigger(),
      since: { kind: "checkpoint" as const, name },
    });
    const input = {
      version: 1 as const,
      initial_state: "one",
      deadline_ms: 10_000,
      states: [
        {
          id: "one",
          max_visits: 1,
          deadline_ms: 2_000,
          on: [
            {
              ...finishTransition(),
              id: "self",
              when: checkpointTrigger("self_checkpoint"),
              actions: [
                { type: "checkpoint" as const, name: "self_checkpoint" },
              ],
              target: { kind: "goto" as const, state: "two" },
            },
          ],
        },
        {
          id: "two",
          max_visits: 1,
          deadline_ms: 2_000,
          on: [
            {
              ...finishTransition(),
              id: "later",
              when: checkpointTrigger("later_checkpoint"),
              actions: [
                { type: "checkpoint" as const, name: "later_checkpoint" },
              ],
            },
          ],
        },
      ],
    };
    const result = processReactiveScenarioSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.filter(({ message }) =>
          message.includes("not definitely available"),
        ),
      ).toHaveLength(2);
  });

  it("rejects trigger trees beyond the declared depth", () => {
    let trigger: unknown = terminalTrigger();
    for (
      let depth = 0;
      depth < PROCESS_REACTIVE_LIMITS.triggerDepth;
      depth += 1
    )
      trigger = { kind: "repeat", trigger, min: 1, max: 1 };
    const input = {
      ...baseScenario(),
      states: [
        {
          ...baseScenario().states[0],
          on: [{ ...finishTransition(), when: trigger }],
        },
      ],
    };
    const result = processReactiveScenarioSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map(({ message }) => message)).toContain(
        "trigger nesting exceeds the v1 limit",
      );

    let hostile: unknown = terminalTrigger();
    for (let depth = 0; depth < 10_000; depth += 1)
      hostile = { kind: "repeat", trigger: hostile, min: 1, max: 1 };
    const hostileInput = {
      ...input,
      states: [
        {
          ...input.states[0],
          on: [{ ...finishTransition(), when: hostile }],
        },
      ],
    };
    expect(() =>
      processReactiveScenarioSchema.safeParse(hostileInput),
    ).not.toThrow();
    expect(processReactiveScenarioSchema.safeParse(hostileInput).success).toBe(
      false,
    );

    let deepJson: unknown = "leaf";
    for (let depth = 0; depth < 10_000; depth += 1)
      deepJson = { child: deepJson };
    const deepJsonInput = {
      ...input,
      states: [
        {
          ...input.states[0],
          on: [
            {
              ...finishTransition(),
              when: {
                kind: "event",
                source: "shim",
                exact: deepJson,
                ignore_fields: [],
                since: { kind: "scenario_start" },
                consume: false,
                cardinality: { min: 1, max: 1 },
              },
            },
          ],
        },
      ],
    };
    expect(() =>
      processReactiveScenarioSchema.safeParse(deepJsonInput),
    ).not.toThrow();
    expect(processReactiveScenarioSchema.safeParse(deepJsonInput).success).toBe(
      false,
    );
  });
});
