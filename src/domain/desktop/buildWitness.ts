import { z } from "zod";

import { jsonValueSchema } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import type { TaskCheckOutcome, TaskFileView } from "./appTaskChecks.js";
import type { ComputerAction } from "./computerActions.js";

/**
 * The witness of an exported task, in order: the seed must fail a check, the
 * edit pass every one, a near miss fail one again, and so must the seed that
 * `data/reset` restores.
 */
export const WITNESS_STAGES = [
  "seed",
  "after_edit",
  "near_miss",
  "after_reset",
] as const;
export type WitnessStage = (typeof WITNESS_STAGES)[number];

/** What a stage's checks must show for the witness to hold. */
export type WitnessExpectation = "some_fail" | "all_pass";

/**
 * What the witness reads of a computer's action log: how many actions it
 * logged, and the index of the last applied action of each kind, which hold
 * however many entries the log has dropped.
 */
export interface WitnessActionLog {
  readonly total: number;
  readonly lastApplied: Readonly<Partial<Record<ComputerAction, number>>>;
}

/** One stage's checks, with how many logged actions came before it. */
export type WitnessStageRecord = {
  readonly stage: WitnessStage;
  readonly actions_before: number;
  readonly checked_at: string;
  readonly expectation: WitnessExpectation;
  readonly held: boolean;
  readonly results: TaskCheckOutcome[];
};

const EXPECTATIONS: Readonly<Record<WitnessStage, WitnessExpectation>> = {
  seed: "some_fail",
  after_edit: "all_pass",
  near_miss: "some_fail",
  after_reset: "some_fail",
};

/** Actions that only look or wait, so they change no state. */
const OBSERVING = new Set(["screenshot", "wait"]);

export const stageExpectation = (stage: WitnessStage): WitnessExpectation =>
  EXPECTATIONS[stage];

/** Whether a stage's results show what the witness needs of it. */
export const stageHeld = (
  stage: WitnessStage,
  results: readonly Pick<TaskCheckOutcome, "passed">[],
): boolean =>
  EXPECTATIONS[stage] === "all_pass"
    ? results.length > 0 && results.every((result) => result.passed)
    : results.some((result) => !result.passed);

/** The index of the last applied action that changed the app's state, and whether it was a reset. */
const lastChange = (log: WitnessActionLog) => {
  const index = Math.max(
    -1,
    ...Object.entries(log.lastApplied).flatMap(([kind, at]) =>
      OBSERVING.has(kind) || at === undefined ? [] : [at],
    ),
  );
  return { index, reset: index >= 0 && log.lastApplied.reset === index };
};

/**
 * Whether `stage` may be checked now, given the stages already checked and
 * the action log; its value is where this stage's actions end. The edit and
 * the near miss each need an applied action on the app since the stage
 * before, and the check after reset needs the reset as the last change.
 */
export const admitWitnessStage = (
  stages: readonly WitnessStageRecord[],
  stage: WitnessStage,
  log: WitnessActionLog,
): Result<number, string> => {
  const expected = WITNESS_STAGES[stages.length];
  if (expected === undefined)
    return err(
      "This witness has ended; start a fresh computer from the bundle to witness again.",
    );
  if (stage !== expected)
    return err(
      `The witness checks ${WITNESS_STAGES.join(", ")} in that order; the next stage is ${expected}.`,
    );
  const from = stages.at(-1)?.actions_before ?? 0;
  const changed = lastChange(log);
  if ((stage === "after_edit" || stage === "near_miss") && changed.index < from)
    return err(
      `Before checking ${stage}, act on the app with act_on_build_computer: no click, drag, scroll, type or key was applied since ${stages.at(-1)?.stage ?? "the start"}.`,
    );
  if (stage === "after_reset" && (changed.index < from || !changed.reset))
    return err(
      "Before checking after_reset, reset the app with act_on_build_computer action reset, and change nothing after it.",
    );
  return ok(log.total);
};

const fileViewSchema = z.looseObject({
  format: z.string().nullable(),
  view: jsonValueSchema.nullable(),
  error: z.string().nullish(),
});
const statePartSchema = z.looseObject({
  kind: z.literal("data"),
  data: z.looseObject({ state: z.record(z.string(), fileViewSchema) }),
});

/**
 * The typed views an exported app's `data/get` returns beside its files,
 * keyed by home path: the shape the task checks read.
 */
export const appStateViews = (
  parts: readonly unknown[],
): Result<ReadonlyMap<string, TaskFileView>, string> => {
  for (const part of parts) {
    const parsed = statePartSchema.safeParse(part);
    if (parsed.success)
      return ok(
        new Map(
          Object.entries(parsed.data.data.state).map(([path, entry]) => [
            path,
            {
              format: entry.format,
              view: entry.view,
              error: entry.error ?? null,
            },
          ]),
        ),
      );
  }
  return err(
    "The app's data/get returned no state views; witness a bundle exported by REA, whose app serves them.",
  );
};
