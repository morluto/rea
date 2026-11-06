import type { ComputerAction } from "../../domain/desktop/computerActions.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { boundedUtf8Text } from "../../process/boundedUtf8Text.js";

/** Bytes the log keeps of each string in an action's arguments, such as type's text. */
export const LOGGED_TEXT_BYTES = 1024;
/** Items the log keeps of each list in an action's arguments, such as drag's path. */
export const LOGGED_LIST_ITEMS = 64;
/** The latest actions the log keeps, and the JSON bytes they may take together. */
export const LOGGED_ACTIONS = 256;
export const LOGGED_BYTES = 256 * 1024;

type Outcome = "pending" | "applied" | "refused" | "failed";

/** One forwarded action, in the order REA sent it, as the witness reads it. */
export interface BuildComputerAction {
  readonly index: number;
  readonly action: ComputerAction;
  readonly tool: string;
  /** The driver's arguments as sent, keys translated, each string and list cut to the log's allowance. */
  readonly arguments: Readonly<Record<string, JsonValue>>;
  /** The arguments cut in this entry; the driver received them whole. */
  readonly truncated_arguments?: readonly string[];
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: Outcome;
}

/** A value within the log's allowance, and whether it was cut. */
const bounded = (
  value: JsonValue,
): { readonly value: JsonValue; readonly cut: boolean } => {
  if (typeof value === "string") {
    const { text, truncated } = boundedUtf8Text(value, LOGGED_TEXT_BYTES);
    return { value: text, cut: truncated };
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, LOGGED_LIST_ITEMS).map(bounded);
    return {
      value: items.map((item) => item.value),
      cut: value.length > items.length || items.some((item) => item.cut),
    };
  }
  if (value === null || typeof value !== "object") return { value, cut: false };
  const fields = Object.entries(value).map(
    ([name, field]) => [name, bounded(field)] as const,
  );
  return {
    value: Object.fromEntries(
      fields.map(([name, field]) => [name, field.value]),
    ),
    cut: fields.some(([, field]) => field.cut),
  };
};

const jsonBytes = (entry: BuildComputerAction): number =>
  Buffer.byteLength(JSON.stringify(entry));

/**
 * A build computer's action log. It counts every action and keeps the index
 * of the last applied action of each kind, so rules over a whole session hold
 * however long it runs, and keeps the latest actions themselves within
 * `LOGGED_ACTIONS` and `LOGGED_BYTES`, dropping the oldest first.
 */
export class BuildComputerActionLog {
  readonly #kept: { entry: BuildComputerAction; bytes: number }[] = [];
  readonly #lastApplied: Partial<Record<ComputerAction, number>> = {};
  #total = 0;
  #bytes = 0;

  /** Every action logged, kept or not; the next one's index. */
  get total(): number {
    return this.#total;
  }

  /** How many of the earliest actions are no longer kept. */
  get dropped(): number {
    return this.#total - this.#kept.length;
  }

  /** The kept actions, oldest first, indexed on from `dropped`. */
  get entries(): readonly BuildComputerAction[] {
    return this.#kept.map(({ entry }) => entry);
  }

  /** The index of the last applied action of each kind, kept or not. */
  get lastApplied(): Readonly<Partial<Record<ComputerAction, number>>> {
    return { ...this.#lastApplied };
  }

  /** Log an action as it is sent, pending, and how to record how it ended. */
  begin(
    action: ComputerAction,
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
  ): {
    readonly index: number;
    readonly settle: (outcome: Exclude<Outcome, "pending">) => void;
  } {
    const index = this.#total;
    const fields = Object.entries(args).map(
      ([name, value]) => [name, bounded(value)] as const,
    );
    const truncated = fields.flatMap(([name, field]) =>
      field.cut ? [name] : [],
    );
    const entry: BuildComputerAction = {
      index,
      action,
      tool,
      arguments: Object.fromEntries(
        fields.map(([name, field]) => [name, field.value]),
      ),
      ...(truncated.length === 0 ? {} : { truncated_arguments: truncated }),
      started_at: new Date().toISOString(),
      ended_at: null,
      outcome: "pending",
    };
    this.#total += 1;
    this.#keep(this.#kept.length, entry);
    return {
      index,
      settle: (outcome) => {
        if (outcome === "applied")
          this.#lastApplied[action] = Math.max(
            index,
            this.#lastApplied[action] ?? index,
          );
        // An action dropped while pending leaves only its outcome above.
        const slot = index - this.dropped;
        if (this.#kept[slot] !== undefined)
          this.#keep(slot, {
            ...entry,
            outcome,
            ended_at: new Date().toISOString(),
          });
      },
    };
  }

  /** Put an entry in its slot, then drop the oldest until the rest fit the allowance. */
  #keep(slot: number, entry: BuildComputerAction): void {
    const bytes = jsonBytes(entry);
    this.#bytes += bytes - (this.#kept[slot]?.bytes ?? 0);
    this.#kept[slot] = { entry, bytes };
    while (this.#kept.length > LOGGED_ACTIONS || this.#bytes > LOGGED_BYTES)
      this.#bytes -= this.#kept.shift()?.bytes ?? 0;
  }
}

/** What later stages read of a computer's action log. */
export type ReadonlyActionLog = Pick<
  BuildComputerActionLog,
  "total" | "dropped" | "entries" | "lastApplied"
>;
