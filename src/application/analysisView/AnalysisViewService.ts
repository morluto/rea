import { setImmediate } from "node:timers/promises";
import { dispatchQueuedInterrupts } from "../../process/queuedInterrupts.js";
import { readImmutableEvidenceBundle } from "../EvidenceBundleFiles.js";
import { INSPECT_ANALYSIS_VIEW_OPERATION } from "../../domain/analysisView/analysisViewErrors.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";

import { ANALYSIS_VIEW_PROVIDER } from "../../domain/investigationProviders.js";
import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import { resolveEvidenceInput } from "../EvidenceInputResolver.js";
import type { EvidenceWriter } from "../investigation/InvestigationRecordPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { safeParseEvidence } from "../../domain/evidenceValidation.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  inspectAnalysisViewInputSchema,
  projectAnalysisView,
  type AnalysisViewResult,
  type AnalysisViewRequest,
  type InspectAnalysisViewInput,
} from "../../domain/analysisView/analysisView.js";
import {
  immutableJsonSnapshotMember,
  isImmutableJsonSnapshot,
} from "../../domain/immutableJson.js";
import { err, ok, type Result } from "../../domain/result.js";
import { WebNetworkApiSurfaceAccumulator } from "../../domain/analysisView/WebNetworkApiSurfaceAccumulator.js";
import { EnvironmentManifestAccumulator } from "../../domain/analysisView/EnvironmentManifestAccumulator.js";
import { EnvironmentStateAccumulator } from "../../domain/analysisView/EnvironmentStateAccumulator.js";
import { admitAnalysisViewData } from "../../domain/analysisView/analysisViewDataAdmission.js";
import {
  readEvidenceFileSource,
  type EvidenceFileReadOptions,
} from "./evidenceFileSource.js";

/** A parsed request whose source can be projected without filesystem access. */
export interface ReadyAnalysisViewInput {
  readonly source: Exclude<
    InspectAnalysisViewInput["source"],
    { kind: "evidence-file" }
  >;
  readonly view: AnalysisViewRequest;
}

/** Source acquisition controls shared by CLI and MCP; bundles are selected by the CLI. */
export interface AnalysisViewReadOptions extends EvidenceFileReadOptions {
  readonly evidenceBundlePath?: string;
}

/** Validate one view request, resolve its selected source, then project completed Evidence. */
export const inspectAnalysisView = async (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: AnalysisViewReadOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const parsed = inspectAnalysisViewInputSchema.safeParse(rawInput);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        INSPECT_ANALYSIS_VIEW_OPERATION,
        parsed.error.issues,
        rawInput,
        { cause: parsed.error },
      ),
    );
  if (options.evidenceBundlePath !== undefined)
    return inspectBundleView(parsed.data, options.evidenceBundlePath, options);
  const source = parsed.data.source;
  if (source.kind === "evidence-file")
    return inspectFileView({ ...parsed.data, source }, lookup, options);
  return inspectAnalysisViewValidated({ ...parsed.data, source }, lookup);
};

/**
 * Read and authenticate an Evidence-file source, then project it as retained
 * Evidence: its strings are bounded by the file reader rather than charged as
 * inline input.
 */
const inspectFileView = async (
  input: InspectAnalysisViewInput & {
    readonly source: Extract<
      InspectAnalysisViewInput["source"],
      { kind: "evidence-file" }
    >;
  },
  lookup?: EvidenceLookup,
  options: EvidenceFileReadOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  const loaded = await readEvidenceFileSource(
    input.source.path,
    options,
    input.source.evidence_id,
  );
  // Authentication and projection are synchronous; yield so a pending abort is dispatched before each check.
  const cancelled = async (): Promise<boolean> => {
    await setImmediate();
    return options.signal?.aborted === true;
  };
  // A request cancelled during authentication reports cancellation, even when authentication failed.
  if (await cancelled())
    return err(
      new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION, {
        cause: options.signal?.reason,
      }),
    );
  if (!loaded.ok) return loaded;
  const id = loaded.value.evidence_id;
  const projected = inspectAnalysisViewValidated(
    { ...input, source: { kind: "retained-evidence", evidence_id: id } },
    (evidenceId) => (evidenceId === id ? loaded.value : lookup?.(evidenceId)),
  );
  // A request cancelled during projection delivers and records nothing.
  if (await cancelled())
    return err(
      new AnalysisCancelledError(INSPECT_ANALYSIS_VIEW_OPERATION, {
        cause: options.signal?.reason,
      }),
    );
  return projected;
};

