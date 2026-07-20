import { MultiDirectedGraph } from "graphology";
import { singleSource } from "graphology-shortest-path";
import canonicalize from "canonicalize";
import { z } from "zod";

const replayIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
const replayPathSchema = z
  .array(z.union([z.string().max(256), z.number().int().nonnegative()]))
  .max(32);
const sensitiveHeaderNames = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
]);
const replayHeaderMatchersSchema = z
  .record(z.string().min(1).max(256), z.string().max(8_192))
  .superRefine((headers, context) => {
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length)
      context.addIssue({
        code: "custom",
        message: "replay header matchers must be unique ignoring case",
        input: headers,
      });
    if (names.some((name) => sensitiveHeaderNames.has(name)))
      context.addIssue({
        code: "custom",
        message:
          "replay header matchers cannot persist authorization or cookie values; capture and guard through a secret alias instead",
        input: headers,
      });
  })
  .transform((headers) =>
    Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    ),
  );

const replayValueSourceSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("request_header"),
    name: z
      .string()
      .min(1)
      .transform((name) => name.toLowerCase()),
  }),
  z.strictObject({ source: z.literal("request_json"), path: replayPathSchema }),
  z.strictObject({
    source: z.literal("websocket_json"),
    path: replayPathSchema,
  }),
  z.strictObject({ source: z.literal("action_json"), path: replayPathSchema }),
]);

const replayTriggerSchema = z.discriminatedUnion("protocol", [
  z.strictObject({
    protocol: z.literal("http"),
    method: z
      .string()
      .min(1)
      .max(16)
      .transform((method) => method.toUpperCase()),
    path: z.string().startsWith("/"),
    headers: replayHeaderMatchersSchema.default({}),
    body: z.string().max(1_000_000).nullable().default(null),
  }),
  z.strictObject({
    protocol: z.literal("websocket_connect"),
    path: z.string().startsWith("/"),
    headers: replayHeaderMatchersSchema.default({}),
  }),
  z.strictObject({
    protocol: z.literal("websocket_message"),
    path: z.string().startsWith("/"),
    body: z.string().max(1_000_000).nullable().default(null),
  }),
]);

const replayActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("http_response"),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().max(1_000_000),
  }),
  z.strictObject({
    type: z.literal("websocket_send"),
    data: z.string().max(1_000_000),
  }),
  z.strictObject({ type: z.literal("disconnect") }),
  z.strictObject({
    type: z.literal("delay"),
    duration_ms: z.number().int().nonnegative().max(30_000),
  }),
]);

const replayTransitionSchema = z.strictObject({
  id: replayIdentifierSchema,
  from: replayIdentifierSchema,
  to: replayIdentifierSchema,
  priority: z.number().int().min(0).max(1_000).default(100),
  trigger: replayTriggerSchema,
  guards: z
    .array(
      z.strictObject({
        variable: replayIdentifierSchema,
        value: replayValueSourceSchema,
      }),
    )
    .max(32)
    .default([]),
  captures: z
    .array(
      z.strictObject({
        variable: replayIdentifierSchema,
        value: replayValueSourceSchema,
        sensitive: z.boolean().default(false),
      }),
    )
    .max(32)
    .default([]),
  actions: z.array(replayActionSchema).min(1).max(32),
  max_uses: z.number().int().min(1).max(10_000),
});

const transitionSignature = (
  transition: z.infer<typeof replayTransitionSchema>,
): string => {
  const signature = canonicalize({
    from: transition.from,
    priority: transition.priority,
    trigger: transition.trigger,
  });
  if (signature === undefined)
    throw new TypeError("Replay transition signature is not canonical JSON");
  return signature;
};

const replayMachineBaseSchema = z.strictObject({
  initial_state: replayIdentifierSchema,
  states: z
    .array(
      z.strictObject({
        name: replayIdentifierSchema,
        terminal: z.boolean().default(false),
        max_visits: z.number().int().min(1).max(100_000).default(100_000),
      }),
    )
    .min(1)
    .max(256),
  transitions: z.array(replayTransitionSchema).min(1).max(2_000),
  max_transitions: z.number().int().min(1).max(100_000),
  limits: z
    .strictObject({
      connections: z.number().int().min(1).max(1_000).default(100),
      messages: z.number().int().min(1).max(100_000).default(10_000),
      bytes: z.number().int().min(1).max(10_000_000).default(1_000_000),
      duration_ms: z.number().int().min(1).max(300_000).default(30_000),
    })
    .default({
      connections: 100,
      messages: 10_000,
      bytes: 1_000_000,
      duration_ms: 30_000,
    }),
});
type ReplayMachineInput = z.infer<typeof replayMachineBaseSchema>;
type ReplayMachineContext = z.core.$RefinementCtx<ReplayMachineInput>;

