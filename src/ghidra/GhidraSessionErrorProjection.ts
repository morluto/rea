import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS } from "../domain/analysisResourceLimits.js";
import { z } from "zod";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import { analysisErrorWithCleanupDependencies } from "../domain/analysisErrorCleanup.js";
import { artifactFilePrimaryFacts } from "../resources/index.js";
import { GhidraAdmissionError } from "./GhidraAdmissionError.js";
import { GHIDRA_RESTRICTED_TEMP_REMEDIATION } from "./GhidraTemporaryDirectory.js";
import {
  ghidraMissingProgramNames,
  type GhidraLauncherFailure,
} from "./GhidraDiagnostics.js";

import type { AnalysisOperation } from "../ports/AnalysisProvider.js";
import type { AppConfig } from "../config/types.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  reattributedResourceConstraint,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  providerRetryAction,
  type ProviderOperationHealth,
} from "../domain/providerOperationHealth.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { GhidraLaunchError } from "./GhidraLauncher.js";
import type { GhidraSessionSource } from "./GhidraProviderCapabilities.js";
import {
  GHIDRA_STARTUP_DEADLINE_ELAPSED,
  isGhidraInputFailureCode,
  type GhidraSessionError,
} from "./GhidraSessionError.js";
import {
  ghidraByteSearchCursorMismatch,
  isGhidraByteSearchCursorMismatch,
} from "./GhidraByteSearchCursorFailure.js";
import {
  ghidraFileOffsetOutcome,
  ghidraFileOffsetUnavailable,
} from "./GhidraFileOffsetFailure.js";
import {
  JVM_EXHAUSTION_DETAILS,
  RUNTIME_EXHAUSTION_AREAS,
  type RuntimeExhaustionArea,
} from "../process/RuntimeExhaustion.js";
import { invalidRegexPatternError } from "../process/RegexMatcher.js";

/** Configured deadlines that Ghidra failure projections name. */
export type GhidraProjectionLimits = Pick<
  AppConfig,
  | "ghidraStartupTimeoutMs"
  | "ghidraDecompileTimeoutSeconds"
  | "ghidraExistingProject"
>;

/** Projection inputs: live configured limits and the program passed to `-process`. */
export interface GhidraProjection {
  readonly limits: GhidraProjectionLimits;
  readonly programName: string | undefined;
  readonly source: GhidraSessionSource;
}

export const projectSessionError = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
  projection: GhidraProjection,
  health?: ProviderOperationHealth,
  request?: Readonly<Record<string, JsonValue>>,
  entryHint?: string,
): AnalysisError => {
  const primary = projectPrimarySessionError(
    operation,
    failure,
    projection,
    health,
    request,
    entryHint,
  );
  return failure.cleanupFailure === undefined
    ? primary
    : analysisErrorWithCleanupDependencies(
        primary,
        failure.cleanupFailure,
        operation,
      );
};

