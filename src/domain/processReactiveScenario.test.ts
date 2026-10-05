import { describe, expect, it } from "vitest";

import {
  PROCESS_REACTIVE_LIMITS,
  processReactiveScenarioSchema,
} from "./processReactiveScenario.js";

const terminalTrigger = () => ({
  kind: "terminal_text" as const,
  literal: "Ready",
});

const finishTransition = () => ({
  id: "finish",
  priority: 100,
  max_uses: 1,
  when: terminalTrigger(),
  actions: [{ type: "checkpoint" as const, name: "ready" }],
  target: { kind: "finish" as const },
});

const baseScenario = () => ({
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

const buildLargeCallerScenario = () => {
  const states = Array.from({ length: 40 }, (_, index) => ({
    id: `state_${String(index)}`,
    max_visits: 300,
    deadline_ms: 30_000,
    on: [] as unknown[],
  }));
  const manyPredicates = {
    kind: "repeat",
    trigger: {
      kind: "all",
      triggers: Array.from({ length: 20 }, () => terminalTrigger()),
    },
    min: 1,
    max: 1_000,
  };
  const sendInputs = Array.from({ length: 300 }, () => ({
    type: "send_input",
    data: "x",
  }));
  states[0]!.on = Array.from({ length: 130 }, (_, index) => ({
    id: `transition_${String(index)}`,
    priority: index,
    max_uses: 300,
    when: index === 0 ? manyPredicates : terminalTrigger(),
    actions: index === 0 ? sendInputs : [],
    target:
      index > 0 && index <= 39
        ? { kind: "goto", state: `state_${String(index)}` }
        : { kind: "finish" },
  }));
  for (let index = 1; index < states.length; index += 1) {
    const state = states[index]!;
    state.on = [
      {
        ...finishTransition(),
        id: `finish_${String(index)}`,
        max_uses: 300,
        actions: [{ type: "checkpoint", name: `ready_${String(index)}` }],
      },
    ];
  }
  return processReactiveScenarioSchema.safeParse({
    initial_state: "state_0",
    deadline_ms: 30_000,
    states,
  });
};

/**
 * The field each rejection row below is meant to invalidate. Asserting only
 * that the scenario is rejected would still pass if a typo in the fixture
 * made it invalid for an unrelated reason, so each row must also produce an
 * issue pointing at the intended path with the expected code.
 */
const REJECTION_FIELD: Readonly<
  Record<
    string,
    { readonly path: readonly (string | number)[]; readonly code: string }
  >
> = {
  "unknown major version": { path: [], code: "unrecognized_keys" },
  "missing state bound": {
    path: ["states", 0, "max_visits"],
    code: "invalid_type",
  },
  "missing transition bound": {
    path: ["states", 0, "on", 0, "max_uses"],
    code: "invalid_type",
  },
  "unsupported trigger": {
    path: ["states", 0, "on", 0, "when", "kind"],
    code: "invalid_union",
  },
  "zero-minimum event absence predicate": {
    path: ["states", 0, "on", 0, "when", "cardinality", "min"],
    code: "too_small",
  },
};

describe("process reactive scenario schema", () => {
  it("parses a terminal scenario", () => {
    expect(processReactiveScenarioSchema.parse(baseScenario())).toMatchObject({
      initial_state: "starting",
      states: [
        {
          on: [
            {
              when: {
                occurrence: 1,
                since: { kind: "scenario_start" },
                consume: false,
              },
            },
          ],
        },
      ],
    });
  });

  it("accepts caller-defined scenario sizes without count ceilings", () => {
    const parsed = buildLargeCallerScenario();
    expect(
      parsed.success,
      parsed.success ? "" : JSON.stringify(parsed.error.issues),
    ).toBe(true);
  });

  it("accepts long caller supplied identifiers, terminal matchers, and input", () => {
    const identifier = `transition_${"x".repeat(128)}`;
    const checkpoint = `checkpoint_${"x".repeat(128)}`;
    const literal = "Ready".repeat(2_001);
    const data = "input".repeat(200_001);
    const parsed = processReactiveScenarioSchema.safeParse({
      initial_state: "starting",
      deadline_ms: 30_000,
      states: [
        {
          id: "starting",
          max_visits: 1,
          deadline_ms: 5_000,
          on: [
            {
              ...finishTransition(),
              id: identifier,
              when: { ...terminalTrigger(), literal },
              actions: [
                { type: "checkpoint", name: checkpoint },
                { type: "send_input", data },
              ],
            },
          ],
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.states[0]?.on[0]?.id).toBe(identifier);
      expect(parsed.data.states[0]?.on[0]?.when).toMatchObject({ literal });
      expect(parsed.data.states[0]?.on[0]?.actions[1]).toMatchObject({ data });
    }
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
  ])("rejects %s at the expected field", (_name, input) => {
    const expected = REJECTION_FIELD[_name];
    expect(expected, `no expected rejection field for ${_name}`).toBeDefined();
    if (expected === undefined) return;
    const parsed = processReactiveScenarioSchema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(
      parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
      })),
    ).toContainEqual({ path: [...expected.path], code: expected.code });
  });
});

describe("process reactive scenario graph validation", () => {
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
});

describe("process reactive scenario checkpoint validation", () => {
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
});

describe("process reactive scenario nesting validation", () => {
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
        "trigger nesting exceeds the configured limit",
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
