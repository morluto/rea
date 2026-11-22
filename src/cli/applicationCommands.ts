import { registerPlaywrightTraceCommand } from "./playwrightTraceCommand.js";
import { registerApiContractCommand } from "./apiContractCommand.js";
import { registerWarcArchiveCommand } from "./warcArchiveCommand.js";
import { registerNtfsJournalCommand } from "./ntfsJournalCommand.js";
import type { CliInstance } from "./types.js";

import { cliCommandFor } from "../contracts/cliCommandNames.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { Logger } from "pino";
import { APPLICATION_TOOL_CONTRACTS } from "../contracts/applicationToolContracts.js";
import { contractNamed } from "./contractCliDescription.js";
import { registerContractDocumentCommand } from "./contractCommand.js";
import type { EvidenceLookup } from "../application/EvidenceInputResolver.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import {
  evidenceBundleOption,
  runEvidenceInputCommand,
} from "./evidenceInputCommand.js";

/** Application workflows whose CLI input is one Evidence-carrying JSON document. */
type EvidenceWorkflowOperation =
  | "trace_application_feature"
  | "trace_javascript_semantics"
  | "compare_application_versions"
  | "compare_javascript_export_shapes"
  | "project_android_application_graph"
  | "project_apple_application_graph"
  | "project_harmony_application_graph";

const workflowJsonDescription = "Inline workflow JSON or JSON file path";