const projectPrimarySessionError = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
  { limits, programName, source }: GhidraProjection,
  health?: ProviderOperationHealth,
  request?: Readonly<Record<string, JsonValue>>,
  entryHint?: string,
): AnalysisError => {
  const context = {
    cause: failure,
    diagnostics: failure.diagnostics,
    ...(failure.partialObservation === undefined
      ? {}
      : { partialObservation: failure.partialObservation }),
  };
  // A refused setting (for example the reply ceiling admitted before launch)
  // is already the caller-facing refusal with its setting and allowed values.
  if (failure.cause instanceof ConfigurationError) return failure.cause;
  if (failure.kind === "checkpoint") {
    if (failure.cause instanceof AnalysisError)
      return analysisClientFailureForOperation(
        failure.cause,
        "ghidra",
        operation,
      );
    return new ConfigurationError(failure.message, {
      ...context,
      settings: [
        { setting: "REA_GHIDRA_CHECKPOINT_DIR", constraint: failure.message },
      ],
      remediationAction:
        "Preserve the checkpoint directory. Correct the reported file, permission or competing-session problem, then reopen the target. Select a new checkpoint directory only if you explicitly want fresh analysis.",
    });
  }
  // The launcher owns normalized inspection and typed artifact outcomes.
  // Ordinary launch errors have no such primary and keep session recovery.
  const launchPrimary =
    failure.cause instanceof GhidraLaunchError
      ? failure.cause.primaryFailure
      : undefined;
  if (
    launchPrimary !== undefined &&
    !(launchPrimary instanceof AnalysisCancelledError)
  )
    return analysisClientFailureForOperation(
      launchPrimary,
      "ghidra",
      operation,
      failure.diagnostics,
    );
  const { cause: physicalCause, origin } = artifactFilePrimaryFacts(
    failure.cause,
  );
  // A client-side ceiling refusal travels as the cause; re-attribute it to this
  // operation so callers see a typed resource constraint rather than a generic
  // session failure, matching how Hopper and Cutter report the same ceiling.
  if (physicalCause instanceof AnalysisResourceConstraintError)
    return reattributedResourceConstraint(operation, physicalCause, context);
  if (
    origin === "owned-or-classified" &&
    physicalCause instanceof AnalysisAccessDeniedError
  )
    return new AnalysisAccessDeniedError(
      operation,
      physicalCause.path,
      physicalCause.systemCode,
      context,
    );
  if (
    origin === "owned-or-classified" &&
    physicalCause instanceof AnalysisArtifactChangedError
  )
    return new AnalysisArtifactChangedError(
      operation,
      physicalCause.path,
      physicalCause.reason,
      { ...context, integrityCheck: physicalCause.integrityCheck },
    );
  if (
    failure.kind === "admission" &&
    failure.cause instanceof GhidraAdmissionError &&
    (failure.cause.code === "import_identity_unavailable" ||
      failure.cause.code === "import_identity_mismatch")
  ) {
    const unavailable = failure.cause.code === "import_identity_unavailable";
    const constraint = unavailable
      ? "The Ghidra program did not report a valid imported SHA-256, so REA cannot verify its target identity"
      : "The Ghidra program's imported SHA-256 differs from the selected target's SHA-256";
    const remediationAction = unavailable
      ? "Select a Ghidra program whose imported identity can be verified, or investigate the missing identity in Ghidra. Configure a different project or program when starting REA. REA did not fall back to a fresh import."
      : "Select a target matching the configured program and retry, or configure a matching project or program when starting REA. Resolve any reported cleanup before reopening. REA did not fall back to a fresh import.";
    if (source === "existing-project")
      return new ConfigurationError(constraint, {
        ...context,
        settings: [{ setting: "REA_GHIDRA_PROJECT_PATH", constraint }],
        remediationAction,
      });
    return new ProviderAdapterError("ghidra", operation, {
      ...context,
      userMessage: `${constraint}.`,
      remediationAction:
        "Inspect the retained Ghidra diagnostics and target identity before retrying the import.",
    });
  }
  // A well-formed address that lacks one exact source offset keeps the
  // bridge's reason and the caller's exact spelling, not schema advice.
  const fileOffset =
    failure.kind === "remote"
      ? ghidraFileOffsetOutcome(failure.remoteCode)
      : undefined;
  if (fileOffset !== undefined)
    return ghidraFileOffsetUnavailable(
      operation,
      fileOffset,
      failure.message,
      typeof request?.address === "string" ? request.address : undefined,
      context,
    );
  // A schema-valid cursor for another bound context is not a malformed
  // argument. The one-way digest cannot name the differing component.
  if (
    operation === "search_bytes" &&
    failure.kind === "remote" &&
    isGhidraByteSearchCursorMismatch(failure.remoteCode)
  )
    return ghidraByteSearchCursorMismatch(operation, failure.message, context);
  if (
    operation === "annotate_native_function" &&
    failure.kind === "remote" &&
    failure.remoteCode === "invalid_function_name"
  )
    return new AnalysisInputError(operation, context, [
      { path: ["name"], reason: "invalid_value", message: failure.message },
    ]);
  if (
    failure.kind === "remote" &&
    (failure.remoteCode === "procedure_not_found" ||
      failure.remoteCode === "file_offset_unmapped" ||
      failure.remoteCode === "procedure_ambiguous" ||
      failure.remoteCode === "file_offset_ambiguous")
  ) {
    let recovery: string;
    let relatedOperations: readonly string[];
    switch (failure.remoteCode) {
      case "file_offset_unmapped":
        recovery =
          "Use inspect_native_load_image to inspect the admitted file's loaded mappings, then select an offset with an observed mapping. A missing mapping does not prove the file contains no relevant data.";
        relatedOperations = ["inspect_native_load_image"];
        break;
      case "file_offset_ambiguous":
        recovery =
          "Choose a space-qualified analysis address from the reported mappings, such as ram:0x1000. A bare 0x... selector falls back to file-offset lookup and can report this ambiguity again. Use inspect_native_load_image to inspect the loaded mappings and Ghidra's observed default address space; REA does not select one automatically.";
        relatedOperations = ["inspect_native_load_image"];
        break;
      case "procedure_ambiguous":
        recovery =
          "Choose an explicit procedure entry address from the reported candidates. Use list_procedures or search_procedures to inspect the current Ghidra inventory.";
        relatedOperations = ["list_procedures", "search_procedures"];
        break;
      default: {
        const query =
          typeof request?.procedure === "string"
            ? request.procedure
            : undefined;
        const selectorText = query !== undefined ? ` \`${query}\`` : "";
        const inProject =
          source === "existing-project" ? " in this project" : "";
        const isAddress =
          query !== undefined && /^0x[0-9a-fA-F]+$/i.test(query);
        const pattern = query ?? "entry";
        const suggestion = isAddress
          ? `Ghidra couldn't resolve address${selectorText}${inProject}. Choose an observed procedure entry from the current Ghidra inventory. CLI: rea search <path> . --kind procedures --provider ghidra. MCP: use list_procedures or search_procedures. An inventory miss leaves the function's presence in the artifact unknown.`
          : `Ghidra couldn't resolve${selectorText}${inProject}. Search the procedure inventory for ${JSON.stringify(pattern)}. If you find a matching entry procedure, retry with its address. CLI: rea search <path> ${JSON.stringify(pattern)} --kind procedures --provider ghidra. MCP: use search_procedures with ${JSON.stringify({ pattern })} or list_procedures. Choose an observed name or address from the current Ghidra inventory. An inventory miss leaves the function's presence in the artifact unknown.`;
        recovery =
          (entryHint === undefined ? "" : `${entryHint} `) +
          (entryHint !== undefined
            ? "Choose an observed name or address from the current Ghidra inventory. CLI: rea search <path> . --kind procedures --provider ghidra. MCP: use search_procedures or list_procedures. An inventory miss leaves the function's presence in the artifact unknown."
            : suggestion) +
          (source === "existing-project"
            ? " The selected project's previous analysis completeness is unknown. To explicitly request a separate fresh import, start a new REA process without REA_GHIDRA_PROJECT_PATH and REA_GHIDRA_PROGRAM_NAME. That separate analysis excludes the selected project's annotations and other edits."
            : "");
        relatedOperations = ["list_procedures", "search_procedures"];
        break;
      }
    }
    return new AnalysisInputError(
      operation,
      {
        ...context,
        related: { operations: relatedOperations },
        userMessage: failure.message,
        conformsToInputContract: true,
        remediationAction: recovery,
      },
      [
        {
          path: ["procedure"],
          reason: "invalid_value",
          message: failure.message,
          ...(typeof request?.procedure === "string"
            ? { observed: { procedure: request.procedure } }
            : {}),
        },
      ],
    );
  }
  if (
    failure.kind === "cancelled" ||
    (failure.kind === "remote" && failure.remoteCode === "decompile_cancelled")
  ) {
    const { cause: _failure, ...cancellationContext } = context;
    return cancelledBy(
      operation,
      carriedReason(
        failure.cancellation === undefined
          ? failure
          : failure.cancellation.reason,
      ),
      cancellationContext,
    );
  }
  if (failure.kind === "remote" && failure.remoteCode === "decompile_failed")
    return new ProviderAdapterError("ghidra", operation, {
      ...context,
      related: { operations: ["analyze_function"] },
      ...ghidraRequestOutcome(
        failure,
        "Only the decompiler failed for this procedure.",
        GHIDRA_SESSION_RETAINED,
        source,
      ),
      remediationAction:
        "Call analyze_function for the same procedure. It returns assembly, callers, callees, references and basic blocks from the Ghidra listing and records this decompiler failure under facet_availability.pseudocode. Repeating the unchanged decompile request is not expected to succeed.",
    });
  // A request-level deadline, not a provider failure: other operations stay
  // available. Only a continuing caller can reuse the session, and only when
  // no caller cancellation closed it while the timeout settled.
  if (
    failure.kind === "remote" &&
    failure.remoteCode === "decompile_timed_out" &&
    limits.ghidraDecompileTimeoutSeconds !== undefined
  ) {
    const outcome = ghidraRequestOutcome(
      failure,
      "Only this procedure's decompilation was stopped.",
      GHIDRA_SESSION_RETAINED,
      source,
    );
    const recovery = ghidraDecompileTimeoutRecovery(
      limits.ghidraDecompileTimeoutSeconds,
      source,
    );
    return new AnalysisTimeoutError(
      operation,
      limits.ghidraDecompileTimeoutSeconds * 1000,
      {
        ...context,
        limit: analysisSettingLimit(
          "ghidra.decompile_timeout_seconds",
          limits.ghidraDecompileTimeoutSeconds,
          undefined,
        ),
        related: { operations: ["analyze_function"] },
        userMessage: outcome.userMessage,
        remediationAction: recovery.remediationAction,
        continuingCallerGuidance: {
          ...outcome.continuingCallerGuidance,
          remediationAction: recovery.continuingRemediationAction,
        },
      },
    );
  }
  if (failure.kind === "analysis_timeout")
    return new AnalysisTimeoutError(
      operation,
      failure.timeoutMs ?? limits.ghidraStartupTimeoutMs,
      context,
    );
  if (
    failure.kind === "remote" &&
    failure.remoteCode === "regex_stack_exhausted"
  ) {
    const outcome = ghidraRequestOutcome(
      failure,
      undefined,
      GHIDRA_ANNOTATIONS_RETAINED,
      source,
    );
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      outcome.userMessage,
      null,
      {
        ...context,
        ...(outcome.continuingCallerGuidance === undefined
          ? {}
          : { continuingCallerGuidance: outcome.continuingCallerGuidance }),
        remediationAction:
          "Retry this search in literal mode or simplify the regex.",
      },
    );
  }
  if (
    failure.kind === "remote" &&
    failure.remoteCode === "invalid_regex_pattern"
  )
    // The bridge message already names the pattern and Java's syntax error.
    return invalidRegexPatternError(operation, failure.message, {
      ...context,
      userMessage: failure.message,
    });
  if (failure.kind === "remote" && isGhidraInputFailureCode(failure.remoteCode))
    return new AnalysisInputError(operation, context, [
      { path: [], reason: "invalid_value", message: failure.message },
    ]);
  if (failure.kind === "remote" && failure.remoteCode === "method_unavailable")
    return new AnalysisCapabilityUnavailableError(
      "ghidra",
      operation,
      failure.message,
      context,
    );
  const output =
    failure.kind === "start" ||
    failure.kind === "process" ||
    failure.kind === "protocol" ||
    failure.kind === "timeout"
      ? readGhidraFailureOutput(failure.diagnostics.failure_output)
      : undefined;
  const memoryFailure = projectObservedJvmMemoryFailure(
    operation,
    failure,
    context,
    output,
  );
  const uncertainty =
    [
      ...(output?.complete === false
        ? [
            "Ghidra's output for this operation is incomplete. No OutOfMemoryError was confirmed; a memory cause cannot be ruled out.",
          ]
        : []),
      ...(output?.launcherFailuresTruncated === true
        ? [
            "The launcher failure-line summary is incomplete; a more specific cause may be omitted.",
          ]
        : []),
    ].join(" ") || undefined;
  if (memoryFailure !== undefined) return memoryFailure;
  if (
    programName !== undefined &&
    output?.launcherFailures.some(
      (observed) =>
        observed.kind === "missing_program" &&
        ghidraMissingProgramNames(observed, programName),
    )
  )
    return missingProjectProgram(
      programName,
      limits.ghidraExistingProject?.programName !== undefined,
      context,
    );
  const javaHomeSave = output?.launcherFailures.find(
    (observed) => observed.kind === "java_home_save_denied",
  );
  if (javaHomeSave !== undefined)
    return new ProviderAdapterError("ghidra", operation, {
      ...context,
      userMessage: `Ghidra's launcher could not open ${javaHomeSave.path} ("Access is denied", Win32 error 5), so Ghidra exited before its bridge started. The output does not establish why the host denied the write.${
        uncertainty === undefined ? "" : ` ${uncertainty}`
      }`,
      remediationAction: GHIDRA_RESTRICTED_TEMP_REMEDIATION,
    });
  const killed = projectSigkill(operation, failure, context, {
    restart: exitedProviderMessage(operation, failure, health, source),
    uncertainty,
  });
  if (killed !== undefined) return killed;
  if (failure.kind === "timeout") {
    const timeoutMs = failure.timeoutMs ?? limits.ghidraStartupTimeoutMs;
    const guidance =
      failure.message === GHIDRA_STARTUP_DEADLINE_ELAPSED
        ? ghidraStartupTimeoutGuidance(timeoutMs, source)
        : undefined;
    return new AnalysisTimeoutError(operation, timeoutMs, {
      ...context,
      ...guidance,
      ...(uncertainty === undefined
        ? {}
        : {
            userMessage: `${
              guidance?.userMessage ??
              `Ghidra did not finish within its ${String(timeoutMs)} ms deadline.`
            } ${uncertainty}`,
          }),
    });
  }
  const exited = exitedProviderMessage(operation, failure, health, source);
  if (exited !== undefined)
    return new ProviderAdapterError("ghidra", operation, {
      ...context,
      userMessage:
        uncertainty === undefined ? exited : `${exited} ${uncertainty}`,
    });
  return new ProviderAdapterError("ghidra", operation, {
    ...context,
    ...(uncertainty === undefined
      ? {}
      : {
          userMessage: uncertainty,
          remediationAction:
            "Review the retained Ghidra diagnostics and capture complete launcher output before choosing resource-specific recovery.",
        }),
  });
};