const validateReplayIdentities = (
  machine: ReplayMachineInput,
  context: ReplayMachineContext,
): ReadonlySet<string> => {
  const names = machine.states.map(({ name }) => name);
  const nameSet = new Set(names);
  if (nameSet.size !== names.length)
    context.addIssue({
      code: "custom",
      message: "replay machine state names must be unique",
      path: ["states"],
      input: machine,
    });
  if (!nameSet.has(machine.initial_state))
    context.addIssue({
      code: "custom",
      message: "replay machine initial state is not declared",
      path: ["initial_state"],
      input: machine,
    });
  const transitionIds = machine.transitions.map(({ id }) => id);
  if (new Set(transitionIds).size !== transitionIds.length)
    context.addIssue({
      code: "custom",
      message: "replay machine transition IDs must be unique",
      path: ["transitions"],
      input: machine,
    });
  const signatures = machine.transitions.map(transitionSignature);
  if (new Set(signatures).size !== signatures.length)
    context.addIssue({
      code: "custom",
      message:
        "replay machine transitions with the same state, trigger, and priority are ambiguous",
      path: ["transitions"],
      input: machine,
    });
  return nameSet;
};

const validateReplayVariables = (
  machine: ReplayMachineInput,
  context: ReplayMachineContext,
): void => {
  const capturedVariables = new Map<string, boolean>();
  for (const [transitionIndex, transition] of machine.transitions.entries()) {
    for (const capture of transition.captures) {
      const sensitivity = capturedVariables.get(capture.variable);
      if (sensitivity !== undefined && sensitivity !== capture.sensitive)
        context.addIssue({
          code: "custom",
          message:
            "a replay variable cannot change secret classification between captures",
          path: ["transitions", transitionIndex, "captures"],
          input: machine,
        });
      capturedVariables.set(capture.variable, capture.sensitive);
    }
  }

  const availableByState = new Map<string, Set<string>>([
    [machine.initial_state, new Set()],
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of machine.transitions) {
      const available = availableByState.get(transition.from);
      if (
        available === undefined ||
        transition.guards.some(({ variable }) => !available.has(variable))
      )
        continue;
      const nextAvailable = new Set(available);
      for (const { variable } of transition.captures)
        nextAvailable.add(variable);
      const existing = availableByState.get(transition.to);
      if (existing === undefined) {
        availableByState.set(transition.to, nextAvailable);
        changed = true;
        continue;
      }
      for (const variable of nextAvailable)
        if (!existing.has(variable)) {
          existing.add(variable);
          changed = true;
        }
    }
  }

  for (const [transitionIndex, transition] of machine.transitions.entries())
    for (const [guardIndex, guard] of transition.guards.entries())
      if (!availableByState.get(transition.from)?.has(guard.variable))
        context.addIssue({
          code: "custom",
          message:
            "replay guard variable is not captured on an executable path before use",
          path: ["transitions", transitionIndex, "guards", guardIndex],
          input: machine,
        });
};

const validateReplayActions = (
  machine: ReplayMachineInput,
  context: ReplayMachineContext,
): void => {
  for (const [index, transition] of machine.transitions.entries()) {
    const httpResponses = transition.actions.filter(
      ({ type }) => type === "http_response",
    ).length;
    const websocketSends = transition.actions.some(
      ({ type }) => type === "websocket_send",
    );
    const invalid =
      transition.trigger.protocol === "http"
        ? httpResponses !== 1 || websocketSends
        : httpResponses !== 0;
    if (invalid)
      context.addIssue({
        code: "custom",
        message:
          "replay actions must match the transition protocol and HTTP transitions require exactly one response",
        path: ["transitions", index, "actions"],
        input: machine,
      });
  }
};

const validateReplayGraph = (
  machine: ReplayMachineInput,
  names: ReadonlySet<string>,
  context: ReplayMachineContext,
): void => {
  const graph = new MultiDirectedGraph();
  for (const name of names) graph.addNode(name);
  for (const [index, transition] of machine.transitions.entries()) {
    if (!names.has(transition.from) || !names.has(transition.to)) {
      context.addIssue({
        code: "custom",
        message: "replay machine transition references an unknown state",
        path: ["transitions", index],
        input: machine,
      });
      continue;
    }
    graph.addDirectedEdgeWithKey(
      `${transition.id}:${String(index)}`,
      transition.from,
      transition.to,
    );
  }
  if (!graph.hasNode(machine.initial_state)) return;
  if (!machine.states.some(({ terminal }) => terminal))
    context.addIssue({
      code: "custom",
      message: "replay machine must declare at least one terminal state",
      path: ["states"],
      input: machine,
    });
  const reachable = new Set(
    Object.keys(singleSource(graph, machine.initial_state)),
  );
  reachable.add(machine.initial_state);
  for (const [index, state] of machine.states.entries()) {
    if (!reachable.has(state.name))
      context.addIssue({
        code: "custom",
        message: "replay machine state is unreachable from the initial state",
        path: ["states", index],
        input: machine,
      });
    if (state.terminal && graph.outDegree(state.name) > 0)
      context.addIssue({
        code: "custom",
        message:
          "terminal replay machine state cannot have outgoing transitions",
        path: ["states", index],
        input: machine,
      });
    if (!state.terminal && graph.outDegree(state.name) === 0)
      context.addIssue({
        code: "custom",
        message: "non-terminal replay machine state has no outgoing transition",
        path: ["states", index],
        input: machine,
      });
  }
};

/** Portable finite replay machine with no executable callbacks. */
export const replayMachineSchema = z
  .object(replayMachineBaseSchema.shape)
  .strict()
  .superRefine((machine, context) => {
    const names = validateReplayIdentities(machine, context);
    validateReplayVariables(machine, context);
    validateReplayActions(machine, context);
    validateReplayGraph(machine, names, context);
  });

export type ReplayMachine = z.infer<typeof replayMachineSchema>;
