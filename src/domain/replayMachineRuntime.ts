import canonicalize from "canonicalize";

import type { ReplayMachine } from "./replayMachine.js";

type ReplayTransition = ReplayMachine["transitions"][number];
type ReplayValueSource = ReplayTransition["captures"][number]["value"];
interface TransitionRecordOptions {
  readonly sequence: number;
  readonly atMs: number;
  readonly stateBefore: string;
  readonly transition: ReplayTransition;
  readonly captures: readonly {
    readonly variable: string;
    readonly sensitive: boolean;
  }[];
}

/** One bounded inbound protocol event offered to a replay machine. */
export interface ReplayMachineEvent {
  readonly protocol: "http" | "websocket_connect" | "websocket_message";
  readonly connection: "not_applicable" | "initial" | "reconnect";
  readonly at_ms: number;
  readonly recorded_at_ms?: number;
  readonly method: string | null;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** Persistable transition journal entry containing aliases, never secrets. */
export interface ReplayTransitionRecord {
  readonly sequence: number;
  readonly at_ms: number;
  readonly transition_id: string;
  readonly state_before: string;
  readonly state_after: string;
  readonly sensitive_aliases: readonly string[];
}

/** Result of dispatching one event through a replay machine. */
export type ReplayMachineDecision =
  | {
      readonly outcome: "matched";
      readonly actions: ReplayTransition["actions"];
      readonly transition: ReplayTransitionRecord;
    }
  | {
      readonly outcome:
        | "unmatched"
        | "invalid_state"
        | "guard_failed"
        | "transition_exhausted"
        | "invalid_capture"
        | "unexpected_reconnect"
        | "limit_exhausted";
      readonly actions: readonly [];
      readonly transition: null;
    };

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const atPath = (
  value: unknown,
  path: readonly (string | number)[],
): unknown => {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, segment)
    )
      return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
};

const actionJsonBody = (transition: ReplayTransition): string | undefined => {
  for (const action of transition.actions)
    if (action.type === "http_response") return action.body;
    else if (action.type === "websocket_send") return action.data;
  return undefined;
};

const readValue = (
  source: ReplayValueSource,
  event: ReplayMachineEvent,
  transition: ReplayTransition,
): unknown => {
  switch (source.source) {
    case "request_header":
      return event.headers[source.name.toLowerCase()];
    case "request_json":
      return atPath(parseJson(event.body), source.path);
    case "websocket_json":
      return atPath(parseJson(event.body), source.path);
    case "action_json": {
      const body = actionJsonBody(transition);
      return body === undefined
        ? undefined
        : atPath(parseJson(body), source.path);
    }
  }
};

const triggerMatches = (
  transition: ReplayTransition,
  event: ReplayMachineEvent,
): boolean => {
  const trigger = transition.trigger;
  if (trigger.protocol !== event.protocol || trigger.path !== event.path)
    return false;
  if (
    "headers" in trigger &&
    Object.entries(trigger.headers).some(
      ([name, value]) => event.headers[name.toLowerCase()] !== value,
    )
  )
    return false;
  if (trigger.protocol === "http")
    return (
      trigger.method === event.method &&
      (trigger.body === null || trigger.body === event.body)
    );
  if (trigger.protocol === "websocket_message")
    return trigger.body === null || trigger.body === event.body;
  return true;
};

const isJsonCompatible = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonCompatible);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isJsonCompatible);
};

const replayValuesEqual = (left: unknown, right: unknown): boolean =>
  isJsonCompatible(left) &&
  isJsonCompatible(right) &&
  (Object.is(left, right) || canonicalize(left) === canonicalize(right));

const createTransitionRecord = ({
  sequence,
  atMs,
  stateBefore,
  transition,
  captures,
}: TransitionRecordOptions): ReplayTransitionRecord => ({
  sequence,
  at_ms: atMs,
  transition_id: transition.id,
  state_before: stateBefore,
  state_after: transition.to,
  sensitive_aliases: captures
    .filter(({ sensitive }) => sensitive)
    .map(({ variable }) => variable)
    .sort(),
});

/** Stateful evaluator for one validated replay-machine instance. */
export class ReplayMachineRuntime {
  readonly #variables = new Map<string, unknown>();
  readonly #sensitiveValues = new Map<string, Set<string>>();
  readonly #uses = new Map<string, number>();
  readonly #stateVisits = new Map<string, number>();
  readonly #timeline: ReplayTransitionRecord[] = [];
  #state: string;
  #connections = 0;
  #messages = 0;
  #bytes = 0;
  #lastAtMs = 0;

  constructor(readonly machine: ReplayMachine) {
    this.#state = machine.initial_state;
    this.#stateVisits.set(machine.initial_state, 1);
  }

  /** Current machine state after all accepted transitions. */
  get state(): string {
    return this.#state;
  }

  /** Ordered, secret-free transition records. */
  get timeline(): readonly ReplayTransitionRecord[] {
    return this.#timeline;
  }

