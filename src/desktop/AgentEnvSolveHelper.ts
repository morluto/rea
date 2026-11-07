import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { readBoundedControlLines } from "../process/BoundedControlLines.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { agentEnvInterpreter } from "./AgentEnvComputerHelper.js";

const HELPER = fileURLToPath(
  new URL("../../bridge/agentenv/solve.py", import.meta.url),
);
const REPORT_BYTES = 256 * 1024;
const STDERR_BYTES = 16 * 1024;
/** The longest one solve may take, its deploy and teardown included, before REA stops it. */
const SOLVE_MS = 45 * 60_000;
/** How long a stopped solve has to tear its computer down. */
const STOP_MS = 120_000;
const POLL_MS = 1_000;

const reportSchema = z.union([
  z.strictObject({
    outcome: z.enum([
      "passed",
      "scored below 1",
      "unscored",
      "failed",
      "cancelled",
    ]),
    instance_id: z.string().nullable(),
    seconds: z.number().nonnegative(),
    checks: z.array(
      z.strictObject({
        id: z.string(),
        passed: z.boolean(),
        description: z.string(),
      }),
    ),
    turns: z.int().nonnegative().nullable(),
    usd: z.number().nonnegative().nullable(),
    agentenv: z.string().nullable(),
    error: z.string().nullable(),
  }),
  z.strictObject({ error: z.string() }),
]);

/** What the helper printed: how the solve ended, or why no solve ran. */
export type SolveReport = z.infer<typeof reportSchema>;

const parseReport = (line: string): SolveReport => {
  try {
    const parsed = reportSchema.safeParse(JSON.parse(line));
    if (parsed.success) return parsed.data;
  } catch {
    // Reported below as a line that is not a report.
  }
  return { error: "REA's solve helper wrote something other than its report" };
};

/**
 * One solve of a bundle's task in a fresh computer, through REA's helper run
 * with the agentenv runner's Python; the solver's model endpoint is the one
 * agentenv reads from the environment or its config. Cancelling it stops the
 * helper, which tears its computer down.
 */
export const runSolveHelper = async (options: {
  readonly bundle: string;
  readonly task: string;
  readonly model: string;
  readonly agent: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal: AbortSignal;
  readonly operation: string;
}): Promise<SolveReport> => {
  const { environment, signal } = options;
  const interpreter = await agentEnvInterpreter(environment, options.operation);
  const spawned = await spawnOwnedProviderProcess({
    command: interpreter,
    arguments: [
      HELPER,
      options.bundle,
      options.task,
      options.model,
      options.agent,
    ],
    runId: randomUUID(),
    expectedCommand: null,
    hostEnvironment: environment,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
    signal,
  });
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    {
      captureStdout: false,
      maxDiagnosticBytes: { stdout: 0, stderr: STDERR_BYTES },
      diagnosticRetention: "tail",
    },
  );
  let report: SolveReport | undefined;
  const reading = (async () => {
    const stdout = spawned.process.stdout;
    if (stdout === null) return;
    for await (const line of readBoundedControlLines(stdout, REPORT_BYTES))
      report ??= line.ok
        ? parseReport(line.value)
        : { error: "REA's solve helper's report is too long" };
  })();
  try {
    const deadline = Date.now() + SOLVE_MS;
    while (
      !signal.aborted &&
      Date.now() < deadline &&
      !(await supervisor.waitForExit(POLL_MS))
    );
    if (supervisor.observedExit() === undefined) {
      spawned.process.kill("SIGTERM");
      await supervisor.waitForExit(STOP_MS);
    }
    await reading.catch(() => undefined);
  } finally {
    await supervisor.stop();
  }
  signal.throwIfAborted();
  const exit = supervisor.observedExit();
  return (
    report ?? {
      error: `REA's solve helper ended (exit ${String(exit?.code ?? exit?.signal)}) without a report: ${supervisor.snapshot().stderr.text.slice(-2000)}`,
    }
  );
};