const observedJvmFailureSchema = z.object({
  stream: z.enum(["stdout", "stderr"]),
  offset: z.number().int().nonnegative(),
  line: z.string().min(1),
  area: z.enum(RUNTIME_EXHAUSTION_AREAS).optional(),
});

interface GhidraFailureOutputView {
  /** Memory areas the supervisor parsed from each observed OOME line. */
  readonly oomAreas: ReadonlySet<RuntimeExhaustionArea | undefined> | undefined;
  readonly complete: boolean | undefined;
  readonly launcherFailures: readonly GhidraLauncherFailure[];
  readonly launcherFailuresTruncated: boolean;
}

const launcherFailureEvidence = {
  stream: z.enum(["stdout", "stderr"]),
  line: z.string().min(1),
};
const launcherFailuresSchema = z.object({
  failures: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("missing_program"),
        ...launcherFailureEvidence,
        requested: z.string(),
      }),
      z.object({
        kind: z.literal("java_home_save_denied"),
        ...launcherFailureEvidence,
        path: z.string().min(1),
      }),
    ]),
  ),
  truncated: z.boolean(),
});

/** Guidance for a `-process` name that selects no root program in the project. */
export const ghidraMissingProgramGuidance = (
  programName: string,
  configured: boolean,
) => {
  const origin = configured
    ? "set by REA_GHIDRA_PROGRAM_NAME"
    : "defaulted from the target file name because REA_GHIDRA_PROGRAM_NAME is unset";
  return {
    constraint: `Ghidra found no root program named ${JSON.stringify(programName)} (${origin}) in the selected REA_GHIDRA_PROJECT_PATH project.`,
    remediationAction:
      "Set REA_GHIDRA_PROGRAM_NAME to the exact name of a root program in the selected project, in the environment that starts REA (your shell or the MCP client's registration), then restart REA and open the target again. REA did not modify the project or fall back to a fresh import.",
  };
};

