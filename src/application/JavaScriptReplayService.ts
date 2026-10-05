import { z } from "zod";
import writeFileAtomic from "write-file-atomic";

import {
  controlledReplayInputSchema,
  replayExecutionResultSchema,
  controlledReplayOutputSchema,
  replayEvidenceSchema,
  type ControlledReplayExecutionInput,
  type ControlledReplayInput,
} from "../domain/javascriptReplay.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisProtocolError,
  ReplayPlanStaleError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import {
  digestBytes,
  prepareReplayPlan,
  type JavaScriptReplayConfiguration,
  type JavaScriptReplayHost,
  type JavaScriptReplayRunner,
} from "./JavaScriptReplayPlanning.js";

const OPERATION = "run_controlled_replay" as const;
const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

export interface JavaScriptReplayDependencies {
  readonly configuration: () => JavaScriptReplayConfiguration;
  readonly host: JavaScriptReplayHost;
  readonly runner: JavaScriptReplayRunner;
}

/** Plan or execute one content-bound extracted-module replay experiment. */
export const runControlledReplay = async (
  dependencies: JavaScriptReplayDependencies,
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<JsonValue, AnalysisError>> => {
  const parsed = controlledReplayInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(
        OPERATION,
        { cause: parsed.error },
        projectInputIssues(parsed.error.issues, rawInput),
      ),
    );
  return runControlledReplayValidated(dependencies, parsed.data, options);
};

/** Plan or execute replay input already parsed by a trusted adapter. */
export const runControlledReplayValidated = async (
  dependencies: JavaScriptReplayDependencies,
  input: ControlledReplayInput,
  options: ExecutionOptions = {},
): Promise<Result<JsonValue, AnalysisError>> => {
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(OPERATION));
  const configuration = dependencies.configuration();

  const prepared = await prepareValidatedReplay(
    dependencies,
    configuration,
    input,
    options.signal,
  );
  if (!prepared.ok) return prepared;
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(OPERATION));

  if (input.mode === "plan")
    return ok(
      asJson({
        phase: "plan",
        plan: prepared.value.publicPlan,
        source_evidence: [],
        evidence: null,
      }),
    );

  if (input.plan_digest !== prepared.value.publicPlan.plan_digest)
    return err(
      new ReplayPlanStaleError(
        input.plan_digest,
        prepared.value.publicPlan.plan_digest,
      ),
    );

  const exportContext = prepareReproducerExport(input);
  if (!exportContext.ok) return exportContext;

  const executed = await executeValidatedReplay({
    runner: dependencies.runner,
    configuration,
    prepared: prepared.value,
    exportContext: exportContext.value,
    options,
  });
  if (!executed.ok) return executed;

  try {
    return ok(
      buildReplayOutput(
        prepared.value,
        executed.value.executed,
        executed.value.sourceEvidence,
      ),
    );
  } catch (cause: unknown) {
    return err(
      new AnalysisProtocolError(
        cause instanceof z.ZodError
          ? "Controlled replay produced an invalid bounded result"
          : "Controlled replay could not establish or clean up its sandbox",
        { cause },
      ),
    );
  }
};

const prepareValidatedReplay = async (
  dependencies: JavaScriptReplayDependencies,
  configuration: JavaScriptReplayConfiguration,
  input: ControlledReplayInput,
  signal: AbortSignal | undefined,
): Promise<
  Result<Awaited<ReturnType<typeof prepareReplayPlan>>, AnalysisError>
> => {
  if (isAborted(signal)) return err(new AnalysisCancelledError(OPERATION));
  try {
    return ok(await prepareReplayPlan(input, configuration, dependencies.host));
  } catch (cause: unknown) {
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-javascript-replay",
        OPERATION,
        cause instanceof Error ? cause.message : "replay planning failed",
      ),
    );
  }
};

interface ReproducerExportContext {
  readonly path: string;
  readonly includeSources: boolean;
}

