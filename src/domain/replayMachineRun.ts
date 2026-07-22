import { z } from "zod";

import { replayMachineSchema, type ReplayMachine } from "./replayMachine.js";
import {
  replayMachineEventSchema,
  ReplayMachineRuntime,
} from "./replayMachineRuntime.js";

const refusalOutcomeSchema = z.enum([
  "unmatched",
  "invalid_state",
  "guard_failed",
  "transition_exhausted",
  "invalid_capture",
  "unexpected_reconnect",
  "limit_exhausted",
]);

const MAX_DIRECT_REPLAY_EVENTS = 10_000;
const MAX_DIRECT_REPLAY_ACTION_BYTES = 4 * 1_024 * 1_024;
const MAX_DIRECT_REPLAY_ACTION_FIELDS = 1_024;
const MAX_DIRECT_REPLAY_SENSITIVE_CAPTURES = 1_024;

const actionFieldCount = (machine: ReplayMachine): number =>
  machine.transitions.reduce(
    (total, transition) =>
      total +
      transition.actions.reduce(
        (fields, action) =>
          fields +
          (action.type === "http_response"
            ? Object.keys(action.headers).length + 1
            : action.type === "websocket_send"
              ? 1
              : 0),
        0,
      ),
    0,
  );

const maximumSensitiveCapturesPerEvent = (machine: ReplayMachine): number =>
  Math.max(
    0,
    ...machine.transitions.map(
      ({ captures }) => captures.filter(({ sensitive }) => sensitive).length,
    ),
  );

/** Complete declarative input for one direct replay-machine run. */
export const replayMachineRunInputSchema = z
  .strictObject({
    machine: replayMachineSchema,
    events: z.array(replayMachineEventSchema).max(MAX_DIRECT_REPLAY_EVENTS),
  })
  .superRefine(({ machine, events }, context) => {
    const actionBytes = Buffer.byteLength(
      JSON.stringify(
        machine.transitions.map(({ id, actions }) => ({ id, actions })),
      ),
    );
    if (actionBytes > MAX_DIRECT_REPLAY_ACTION_BYTES)
      context.addIssue({
        code: "custom",
        path: ["machine", "transitions"],
        message: "direct replay actions exceed the 4 MiB output boundary",
        input: machine.transitions,
      });
    if (actionFieldCount(machine) > MAX_DIRECT_REPLAY_ACTION_FIELDS)
      context.addIssue({
        code: "custom",
        path: ["machine", "transitions"],
        message: "direct replay actions exceed the 1,024-field output boundary",
        input: machine.transitions,
      });
    if (
      maximumSensitiveCapturesPerEvent(machine) * events.length >
      MAX_DIRECT_REPLAY_SENSITIVE_CAPTURES
    )
      context.addIssue({
        code: "custom",
        path: ["events"],
        message:
          "direct replay events exceed the 1,024 sensitive-capture operation boundary",
        input: events,
      });
  });

const replayMachineRunDecisionSchema = z.strictObject({
  event_sequence: z.number().int().nonnegative(),
  outcome: z.union([z.literal("matched"), refusalOutcomeSchema]),
  transition_sequence: z.number().int().nonnegative().nullable(),
});

const replayRunActionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("http_response"),
    status: z.number().int().min(100).max(599),
    headers: z.record(
      z
        .string()
        .min(1)
        .max(256)
        .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
      z.string().max(8_192),
    ),
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

const replayRunIdentifierSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);

const replayMachineRunJournalEntrySchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  at_ms: z.number().int().nonnegative(),
  transition_id: replayRunIdentifierSchema,
  state_before: replayRunIdentifierSchema,
  state_after: replayRunIdentifierSchema,
  captured_aliases: z
    .array(
      z.strictObject({
        name: replayRunIdentifierSchema,
        sensitive: z.boolean(),
      }),
    )
    .max(32),
});