/** The selected project is preserved; only the program choice is reported. */
const missingProjectProgram = (
  programName: string,
  configured: boolean,
  context: {
    readonly cause: GhidraSessionError;
    readonly diagnostics: Readonly<Record<string, JsonValue>>;
  },
): ConfigurationError => {
  const { constraint, remediationAction } = ghidraMissingProgramGuidance(
    programName,
    configured,
  );
  return new ConfigurationError(constraint, {
    ...context,
    settings: [{ setting: "REA_GHIDRA_PROGRAM_NAME", constraint }],
    remediationAction,
  });
};

/** Read the scoped capture once; unavailable fields remain unconfirmed. */
const readGhidraFailureOutput = (
  scoped: JsonValue | undefined,
): GhidraFailureOutputView | undefined => {
  if (scoped === null || typeof scoped !== "object" || Array.isArray(scoped))
    return undefined;
  const observedAreas = Array.isArray(scoped.observed_oome)
    ? scoped.observed_oome.flatMap((observed) => {
        const parsed = observedJvmFailureSchema.safeParse(observed);
        return parsed.success ? [parsed.data.area] : [];
      })
    : [];
  const launcherFailures = launcherFailuresSchema.safeParse(
    scoped.launcher_failures,
  );
  return {
    oomAreas: observedAreas.length === 0 ? undefined : new Set(observedAreas),
    complete:
      typeof scoped.complete === "boolean" ? scoped.complete : undefined,
    launcherFailures: launcherFailures.success
      ? launcherFailures.data.failures
      : [],
    // An unreadable failure list is not evidence that no launcher failure occurred.
    launcherFailuresTruncated: launcherFailures.success
      ? launcherFailures.data.truncated
      : scoped.launcher_failures !== undefined,
  };
};