const prepareReproducerExport = (
  input: ControlledReplayExecutionInput,
): Result<ReproducerExportContext | undefined, AnalysisError> => {
  if (input.reproducer_export === undefined) return ok(undefined);
  return ok({
    path: input.reproducer_export.path,
    includeSources: input.reproducer_export.include_sources === true,
  });
};

interface ReplayExecutionContext {
  readonly runner: JavaScriptReplayRunner;
  readonly configuration: JavaScriptReplayConfiguration;
  readonly prepared: Awaited<ReturnType<typeof prepareReplayPlan>>;
  readonly exportContext: ReproducerExportContext | undefined;
  readonly options: ExecutionOptions;
}

const executeValidatedReplay = async (
  context: ReplayExecutionContext,
): Promise<
  Result<
    {
      readonly executed: z.infer<typeof replayExecutionResultSchema>;
      readonly sourceEvidence: ReturnType<typeof createReplayEvidence>[];
    },
    AnalysisError
  >
> => {
  const { runner, configuration, prepared, exportContext, options } = context;
  await options.progress?.report({
    phase: OPERATION,
    completed: 0,
    total: 1,
    message: "Starting the isolated replay worker",
  });
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(OPERATION));

  try {
    let executed = replayExecutionResultSchema.parse(
      await runner.execute(prepared, configuration, options.signal),
    );
    await options.progress?.report({
      phase: OPERATION,
      completed: 1,
      total: 1,
      message: "Controlled replay stopped and sandbox cleanup was observed",
      terminal: true,
    });
    if (executed.termination === "cancelled")
      return err(new AnalysisCancelledError(OPERATION));
    executed = await applyReproducerExport(executed, exportContext, prepared);
    const sourceEvidence = buildSourceEvidence(prepared, executed);
    return ok({ executed, sourceEvidence });
  } catch (cause: unknown) {
    return err(
      new AnalysisProtocolError(
        cause instanceof z.ZodError
          ? "Controlled replay produced an invalid bounded result"
          : "Controlled replay could not establish or clean up its sandbox",
        { cause },
      ),
    );
  }
};

const applyReproducerExport = async (
  executed: z.infer<typeof replayExecutionResultSchema>,
  exportContext: ReproducerExportContext | undefined,
  prepared: Awaited<ReturnType<typeof prepareReplayPlan>>,
): Promise<z.infer<typeof replayExecutionResultSchema>> => {
  if (exportContext === undefined || executed.cleanup.state !== "complete")
    return executed;

  const manifest = {
    plan: prepared.publicPlan,
    result: executed,
    sources: exportContext.includeSources
      ? {
          left: prepared.leftSources,
          ...(prepared.rightSources === undefined
            ? {}
            : { right: prepared.rightSources }),
        }
      : null,
  };
  const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  try {
    await writeFileAtomic(exportContext.path, encoded, {
      mode: 0o600,
    });
    return replayExecutionResultSchema.parse({
      ...executed,
      reproducer: {
        state: "written",
        path: exportContext.path,
        sha256: digestBytes(encoded),
      },
    });
  } catch (cause: unknown) {
    return replayExecutionResultSchema.parse({
      ...executed,
      limitations: [
        ...executed.limitations,
        "Replay completed, but the requested reproducer export failed.",
      ],
      reproducer: {
        state: "failed",
        path: exportContext.path,
        error:
          cause instanceof Error
            ? cause.message
            : "unknown reproducer export failure",
      },
    });
  }
};

const buildSourceEvidence = (
  prepared: Awaited<ReturnType<typeof prepareReplayPlan>>,
  executed: z.infer<typeof replayExecutionResultSchema>,
): ReturnType<typeof createReplayEvidence>[] => {
  const leftCount = prepared.publicPlan.cases.length;
  return [
    createReplayEvidence(
      prepared,
      executed,
      "left",
      executed.outcomes.slice(0, leftCount),
    ),
    ...(prepared.publicPlan.right === undefined
      ? []
      : [
          createReplayEvidence(
            prepared,
            executed,
            "right",
            executed.outcomes.slice(leftCount),
          ),
        ]),
  ];
};

