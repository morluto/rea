import { createHash } from "node:crypto";

import { z } from "zod";

import {
  nodeCharacterizationExecutionInputSchema,
  nodeCharacterizationExecutionOutputSchema,
  nodeCharacterizationPreparationInputSchema,
  nodeCharacterizationPreparationOutputSchema,
  type NodeCharacterizationPreparationInput,
} from "../domain/nodeRuntimeCharacterization.js";
import {
  AnalysisInputError,
  AnalysisProtocolError,
  ReplayPlanStaleError,
  type AnalysisError,
} from "../domain/errors.js";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { controlledReplayOutputSchema } from "../domain/javascriptReplay.js";
import type { ReplayPlan } from "../domain/javascriptReplay.js";
import type { JavaScriptExportInstrumentation } from "../domain/javascriptExportInstrumentation.js";
import {
  createRuntimeCharacterizationPlan,
  type RuntimeCharacterizationPlan,
} from "../domain/runtimeCharacterization.js";
import { err, ok, type Result } from "../domain/result.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import type { ExecutionOptions } from "./AnalysisProvider.js";
import { InstrumentedJavaScriptReplayHost } from "./InstrumentedJavaScriptReplayHost.js";
import {
  runControlledReplayValidated,
  type JavaScriptReplayDependencies,
} from "./JavaScriptReplayService.js";

const PREPARE_OPERATION = "prepare_node_characterization" as const;
const EXECUTE_OPERATION = "execute_node_characterization" as const;
const PROVIDER = {
  id: "rea-node-characterization",
  name: "REA Node runtime characterization",
  version: "1",
} as const;

/** Prepare exact Node/JavaScript characterization without executing target code. */
export const prepareNodeCharacterization = async (
  dependencies: JavaScriptReplayDependencies,
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<JsonValue, AnalysisError>> => {
  const parsed = nodeCharacterizationPreparationInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(PREPARE_OPERATION, { cause: parsed.error }),
    );
  const prepared = await prepareValidated(dependencies, parsed.data, options);
  return prepared.ok
    ? ok(
        jsonValueSchema.parse(
          nodeCharacterizationPreparationOutputSchema.parse(prepared.value),
        ),
      )
    : prepared;
};

/** Execute only a freshly recomputed and separately approved characterization plan. */
export const executeNodeCharacterization = async (
  dependencies: JavaScriptReplayDependencies,
  rawInput: unknown,
  options: ExecutionOptions = {},
): Promise<Result<JsonValue, AnalysisError>> => {
  const parsed = nodeCharacterizationExecutionInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      new AnalysisInputError(EXECUTE_OPERATION, { cause: parsed.error }),
    );
  const prepared = await prepareValidated(
    dependencies,
    parsed.data.preparation,
    options,
  );
  if (!prepared.ok) return prepared;
  if (prepared.value.plan.plan_sha256 !== parsed.data.approved_plan_sha256)
    return err(
      new ReplayPlanStaleError(
        parsed.data.approved_plan_sha256,
        prepared.value.plan.plan_sha256,
      ),
    );
  const plannedReplay = controlledReplayOutputSchema.parse(
    prepared.value.replay,
  );
  if (plannedReplay.phase !== "plan" || plannedReplay.plan === null)
    return err(
      new AnalysisProtocolError(
        "Node characterization preparation did not produce a replay plan",
      ),
    );
  const host = new InstrumentedJavaScriptReplayHost(
    dependencies.host,
    parsed.data.preparation.instrumentation,
  );
  const executed = await runControlledReplayValidated(
    { ...dependencies, host },
    {
      ...parsed.data.preparation.replay,
      mode: "execute",
      approved: true,
      plan_digest: plannedReplay.plan.plan_digest,
    },
    options,
  );
  if (!executed.ok) return executed;
  if (host.instrumentation === null)
    return err(
      new AnalysisProtocolError(
        "Node characterization execution omitted instrumentation evidence",
      ),
    );
  return ok(
    jsonValueSchema.parse(
      nodeCharacterizationExecutionOutputSchema.parse({
        schema_version: 1,
        phase: "execution",
        plan: prepared.value.plan,
        transformation: host.instrumentation.manifest,
        transformation_evidence: prepared.value.transformation_evidence,
        evidence: createCharacterizationEvidence(
          prepared.value,
          controlledReplayOutputSchema.parse(executed.value),
        ),
        replay: controlledReplayOutputSchema.parse(executed.value),
      }),
    ),
  );
};

const prepareValidated = async (
  dependencies: JavaScriptReplayDependencies,
  input: NodeCharacterizationPreparationInput,
  options: ExecutionOptions,
): Promise<
  Result<
    {
      readonly schema_version: 1;
      readonly phase: "preparation";
      readonly plan: RuntimeCharacterizationPlan;
      readonly transformation: NonNullable<
        InstrumentedJavaScriptReplayHost["instrumentation"]
      >["manifest"];
      readonly transformation_evidence: Evidence;
      readonly replay: z.output<typeof controlledReplayOutputSchema>;
    },
    AnalysisError
  >