/**
 * Project OOME evidence captured during the operation that failed, including
 * OOME lines the process supervisor observed beyond the retention budget.
 */
const projectObservedJvmMemoryFailure = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
  context: {
    readonly cause: GhidraSessionError;
    readonly diagnostics: Readonly<Record<string, JsonValue>>;
  },
  scoped: GhidraFailureOutputView | undefined,
): AnalysisResourceConstraintError | undefined => {
  const areas = scoped?.oomAreas;
  if (areas === undefined) return undefined;
  const threadCapacity = areas.has("native-thread");
  const heapExhaustion = areas.has("heap") || areas.has("gc-overhead");
  const detail = JVM_EXHAUSTION_DETAILS.find(([, area]) =>
    areas.has(area),
  )?.[0];
  if (threadCapacity)
    return new AnalysisResourceConstraintError(
      operation,
      "capacity",
      "Ghidra's process output reports an OutOfMemoryError while creating a native thread. This is observed capacity evidence; it does not establish a process limit or the precise cause.",
      null,
      {
        ...context,
        remediationAction:
          "Reduce concurrent analysis processes or review the host's available thread and process capacity, then retry.",
      },
    );
  const configuredHeap = failure.diagnostics.configured_jvm_max_heap;
  const reportedLimits = heapExhaustion
    ? {
        configured_jvm_max_heap:
          typeof configuredHeap === "string" ? configuredHeap : null,
      }
    : null;
  return new AnalysisResourceConstraintError(
    operation,
    "memory",
    `Ghidra's operation-scoped process output reports java.lang.OutOfMemoryError${detail === undefined ? "" : `: ${detail}`}. This is reported evidence and does not prove the exact allocation failure.`,
    reportedLimits,
    {
      ...context,
      ...(heapExhaustion
        ? {
            remediationAction:
              "If the host has available memory, consider increasing GHIDRA_HEADLESS_MAXMEM or disabling expensive analyzers with REA_GHIDRA_DISABLED_ANALYZERS, then retry.",
          }
        : {}),
    },
  );
};