/** Register CLI equivalents of provider-neutral application graph workflows. */
export const registerApplicationCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: cliCommandFor("trace_application_feature"),
    operation: "trace_application_feature",
    omit: {
      view: "A one-shot command retains no session Evidence for a selected view; save the complete trace and query it with inspect-analysis-view",
    },
    description:
      "Trace a typed seed through authenticated application Evidence JSON",
    workflow: async (input, lookup, signal) => {
      const { traceApplicationFeatureEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = traceApplicationFeatureEvidence(input, lookup, { signal });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: cliCommandFor("trace_javascript_semantics"),
    operation: "trace_javascript_semantics",
    description:
      "Trace bounded static semantic relations through authenticated application Evidence",
    workflow: async (input, lookup, signal) => {
      const { traceJavaScriptSemanticsEvidence } =
        await import("../application/javascript/JavaScriptSemanticTraceService.js");
      const result = traceJavaScriptSemanticsEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: cliCommandFor("compare_application_versions"),
    operation: "compare_application_versions",
    description:
      "Compare two authenticated JavaScript Application Graph versions",
    workflow: async (input, lookup, signal) => {
      const { compareApplicationVersionsEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = compareApplicationVersionsEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerApiContractCommand(cli, logger);
  registerWarcArchiveCommand(cli, logger);
  registerNtfsJournalCommand(cli, logger);
  registerPlaywrightTraceCommand(cli, logger);
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: cliCommandFor("compare_javascript_export_shapes"),
    operation: "compare_javascript_export_shapes",
    description:
      "Compare exact static JavaScript export return shapes without execution",
    workflow: async (input, lookup, signal) => {
      const { compareJavaScriptExportShapesEvidence } =
        await import("../application/javascript/JavaScriptApplicationWorkflowService.js");
      const result = compareJavaScriptExportShapesEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerObligationLedgerCommand(cli, logger);
  registerCoverageCommand(cli, logger);
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: cliCommandFor("project_android_application_graph"),
    operation: "project_android_application_graph",
    description:
      "Project authenticated APK inventory Evidence into an Android application graph",
    workflow: async (input, lookup, signal) => {
      const { projectAndroidApplicationEvidence } =
        await import("../application/android/AndroidApplicationService.js");
      const result = projectAndroidApplicationEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: cliCommandFor("project_apple_application_graph"),
    operation: "project_apple_application_graph",
    description:
      "Project authenticated IPA or macOS app inventory Evidence into an Apple application graph",
    workflow: async (input, lookup, signal) => {
      const { projectAppleApplicationEvidence } =
        await import("../application/apple/AppleApplicationService.js");
      const result = projectAppleApplicationEvidence(input, lookup, { signal });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
  registerEvidenceJsonCommand({
    cli,
    logger,
    name: cliCommandFor("project_harmony_application_graph"),
    operation: "project_harmony_application_graph",
    description:
      "Project authenticated HarmonyOS HAP, HSP, or App Pack inventory Evidence into an application graph",
    workflow: async (input, lookup, signal) => {
      const { projectHarmonyApplicationEvidence } =
        await import("../application/harmony/HarmonyApplicationService.js");
      const result = projectHarmonyApplicationEvidence(input, lookup, {
        signal,
      });
      return result.ok ? { ok: true, value: result.value.evidence } : result;
    },
  });
};

/**
 * Inline reconstruction workflows. Each owner authenticates its embedded
 * Evidence bundle itself, so the handler passes the decoded document on.
 */
const registerReconstructionDocumentCommand = <
  Operation extends
    | "build_reconstruction_obligation_ledger"
    | "evaluate_reconstruction_coverage",
>(
  cli: CliInstance,
  logger: Logger,
  operation: Operation,
  command: string,
  description: string,
  workflow: (
    input: unknown,
  ) => Promise<
    | { readonly ok: true; readonly value: JsonValue }
    | { readonly ok: false; readonly error: AnalysisError }
  >,
): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(APPLICATION_TOOL_CONTRACTS, operation),
    { command, description, document: workflowJsonDescription },
    async (input) => {
      const result = await workflow(input);
      return result.ok
        ? result.value
        : {
            error: "Application workflow failed",
            ...projectAnalysisError(result.error, "invocation"),
          };
    },
  );

const registerObligationLedgerCommand = (
  cli: CliInstance,
  logger: Logger,
): void =>
  registerReconstructionDocumentCommand(
    cli,
    logger,
    "build_reconstruction_obligation_ledger",
    cliCommandFor("build_reconstruction_obligation_ledger"),
    "Generate a deterministic Evidence-backed reconstruction obligation ledger page",
    async (input) => {
      const { buildReconstructionObligationLedgerEvidence } =
        await import("../application/ReconstructionObligationLedgerService.js");
      return buildReconstructionObligationLedgerEvidence(input);
    },
  );

const registerCoverageCommand = (cli: CliInstance, logger: Logger): void =>
  registerReconstructionDocumentCommand(
    cli,
    logger,
    "evaluate_reconstruction_coverage",
    cliCommandFor("evaluate_reconstruction_coverage"),
    "Evaluate inline fail-closed reconstruction coverage",
    async (input) => {
      const { evaluateReconstructionCoverage } =
        await import("../application/ReconstructionCoverageService.js");
      return evaluateReconstructionCoverage(input);
    },
  );

/** Evidence consumers share one explicit portable source and cancellation lifetime. */
const registerEvidenceJsonCommand = ({
  cli,
  logger,
  name,
  operation,
  description,
  omit,
  workflow,
}: {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly name: string;
  readonly operation: EvidenceWorkflowOperation;
  readonly description: string;
  readonly omit?: Readonly<Record<string, string>>;
  readonly workflow: (
    input: unknown,
    lookup: EvidenceLookup | undefined,
    signal: AbortSignal,
  ) => Promise<Result<Evidence, AnalysisError>>;
}): void =>
  registerContractDocumentCommand(
    cli,
    logger,
    contractNamed(APPLICATION_TOOL_CONTRACTS, operation),
    {
      command: name,
      description,
      document: workflowJsonDescription,
      ...(omit === undefined ? {} : { omit }),
      cliOptions: { evidenceBundle: evidenceBundleOption },
    },
    async (input, { signal, frame, cliOptions }) => {
      const result = await runEvidenceInputCommand(
        input,
        { operation, signal, frame, cliOptions },
        (lookup) => workflow(input, lookup, signal),
      );
      return result.ok
        ? result.value
        : { error: "Application workflow failed", ...result.error };
    },
  );