/** Resolve the caller's exact retained parent from an authenticated portable bundle. */
const inspectBundleView = async (
  input: InspectAnalysisViewInput,
  bundlePath: string,
  { resources, signal }: EvidenceFileReadOptions,
): Promise<Result<Evidence, AnalysisError>> => {
  if (input.source.kind !== "retained-evidence")
    return err(
      new AnalysisInputError("inspect_analysis_view", undefined, [
        {
          path: ["source", "kind"],
          reason: "invalid_value",
          message:
            "--evidence-bundle requires a retained-evidence source with the exact parent evidence_id; inline Evidence already supplies its source",
        },
      ]),
    );
  const loaded = await readImmutableEvidenceBundle(
    bundlePath,
    signal,
    resources,
    "inspect_analysis_view",
  );
  // Authentication and projection are synchronous; dispatch queued interrupts before accepting either result.
  await dispatchQueuedInterrupts();
  if (!loaded.ok) return loaded;
  if (signal?.aborted)
    return err(
      new AnalysisCancelledError("inspect_analysis_view", {
        cause: signal.reason,
      }),
    );
  const projected = inspectAnalysisViewValidated(
    { source: input.source, view: input.view },
    (id) => loaded.value.records.find((record) => record.evidence_id === id),
  );
  await dispatchQueuedInterrupts();
  if (projected.ok && signal?.aborted)
    return err(
      new AnalysisCancelledError("inspect_analysis_view", {
        cause: signal.reason,
        partialObservation: projected.value,
      }),
    );
  return projected;
};

/** Project a parsed request whose selected source is inline or retained. */
export const inspectAnalysisViewValidated = (
  input: ReadyAnalysisViewInput,
  lookup?: EvidenceLookup,
): Result<Evidence, AnalysisError> => {
  const apiSurfaceAccumulator =
    input.view.kind === "api-surface"
      ? WebNetworkApiSurfaceAccumulator.forView(input.view)
      : undefined;
  const manifestAccumulator =
    input.view.kind === "environment-manifest"
      ? new EnvironmentManifestAccumulator(
          undefined,
          input.view.include_query_parameter_names,
          input.view.template_rules,
        )
      : undefined;
  const stateAccumulator =
    input.view.kind === "environment-state"
      ? new EnvironmentStateAccumulator(undefined, input.view.template_rules)
      : undefined;
  const accumulator =
    apiSurfaceAccumulator ?? manifestAccumulator ?? stateAccumulator;
  if (input.source.kind === "inline") {
    const admitted =
      accumulator === undefined
        ? admitAnalysisViewData(input.source.evidence, true)
        : accumulator.admitInlineEvidence(input.source.evidence);
    if (!admitted.ok) return admitted;
  }
  const resolved = resolveAnalysisViewSource(input.source, lookup);
  if (!resolved.ok) return resolved;
  const parent = resolved.value;
  const projected = projectAnalysisView(
    {
      evidenceId: parent.evidence_id,
      operation: parent.operation,
      provider: parent.provider,
      analysisProfileDigest: parent.analysis_profile?.digest ?? null,
      normalizedResult:
        immutableJsonSnapshotMember(parent, "normalized_result") ??
        parent.normalized_result,
      // Sealing an Evidence root deep-freezes it; only the root is registered.
      sealedResult: isImmutableJsonSnapshot(parent),
      subject: parent.subject,
      limitations: parent.limitations,
      parameters: parent.parameters,
      artifact:
        parent.subject === null
          ? null
          : {
              path: parent.subject.local_path,
              sha256: parent.subject.digest.sha256,
            },
    },
    input.view,
    {
      apiSurface: apiSurfaceAccumulator,
      manifest: manifestAccumulator,
      state: stateAccumulator,
    },
  );
  if (!projected.ok) return projected;
  if (
    parent.subject !== null &&
    parent.subject.digest.sha256 !== projected.value.artifact?.sha256
  )
    return err(
      new EvidenceIntegrityError(
        `Parent subject SHA-256 ${parent.subject.digest.sha256} differs from analysis artifact SHA-256 ${projected.value.artifact?.sha256 ?? "unknown"}.`,
      ),
    );
  return ok(createAnalysisViewEvidence(input, parent, projected.value));
};

/** Session Evidence ownership required to deliver a view instead of a complete record. */
export interface AnalysisViewRetention {
  readonly evidenceById: EvidenceLookup | undefined;
  readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
}

/** Fail before analysis when selected delivery cannot keep its complete source. */
export const requireAnalysisViewRetention = (
  operation: string,
  retention: AnalysisViewRetention,
): Result<
  {
    readonly evidenceById: EvidenceLookup;
    readonly recordEvidence: EvidenceWriter["recordEvidence"];
  },
  AnalysisError