/** Outcome addition that only a caller keeping the Ghidra session receives. */
const GHIDRA_SESSION_RETAINED = "The Ghidra session remains usable.";

/** The same addition when a failed search leaves session annotations intact. */
const GHIDRA_ANNOTATIONS_RETAINED =
  "The active analysis session and annotations remain available.";

/** What a new Ghidra session repeats in the configured startup mode. */
const ghidraSessionRestart = (source: GhidraSessionSource): string =>
  source === "existing-project"
    ? "copies and opens the selected REA_GHIDRA_PROJECT_PATH project again, without import or auto-analysis"
    : source === "owned-checkpoint"
      ? "restores the last saved Program from REA_GHIDRA_CHECKPOINT_DIR; if initial analysis never completed, it must finish once before a checkpoint exists"
      : "repeats import and analysis";

/**
 * Decompile-deadline recovery for each caller lifetime. A finished invocation
 * can raise the deadline only for a new invocation; a continuing caller can
 * update it for the next operation on the same Program.
 */
const ghidraDecompileTimeoutRecovery = (
  seconds: number,
  source: GhidraSessionSource,
): {
  readonly remediationAction: string;
  readonly continuingRemediationAction: string;
} => ({
  remediationAction: `${
    seconds < MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS
      ? `Set REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS above ${String(seconds)} seconds (maximum ${String(MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS)}), or unset it to leave decompilation unbounded,`
      : `REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS is already at its maximum of ${String(seconds)} seconds; unset it to leave decompilation unbounded`
  } in the environment of a new REA invocation, then rerun the command. That invocation starts a new Ghidra session and ${ghidraSessionRestart(source)}. Use analyze_function for this procedure's listing facts without pseudocode.`,
  continuingRemediationAction:
    "Use analyze_function for listing facts. Call update_analysis_settings with setting ghidra.decompile_timeout_seconds and action set to raise the per-function deadline for the next operation on this Program. For CLI or future REA processes, set REA_GHIDRA_DECOMPILE_TIMEOUT_SECONDS. Set the MCP tool-call deadline to cover startup and the full call; earlier cancellation closes the session. `rea setup` estimates deadlines for new Codex/Kimi registrations and preserves existing positive values; edit existing deadlines yourself.",
});