const buildReplayOutput = (
  prepared: Awaited<ReturnType<typeof prepareReplayPlan>>,
  executed: z.infer<typeof replayExecutionResultSchema>,
  sourceEvidence: ReturnType<typeof createReplayEvidence>[],
): JsonValue => {
  const subject = prepared.publicPlan.left.modules[0];
  const evidence = createEvidence(
    subject === undefined
      ? undefined
      : {
          path: subject.canonical_path,
          sha256: subject.sha256,
          format: "javascript",
        },
    {
      id: "rea-javascript-replay",
      name: "REA isolated JavaScript replay",
      version: "1",
    },
    {
      predicateType: "javascript-controlled-replay",
      operation: OPERATION,
      parameters: {
        replay_plan: jsonValueSchema.parse(
          JSON.parse(JSON.stringify(prepared.publicPlan)),
        ),
      },
      result: jsonValueSchema.parse(JSON.parse(JSON.stringify(executed))),
      rawResult: jsonValueSchema.parse(
        JSON.parse(
          JSON.stringify({
            cases: prepared.publicPlan.cases,
            outcomes: executed.outcomes,
            stderr: executed.stderr,
          }),
        ),
      ),
      confidence: executed.comparison === undefined ? "observed" : "derived",
      authority: "controlled-replay",
      environment: {
        id: prepared.publicPlan.plan_digest,
        platform: process.platform,
        architecture: process.arch,
        isolation: "container",
      },
      limitations: executed.limitations,
      locations: prepared.publicPlan.left.modules.map((module) => ({
        kind: "artifact-path" as const,
        path: module.canonical_path,
      })),
      evidenceLinks: sourceEvidence.map(({ evidence_id: id }) => id),
    },
  );
  return asJson({
    phase: "execute",
    plan: null,
    source_evidence: sourceEvidence.map((item) =>
      replayEvidenceSchema.parse(item),
    ),
    evidence: replayEvidenceSchema.parse(evidence),
  });
};

const createReplayEvidence = (
  prepared: Awaited<ReturnType<typeof prepareReplayPlan>>,
  executed: z.infer<typeof replayExecutionResultSchema>,
  side: "left" | "right",
  outcomes: z.infer<typeof replayExecutionResultSchema>["outcomes"],
) => {
  const manifest =
    side === "left" ? prepared.publicPlan.left : prepared.publicPlan.right;
  const subject = manifest?.modules[0];
  const result = replayExecutionResultSchema.parse({
    ...executed,
    outcomes,
    comparison: undefined,
    reproducer: null,
  });
  return createEvidence(
    subject === undefined
      ? undefined
      : {
          path: subject.canonical_path,
          sha256: subject.sha256,
          format: "javascript",
        },
    {
      id: "rea-javascript-replay",
      name: "REA isolated JavaScript replay",
      version: "1",
    },
    {
      predicateType: "javascript-controlled-replay-observation",
      operation: OPERATION,
      parameters: {
        replay_plan: jsonValueSchema.parse(
          JSON.parse(JSON.stringify(prepared.publicPlan)),
        ),
        side,
      },
      result: jsonValueSchema.parse(JSON.parse(JSON.stringify(result))),
      rawResult: jsonValueSchema.parse(
        JSON.parse(
          JSON.stringify({ cases: prepared.publicPlan.cases, outcomes }),
        ),
      ),
      confidence: "observed",
      authority: "controlled-replay",
      environment: {
        id: prepared.publicPlan.plan_digest,
        platform: process.platform,
        architecture: process.arch,
        isolation: "container",
      },
      limitations: executed.limitations,
      locations: (manifest?.modules ?? []).map((module) => ({
        kind: "artifact-path" as const,
        path: module.canonical_path,
      })),
    },
  );
};

const asJson = (value: unknown): JsonValue => {
  const serialized: unknown = JSON.parse(
    JSON.stringify(controlledReplayOutputSchema.parse(value)),
  );
  return jsonValueSchema.parse(serialized);
};
