import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  createEvidence,
  evidenceSubjectInput,
  type Evidence,
} from "../../domain/evidence.js";
import { readEvidence } from "../../domain/evidenceValidation.js";
import { projectInputIssues } from "../../domain/inputIssueProjection.js";
import {
  JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
  VSIX_PACKAGE_PROVIDER_IDENTITY,
} from "../../domain/investigationProviders.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  correlateVsixRegistrations,
  correlateVsixRegistrationsInputSchema,
  vsixRegistrationCorrelationSchema,
} from "../../domain/vsix/vsixRegistrationCorrelation.js";
import { vsixPackageSchema } from "../../domain/vsix/vsixPackage.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import {
  applicationGraphEvidenceInputError,
  parseApplicationGraphEvidence,
} from "../javascript/JavaScriptApplicationEvidenceGraph.js";

const OPERATION = "correlate_vsix_registrations";

const LIMITATIONS = [
  "REA does not verify that the JavaScript analysis covers the files of the selected package; entry_points only says whether a declared entry path was analyzed.",
  "undetermined replaces not_found when a declared entry point or any source was not analyzed, analysis was truncated, or the application graph predates callee facts; it replaces registered_undeclared when declarations were not all read. not_found means no vscode registration with that literal identifier was seen. Identifiers built at run time are listed as unresolved, and unrecognized code or bundler forms can hide a registration.",
  "A registration with loader_authority candidate rests on an unestablished require; wrapper unverified additionally rests on a helper whose effect was not checked.",
  "Static source facts only: activation, execution and handler behavior are not observed.",
] as const;

const invalid = (field: string, message: string) =>
  new AnalysisInputError(OPERATION, {}, [
    { path: [field], reason: "invalid_value", message },
  ]);

/** Authenticate the package Evidence and its complete report. */
const readPackageSource = (input: unknown) => {
  const evidence = readEvidence(input);
  if (!evidence.ok) return evidence;
  const { operation, provider, normalized_result } = evidence.value;
  if (
    operation !== "inspect_vsix_package" ||
    provider.id !== VSIX_PACKAGE_PROVIDER_IDENTITY.id
  )
    return err(
      invalid("vsix_package", "Expected inspect_vsix_package Evidence."),
    );
  const report = vsixPackageSchema.safeParse(normalized_result);
  return report.success
    ? ok({ evidence: evidence.value, report: report.data })
    : err(
        new AnalysisInputError(
          OPERATION,
          {},
          projectInputIssues(report.error.issues, normalized_result).map(
            (issue) => ({
              ...issue,
              path: ["vsix_package", "normalized_result", ...issue.path],
            }),
          ),
        ),
      );
};

/** Join one package's declared commands to one application's registrations. */
export const correlateVsixRegistrationsExecution = (
  rawInput: unknown,
  lookup?: EvidenceLookup,
  options: Pick<ExecutionOptions, "signal"> = {},
): Result<
  { readonly evidence: Evidence; readonly sources: readonly Evidence[] },
  AnalysisError
> => {
  const request = resolveEvidenceRequest(
    OPERATION,
    rawInput,
    correlateVsixRegistrationsInputSchema,
    lookup,
    options,
  );
  if (!request.ok) return request;
  const input = request.value.input;
  const selected = readPackageSource(input.vsix_package);
  if (!selected.ok) return selected;
  const application = parseApplicationGraphEvidence(
    input.javascript_application,
    ["javascript_application"],
  );
  if (!application.ok)
    return err(
      applicationGraphEvidenceInputError(OPERATION, application.error),
    );
  const { evidence: source, semanticGraph } = application.value;
  if (
    source.operation !== "analyze_javascript_application" ||
    semanticGraph === null
  )
    return err(
      invalid(
        "javascript_application",
        "Expected analyze_javascript_application Evidence with a semantic graph.",
      ),
    );
  const { report, evidence: packageEvidence } = selected.value;
  const identities = {
    vsix_package_evidence_id: packageEvidence.evidence_id,
    javascript_application_evidence_id: source.evidence_id,
  };
  const result = vsixRegistrationCorrelationSchema.parse({
    ...correlateVsixRegistrations({
      contributes: report.contributes,
      manifestRead: report.package_identity !== null,
      entryPoints: [
        report.entry_points.main,
        report.entry_points.browser,
      ].flatMap((entry) => (entry === null ? [] : [entry.path])),
      semanticGraph,
    }),
    source_evidence: identities,
    limitations: [...LIMITATIONS],
  });
  return ok({
    evidence: createEvidence(
      evidenceSubjectInput(packageEvidence.subject),
      JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
      {
        predicateType: "rea.vsix-registration-correlation",
        operation: OPERATION,
        parameters: identities,
        result,
        rawResult: null,
        confidence: "inferred",
        authority: "analyst-inference",
        environment: null,
        limitations: result.limitations,
        evidenceLinks: Object.values(identities),
      },
    ),
    sources: [packageEvidence, source],
  });
};