/**
 * Interpret the queue's observed cancellation and cleanup outcome once. A
 * session that survived this request stays usable only to a caller that keeps
 * it, so that fact is continuing-caller guidance rather than the outcome.
 */
const ghidraRequestOutcome = (
  failure: GhidraSessionError,
  requestScope: string | undefined,
  retainedSession: string,
  source: GhidraSessionSource,
): {
  readonly userMessage: string;
  readonly continuingCallerGuidance?: { readonly userMessage: string };
} => {
  const detail = `${failure.message.trim().replace(/\.$/u, "")}.`;
  if (failure.concurrentCancellation === undefined)
    return {
      userMessage:
        requestScope === undefined ? detail : `${detail} ${requestScope}`,
      continuingCallerGuidance: { userMessage: retainedSession },
    };
  return {
    userMessage: `${detail} ${
      failure.cleanupFailure === undefined
        ? `The request was also cancelled before the failure settled, so REA closed the Ghidra session; the next request starts a new session and ${ghidraSessionRestart(source)}.`
        : "The request was also cancelled, and Ghidra session shutdown left cleanup unconfirmed. Close the target to retry retained cleanup before starting another Ghidra session."
    }`,
  };
};

const memoryCgroupSchema = z.object({
  path: z.string(),
  oom_kill_before: z.number().int().nonnegative(),
  oom_kill_after: z.number().int().nonnegative(),
  memory_max: z
    .union([z.number().int().nonnegative(), z.literal("max")])
    .nullable(),
});

const GHIDRA_PROCESS_TREE_MEMORY_ACTION =
  "A memory limit covers Ghidra's native decompiler processes as well as its Java heap, and their number follows the available CPUs, so a larger GHIDRA_HEADLESS_MAXMEM does not help. Raise the container or host memory limit, or allow fewer CPUs with a longer REA_GHIDRA_STARTUP_TIMEOUT_MS.";

/**
 * Own SIGKILL interpretation for startup and running-provider failures.
 * The signal alone leaves its cause unknown. For process/protocol failures
 * observed before REA requested a stop, a rising cgroup oom_kill count supplies
 * separate memory evidence. That count covers the cgroup and its child groups,
 * not only REA's process tree.
 */
const projectSigkill = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
  context: {
    readonly cause: GhidraSessionError;
    readonly diagnostics: Readonly<Record<string, JsonValue>>;
  },
  guidance: {
    readonly restart: string | undefined;
    readonly uncertainty: string | undefined;
  },
): AnalysisError | undefined => {
  if (
    (failure.kind !== "start" &&
      failure.kind !== "process" &&
      failure.kind !== "protocol") ||
    failure.diagnostics.exit_signal !== "SIGKILL"
  )
    return undefined;
  const retry = guidance.restart ?? "Then retry.";
  const cgroup = memoryCgroupSchema.safeParse(
    failure.diagnostics.memory_cgroup,
  );
  if (
    (failure.kind === "process" || failure.kind === "protocol") &&
    failure.diagnostics.stop_requested === false &&
    cgroup.success &&
    cgroup.data.oom_kill_after > cgroup.data.oom_kill_before
  ) {
    const configuredHeap = failure.diagnostics.configured_jvm_max_heap;
    return new AnalysisResourceConstraintError(
      operation,
      "memory",
      `Ghidra was killed by SIGKILL while the oom_kill count of REA's cgroup ${cgroup.data.path} rose from ${String(cgroup.data.oom_kill_before)} to ${String(cgroup.data.oom_kill_after)}, so the kernel OOM killer ended a process in that cgroup or one of its child groups. The Java heap need not have been full.`,
      {
        cgroup_memory_max: cgroup.data.memory_max,
        configured_jvm_max_heap:
          typeof configuredHeap === "string" ? configuredHeap : null,
      },
      {
        ...context,
        remediationAction: `${GHIDRA_PROCESS_TREE_MEMORY_ACTION} ${retry}`,
      },
    );
  }
  return new ProviderAdapterError("ghidra", operation, {
    ...context,
    userMessage: `Ghidra process diagnostics report termination by SIGKILL. The signal alone does not establish its cause or an out-of-memory failure.${guidance.uncertainty === undefined ? "" : ` ${guidance.uncertainty}`}`,
    remediationAction:
      "Review the retained process output and host or container termination records before choosing a resource-specific remedy. Export useful Evidence, close the binary and resolve any cleanup failure, then call open_binary for the same target to start a new Ghidra session. Session-only annotations are not retained.",
  });
};