> => {
  const host = new InstrumentedJavaScriptReplayHost(
    dependencies.host,
    input.instrumentation,
  );
  const replay = await runControlledReplayValidated(
    { ...dependencies, host },
    input.replay,
    options,
  );
  if (!replay.ok) return replay;
  const output = controlledReplayOutputSchema.parse(replay.value);
  if (
    output.phase !== "plan" ||
    output.plan === null ||
    host.instrumentation === null
  )
    return err(
      new AnalysisProtocolError(
        "Node characterization preparation omitted committed plan evidence",
      ),
    );
  const module = output.plan.left.modules.find(
    ({ alias }) => alias === input.selected_alias,
  );
  if (module === undefined)
    return err(
      new AnalysisProtocolError(
        "Node characterization replay plan omitted selected module",
      ),
    );
  const plan = createCharacterizationPlan(
    input,
    host.instrumentation,
    output.plan,
  );
  return ok({
    schema_version: 1,
    phase: "preparation",
    plan,
    transformation: host.instrumentation.manifest,
    transformation_evidence: createTransformationEvidence(
      input,
      host.instrumentation,
    ),
    replay: output,
  });
};

const createTransformationEvidence = (
  input: NodeCharacterizationPreparationInput,
  instrumentation: JavaScriptExportInstrumentation,
): Evidence =>
  createEvidence(
    {
      path: input.instrumentation.artifact_path,
      sha256: input.instrumentation.artifact_sha256,
      format: "javascript-bundle",
    },
    PROVIDER,
    {
      predicateType: "rea.javascript-export-transformation/v1",
      operation: PREPARE_OPERATION,
      parameters: {
        selected_alias: input.selected_alias,
        selected_sha256: input.instrumentation.selection.selected_sha256,
      },
      result: jsonValueSchema.parse(instrumentation.manifest),
      confidence: "derived",
      authority: "shipped-artifact",
      locations: [
        {
          kind: "file-offset-range",
          start: input.instrumentation.selection.byte_start,
          end: input.instrumentation.selection.byte_end,
        },
      ],
      limitations: [
        "The transformation is deterministic derived evidence; execution authority is established only by a separately approved characterization run.",
      ],
    },
  );

const createCharacterizationEvidence = (
  prepared: {
    readonly plan: RuntimeCharacterizationPlan;
    readonly transformation_evidence: Evidence;
  },
  replay: z.output<typeof controlledReplayOutputSchema>,
): Evidence => {
  if (replay.phase !== "execute" || replay.evidence === null)
    throw new AnalysisProtocolError(
      "Node characterization execution omitted replay Evidence",
    );
  return createEvidence(
    {
      path: prepared.plan.artifact.path,
      sha256: prepared.plan.artifact.sha256,
      format: "javascript-bundle",
    },
    PROVIDER,
    {
      predicateType: "rea.runtime-characterization/v1",
      operation: EXECUTE_OPERATION,
      parameters: {
        plan_sha256: prepared.plan.plan_sha256,
        replay_evidence_id: replay.evidence.evidence_id,
      },
      result: jsonValueSchema.parse({
        plan: prepared.plan,
        transformation_evidence_id:
          prepared.transformation_evidence.evidence_id,
        replay_evidence_id: replay.evidence.evidence_id,
        execution: replay.evidence.normalized_result,
      }),
      confidence: "observed",
      authority: "controlled-replay",
      environment: replay.evidence.environment,
      limitations: [
        "This Evidence proves only the finite approved characterization plan and transformed controlled-replay authority, not unmodified shipped-runtime equivalence.",
        ...replay.evidence.limitations,
      ],
      evidenceLinks: [
        prepared.transformation_evidence.evidence_id,
        replay.evidence.evidence_id,
      ],
    },
  );
};

const createCharacterizationPlan = (
  input: NodeCharacterizationPreparationInput,
  instrumentation: JavaScriptExportInstrumentation,
  replayPlan: ReplayPlan,
): RuntimeCharacterizationPlan =>
  createRuntimeCharacterizationPlan({
    schema_version: 1,
    preparation_sha256: digestPreparation(
      instrumentation.manifest.instrumented_sha256,
      replayPlan.plan_digest,
    ),
    artifact: {
      path: input.instrumentation.artifact_path,
      sha256: input.instrumentation.artifact_sha256,
      byte_length: instrumentation.manifest.original_byte_length,
    },
    runtime: {
      family: "ecmascript",
      provider_id: "node-javascript",
      executable_path: replayPlan.runtime.executable.path,
      executable_sha256: replayPlan.runtime.executable.sha256,
      version: replayPlan.runtime.executable.version,
      profile_sha256: replayPlan.policy_sha256,
    },
    callable: {
      callable_id: `callable/${input.instrumentation.selection.selected_sha256}`,
      module_id: stableModuleId(input.selected_alias),
      export_name: input.instrumentation.selection.export_name,
      semantic_evidence_id: null,
      selector_sha256: input.instrumentation.selection.selected_sha256,
    },
    working_directory: "/work",
    isolated_home: "/work",
    expected_effect: input.expected_effect,
    allowed_boundaries: [],
    limits: {
      max_calls: replayPlan.cases.length,
      max_processes: 0,
      max_files: 0,
      max_bytes: replayPlan.limits.output_bytes,
      max_handles: replayPlan.limits.tasks,
      timeout_ms: replayPlan.limits.wall_time_ms,
      idle_timeout_ms: replayPlan.limits.wall_time_ms,
    },
    determinism: {
      clock: "fixed",
      randomness: "seeded",
      identifiers: "deterministic",
      seed: replayPlan.determinism.random_seed,
    },
    authority: {
      preparation_approved: true,
      execution_approved: false,
      network: "none",
      provider_owned_process_only: true,
    },
  });

const digestPreparation = (
  instrumentedSha256: string,
  replayPlanDigest: string,
): string =>
  createHash("sha256")
    .update(
      `rea.node-characterization-preparation/v1\0${instrumentedSha256}\0${replayPlanDigest}`,
    )
    .digest("hex");

const stableModuleId = (alias: string): string =>
  `module/${createHash("sha256").update(alias).digest("hex")}`;
