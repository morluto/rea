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
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { PermissionAuthority } from "./PermissionAuthority.js";
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
    return err(new AnalysisInputError(OPERATION, { cause: parsed.error }));
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
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(OPERATION));
  const request = permissionRequest(parsed.data, dependencies.policy);
  const authorized =
    parsed.data.mode === "plan"
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
  let prepared;
  try {
    prepared = await prepareReplayPlan(
      parsed.data,
      dependencies.policy,
      dependencies.host,
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
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(OPERATION));
  if (parsed.data.mode === "plan")
    return ok(
      asJson({
        phase: "plan",
        plan: prepared.publicPlan,
        source_evidence: [],
        evidence: null,
      }),
    );
  if (parsed.data.plan_digest !== prepared.publicPlan.plan_digest)
    return err(
      new ReplayPlanStaleError(
        parsed.data.plan_digest ?? "",
        prepared.publicPlan.plan_digest,
      ),
    );
  let canonicalExportPath: string | undefined;
  if (parsed.data.reproducer_export !== undefined) {
    if (parsed.data.reproducer_export.approved !== true)
      return err(new AnalysisInputError(`${OPERATION}:reproducer_export`));
    const exportAuthorized = await dependencies.authority.authorize(
      {
        capability: "evidence_write",
        roots: [parsed.data.reproducer_export.path],
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
    canonicalExportPath = exportAuthorized.value.request.roots[0];
    if (canonicalExportPath !== parsed.data.reproducer_export.path)
      return err(
        new AnalysisInputError(`${OPERATION}:reproducer_export:path`, {
          cause: new TypeError(
            `Use the canonical reproducer path: ${canonicalExportPath ?? "unavailable"}`,
          ),
        }),
      );
  }
  if (isAborted(options.signal))
    return err(new AnalysisCancelledError(OPERATION));
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
    if (
      parsed.data.reproducer_export !== undefined &&
      canonicalExportPath !== undefined &&
      executed.cleanup.state === "complete"
    ) {
      const manifest = {
        schema_version: 1,
        plan: prepared.publicPlan,
        result: executed,
        sources: parsed.data.reproducer_export.include_sources
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
        await writeFileAtomic(canonicalExportPath, encoded, {
          mode: 0o600,
        });
        executed = replayExecutionResultSchema.parse({
          ...executed,
          reproducer: {
            state: "written",
            path: canonicalExportPath,
            sha256: digestBytes(encoded),
          },
        });
      } catch (cause: unknown) {
        executed = replayExecutionResultSchema.parse({
          ...executed,
          limitations: [
            ...executed.limitations,
            "Replay completed, but the separately approved reproducer export failed.",
          ],
          reproducer: {
            state: "failed",
            path: canonicalExportPath,
            error:
              cause instanceof Error
                ? cause.message
                : "unknown reproducer export failure",
          },
        });
      }
    }
    const leftCount = prepared.publicPlan.cases.length;
    const sourceEvidence = [
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
    return ok(
      asJson({
        phase: "execute",
        plan: null,
        source_evidence: sourceEvidence.map((item) =>
          replayEvidenceSchema.parse(item),
        ),
        evidence: replayEvidenceSchema.parse(evidence),
      }),
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

const permissionRequest = (
  input: z.infer<typeof controlledReplayInputSchema>,
  policy: JavaScriptReplayPolicy,
) => ({
  capability: "javascript_replay" as const,
  roots: [...input.left.modules, ...(input.right?.modules ?? [])].map(
    ({ path }) => path,
  ),
  executables: [
    policy.nodePath,
    policy.bubblewrapPath,
    policy.systemdRunPath,
    policy.systemctlPath,
    policy.shellPath,
  ],
  environment_names: [],
  network: "none" as const,
  mount: true,
  operation_identity: `${OPERATION}:${input.plan_digest ?? "plan"}`,
});
