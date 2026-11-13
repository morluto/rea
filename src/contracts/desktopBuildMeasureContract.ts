import { portableBundleNameSchema } from "../domain/portableBundleName.js";
import { z } from "zod";

import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

const strings = z.array(z.string());
const band = z
  .enum(["in_band", "too_easy", "too_hard", "undecided"])
  .describe(
    "in_band: it passed 1 to 3 of 5; too_easy: 3 of 3 or 4 of 5; too_hard: 0 of 3; undecided: the measure stopped before deciding.",
  );
const solve = z.strictObject({
  outcome: z.enum([
    "passed",
    "scored below 1",
    "unscored",
    "failed",
    "cancelled",
  ]),
  turns: z.int().nonnegative().nullable(),
  usd: z.number().nonnegative().nullable(),
  seconds: z.number().nonnegative(),
  failed_checks: strings,
  instance_id: z.string().nullable(),
  error: z
    .string()
    .nullable()
    .describe(
      "The error agentenv reported for the run, such as why it failed to deploy, solve or verify; null when it reported none.",
    ),
});

/** The tool that runs a bundle's task in fresh computers and records how hard it is. */
export const MEASURE_BUILD_TASK_CONTRACT = {
  name: "measure_build_task",
  ...toolContractMetadata("measure_build_task"),
  kind: "application",
  description:
    "Measure how hard an exported bundle's task is for a model: run it in fresh agentenv computers on this host, each solve the bundle's own steps with the agent deployed as the solver on the model, 3 times, then 2 more unless they passed none or all, and keep it in the band when it passes 1 to 3 of 5. A solve that did not finish is run again, at most twice, and not counted. Before each solve REA stops if the largest cost so far would take the total past budget_usd; a solve's cost is known only when it ends, so the first always runs, and a solve that reports no cost stops the measure. The solver calls the model endpoint agentenv reads where REA starts: LITELLM_BASE_URL and LITELLM_API_KEY, or [model] in .agentenv/config.toml; REA holds no model client and never reads the key. It writes difficulty.json at the bundle's root, each measured task's record by name, and a Measured difficulty section in its README, and returns the record: the band, passes, finished solves (k), turns, cost, failures per check and each solve. Solves run one at a time and take minutes each; REA reports progress meanwhile.",
  inputSchema: z.strictObject({
    bundle: absoluteLocalPathStringSchema.describe(
      "The exported bundle's folder on this host.",
    ),
    task: portableBundleNameSchema.describe(
      "The task's name, as its tasks/<name>.json names it.",
    ),
    model: z
      .string()
      .min(1)
      .describe(
        "The model the solver runs on, such as anthropic/claude-sonnet-5-5.",
      ),
    agent: z
      .string()
      .min(1)
      .default("claude-code")
      .describe(
        "The agent the solver runs as; claude-code reports each solve's turns and cost.",
      ),
    budget_usd: z
      .number()
      .positive()
      .max(1000)
      .describe("The most the measure may spend on solves, in US dollars."),
  }),
  outputSchema: z.strictObject({
    bundle: z.string(),
    task: z.string(),
    model: z.string(),
    agent: z.string(),
    measured_at: z.string(),
    band,
    stopped: z
      .enum(["decided", "budget", "unfinished", "cost_unknown"])
      .describe(
        "decided: the band is known; budget: the next solve could pass budget_usd; unfinished: 3 solves did not finish; cost_unknown: a solve reported no cost.",
      ),
    k: z.int().nonnegative().describe("The solves that finished."),
    passes: z.int().nonnegative(),
    unfinished: z.int().nonnegative(),
    usd: z.number().nonnegative(),
    budget_usd: z.number().positive(),
    turns: z.array(z.int().nonnegative().nullable()),
    failures_per_check: z
      .record(z.string(), z.int().positive())
      .describe("How many finished solves failed each check."),
    solves: z.array(solve),
    task_sha256: z
      .string()
      .describe(
        "The SHA-256 of the task's steps file followed by its verifier, so a changed task shows the record is stale.",
      ),
    difficulty_file: z.string(),
  }),
  examples: [
    {
      title: "Measure a task with Sonnet within $8",
      input: {
        bundle: "/tmp/mousepad-bundle",
        task: "add-eggs",
        model: "anthropic/claude-sonnet-5-5",
        budget_usd: 8,
      },
    },
  ],
} as const satisfies ToolContract;