  /** Replace captured secret values with stable aliases before persistence. */
  redact(value: string): string {
    let redacted = value;
    const secrets = [...this.#sensitiveValues]
      .flatMap(([variable, values]) =>
        [...values].map((secret) => ({ variable, secret })),
      )
      .sort(
        (left, right) =>
          right.secret.length - left.secret.length ||
          left.variable.localeCompare(right.variable),
      );
    for (const { variable, secret } of secrets)
      redacted = redacted.replaceAll(secret, `<secret:${variable}>`);
    return redacted;
  }

  /** Evaluate and, when admitted, commit one protocol event. */
  dispatch(event: ReplayMachineEvent): ReplayMachineDecision {
    const normalizedEvent = {
      ...event,
      headers: Object.fromEntries(
        Object.entries(event.headers).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      ),
    };
    if (!this.#admitEvent(normalizedEvent))
      return this.#refusal("limit_exhausted");
    const matching = this.machine.transitions
      .map((transition, declarationOrder) => ({
        transition,
        declarationOrder,
      }))
      .filter(({ transition }) => triggerMatches(transition, normalizedEvent));
    const eligible = matching
      .filter(({ transition }) => transition.from === this.#state)
      .sort(
        (left, right) =>
          left.transition.priority - right.transition.priority ||
          left.declarationOrder - right.declarationOrder,
      );
    if (eligible.length === 0)
      return this.#refusal(
        matching.length === 0
          ? "unmatched"
          : normalizedEvent.protocol === "websocket_connect" &&
              normalizedEvent.connection === "reconnect"
            ? "unexpected_reconnect"
            : "invalid_state",
      );
    const guarded = eligible.filter(({ transition }) =>
      transition.guards.every(
        (guard) =>
          this.#variables.has(guard.variable) &&
          replayValuesEqual(
            this.#variables.get(guard.variable),
            readValue(guard.value, normalizedEvent, transition),
          ),
      ),
    );
    if (guarded.length === 0) return this.#refusal("guard_failed");
    if (this.#timeline.length >= this.machine.max_transitions)
      return this.#refusal("transition_exhausted");
    const usable = guarded.find(
      ({ transition }) =>
        (this.#uses.get(transition.id) ?? 0) < transition.max_uses,
    );
    if (usable === undefined) return this.#refusal("transition_exhausted");
    const transition = usable.transition;
    const used = this.#uses.get(transition.id) ?? 0;
    const nextState = this.machine.states.find(
      ({ name }) => name === transition.to,
    );
    const nextVisits = (this.#stateVisits.get(transition.to) ?? 0) + 1;
    if (nextState === undefined || nextVisits > nextState.max_visits)
      return this.#refusal("limit_exhausted");
    const captures = transition.captures.map((capture) => ({
      ...capture,
      captured: readValue(capture.value, normalizedEvent, transition),
    }));
    if (
      captures.some(
        ({ captured, sensitive }) =>
          !isJsonCompatible(captured) ||
          (sensitive && typeof captured !== "string"),
      )
    )
      return this.#refusal("invalid_capture");
    for (const capture of captures) {
      this.#variables.set(capture.variable, capture.captured);
      if (capture.sensitive && typeof capture.captured === "string") {
        const values = this.#sensitiveValues.get(capture.variable) ?? new Set();
        if (capture.captured.length > 0) values.add(capture.captured);
        this.#sensitiveValues.set(capture.variable, values);
      }
    }
    const record = createTransitionRecord({
      sequence: this.#timeline.length,
      atMs: normalizedEvent.recorded_at_ms ?? normalizedEvent.at_ms,
      stateBefore: this.#state,
      transition,
      captures,
    });
    this.#uses.set(transition.id, used + 1);
    this.#stateVisits.set(transition.to, nextVisits);
    this.#state = transition.to;
    this.#timeline.push(record);
    return {
      outcome: "matched",
      actions: transition.actions,
      transition: record,
    };
  }

  #admitEvent(event: ReplayMachineEvent): boolean {
    const connections =
      this.#connections + (event.protocol === "websocket_connect" ? 1 : 0);
    const messages =
      this.#messages + (event.protocol === "websocket_message" ? 1 : 0);
    const bytes = this.#bytes + Buffer.byteLength(event.body);
    if (
      !Number.isSafeInteger(event.at_ms) ||
      event.at_ms < this.#lastAtMs ||
      event.at_ms > this.machine.limits.duration_ms ||
      connections > this.machine.limits.connections ||
      messages > this.machine.limits.messages ||
      bytes > this.machine.limits.bytes
    )
      return false;
    this.#connections = connections;
    this.#messages = messages;
    this.#bytes = bytes;
    this.#lastAtMs = event.at_ms;
    return true;
  }

  #refusal(
    outcome: Exclude<ReplayMachineDecision["outcome"], "matched">,
  ): ReplayMachineDecision {
    return { outcome, actions: [], transition: null };
  }
}