> => {
  if (
    retention.recordEvidence === undefined ||
    retention.evidenceById === undefined
  )
    return err(
      new AnalysisCapabilityUnavailableError(
        ANALYSIS_VIEW_PROVIDER.id,
        operation,
        "summary detail requires a server session that retains Evidence for later views",
        {
          userMessage:
            "This server does not retain Evidence. Select detail complete to receive the complete analysis inline.",
        },
      ),
    );
  return ok({
    evidenceById: retention.evidenceById,
    recordEvidence: retention.recordEvidence,
  });
};

/**
 * Retain complete analysis Evidence in the session, then project its summary
 * view from the retained record. Callers page or select the rest through
 * inspect_analysis_view with the view's parent Evidence ID.
 */
export const summarizeRetainedAnalysis = (
  evidence: Evidence,
  retention: AnalysisViewRetention,
): Result<Evidence, AnalysisError> =>
  projectRetainedAnalysis(evidence, retention, { kind: "summary" });

/** Retain the complete owner observation and deliver one explicitly selected view. */
export const projectRetainedAnalysis = (
  evidence: Evidence,
  retention: AnalysisViewRetention,
  view: AnalysisViewRequest,
): Result<Evidence, AnalysisError> => {
  const ready = requireAnalysisViewRetention(evidence.operation, retention);
  if (!ready.ok) return ready;
  const recorded = ready.value.recordEvidence(evidence);
  if (!recorded.ok) return recorded;
  return inspectAnalysisViewValidated(
    {
      source: { kind: "retained-evidence", evidence_id: evidence.evidence_id },
      view,
    },
    ready.value.evidenceById,
  );
};

const resolveAnalysisViewSource = (
  source: ReadyAnalysisViewInput["source"],
  lookup: EvidenceLookup | undefined,
): Result<Evidence, AnalysisError> => {
  if (source.kind === "retained-evidence")
    return resolveEvidenceInput(source, lookup);
  return authenticateEvidence(source.evidence, ["source", "evidence"], {
    source,
  });
};

/** Parse complete Evidence, reporting schema issues under the given request path. */
const authenticateEvidence = (
  value: unknown,
  path: readonly (string | number)[],
  input: unknown,
): Result<Evidence, AnalysisError> => {
  const parsed = safeParseEvidence(value);
  if (parsed.ok) return parsed;
  const cause = parsed.error;
  return err(
    analysisInputErrorFromIssues(
      INSPECT_ANALYSIS_VIEW_OPERATION,
      cause.issues.map((issue) => ({
        ...issue,
        path: [...path, ...issue.path],
      })),
      input,
      { cause },
    ),
  );
};

const createAnalysisViewEvidence = (
  input: ReadyAnalysisViewInput,
  parent: Evidence,
  result: AnalysisViewResult,
): Evidence => {
  const target =
    parent.subject === null
      ? undefined
      : {
          path: parent.subject.local_path,
          sha256: parent.subject.digest.sha256,
          format: parent.subject.format,
          ...(parent.subject.architecture === null
            ? {}
            : { architecture: parent.subject.architecture }),
        };
  const nativeFunctionView =
    result.kind === "native" ||
    (result.kind === "summary" &&
      result.parent_operation === "analyze_function")
      ? result
      : undefined;
  return createEvidence(
    target,
    ANALYSIS_VIEW_PROVIDER,
    {
      predicateType: "rea.analysis-view",
      operation: INSPECT_ANALYSIS_VIEW_OPERATION,
      parameters: {
        parent_evidence_id: parent.evidence_id,
        view: jsonValueSchema.parse(input.view),
      },
      result: jsonValueSchema.parse(result),
      rawResult: null,
      confidence:
        // Grouping is whole-capture, so any templated group or parameter makes the result inferred;
        // entity types and identity in an extracted state always are.
        result.kind === "environment-state" ||
        ((result.kind === "api-surface" ||
          result.kind === "environment-manifest") &&
          result.templated_groups > 0)
          ? "inferred"
          : "derived",
      authority: parent.authority,
      limitations: result.limitations,
      ...(nativeFunctionView !== undefined &&
      parent.relationship_coverage !== null
        ? { relationshipCoverage: parent.relationship_coverage }
        : {}),
      locations: [
        ...(result.artifact != null && result.artifact.path.length > 0
          ? [{ kind: "artifact-path" as const, path: result.artifact.path }]
          : []),
        ...(nativeFunctionView !== undefined &&
        nativeFunctionView.procedure_address !== null &&
        nativeFunctionView.procedure_address.length > 0
          ? [
              {
                kind: "address" as const,
                address: nativeFunctionView.procedure_address,
              },
            ]
          : []),
      ],
      evidenceLinks: [parent.evidence_id],
    },
    { immutable: true },
  );
};
