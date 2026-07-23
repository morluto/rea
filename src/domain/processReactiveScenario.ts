import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";
import { processObservationSourceSchema } from "./processObservation.js";
import { definitelyAvailableCheckpoints } from "./processReactiveCheckpointDataflow.js";
import { preflightProcessReactiveScenario } from "./processReactiveScenarioPreflight.js";

/** Fixed public bounds for Process Reactive Scenario v1. */
export const PROCESS_REACTIVE_LIMITS = {
  states: 32,
  transitions: 128,
  triggerDepth: 6,
  predicates: 64,
  actions: 256,
  actionsPerTransition: 16,
  childrenPerComposite: 16,
  stateVisits: 256,
  transitionUses: 256,
  repeat: 64,
  retainedObservations: 256,
  terminalMatchBytes: 65_536,
  evaluationWork: 8_192,
  jsonDepth: 20,
  jsonNodes: 1_024,
  runtimeMs: 300_000,
} as const;

const identifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);
const checkpointNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const positiveRuntime = z
  .number()
  .int()
  .positive()
  .max(PROCESS_REACTIVE_LIMITS.runtimeMs);

const frontierSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("scenario_start") }),
  z.strictObject({ kind: z.literal("state_entry") }),
  z.strictObject({ kind: z.literal("checkpoint"), name: checkpointNameSchema }),
  z.strictObject({ kind: z.literal("event_id"), event_id: identifierSchema }),
]);
export type ProcessReactiveFrontier = z.infer<typeof frontierSchema>;

const ignoredFieldSchema = z.enum([
  "sequence",
  "at_ms",
  "scheduled_at_ms",
  "dispatched_at_ms",
  "elapsed_ms",
]);

interface EventTrigger {
  readonly kind: "event";
  readonly source: z.infer<typeof processObservationSourceSchema>;
  readonly exact: z.infer<typeof jsonValueSchema>;
  readonly ignore_fields: readonly z.infer<typeof ignoredFieldSchema>[];
  readonly since: ProcessReactiveFrontier;
  readonly consume: boolean;
  readonly cardinality: { readonly min: number; readonly max: number };
}

interface TerminalTextTrigger {
  readonly kind: "terminal_text";
  readonly view: "decoded";
  readonly encoding: "utf8";
  readonly literal: string;
  readonly case_sensitive: true;
  readonly control_sequences: "include";
  readonly occurrence: number;
  readonly since: ProcessReactiveFrontier;
  readonly consume: boolean;
}

type TriggerGroup =
  | {
      readonly kind: "all";
      readonly triggers: readonly ProcessReactiveTrigger[];
    }
  | {
      readonly kind: "any";
      readonly triggers: readonly ProcessReactiveTrigger[];
    }
  | {
      readonly kind: "sequence";
      readonly triggers: readonly ProcessReactiveTrigger[];
    };

interface RepeatTrigger {
  readonly kind: "repeat";
  readonly trigger: ProcessReactiveTrigger;
  readonly min: number;
  readonly max: number;
}

/** Declarative, bounded predicate tree evaluated against process observations. */
export type ProcessReactiveTrigger =
  | EventTrigger
  | TerminalTextTrigger
  | TriggerGroup
  | RepeatTrigger;

const processReactiveTriggerSchema: z.ZodType<ProcessReactiveTrigger> = z.lazy(
  () =>
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("event"),
        source: processObservationSourceSchema,
        exact: jsonValueSchema,
        ignore_fields: z
          .array(ignoredFieldSchema)
          .max(5)
          .refine((values) => new Set(values).size === values.length, {
            message: "ignored event fields must be unique",
          }),
        since: frontierSchema,
        consume: z.boolean(),
        cardinality: z
          .strictObject({
            min: z.number().int().positive().max(256),
            max: z.number().int().positive().max(256),
          })
          .refine(({ min, max }) => min <= max, {
            message: "cardinality min must not exceed max",
          }),
      }),
      z.strictObject({
        kind: z.literal("terminal_text"),
        view: z.literal("decoded"),
        encoding: z.literal("utf8"),
        literal: z.string().min(1).max(10_000),
        case_sensitive: z.literal(true),
        control_sequences: z.literal("include"),
        occurrence: z.number().int().positive().max(1_000),
        since: frontierSchema,
        consume: z.boolean(),
      }),
      z.strictObject({
        kind: z.literal("all"),
        triggers: z
          .array(processReactiveTriggerSchema)
          .min(2)
          .max(PROCESS_REACTIVE_LIMITS.childrenPerComposite),
      }),
      z.strictObject({
        kind: z.literal("any"),
        triggers: z
          .array(processReactiveTriggerSchema)
          .min(2)
          .max(PROCESS_REACTIVE_LIMITS.childrenPerComposite),
      }),
      z.strictObject({
        kind: z.literal("sequence"),
        triggers: z
          .array(processReactiveTriggerSchema)
          .min(1)
          .max(PROCESS_REACTIVE_LIMITS.childrenPerComposite),
      }),
      z
        .strictObject({
          kind: z.literal("repeat"),
          trigger: processReactiveTriggerSchema,
          min: z.number().int().positive().max(PROCESS_REACTIVE_LIMITS.repeat),
          max: z.number().int().positive().max(PROCESS_REACTIVE_LIMITS.repeat),
        })
        .refine(({ min, max }) => min <= max, {
          message: "repeat min must not exceed max",
        }),
    ]),
);

const signalTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("root") }),
  z.strictObject({ kind: z.literal("process_group") }),
  z.strictObject({
    kind: z.literal("subject_id"),
    subject_id: identifierSchema,
  }),
]);

const processReactiveActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("send_input"),
    data: z.string().max(1_000_000),
    sensitive: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("resize"),
    columns: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }),
  z.strictObject({
    type: z.literal("send_signal"),
    target: signalTargetSchema,
    signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]),
  }),
  z.strictObject({ type: z.literal("checkpoint"), name: checkpointNameSchema }),
]);
export type ProcessReactiveAction = z.infer<typeof processReactiveActionSchema>;

const transitionTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("goto"), state: identifierSchema }),
  z.strictObject({ kind: z.literal("finish"), outcome: z.literal("passed") }),
]);

const transitionSchema = z.strictObject({
  id: identifierSchema,
  priority: z.number().int().min(0).max(1_000),
  max_uses: z
    .number()
    .int()
    .positive()
    .max(PROCESS_REACTIVE_LIMITS.transitionUses),
  when: processReactiveTriggerSchema,
  actions: z
    .array(processReactiveActionSchema)
    .max(PROCESS_REACTIVE_LIMITS.actionsPerTransition),
  target: transitionTargetSchema,
});

const stateSchema = z.strictObject({
  id: identifierSchema,
  max_visits: z
    .number()
    .int()
    .positive()
    .max(PROCESS_REACTIVE_LIMITS.stateVisits),
  deadline_ms: positiveRuntime,
  on: z.array(transitionSchema).min(1).max(128),
});

const scenarioShapeSchema = z.strictObject({
  version: z.literal(1),
  initial_state: identifierSchema,
  deadline_ms: positiveRuntime,
  states: z.array(stateSchema).min(1).max(PROCESS_REACTIVE_LIMITS.states),
});

/** Parsed Process Reactive Scenario v1 declaration. */
export type ProcessReactiveScenario = z.infer<typeof scenarioShapeSchema>;

type TriggerMeasurements = {
  readonly depth: number;
  readonly predicates: number;
};

const measureTrigger = (
  trigger: ProcessReactiveTrigger,
): TriggerMeasurements => {
  if (trigger.kind === "event" || trigger.kind === "terminal_text")
    return { depth: 1, predicates: 1 };
  const children =
    trigger.kind === "repeat" ? [trigger.trigger] : trigger.triggers;
  const measured = children.map(measureTrigger);
  return {
    depth: 1 + Math.max(...measured.map(({ depth }) => depth)),
    predicates: measured.reduce(
      (total, { predicates }) => total + predicates,
      0,
    ),
  };
};

const collectCheckpointFrontiers = (
  trigger: ProcessReactiveTrigger,
): readonly string[] => {
  if (trigger.kind === "event" || trigger.kind === "terminal_text")
    return trigger.since.kind === "checkpoint" ? [trigger.since.name] : [];
  const children =
    trigger.kind === "repeat" ? [trigger.trigger] : trigger.triggers;
  return children.flatMap(collectCheckpointFrontiers);
};

