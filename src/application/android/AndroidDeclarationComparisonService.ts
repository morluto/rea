import { setImmediate } from "node:timers/promises";
import { constants as bufferConstants } from "node:buffer";
import { isRecord } from "../../kernel/isRecord.js";
import { compareAndroidDeclarationsInputSchema } from "../../contracts/android/androidComparisonContracts.js";
import {
  androidResultSchemas,
  androidInputSchemas,
} from "../../domain/android/androidAnalysis.js";
import {
  androidDeclarationComparisonSchema,
  compareAndroidDeclarationFacts,
  ANDROID_DECLARATION_COMPARISON_LIMITATIONS,
  type AndroidDeclarationComparison,
  type AndroidPackageDeclarations,
} from "../../domain/android/androidDeclarationComparison.js";
import {
  AnalysisInputError,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import {
  createEvidence,
  evidenceEnvelopeForAdmission,
  evidenceFileTarget,
  evidenceSubjectDisplay,
  type Evidence,
} from "../../domain/evidence.js";
import { readEvidencePayload } from "../../domain/evidenceValidation.js";
import {
  canBorrowParsedJsonSnapshot,
  immutableJsonSnapshotMember,
} from "../../domain/immutableJson.js";
import { unknownTarget } from "../../domain/targetIdentity.js";
import { ANDROID_APPLICATION_PROVIDER } from "../../domain/investigationProviders.js";
import { err, ok } from "../../domain/result.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import { requireAuthenticationHeadroom } from "../JsonAuthenticationHeadroom.js";
import { completeProviderEvidence } from "../ProviderOperationExecution.js";
import {
  requireAndroidDeclarationComparisonHeadroom,
  readAndroidDeclarationSource,
} from "./AndroidDeclarationComparisonAdmission.js";
import type { EvidenceWorkflowExecution } from "../investigation/EvidenceWorkflowExecution.js";
import {
  withEvidenceSources,
  type AnalysisResultWithSources,
} from "../investigation/recordEvidenceSources.js";

const OPERATION = "compare_android_declarations";
const checkedPackages = new WeakMap<object, AndroidPackageDeclarations>();

/** Evidence authentication does not establish the Android payload's format semantics. */
const readPackageDeclarations = (
  evidence: Evidence,
  side: "left" | "right",
) => {
  const source = immutableJsonSnapshotMember(evidence, "normalized_result");
  const known = isRecord(source) ? checkedPackages.get(source) : undefined;
  if (known !== undefined) return ok(known);
  const capacity = requireAuthenticationHeadroom(source, {
    operation: OPERATION,
    path: `${side}.normalized_result`,
    description: "Android package declarations cannot be validated",
  });
  if (!capacity.ok) return capacity;
  const parsed = readEvidencePayload(
    androidResultSchemas.inspect_android_package,
    source,
    { side, within: ["normalized_result"] },
  );
  if (parsed.ok && canBorrowParsedJsonSnapshot(source, parsed.value)) {
    checkedPackages.set(source, source);
    return ok(source);
  }
  return parsed;
};

const readInspection = (evidence: Evidence, side: "left" | "right") => {
  const invalid = (message: string) =>
    err(
      new AnalysisInputError(OPERATION, { userMessage: message }, [
        { path: [side], reason: "invalid_value", message },
      ]),
    );
  if (
    evidence.operation !== "inspect_android_package" ||
    evidence.predicate_type !== "rea.analysis"
  ) {
    const result = evidence.normalized_result;
    const parent =
      isRecord(result) && typeof result.parent_evidence_id === "string"
        ? ` Select complete parent Evidence ${result.parent_evidence_id} instead.`
        : "";
    return invalid(
      `Expected complete rea.analysis inspect_android_package Evidence.${parent}`,
    );
  }
  const subject = evidenceFileTarget(evidence);
  const display = evidenceSubjectDisplay(evidence);
  if (
    subject === undefined ||
    display === undefined ||
    subject.format !== "apk" ||
    subject.selection !== null
  )
    return invalid(
      "Android declaration comparison requires the recorded whole-APK file subject identity.",
    );
  const selection = androidInputSchemas.inspect_android_package.safeParse(
    evidence.parameters,
  );
  if (!selection.success)
    return invalid(
      "Android inspection Evidence must retain its exact path selection in parameters.path.",
    );
  const parsed = readPackageDeclarations(evidence, side);
  if (!parsed.ok) return parsed;
  const result = parsed.value;
  // The subject is the canonical APK identity. The requested path can be a
  // relative spelling or symlink; do not resolve it again in another context.
  return ok({
    evidence,
    result,
    side: {
      evidence_id: evidence.evidence_id,
      artifact: { path: display.local_path, sha256: subject.sha256 },
      input_path: selection.data.path,
      package_name: result.package_name,
      version_name: result.version_name,
      version_code: result.version_code,
      engine: result.engine,
      manifest_status: result.manifest.status,
      components_status: result.components.status,
      limitations: [...evidence.limitations, ...result.components.limitations],
    },
  });
};

/** Compare exact retained parsed declarations without acquiring APKs or providers. */
export const compareAndroidDeclarations = async (
  input: unknown,
  options?: ExecutionOptions,
  lookup?: EvidenceLookup,
): Promise<AnalysisResultWithSources<EvidenceWorkflowExecution>> => {
  if (options?.signal?.aborted)
    return err(cancelledBy(OPERATION, options.signal));
  await setImmediate();
  if (options?.signal?.aborted)
    return err(cancelledBy(OPERATION, options.signal));
  const snapshots = new WeakMap<object, Evidence>();
  const resolved = resolveEvidenceRequest(
    OPERATION,
    input,
    compareAndroidDeclarationsInputSchema,
    lookup,
    {
      ...options,
      readEvidence: (input, path) => {
        const known = isRecord(input) ? snapshots.get(input) : undefined;
        if (known !== undefined) return ok(known);
        const source = readAndroidDeclarationSource(input, path);
        if (source.ok && isRecord(input)) snapshots.set(input, source.value);
        return source;
      },
    },
  );
  if (!resolved.ok) return resolved;
  const left = readInspection(resolved.value.input.left, "left");
  if (!left.ok) return left;
  const right = readInspection(resolved.value.input.right, "right");
  if (!right.ok) return right;
  const total =
    left.value.result.components.items.length +
    right.value.result.components.items.length;
  // Admission-only envelope: longest statuses and maximum count widths bound
  // fixed output fields. These placeholder facts are never delivered.
  const baseline: AndroidDeclarationComparison = {
    left: left.value.side,
    right: right.value.side,
    sdk: {
      min_sdk: {
        left: left.value.result.min_sdk,
        right: right.value.result.min_sdk,
        state: "unchanged",
      },
      target_sdk: {
        left: left.value.result.target_sdk,
        right: right.value.result.target_sdk,
        state: "unchanged",
      },
    },
    permissions: {
      coverage: "unknown",
      left: left.value.result.permissions,
      right: right.value.result.permissions,
      observed_only_left: [],
      observed_only_right: [],
      observed_both: [],
    },
    components: {
      coverage: "complete-within-inputs",
      changes: [],
      summary: {
        added: total,
        removed: total,
        changed: total,
        unchanged: total,
        unknown: total,
      },
    },
    limitations: [...ANDROID_DECLARATION_COMPARISON_LIMITATIONS],
  };
  const sources = [left.value.evidence, right.value.evidence];
  const observationFor = (result: AndroidDeclarationComparison) => ({
    operation: OPERATION,
    predicateType: "rea.android-declaration-comparison",
    parameters: {
      left_evidence_id: left.value.evidence.evidence_id,
      right_evidence_id: right.value.evidence.evidence_id,
    },
    result,
    confidence: "derived" as const,
    authority: "analyst-inference" as const,
    limitations: result.limitations,
    evidenceLinks: sources.map(({ evidence_id }) => evidence_id),
  });
  const subject = unknownTarget("derived-from-linked-evidence");
  const capacity = requireAndroidDeclarationComparisonHeadroom(
    evidenceEnvelopeForAdmission(
      subject,
      ANDROID_APPLICATION_PROVIDER,
      observationFor(baseline),
    ),
    left.value.result,
    right.value.result,
  );
  if (!capacity.ok) return capacity;
  const report = {
    ...baseline,
    ...compareAndroidDeclarationFacts(left.value.result, right.value.result),
  };
  const observation = observationFor(report);
  const admission = requireAuthenticationHeadroom(
    evidenceEnvelopeForAdmission(
      subject,
      ANDROID_APPLICATION_PROVIDER,
      observation,
    ),
    {
      operation: OPERATION,
      path: "selected Android package Evidence",
      description:
        "Complete Android declaration comparison Evidence cannot be assembled",
      serializedCodeUnitLimit: bufferConstants.MAX_STRING_LENGTH,
    },
  );
  if (!admission.ok) return admission;
  const evidence = createEvidence(subject, ANDROID_APPLICATION_PROVIDER, {
    ...observation,
    result: androidDeclarationComparisonSchema.parse(report),
  });
  await setImmediate();
  const completed = completeProviderEvidence(evidence, options?.signal);
  return withEvidenceSources(
    completed.ok ? ok({ evidence: completed.value, sources }) : completed,
    sources,
  );
};
