import { z } from "zod";

import { jsonValueSchema } from "./jsonValue.js";
import { processObservationSourceSchema } from "./processObservation.js";
import { definitelyAvailableCheckpoints } from "./processReactiveCheckpointDataflow.js";
import { preflightProcessReactiveScenario } from "./processReactiveScenarioPreflight.js";

/** Structural depth guard for recursive Zod parsing. */
export const PROCESS_REACTIVE_LIMITS = {
  // Recursive Zod schemas need a practical stack guard, not a small tree quota.
  triggerDepth: 256,
  jsonDepth: 256,
} as const;

const identifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._-]*$/u);
const checkpointNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const positiveRuntime = z.number().int().safe().positive();

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
  "files",
  "effects",
  "truncated",
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
  readonly literal: string;
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
          .default([])
          .refine((values) => new Set(values).size === values.length, {
            message: "ignored event fields must be unique",
          }),
        since: frontierSchema.default({ kind: "scenario_start" }),
        consume: z.boolean().default(false),
        cardinality: z
          .strictObject({
            min: z.number().int().safe().positive(),
            max: z.number().int().safe().positive(),
          })
          .default({ min: 1, max: 1 })
          .refine(({ min, max }) => min <= max, {
            message: "cardinality min must not exceed max",
          }),
      }),
      z.strictObject({
        kind: z.literal("terminal_text"),
        literal: z.string().min(1),
        occurrence: z.number().int().safe().positive().default(1),
        since: frontierSchema.default({ kind: "scenario_start" }),
        consume: z.boolean().default(false),
      }),
      z.strictObject({
        kind: z.literal("all"),
        triggers: z.array(processReactiveTriggerSchema).min(2),
      }),
      z.strictObject({
        kind: z.literal("any"),
        triggers: z.array(processReactiveTriggerSchema).min(2),
      }),
      z.strictObject({
        kind: z.literal("sequence"),
        triggers: z.array(processReactiveTriggerSchema).min(1),
      }),
      z
        .strictObject({
          kind: z.literal("repeat"),
          trigger: processReactiveTriggerSchema,
          min: z.number().int().safe().positive(),
          max: z.number().int().safe().positive(),
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
    data: z.string(),
    sensitive: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal("resize"),
    columns: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  z.strictObject({ type: z.literal("close_stdin") }),
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
  z.strictObject({ kind: z.literal("finish") }),
]);

const transitionSchema = z.strictObject({
  id: identifierSchema,
  priority: z.number().int().safe().min(0),
  max_uses: z.number().int().safe().positive(),
  when: processReactiveTriggerSchema,
  actions: z.array(processReactiveActionSchema),
  target: transitionTargetSchema,
});

const stateSchema = z.strictObject({
  id: identifierSchema,
  max_visits: z.number().int().safe().positive(),
  deadline_ms: positiveRuntime,
  on: z.array(transitionSchema).min(1),
});

const scenarioShapeSchema = z.strictObject({
  initial_state: identifierSchema,
  deadline_ms: positiveRuntime,
  states: z.array(stateSchema).min(1),
});

/** Parsed process reactive scenario declaration. */
export type ProcessReactiveScenario = z.infer<typeof scenarioShapeSchema>;

type TriggerMeasurements = {
  readonly depth: number;
};

const measureTrigger = (
  trigger: ProcessReactiveTrigger,
): TriggerMeasurements => {
  if (trigger.kind === "event" || trigger.kind === "terminal_text")
    return { depth: 1 };
  const children =
    trigger.kind === "repeat" ? [trigger.trigger] : trigger.triggers;
  const measured = children.map(measureTrigger);
  return {
    depth:
      1 + measured.reduce((maximum, { depth }) => Math.max(maximum, depth), 0),
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
  const measured = measureTrigger(transition.when);
  validateTriggerSemantics(transition.when, [...path, "when"], context);
  if (measured.depth > PROCESS_REACTIVE_LIMITS.triggerDepth)
    context.addIssue({
      code: "custom",
      message: "trigger nesting exceeds the configured limit",
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
