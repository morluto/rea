/** How one solve ended, as agentenv reports a run: only `passed` and `scored below 1` finished. */
export type SolveOutcome =
  | "passed"
  | "scored below 1"
  | "unscored"
  | "failed"
  | "cancelled";

/** One solve of a task in a fresh computer. */
export type SolveRecord = {
  readonly outcome: SolveOutcome;
  readonly turns: number | null;
  readonly usd: number | null;
  readonly seconds: number;
  /** The checks that failed, for a solve that finished. */
  readonly failed_checks: string[];
  readonly instance_id: string | null;
};

/** Completed paid solves retained when measurement stops before publication. */
export interface PartialTaskMeasurement {
  readonly kind: "partial-task-measurement";
  readonly bundle: string;
  readonly task: string;
  readonly solves: readonly SolveRecord[];
}

/** Where the finished solves place a task: kept in the band, or outside it either way. */
export type Band = "in_band" | "too_easy" | "too_hard" | "undecided";

/** Why the measure stopped asking for solves. */
export type StopReason = "decided" | "budget" | "unfinished" | "cost_unknown";

/** Solves asked first; a task that passes none or all of them is decided. */
const FIRST_SOLVES = 3;
/** Solves in all for a task the first ones leave undecided. */
const ALL_SOLVES = 5;
/** The most passes of all the solves a task in the band has. */
const MOST_BAND_PASSES = 3;
/** Solves that did not finish, run again, before the measure stops. */
const MAX_UNFINISHED = 2;

const finished = (solve: SolveRecord): boolean =>
  solve.outcome === "passed" || solve.outcome === "scored below 1";

const counts = (solves: readonly SolveRecord[]) => {
  const done = solves.filter(finished);
  return {
    done: done.length,
    passes: done.filter((solve) => solve.outcome === "passed").length,
  };
};

/** The band the finished solves place the task in: 0 or 3 of 3 decide it, else 1 to 3 of 5 keep it. */
export const bandOf = (solves: readonly SolveRecord[]): Band => {
  const { done, passes } = counts(solves);
  if (done >= ALL_SOLVES)
    return passes <= MOST_BAND_PASSES ? "in_band" : "too_easy";
  if (done >= FIRST_SOLVES && passes === 0) return "too_hard";
  if (done >= FIRST_SOLVES && passes === done) return "too_easy";
  return "undecided";
};

/** The total cost of the solves, unknown costs as none. */
const spent = (solves: readonly SolveRecord[]): number =>
  solves.reduce((total, solve) => total + (solve.usd ?? 0), 0);

/**
 * Whether to run another solve: not once the band is decided, after too many
 * unfinished solves, after a solve of unknown cost, or when the largest cost
 * so far would take the total past the budget.
 */
export const nextSolve = (
  solves: readonly SolveRecord[],
  budgetUsd: number,
):
  | { readonly next: true }
  | { readonly next: false; readonly stopped: StopReason } => {
  if (bandOf(solves) !== "undecided")
    return { next: false, stopped: "decided" };
  if (solves.filter((solve) => !finished(solve)).length > MAX_UNFINISHED)
    return { next: false, stopped: "unfinished" };
  if (solves.some((solve) => solve.usd === null))
    return { next: false, stopped: "cost_unknown" };
  const largest = Math.max(0, ...solves.map((solve) => solve.usd ?? 0));
  return spent(solves) + largest > budgetUsd
    ? { next: false, stopped: "budget" }
    : { next: true };
};

/** What a bundle records of one task's measure in `difficulty.json`. */
export type DifficultyRecord = {
  readonly model: string;
  readonly agent: string;
  readonly measured_at: string;
  readonly band: Band;
  readonly stopped: StopReason;
  /** Finished solves, which the band counts. */
  readonly k: number;
  readonly passes: number;
  readonly unfinished: number;
  readonly usd: number;
  readonly budget_usd: number;
  /** Each finished solve's turns, in order. */
  readonly turns: (number | null)[];
  readonly failures_per_check: Record<string, number>;
  readonly solves: SolveRecord[];
  /** The SHA-256 of the task's steps file followed by its verifier, so a changed task shows the record is stale. */
  readonly task_sha256: string;
  readonly versions: { readonly rea: string; readonly agentenv: string | null };
};

const cents = (usd: number): number => Math.round(usd * 1e6) / 1e6;

export const difficultyRecord = (input: {
  readonly model: string;
  readonly agent: string;
  readonly solves: readonly SolveRecord[];
  readonly budgetUsd: number;
  readonly stopped: StopReason;
  readonly taskSha256: string;
  readonly versions: DifficultyRecord["versions"];
  readonly measuredAt: string;
}): DifficultyRecord => {
  const done = input.solves.filter(finished);
  // A Map, so a check named like an object's own member, such as constructor, counts as any other.
  const failures = new Map<string, number>();
  for (const solve of done)
    for (const check of solve.failed_checks)
      failures.set(check, (failures.get(check) ?? 0) + 1);
  return {
    model: input.model,
    agent: input.agent,
    measured_at: input.measuredAt,
    band: bandOf(input.solves),
    stopped: input.stopped,
    k: done.length,
    passes: counts(input.solves).passes,
    unfinished: input.solves.length - done.length,
    usd: cents(spent(input.solves)),
    budget_usd: input.budgetUsd,
    turns: done.map((solve) => solve.turns),
    failures_per_check: Object.fromEntries(failures),
    solves: [...input.solves],
    task_sha256: input.taskSha256,
    versions: input.versions,
  };
};

const BAND_WORDS: Readonly<Record<Band, string>> = {
  in_band: "in the band",
  too_easy: "too easy",
  too_hard: "too hard",
  undecided: "undecided",
};

const DIFFICULTY_HEADING = "## Measured difficulty";

/** What the README names of a task's record. */
export type DifficultySummary = Pick<
  DifficultyRecord,
  "model" | "passes" | "k" | "band" | "usd"
>;

/** The README section naming each measured task's model, passes, band and cost. */
export const difficultySection = (
  records: Readonly<Record<string, DifficultySummary>>,
): string =>
  `${DIFFICULTY_HEADING}

\`difficulty.json\` records each task's solves in fresh computers, by REA's \`measure_build_task\`: 3 solves, 2 more
unless they pass none or all, and a task is in the band when it passes 1 to 3 of 5.

${Object.entries(records)
  .map(
    ([name, record]) =>
      `- \`${name}\`: ${record.model} passed ${String(record.passes)} of ${String(record.k)}, ${BAND_WORDS[record.band]}, $${record.usd.toFixed(2)} in all.`,
  )
  .join("\n")}
`;

/** The README with its measured-difficulty section replaced, or added at the end. */
export const withDifficultySection = (
  readme: string,
  section: string,
): string => {
  const start = readme.indexOf(`\n${DIFFICULTY_HEADING}\n`);
  if (start === -1) return `${readme.replace(/\n*$/u, "\n")}\n${section}`;
  const next = readme.indexOf("\n## ", start + 1);
  return `${readme.slice(0, start + 1)}${section}${next === -1 ? "" : readme.slice(next)}`;
};
