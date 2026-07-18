import { z } from "zod";
import writeFileAtomic from "write-file-atomic";

import {
  controlledReplayInputSchema,
  replayExecutionResultSchema,
  controlledReplayOutputSchema,
  replayEvidenceSchema,
} from "../domain/javascriptReplay.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisProtocolError,
  PermissionRequiredError,
  ReplayPlanStaleError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence } from "../domain/evidence.js";
import { projectInputIssues } from "../domain/inputIssueProjection.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
import { replayPermissionRequest } from "./JavaScriptReplayPermission.js";
import {
  digestBytes,
  prepareReplayPlan,
  type JavaScriptReplayHost,
  type JavaScriptReplayPolicy,
  type JavaScriptReplayRunner,
} from "./JavaScriptReplayPlanning.js";

const OPERATION = "run_controlled_replay" as const;
const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

export interface JavaScriptReplayDependencies {
  readonly policy: JavaScriptReplayPolicy;
  readonly host: JavaScriptReplayHost;
  readonly runner: JavaScriptReplayRunner;
  readonly authority: PermissionAuthority | undefined;
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
  input: z.output<typeof controlledReplayInputSchema>,
  options: ExecutionOptions = {},
): Promise<Result<JsonValue, AnalysisError>> => {
  const authorized = await authorizeReplay(dependencies, input, options.signal);
  if (!authorized.ok) return authorized;

  const prepared = await prepareValidatedReplay(
    dependencies,
    input,
    options.signal,
  );
  if (!prepared.ok) return prepared;

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
        input.plan_digest ?? "",
        prepared.value.publicPlan.plan_digest,
      ),
    );

  const exportContext = await authorizeReproducerExport(
    dependencies.authority,
    input,
    prepared.value,
  );
  if (!exportContext.ok) return exportContext;

  const executed = await executeValidatedReplay(
    dependencies,
    prepared.value,
    exportContext.value,
    options,
  );
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

const authorizeReplay = async (
  dependencies: JavaScriptReplayDependencies,
  input: z.output<typeof controlledReplayInputSchema>,
  signal: AbortSignal | undefined,
): Promise<Result<true, AnalysisError>> => {
  if (!dependencies.policy.enabled)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-javascript-replay",
        OPERATION,
        "controlled replay is disabled; configure exact roots and executables before enabling it",
      ),
    );
  if (dependencies.authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-javascript-replay",
        OPERATION,
        "JavaScript replay permission policy is not configured",
      ),
    );
  if (isAborted(signal)) return err(new AnalysisCancelledError(OPERATION));

  const request = replayPermissionRequest(input, dependencies.policy);
  const authorized =
    input.mode === "plan"
      ? await dependencies.authority.explain(request, "read")
      : await dependencies.authority.authorize(request, "read");
  if (!authorized.ok)
    return err(
      authorized.error instanceof PermissionRequiredError
        ? authorized.error
        : new AnalysisProtocolError(authorized.error.message, {
            cause: authorized.error,
          }),
    );
  return ok(true);
};

const prepareValidatedReplay = async (
  dependencies: JavaScriptReplayDependencies,
  input: z.output<typeof controlledReplayInputSchema>,
  signal: AbortSignal | undefined,
): Promise<
  Result<Awaited<ReturnType<typeof prepareReplayPlan>>, AnalysisError>
> => {
  if (isAborted(signal)) return err(new AnalysisCancelledError(OPERATION));
  try {
    return ok(
      await prepareReplayPlan(input, dependencies.policy, dependencies.host),
    );
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

const authorizeReproducerExport = async (
  authority: PermissionAuthority | undefined,
  input: z.output<typeof controlledReplayInputSchema>,
  prepared: Awaited<ReturnType<typeof prepareReplayPlan>>,
): Promise<Result<ReproducerExportContext | undefined, AnalysisError>> => {
  if (input.reproducer_export === undefined) return ok(undefined);
  if (input.reproducer_export.approved !== true)
    return err(new AnalysisInputError(`${OPERATION}:reproducer_export`));
  if (authority === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-javascript-replay",
        OPERATION,
        "JavaScript replay permission policy is not configured",
      ),
    );
  const exportAuthorized = await authority.authorize(
    {
      capability: "evidence_write",
      roots: [input.reproducer_export.path],
      executables: [],
      environment_names: [],
      network: "none",
      mount: false,
      operation_identity: `${OPERATION}:reproducer:${prepared.publicPlan.plan_digest}`,
    },
    "write",
  );
  if (!exportAuthorized.ok)
    return err(
      exportAuthorized.error instanceof PermissionRequiredError
        ? exportAuthorized.error
        : new AnalysisProtocolError(exportAuthorized.error.message, {
            cause: exportAuthorized.error,
          }),
    );
  const canonicalExportPath = exportAuthorized.value.request.roots[0];
  if (canonicalExportPath !== input.reproducer_export.path)
    return err(
      new AnalysisInputError(`${OPERATION}:reproducer_export:path`, {
        cause: new TypeError(
          `Use the canonical reproducer path: ${canonicalExportPath ?? "unavailable"}`,
        ),
      }),
    );
  return ok({
    path: canonicalExportPath,
    includeSources: input.reproducer_export.include_sources === true,
  });
};

const executeValidatedReplay = async (
  dependencies: JavaScriptReplayDependencies,
  prepared: Awaited<ReturnType<typeof prepareReplayPlan>>,
  exportContext: ReproducerExportContext | undefined,
  options: ExecutionOptions,
): Promise<
  Result<
    {
      readonly executed: z.infer<typeof replayExecutionResultSchema>;
      readonly sourceEvidence: ReturnType<typeof createReplayEvidence>[];
    },
    AnalysisError
  >
> => {
  await options.progress?.report({
    phase: OPERATION,
    completed: 0,
    total: 1,
    message: "Admitting approved modules into the isolated replay worker",
  });
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(OPERATION));

  try {
    let executed = replayExecutionResultSchema.parse(
      await dependencies.runner.execute(
        prepared,
        dependencies.policy,
        options.signal,
      ),
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
    schema_version: 1,
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
        "Replay completed, but the separately approved reproducer export failed.",
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

const asJson = (value: unknown): JsonValue =>
  jsonValueSchema.parse(
    JSON.parse(
      JSON.stringify(controlledReplayOutputSchema.parse(value)),
    ) as unknown,
  );