const validateTriggerSemantics = (
  trigger: ProcessReactiveTrigger,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void => {
  if (trigger.kind === "event") {
    const exact = trigger.exact;
    if (
      trigger.ignore_fields.length > 0 &&
      (typeof exact !== "object" || exact === null || Array.isArray(exact))
    )
      context.addIssue({
        code: "custom",
        message: "ignored fields require an exact object payload",
        path: [...path, "ignore_fields"],
      });
    if (
      typeof exact === "object" &&
      exact !== null &&
      !Array.isArray(exact) &&
      trigger.ignore_fields.some((field) => field in exact)
    )
      context.addIssue({
        code: "custom",
        message: "exact payload must omit every ignored field",
        path: [...path, "exact"],
      });
    return;
  }
  if (trigger.kind === "terminal_text") return;
  if (trigger.kind === "repeat") {
    validateTriggerSemantics(trigger.trigger, [...path, "trigger"], context);
    return;
  }
  for (const [index, child] of trigger.triggers.entries())
    validateTriggerSemantics(child, [...path, "triggers", index], context);
};

type GraphValidation = {
  readonly knownStates: ReadonlySet<string>;
  readonly transitionIds: Set<string>;
  readonly checkpoints: Set<string>;
  readonly checkpointReferences: Array<{
    readonly name: string;
    readonly stateId: string;
    readonly path: PropertyKey[];
  }>;
  readonly adjacency: ReadonlyMap<string, Set<string>>;
  transitions: number;
  predicates: number;
  actions: number;
};

type ReactiveTransition =
  ProcessReactiveScenario["states"][number]["on"][number];

const validateTransition = (input: {
  readonly stateId: string;
  readonly transition: ReactiveTransition;
  readonly path: PropertyKey[];
  readonly validation: GraphValidation;
  readonly context: z.RefinementCtx;
}): void => {
  const { transition, validation, path, context } = input;
  validation.transitions += 1;
  validation.actions += transition.actions.length;
  const measured = measureTrigger(transition.when);
  validation.predicates += measured.predicates;
  validateTriggerSemantics(transition.when, [...path, "when"], context);
  if (measured.depth > PROCESS_REACTIVE_LIMITS.triggerDepth)
    context.addIssue({
      code: "custom",
      message: "trigger nesting exceeds the v1 limit",
      path: [...path, "when"],
    });
  if (validation.transitionIds.has(transition.id))
    context.addIssue({
      code: "custom",
      message: "transition ids must be unique",
      path: [...path, "id"],
    });
  validation.transitionIds.add(transition.id);
  for (const action of transition.actions) {
    if (action.type !== "checkpoint") continue;
    if (validation.checkpoints.has(action.name))
      context.addIssue({
        code: "custom",
        message: "checkpoint action names must be unique",
        path: [...path, "actions"],
      });
    validation.checkpoints.add(action.name);
  }
  for (const name of collectCheckpointFrontiers(transition.when))
    validation.checkpointReferences.push({
      name,
      stateId: input.stateId,
      path: [...path, "when"],
    });
  if (transition.target.kind !== "goto") return;
  if (!validation.knownStates.has(transition.target.state)) {
    context.addIssue({
      code: "custom",
      message: "transition target state is not declared",
      path: [...path, "target", "state"],
    });
    return;
  }
  validation.adjacency.get(input.stateId)?.add(transition.target.state);
};

const validateTotalsAndReferences = (
  scenario: ProcessReactiveScenario,
  validation: GraphValidation,
  context: z.RefinementCtx,
): void => {
  for (const [count, limit, message] of [
    [
      validation.transitions,
      PROCESS_REACTIVE_LIMITS.transitions,
      "scenario has too many transitions",
    ],
    [
      validation.predicates,
      PROCESS_REACTIVE_LIMITS.predicates,
      "scenario has too many predicates",
    ],
    [
      validation.actions,
      PROCESS_REACTIVE_LIMITS.actions,
      "scenario has too many actions",
    ],
  ] as const)
    if (count > limit)
      context.addIssue({ code: "custom", message, path: ["states"] });
  const available = definitelyAvailableCheckpoints(scenario);
  for (const reference of validation.checkpointReferences)
    if (!available.get(reference.stateId)?.has(reference.name))
      context.addIssue({
        code: "custom",
        message:
          "checkpoint frontier is not definitely available before this transition",
        path: reference.path,
      });
};

const validateReachability = (
  scenario: ProcessReactiveScenario,
  stateIds: readonly string[],
  validation: GraphValidation,
  context: z.RefinementCtx,
): void => {
  const reachable = new Set<string>();
  const pending = validation.knownStates.has(scenario.initial_state)
    ? [scenario.initial_state]
    : [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || reachable.has(current)) continue;
    reachable.add(current);
    pending.push(...(validation.adjacency.get(current) ?? []));
  }
  for (const [index, id] of stateIds.entries())
    if (!reachable.has(id))
      context.addIssue({
        code: "custom",
        message: "state is unreachable from the initial state",
        path: ["states", index],
      });
};

const validateScenarioGraph = (
  scenario: ProcessReactiveScenario,
  context: z.RefinementCtx,
): void => {
  const stateIds = scenario.states.map(({ id }) => id);
  const knownStates = new Set(stateIds);
  if (knownStates.size !== stateIds.length)
    context.addIssue({
      code: "custom",
      message: "state ids must be unique",
      path: ["states"],
    });
  if (!knownStates.has(scenario.initial_state))
    context.addIssue({
      code: "custom",
      message: "initial state is not declared",
      path: ["initial_state"],
    });
  const validation: GraphValidation = {
    knownStates,
    transitionIds: new Set(),
    checkpoints: new Set(),
    checkpointReferences: [],
    adjacency: new Map(stateIds.map((id) => [id, new Set<string>()])),
    transitions: 0,
    predicates: 0,
    actions: 0,
  };
  for (const [stateIndex, state] of scenario.states.entries()) {
    if (state.deadline_ms > scenario.deadline_ms)
      context.addIssue({
        code: "custom",
        message: "state deadline must not exceed scenario deadline",
        path: ["states", stateIndex, "deadline_ms"],
      });
    for (const [transitionIndex, transition] of state.on.entries())
      validateTransition({
        stateId: state.id,
        transition,
        path: ["states", stateIndex, "on", transitionIndex],
        validation,
        context,
      });
  }
  validateTotalsAndReferences(scenario, validation, context);
  validateReachability(scenario, stateIds, validation, context);
};

/** Strict boundary schema for a bounded declarative reactive scenario. */
export const processReactiveScenarioSchema = z.preprocess(
  (input, context) =>
    preflightProcessReactiveScenario(input, context, PROCESS_REACTIVE_LIMITS),
  scenarioShapeSchema.superRefine((scenario, context) =>
    validateScenarioGraph(scenario, context),
  ),
);