/** Capture-value-free result of directly evaluating a finite replay machine. */
export const replayMachineRunOutputSchema = z.strictObject({
  schema_version: z.literal(1),
  initial_state: replayRunIdentifierSchema,
  final_state: replayRunIdentifierSchema,
  terminal: z.boolean(),
  decisions: z
    .array(replayMachineRunDecisionSchema)
    .max(MAX_DIRECT_REPLAY_EVENTS),
  transition_journal: z
    .array(replayMachineRunJournalEntrySchema)
    .max(MAX_DIRECT_REPLAY_EVENTS),
  transition_actions: z
    .array(
      z.strictObject({
        transition_id: replayRunIdentifierSchema,
        actions: z.array(replayRunActionSchema).max(32),
      }),
    )
    .max(2_000),
  limits: z.strictObject({
    configured: z.strictObject({
      transitions: z.number().int().positive(),
      connections: z.number().int().positive(),
      messages: z.number().int().positive(),
      bytes: z.number().int().positive(),
      duration_ms: z.number().int().positive(),
    }),
    usage: z.strictObject({
      offered_events: z.number().int().nonnegative(),
      admitted_events: z.number().int().nonnegative(),
      transitions: z.number().int().nonnegative(),
      connections: z.number().int().nonnegative(),
      messages: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      last_at_ms: z.number().int().nonnegative(),
    }),
  }),
});

export type ReplayMachineRunInput = z.infer<typeof replayMachineRunInputSchema>;
export type ReplayMachineRunOutput = z.infer<
  typeof replayMachineRunOutputSchema
>;

type ReplayAction = ReplayMachine["transitions"][number]["actions"][number];

const redactAction = (
  runtime: ReplayMachineRuntime,
  action: ReplayAction,
): ReplayAction => {
  switch (action.type) {
    case "http_response":
      return {
        ...action,
        headers: Object.fromEntries(
          Object.entries(action.headers).map(([name, value]) => [
            name,
            runtime.redactField(value),
          ]),
        ),
        body: runtime.redactField(action.body),
      };
    case "websocket_send":
      return { ...action, data: runtime.redactField(action.data) };
    case "delay":
    case "disconnect":
      return action;
  }
};

/** Evaluate every supplied event in order without opening sockets or processes. */
export const runReplayMachine = (
  input: ReplayMachineRunInput,
): ReplayMachineRunOutput => {
  const runtime = new ReplayMachineRuntime(input.machine);
  const decisions: ReplayMachineRunOutput["decisions"] = [];
  const transitionJournal: ReplayMachineRunOutput["transition_journal"] = [];
  const usedTransitionIds = new Set<string>();

  for (const [eventSequence, event] of input.events.entries()) {
    const decision = runtime.dispatch(event);
    decisions.push({
      event_sequence: eventSequence,
      outcome: decision.outcome,
      transition_sequence: decision.transition?.sequence ?? null,
    });
    if (decision.outcome !== "matched") continue;
    usedTransitionIds.add(decision.transition.transition_id);
    const definition = input.machine.transitions.find(
      ({ id }) => id === decision.transition.transition_id,
    );
    if (definition === undefined)
      throw new TypeError("Replay runtime selected an unknown transition");
    transitionJournal.push({
      sequence: decision.transition.sequence,
      at_ms: decision.transition.at_ms,
      transition_id: decision.transition.transition_id,
      state_before: decision.transition.state_before,
      state_after: decision.transition.state_after,
      captured_aliases: definition.captures.map(({ variable, sensitive }) => ({
        name: variable,
        sensitive,
      })),
    });
  }

  const usage = runtime.usage;
  const transitionActions = input.machine.transitions
    .filter(({ id }) => usedTransitionIds.has(id))
    .map(({ id, actions }) => ({
      transition_id: id,
      actions: actions.map((action) => redactAction(runtime, action)),
    }));
  return replayMachineRunOutputSchema.parse({
    schema_version: 1,
    initial_state: input.machine.initial_state,
    final_state: runtime.state,
    terminal:
      input.machine.states.find(({ name }) => name === runtime.state)
        ?.terminal ?? false,
    decisions,
    transition_journal: transitionJournal,
    transition_actions: transitionActions,
    limits: {
      configured: {
        transitions: input.machine.max_transitions,
        ...input.machine.limits,
      },
      usage: {
        offered_events: input.events.length,
        admitted_events: usage.events,
        transitions: usage.transitions,
        connections: usage.connections,
        messages: usage.messages,
        bytes: usage.bytes,
        last_at_ms: usage.last_at_ms,
      },
    },
  });
};