/** Name the settings that change Ghidra's startup deadline for the configured startup mode. */
export const ghidraStartupTimeoutGuidance = (
  timeoutMs: number,
  source: GhidraSessionSource,
) => {
  const remediation = (continuing: boolean): string => {
    const raise = continuing
      ? `use update_analysis_settings with setting ghidra.startup_timeout_ms and action set above ${String(timeoutMs)}, or set REA_GHIDRA_STARTUP_TIMEOUT_MS in the launch environment for future REA processes`
      : `set REA_GHIDRA_STARTUP_TIMEOUT_MS above ${String(timeoutMs)} in the environment of a new REA invocation, then rerun the command`;
    const retry = continuing
      ? "Export useful Evidence and resolve any retained cleanup before starting a new provider attempt. Runtime updates apply to the next startup attempt without restarting REA."
      : "Resolve any retained cleanup before rerunning.";
    const client = continuing
      ? " The MCP client's tool-call deadline must also allow startup and the query."
      : "";
    const reopen = continuing ? "Reopening" : "Each invocation";
    return source === "existing-project"
      ? `Large projects can need longer: ${raise}. Existing-project mode does not run auto-analysis, so analyzer settings do not shorten this startup. ${retry}${client}`
      : source === "owned-checkpoint"
        ? `Checkpoint startup can need longer: ${raise}. Restoring a saved Program skips auto-analysis; initial analysis and its first checkpoint must complete once. ${retry} Keep REA_GHIDRA_CHECKPOINT_DIR to recover the last successful save. Analyzer overrides require explicitly disabling checkpoint mode.${client}`
        : `Large binaries can need longer: ${raise}; REA_GHIDRA_DISABLED_ANALYZERS can skip selected expensive analyzers with reduced coverage. ${retry} ${reopen} repeats import from scratch; --snapshot reuses cached query results, not the analyzed Ghidra Program. For repeated work on supported native ELF, PE or Mach-O binaries on Linux/macOS, opt into REA_GHIDRA_CHECKPOINT_DIR to save completed analysis automatically, or select an analyzed project with REA_GHIDRA_PROJECT_PATH. Checkpoint mode excludes analysis overrides; use a project already analyzed with the desired settings for customized analysis. Changing startup mode requires a new REA invocation or an MCP server restart. Initial analysis must still complete once.${client}`;
  };
  return {
    limit: analysisSettingLimit(
      "ghidra.startup_timeout_ms",
      timeoutMs,
      undefined,
    ),
    userMessage:
      source === "existing-project"
        ? `Ghidra did not finish copying and opening the selected project within its configured ${String(timeoutMs)} ms startup deadline (REA_GHIDRA_STARTUP_TIMEOUT_MS).`
        : source === "owned-checkpoint"
          ? `Ghidra did not finish checkpoint restore or initial analysis and saving within its configured ${String(timeoutMs)} ms startup deadline (REA_GHIDRA_STARTUP_TIMEOUT_MS).`
          : `Ghidra did not finish importing and analyzing the target within its configured ${String(timeoutMs)} ms startup deadline (REA_GHIDRA_STARTUP_TIMEOUT_MS).`,
    remediationAction: remediation(false),
    continuingCallerGuidance: { remediationAction: remediation(true) },
  };
};

/** A provider already observed as running can be restarted by reopening. */
const exitedProviderMessage = (
  operation: AnalysisOperation,
  failure: GhidraSessionError,
  health: ProviderOperationHealth | undefined,
  source: GhidraSessionSource,
): string | undefined => {
  if (failure.kind !== "process" && failure.kind !== "protocol")
    return undefined;
  if (
    health === undefined ||
    providerRetryAction(health.state) !== "restart_provider"
  )
    return undefined;
  const observed =
    health.state === "exited"
      ? `exited${health.exitCode === null ? "" : ` with code ${String(health.exitCode)}`}`
      : "became unreachable";
  return `The Ghidra provider for this session ${observed} before ${operation} could complete. Call open_binary for the same target to start a new Ghidra session, then retry; ${source === "owned-checkpoint" ? "the last successful checkpoint is restored, and later unsaved annotations are not retained" : "session-only annotations from the previous provider are not retained"}.`;
};
