import type { WorkflowAnalysisPort } from "../WorkflowEvidence.js";
import type { ProgressReporter } from "../../ports/ProgressReporter.js";
import {
  ExportPublishedCleanupFailure,
  type StagedExportFile,
} from "./exportResources.js";
import { join } from "node:path";
import { z } from "zod";
import type { PseudocodeAbsence } from "../../domain/native/pseudocodeAbsence.js";

import { ArtifactReaderFailure } from "../../resources/index.js";

import {
  DECOMPILE_DIRECTORY_INDEX_NAME,
  DECOMPILE_DIRECTORY_INLINE_FAILURE_LIMIT,
  DECOMPILE_DIRECTORY_INLINE_FAILURE_BYTES,
  decompileDirectoryManifestSchema,
  type DecompileDirectoryFunctionRecord,
  type DecompileDirectoryInput,
  type DecompileDirectoryInlineFailure,
} from "../../contracts/decompileDirectory.js";
import { jsonValueByteLength } from "../../domain/jsonValueByteLength.js";
import { digestSchema } from "../../domain/digests.js";
import {
  UPCOMING_DECOMPILES_WINDOW,
  type AnalysisExecution,
  type AnalysisOperationPort,
} from "../../ports/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisTimeoutError,
  isAborted,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupDependencies } from "../../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { procedureInfoSchema } from "../../domain/native/procedureInfo.js";
import { listProceduresFact } from "../../domain/native/nativeOperationFacts.js";
import { executeFact } from "../AnalysisOperationFacts.js";
import { addressCoordinate } from "../../domain/native/addressCoordinate.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { inlineLinkedSessionLimitations } from "../binary/SessionLimitationContext.js";
import {
  classifyOutputPath,
  DecompileExport,
  exportOutputFailure,
  type ExportIdentity,
  type UnknownBodies,
} from "./exportTree.js";
import {
  bodyRecord,
  functionFileText,
  type FunctionBody,
} from "./functionFile.js";
import {
  selectProcedures,
  validateDecompileBounds,
  type SelectedProcedure,
} from "./selection.js";

const DWARF_LAYOUT_UNAVAILABLE =
  "Debug compilation-unit layout is unavailable. Files are named by canonical address.";
const BODY_UNAVAILABLE =
  "procedure_info is unavailable, so function body ranges are unknown.";
const TARGET_DIGEST_UNAVAILABLE =
  "Target SHA-256 was not observed, so this export cannot be resumed.";
const PROFILE_UNAVAILABLE =
  "The provider did not commit an analysis profile, so this export cannot be resumed.";
const DUPLICATE_ADDRESSES =
  "Duplicate procedure addresses were coalesced to the first matching inventory row.";
/**
 * How long one provider request for a function may stay pending before the
 * export names it, and how often it repeats while the wait continues. A
 * provider may be unable to bound or interrupt one decompilation, so the wait
 * itself is reported.
 */
export const FUNCTION_WAIT_REPORT_INTERVAL_MS = 5_000;
/** Consecutive output_io failures after which an export stops. */
export const OUTPUT_IO_STREAK_LIMIT = 5;
const unaddressedRows = (count: number): string =>
  `${count.toString()} inventory row(s) had no address and were not exported.`;
/** Summarizes every retained record, including those earlier runs wrote. */
const unknownBodyRecords = (unknown: UnknownBodies): string =>
  `${unknown.count.toString()} exported function record(s) report an unavailable body${
    unknown.sharedReason === undefined
      ? ` for differing reasons; see each record's body.reason in ${DECOMPILE_DIRECTORY_INDEX_NAME}.`
      : `: ${unknown.sharedReason}`
  }`;

interface FailureReason {
  readonly code: string;
  readonly message: string;
}

type InlineFailure = DecompileDirectoryInlineFailure;
type NamedFailure = Extract<InlineFailure, { readonly name: string | null }>;

interface PublishState {
  /** Functions this call took on after skipping verified files; bounded by limit. */
  attempted: number;
  written: number;
  failed: number;
  /** Functions procedure_info classifies as external: not decompiled, no file. */
  external: number;
  skipped: number;
  readonly failures: InlineFailure[];
  inlineFailureBytes: number;
  readonly recentFailures: PublishState["failures"];
  /**
   * Functions the next decompile request names as upcoming, itself first. The
   * request that carries them clears it.
   */
  readAhead: readonly string[] | undefined;
  /**
   * Consecutive output_io failures. A verified file, a write, or any other
   * outcome ends the run of failures; a recorded external function does not.
   */
  outputIoStreak: number;
}

/**
 * The directory outlives the session, so its files, journal and index keep the
 * full text of session limitations a result only references.
 */
const withInlineSessionLimitations = (
  session: WorkflowAnalysisPort,
): WorkflowAnalysisPort => ({
  ...(session.resourceScope === undefined
    ? {}
    : { resourceScope: session.resourceScope }),
  execute: async (operation, parameters, options) => {
    const executed = await session.execute(operation, parameters, options);
    return executed.ok
      ? ok(inlineLinkedSessionLimitations(executed.value))
      : executed;
  },
  ...(session.recordItemLimitations === undefined
    ? {}
    : {
        recordItemLimitations: (operation, execution) =>
          session.recordItemLimitations?.(operation, execution),
      }),
});

/**
 * Write one pseudocode file per selected function and return only a manifest.
 * Files already committed stay in place when a later function fails or the
 * caller cancels, and functions decompiled before that point are committed
 * first.
 */
export const decompileAll = async (
  sessionAnalysis: WorkflowAnalysisPort,
  input: DecompileDirectoryInput,
  signal?: AbortSignal,
  progress?: ProgressReporter,
): Promise<Result<JsonValue, AnalysisError>> => {
  const analysis = withInlineSessionLimitations(sessionAnalysis);
  const bounds = validateDecompileBounds(input);
  if (!bounds.ok) return bounds;
  const placement = await classifyOutputPath(
    input.output_directory,
    input.resume,
  );
  if (!placement.ok) return placement;
  if (isAborted(signal)) return err(cancelledBy("decompile_all", signal));
  const loaded = await loadProcedures(analysis, input.layout, signal);
  if (!loaded.ok) return loaded;
  if (isAborted(signal)) return err(cancelledBy("decompile_all", signal));
  const selection = selectProcedures(
    loaded.value.procedures,
    input,
    bounds.value,
  );
  const inventoryLimitations = loaded.value.limitations;
  const opened = await DecompileExport.open({
    placement: placement.value,
    identity: loaded.value.identity,
    resourceScope: analysis.resourceScope,
  });
  if (!opened.ok) return opened;
  const session = opened.value;
  const state: PublishState = {
    attempted: 0,
    written: 0,
    failed: 0,
    external: 0,
    skipped: 0,
    failures: [],
    inlineFailureBytes: 2,
    recentFailures: [],
    readAhead: undefined,
    outputIoStreak: 0,
  };
  let published: Result<void, AnalysisError> | undefined;
  let indexed: Result<void, AnalysisError> | undefined;
  let limitations: readonly string[] = [];
  let closed: Result<void, AnalysisError> | undefined;
  // The journal handle is closed on every path, including an unexpected throw.
  try {
    published = await publishSelected({
      analysis,
      session,
      procedures: attemptOrder(session, selection.procedures),
      identity: loaded.value.identity,
      signal,
      progress,
      limit: input.limit,
      retryFailed: input.retry_failed,
      state,
    });
    limitations = exportLimitations(
      input.layout,
      loaded.value.identity,
      selection.collapsedDuplicates,
      session.unknownBodies(),
      loaded.value.unaddressed,
    );
    indexed = await session.writeIndex({
      layoutStatus: layoutStatus(input.layout),
      limitations,
      latestRun: {
        resume: input.resume,
        selected: selection.procedures.length,
        excluded: selection.excluded,
        selection: {
          name: input.name ?? null,
          namespace: input.namespace ?? null,
          address_start: input.address_start ?? null,
          address_end: input.address_end ?? null,
          limit: input.limit ?? null,
        },
        inventoryLimitations,
      },
    });
  } finally {
    closed = await session.close();
  }
  // A publish, index or close failure stays primary: the journal or index
  // may be incomplete and the caller needs that reason. Cancellation only
  // replaces success, so an index or close failure after the caller's abort
  // stopped the publish loop is still reported. A provider's own
  // cancellation, without a caller abort, is a publish failure like any other.
  const callerStoppedPublish =
    !published.ok &&
    published.error instanceof AnalysisCancelledError &&
    !published.error.cleanupIncomplete &&
    isAborted(signal);
  const failures = [
    ...(!published.ok && !callerStoppedPublish ? [published.error] : []),
    ...(indexed.ok ? [] : [indexed.error]),
    ...(closed.ok ? [] : [closed.error]),
  ];
  const primary = failures[0];
  const publishedIndex = indexed.ok
    ? join(session.root, DECOMPILE_DIRECTORY_INDEX_NAME)
    : indexed.error.cause instanceof ExportPublishedCleanupFailure
      ? indexed.error.cause.publishedPath
      : undefined;
  const publishedOutput =
    publishedIndex === undefined
      ? undefined
      : { output_directory: session.root, index_path: publishedIndex };
  if (primary !== undefined) {
    if (
      isAborted(signal) &&
      !(
        primary instanceof AnalysisCancelledError &&
        primary.cause === signal?.reason
      )
    )
      primary.retainSecondaryFailure(cancelledBy("decompile_all", signal));
    const failure = composeFailures(primary, failures.slice(1));
    if (publishedOutput !== undefined)
      failure.retainPrimaryDiagnostics({ published_output: publishedOutput });
    return err(failure);
  }
  // Finalization succeeded, so committed files and the index are usable on
  // resume, but a caller abort that stopped the loop or arrived meanwhile is
  // not a success. Report it with the caller's own reason.
  if (isAborted(signal)) {
    const failure = cancelledBy("decompile_all", signal);
    if (publishedOutput !== undefined)
      failure.retainPrimaryDiagnostics({ published_output: publishedOutput });
    return err(failure);
  }
  const manifest = decompileDirectoryManifestSchema.safeParse(
    manifestOf({
      root: session.root,
      input,
      identity: loaded.value.identity,
      selected: selection.procedures.length,
      excluded: selection.excluded,
      state,
      limitations,
      inventoryLimitations,
    }),
  );
  return manifest.success
    ? ok(manifest.data)
    : err(
        new AnalysisOutputError(
          "decompile_all",
          "decompile manifest could not be built",
        ),
      );
};

/**
 * Functions with no recorded failure go first, so a limited resume reaches
 * new work instead of retrying the same failures every call.
 */
const attemptOrder = (
  session: DecompileExport,
  procedures: readonly SelectedProcedure[],
): readonly SelectedProcedure[] => {
  const failedBefore = (procedure: SelectedProcedure): boolean =>
    session.record(procedure.address)?.status === "failed";
  return [
    ...procedures.filter((procedure) => !failedBefore(procedure)),
    ...procedures.filter(failedBefore),
  ];
};

const loadProcedures = async (
  analysis: AnalysisOperationPort,
  layout: DecompileDirectoryInput["layout"],
  signal: AbortSignal | undefined,
): Promise<
  Result<
    {
      readonly procedures: readonly SelectedProcedure[];
      readonly identity: ExportIdentity;
      readonly unaddressed: number;
      readonly limitations: readonly string[];
    },
    AnalysisError
  >
> => {
  const inventory = await executeFact(
    analysis,
    listProceduresFact,
    {},
    executionOptions(signal),
  );
  if (!inventory.ok) return inventory;
  const identity = identityFrom(inventory.value.execution, layout);
  if (!identity.ok) return identity;
  // An empty address cannot name a file or a journal record.
  const addressed = inventory.value.fact.filter(
    (row) => row.address.length > 0,
  );
  return ok({
    procedures: addressed.map((row) => ({
      address: row.address,
      name: row.value.length === 0 ? null : row.value,
    })),
    identity: identity.value,
    unaddressed: inventory.value.fact.length - addressed.length,
    limitations: inventory.value.execution.limitations,
  });
};

const identityFrom = (
  execution: AnalysisExecution,
  layout: DecompileDirectoryInput["layout"],
): Result<ExportIdentity, AnalysisError> => {
  const sha = execution.subject?.sha256 ?? null;
  if (sha !== null && !digestSchema.safeParse(sha).success)
    return err(
      new AnalysisOutputError(
        "list_procedures",
        "provider returned a target digest that is not a SHA-256",
      ),
    );
  const profile = execution.analysisProfile?.digest ?? null;
  if (profile !== null && !digestSchema.safeParse(profile).success)
    return err(
      new AnalysisOutputError(
        "list_procedures",
        "provider returned an analysis profile digest that is not a SHA-256",
      ),
    );
  const provider = execution.provider;
  if (provider.id.length === 0 || provider.name.length === 0)
    return err(
      new AnalysisOutputError(
        "list_procedures",
        "provider identity is incomplete",
      ),
    );
  if (provider.version !== null && provider.version.length === 0)
    return err(
      new AnalysisOutputError(
        "list_procedures",
        "provider identity is incomplete",
      ),
    );
  return ok({
    targetSha256: sha,
    provider: {
      id: provider.id,
      name: provider.name,
      version: provider.version,
    },
    analysisProfileDigest: profile,
    layout,
  });
};

interface PublishInput {
  readonly analysis: WorkflowAnalysisPort;
  readonly session: DecompileExport;
  readonly procedures: readonly SelectedProcedure[];
  readonly identity: ExportIdentity;
  readonly signal: AbortSignal | undefined;
  readonly progress: ProgressReporter | undefined;
  readonly limit: number | undefined;
  readonly retryFailed: DecompileDirectoryInput["retry_failed"];
  readonly state: PublishState;
}

/**
 * Functions settled per durable commit. Each function's bytes are synced in
 * staging while later functions are decompiled; a full group then publishes
 * its files in order and appends its journal records with one sync, instead of
 * one journal sync per function. A fixed ceiling rather than a setting: it
 * changes only how often the same durable state is reached. It bounds what a
 * stopped process leaves unrecorded (at most this many functions, which a
 * resume decompiles again), the pseudocode and staging directories held at
 * once, and the file syncs in flight. Larger groups save little more, because
 * the journal sync is already shared by this many functions.
 */
export const COMMIT_GROUP_SIZE = 8;

/**
 * Time since the previous commit after which the next settled function commits
 * the group, whatever its size. Grouping pays only while functions settle
 * faster than a sync; without this bound a slow provider would leave up to a
 * full group of long decompilations unrecorded when the process stops. With
 * it, a provider that needs this long per function is committed function by
 * function, as it was before grouping, and one extra journal sync per interval
 * costs nothing measurable. The bound is checked when a function settles, so
 * it does not cover functions waiting behind one that is still pending. A
 * fixed ceiling for the same reason as the group size.
 */
export const COMMIT_GROUP_MAX_OPEN_MS = 1_000;

/** What one attempted function came to, before any journal or count effect. */
type AttemptOutcome =
  | {
      readonly kind: "external";
      readonly record: DecompileDirectoryFunctionRecord;
    }
  | {
      readonly kind: "failed";
      readonly reason: FailureReason;
      readonly record: DecompileDirectoryFunctionRecord;
      readonly pseudocodeAbsence?: PseudocodeAbsence | undefined;
    }
  | {
      readonly kind: "file";
      readonly relativePath: string;
      readonly bytes: Buffer;
      /** Staging runs while later functions are decompiled. */
      readonly staged: Promise<StagedExportFile>;
      readonly body: FunctionBody;
      readonly caveats: readonly string[];
      readonly providerSource: NonNullable<
        DecompileDirectoryFunctionRecord["provider_source"]
      >;
    }
  /** The export ends here, after everything before it is committed. */
  | { readonly kind: "stopped"; readonly error: AnalysisError };

interface Attempt {
  readonly outcome: AttemptOutcome;
  readonly bodySupport: "unknown" | "unavailable";
}

/** One function's effect on the journal and counts, applied in visit order. */
type Pending =
  /** The recorded file verified; a stale later failure is superseded. */
  | {
      readonly kind: "verified";
      readonly reappend: DecompileDirectoryFunctionRecord | undefined;
    }
  | { readonly kind: "retained_external" }
  /**
   * The provider failure an independent retry followed. It joins the group
   * before the retry is requested, so a retry that throws cannot lose it.
   */
  | {
      readonly kind: "superseded";
      readonly record: DecompileDirectoryFunctionRecord;
    }
  | {
      readonly kind: "attempt";
      readonly procedure: SelectedProcedure;
      readonly attempt: Attempt;
    }
  | { readonly kind: "stopped"; readonly error: AnalysisError };

const publishSelected = async (
  input: PublishInput,
): Promise<Result<void, AnalysisError>> => {
  const group: Pending[] = [];
  try {
    return await publishGroups(input, group);
  } catch (cause: unknown) {
    // An unexpected throw, for example from a provider adapter, is not a
    // reason to drop the functions already decompiled. A throw from the
    // commit itself left the group empty, so nothing is settled twice.
    const committed = await commitGroup(input, group);
    if (committed.ok) throw cause;
    // The commit failed on functions before the throw. Before grouping, that
    // failure stopped the export before the call that threw, so it stays
    // primary and the throw is retained with it.
    return err(
      cause instanceof AnalysisError
        ? composeFailures(committed.error, [cause])
        : committed.error.retainDiagnostics({
            later_unexpected_throw:
              cause instanceof Error
                ? `${cause.name}: ${cause.message}`
                : String(cause),
          }),
    );
  }
};

const publishGroups = async (
  input: PublishInput,
  group: Pending[],
): Promise<Result<void, AnalysisError>> => {
  let bodySupport: "unknown" | "unavailable" = "unknown";
  // Attempts admitted against the limit; state.attempted follows at commit.
  let admitted = 0;
  let committedAt = performance.now();
  // Index after the last function a read-ahead window already examined.
  let preparedUntil = 0;
  // Decisions a read-ahead window made for later functions; the loop takes
  // each one instead of deciding that function again.
  const decided = new Map<number, ProcedureDecision>();
  const stop = (error: AnalysisError): Promise<Result<void, AnalysisError>> => {
    group.push({ kind: "stopped", error });
    return commitGroup(input, group);
  };
  for (const [index, procedure] of input.procedures.entries()) {
    if (isAborted(input.signal))
      return stop(cancelledBy("decompile_all", input.signal));
    const decision =
      decided.get(index) ??
      (await decideProcedure(input.session, procedure.address, input.signal));
    decided.delete(index);
    if (decision.kind === "error") return stop(decision.error);
    if (isAborted(input.signal))
      return stop(cancelledBy("decompile_all", input.signal));
    if (decision.kind === "skip") {
      // The file verified again after a later failure, so the journal and
      // index report it as written instead of keeping the stale failure.
      const written = input.session.lastWritten(procedure.address);
      group.push({
        kind: "verified",
        reappend:
          written !== undefined &&
          input.session.record(procedure.address) !== written
            ? written
            : undefined,
      });
    } else if (decision.kind === "external") {
      group.push({ kind: "retained_external" });
    } else {
      if (input.limit !== undefined && admitted >= input.limit) continue;
      if (decision.existing === "write" && index >= preparedUntil) {
        const window = await decompileReadAhead(
          input,
          index,
          admitted,
          decided,
        );
        preparedUntil = window.until;
        input.state.readAhead =
          window.procedures.length > 1 ? window.procedures : undefined;
      }
      admitted += 1;
      const attempt = await attemptOne(
        input,
        procedure,
        decision.existing,
        bodySupport,
        (record) => group.push({ kind: "superseded", record }),
        (operation, pending) =>
          reportingProviderWait(input, procedure, index, operation, pending),
      );
      bodySupport = attempt.bodySupport;
      group.push({ kind: "attempt", procedure, attempt });
      if (attempt.outcome.kind === "stopped") return commitGroup(input, group);
    }
    if (
      group.length >= COMMIT_GROUP_SIZE ||
      performance.now() - committedAt >= COMMIT_GROUP_MAX_OPEN_MS
    ) {
      const committed = await commitGroup(input, group);
      committedAt = performance.now();
      if (!committed.ok) return committed;
    }
  }
  return commitGroup(input, group);
};

/**
 * Commit the pending group and empty it. Function files are published in
 * visit order, each already synced in staging, and only then are the group's
 * journal records appended and synced together. A journal record therefore
 * never precedes its file's durable content, and cancellation or a failure
 * commits what was already decompiled before it is reported. The commit does
 * not observe the caller's signal: a group whose publication has started is
 * finished, so no published file is left without its record.
 */
const commitGroup = async (
  input: PublishInput,
  group: Pending[],
): Promise<Result<void, AnalysisError>> => {
  const records: DecompileDirectoryFunctionRecord[] = [];
  // Every entry's failure, in visit order. The first stops the export; the
  // rest are kept behind it, with any cleanup they still own.
  const stops: AnalysisError[] = [];
  for (const pending of group.splice(0)) {
    if (stops.length === 0) {
      const stopped = await settle(input, pending, records);
      if (stopped !== undefined) stops.push(stopped);
    } else await abandon(input, pending, stops);
  }
  const appended = await input.session.append(records);
  // The journal failed on functions before the stop, so it leads.
  const failures = appended.ok ? stops : [appended.error, ...stops];
  const [primary, ...later] = failures;
  return primary === undefined
    ? ok(undefined)
    : err(composeFailures(primary, later));
};

/**
 * Leave a function the export stopped before as if it had not been visited:
 * no file, record or count. Its provider observation already ran, though, so
 * a failure it observed, which may still own cleanup, is kept.
 */
const abandon = async (
  input: PublishInput,
  pending: Pending,
  stops: AnalysisError[],
): Promise<void> => {
  if (pending.kind === "stopped") stops.push(pending.error);
  if (pending.kind !== "attempt") return;
  const { outcome } = pending.attempt;
  if (outcome.kind === "file")
    await input.session.discardStaged(await outcome.staged);
  else if (outcome.kind === "stopped") stops.push(outcome.error);
};

/**
 * Keep `primary` and retain each later failure behind it as a secondary
 * failure. A later failure that still owns cleanup keeps the result
 * incomplete until that owner releases.
 */
const composeFailures = (
  primary: AnalysisError,
  later: readonly AnalysisError[],
): AnalysisError => {
  let failure = primary;
  for (const next of later) {
    primary.retainSecondaryFailure(next);
    if (next.cleanupIncomplete)
      failure = analysisErrorWithCleanupDependencies(
        failure,
        next,
        "decompile_all",
      );
  }
  return failure;
};

/**
 * Apply one pending outcome to the counts and collect its journal records.
 * Returns the error that ends the export at this function, if any.
 */
const settle = async (
  input: PublishInput,
  pending: Pending,
  records: DecompileDirectoryFunctionRecord[],
): Promise<AnalysisError | undefined> => {
  const { state } = input;
  if (pending.kind === "stopped") return pending.error;
  if (pending.kind === "retained_external") {
    state.skipped += 1;
    return undefined;
  }
  if (pending.kind === "superseded") {
    records.push(pending.record);
    return undefined;
  }
  if (pending.kind === "verified") {
    state.skipped += 1;
    // A file that reads back and verifies shows the directory works.
    state.outputIoStreak = 0;
    if (pending.reappend !== undefined) records.push(pending.reappend);
    return undefined;
  }
  const { procedure, attempt } = pending;
  const { outcome } = attempt;
  state.attempted += 1;
  if (outcome.kind === "stopped") return outcome.error;
  if (outcome.kind === "external") {
    // An external function writes no file, so it says nothing about the
    // directory and leaves the run of output_io failures as it is.
    state.external += 1;
    records.push(outcome.record);
    return undefined;
  }
  let failureCode: string | undefined;
  if (outcome.kind === "failed") {
    recordFailure(state, procedure, outcome.reason, outcome.pseudocodeAbsence);
    records.push(outcome.record);
    failureCode = outcome.reason.code;
  } else {
    const committed = await input.session.commitFunctionFile(
      outcome.relativePath,
      outcome.bytes,
      await outcome.staged,
    );
    if (committed.status === "error") return committed.error;
    if (committed.status === "conflict" || committed.status === "io") {
      const reason =
        committed.status === "conflict"
          ? {
              code: "output_exists",
              message:
                "The function file already exists and does not match this export.",
            }
          : {
              code: "output_io",
              message: "The function file could not be written.",
            };
      recordFailure(state, procedure, reason);
      records.push(
        failureRecord(procedure, outcome.body, reason, {
          relativePath: outcome.relativePath,
          limitations: outcome.caveats,
          providerSource: outcome.providerSource,
        }),
      );
      failureCode = reason.code;
    } else {
      records.push({
        address: procedure.address,
        name: procedure.name,
        status: "written",
        relative_path: outcome.relativePath,
        sha256: committed.sha256,
        // Matching existing bytes prove equality, not who originally wrote them.
        provider_source:
          committed.status === "matched"
            ? { status: "unknown", reason: "existing_file_origin_unknown" }
            : outcome.providerSource,
        body: bodyRecord(outcome.body),
        // The header may truncate; the journal keeps the complete list.
        ...(outcome.caveats.length === 0
          ? {}
          : { limitations: [...outcome.caveats] }),
      });
      state.written += committed.status === "written" ? 1 : 0;
      state.skipped += committed.status === "matched" ? 1 : 0;
    }
  }
  state.outputIoStreak =
    failureCode === "output_io" ? state.outputIoStreak + 1 : 0;
  // Repeated write failures mean the directory has stopped accepting files,
  // for example a full disk. Stop instead of decompiling every remaining
  // function only to fail its write. Committed files and records are kept.
  return state.outputIoStreak >= OUTPUT_IO_STREAK_LIMIT
    ? outputStoppedAccepting(state)
    : undefined;
};

/** What this call does with one selected function. */
type ProcedureDecision =
  /** Its file reads back and verifies against the journal. */
  | { readonly kind: "skip" }
  /** The journal records it as external; asking again would spend the limit. */
  | { readonly kind: "external" }
  /** It consumes the limit: decompile it, or report its file problem. */
  | { readonly kind: "attempt"; readonly existing: "write" | "conflict" | "io" }
  | { readonly kind: "error"; readonly error: AnalysisError };

const decideProcedure = async (
  session: DecompileExport,
  address: string,
  signal: AbortSignal | undefined,
): Promise<ProcedureDecision> => {
  const existing = await existingFile(session, address, signal);
  if (typeof existing === "object")
    return { kind: "error", error: existing.error };
  if (existing === "skip") return { kind: "skip" };
  // The journal header pins the target, provider and profile, so a
  // recorded external classification still holds. Asking again would only
  // spend the limit, and a limit below the external count would leave
  // functions remaining on every resume.
  // A conflicting or unreadable file at its reserved path is still reported
  // rather than hidden by the skip.
  if (existing === "write" && session.record(address)?.status === "external")
    return { kind: "external" };
  return { kind: "attempt", existing };
};

/**
 * The functions this call will decompile next, starting with the one at
 * `from`. Each later function is decided once, the way the loop decides it,
 * and the decision is kept for the loop. Every attempt, including a file
 * problem that decompiles nothing, counts against the caller's limit.
 */
const decompileReadAhead = async (
  input: PublishInput,
  from: number,
  admitted: number,
  decided: Map<number, ProcedureDecision>,
): Promise<{
  readonly procedures: readonly string[];
  readonly until: number;
}> => {
  // `admitted` counts attempts before this one; state.attempted follows only
  // when a group commits.
  const attemptsLeft =
    input.limit === undefined
      ? Number.POSITIVE_INFINITY
      : input.limit - admitted;
  const procedures = [input.procedures[from]!.address];
  let attempts = 1;
  let index = from + 1;
  for (; index < input.procedures.length; index++) {
    if (
      procedures.length >= UPCOMING_DECOMPILES_WINDOW ||
      attempts >= attemptsLeft
    )
      break;
    if (isAborted(input.signal)) break;
    const address = input.procedures[index]!.address;
    let decision = decided.get(index);
    if (decision === undefined) {
      decision = await decideProcedure(input.session, address, input.signal);
      decided.set(index, decision);
    }
    // The loop reports the failure when it reaches this function.
    if (decision.kind === "error") break;
    if (decision.kind !== "attempt") continue;
    attempts += 1;
    if (decision.existing === "write") procedures.push(address);
  }
  return { procedures, until: index };
};

/**
 * The planned window from the function this decompile request carries,
 * which a provider reads as its own. A function the window named earlier
 * may send no decompile request, for example when procedure_info classifies
 * it as external, so the window is rebased here rather than when planned.
 */
const takeReadAhead = (
  state: PublishState,
  address: string,
): readonly string[] | undefined => {
  const window = state.readAhead;
  state.readAhead = undefined;
  const from = window?.indexOf(address) ?? -1;
  const carried = from < 0 ? [] : window!.slice(from);
  return carried.length > 1 ? carried : undefined;
};

/** The provider requests an export makes for one function. */
type FunctionRequest = "procedure_info" | "procedure_pseudo_code";

/** Wrap one provider request for the current function in wait reporting. */
type ProviderWait = <Value>(
  operation: FunctionRequest,
  pending: Promise<Value>,
) => Promise<Value>;

const WAITING_FOR: Readonly<Record<FunctionRequest, string>> = {
  procedure_info: "read the body of",
  procedure_pseudo_code: "decompile",
};

/**
 * Name the function and the provider request an export is waiting on once it
 * has been pending for a reporting interval, and again each interval until it
 * settles. Only provider requests are timed: journal and file writes are the
 * export's own work, so a slow output volume is never reported as a provider
 * wait. Requests that settle sooner report nothing, so a healthy export stays
 * quiet.
 */
const reportingProviderWait = async <Value>(
  input: PublishInput,
  procedure: SelectedProcedure,
  index: number,
  operation: FunctionRequest,
  pending: Promise<Value>,
): Promise<Value> => {
  const { progress } = input;
  if (progress === undefined) return pending;
  const startedAt = performance.now();
  const subject =
    procedure.name === null
      ? procedure.address
      : `${procedure.name} at ${procedure.address}`;
  const timer = setInterval(() => {
    if (isAborted(input.signal)) return;
    const elapsedSeconds = Math.floor((performance.now() - startedAt) / 1000);
    // Reporting is observational; its failure cannot change the export.
    void Promise.resolve()
      .then(() =>
        progress.report({
          phase: "decompile_all",
          completed: index,
          total: input.procedures.length,
          message: `Waiting for the provider to ${WAITING_FOR[operation]} ${subject} (${String(elapsedSeconds)}s elapsed); function ${String(index + 1)} of ${String(input.procedures.length)} selected.`,
        }),
      )
      .catch(() => undefined);
  }, FUNCTION_WAIT_REPORT_INTERVAL_MS);
  try {
    return await pending;
  } finally {
    clearInterval(timer);
  }
};

/** One function this call takes on: report a file problem or decompile it. */
const attemptOne = async (
  input: PublishInput,
  procedure: SelectedProcedure,
  existing: "write" | "conflict" | "io",
  bodySupport: "unknown" | "unavailable",
  retainSuperseded: (record: DecompileDirectoryFunctionRecord) => void,
  providerWait: ProviderWait,
): Promise<Attempt> => {
  if (existing === "write")
    return observeOne({
      ...input,
      procedure,
      bodySupport,
      retainSuperseded,
      providerWait,
    });
  const reason =
    existing === "conflict"
      ? {
          code: "output_exists",
          message:
            "The function file already exists and does not match this export.",
        }
      : {
          code: "output_io",
          message: "The existing function file could not be read.",
        };
  const retained = retainedObservation(input.session, procedure.address);
  return {
    outcome: {
      kind: "failed",
      reason,
      record: failureRecord(procedure, retained.body, reason, {
        relativePath: input.session.pathFor(procedure.address),
        ...retained.options,
      }),
    },
    bodySupport,
  };
};

/** Ask the provider about one function and start staging its file, if any. */
const observeOne = async (input: {
  readonly analysis: WorkflowAnalysisPort;
  readonly session: DecompileExport;
  readonly procedure: SelectedProcedure;
  readonly identity: ExportIdentity;
  readonly signal: AbortSignal | undefined;
  readonly bodySupport: "unknown" | "unavailable";
  readonly retryFailed: DecompileDirectoryInput["retry_failed"];
  readonly retainSuperseded: (record: DecompileDirectoryFunctionRecord) => void;
  readonly state: PublishState;
  readonly providerWait: ProviderWait;
}): Promise<Attempt> => {
  const body = await readBody(
    input.analysis,
    input.procedure.address,
    input.identity,
    input.signal,
    input.bodySupport,
    input.providerWait,
  );
  if (body.kind === "error")
    return {
      outcome: { kind: "stopped", error: body.error },
      bodySupport: input.bodySupport,
    };
  let superseded = false;
  const attempt = (outcome: AttemptOutcome): Attempt => ({
    outcome,
    bodySupport: body.support,
  });
  const failed = (
    reason: FailureReason,
    options: Parameters<typeof failureRecord>[3],
    pseudocodeAbsence?: PseudocodeAbsence,
  ): Attempt =>
    attempt({
      kind: "failed",
      reason,
      record: failureRecord(input.procedure, body.fact, reason, options),
      pseudocodeAbsence,
    });
  // Caveats of the observations this attempt used. The journal record keeps
  // the complete list, written or failed, so the bounded Evidence summary and
  // the length-capped file header never hold the only copy.
  const infoCaveats = body.kind === "body" ? (body.limitations ?? []) : [];
  // procedure_info classifies the function as external, so this target holds
  // no code of its own to decompile. The record keeps the provider's body
  // fact as observed; it is reported as external, not as a failure.
  if (body.kind === "body" && body.external === true)
    return attempt({
      kind: "external",
      record: externalRecord(input.procedure, body.fact, infoCaveats),
    });
  const readAhead = takeReadAhead(input.state, input.procedure.address);
  let decompiled = await input.providerWait(
    "procedure_pseudo_code",
    input.analysis.execute(
      "procedure_pseudo_code",
      { procedure: input.procedure.address },
      {
        ...executionOptions(input.signal),
        ...(readAhead === undefined ? {} : { upcomingDecompiles: readAhead }),
      },
    ),
  );
  // A provider still owns cleanup even if the caller aborted meanwhile.
  if (!decompiled.ok && decompiled.error.cleanupIncomplete)
    return attempt({ kind: "stopped", error: decompiled.error });
  if (
    !isAborted(input.signal) &&
    decompiled.ok &&
    input.retryFailed === "independent_fresh" &&
    decompiled.value.result === null &&
    decompiled.value.pseudocodeAbsence?.kind === "provider-failure" &&
    observationMismatch(input.identity, decompiled.value) === undefined
  ) {
    const original = decompiled.value;
    input.analysis.recordItemLimitations?.("procedure_pseudo_code", original);
    const originalSource: NonNullable<
      DecompileDirectoryFunctionRecord["provider_source"]
    > =
      original.sourceDescriptor === undefined
        ? { status: "unknown", reason: "source_not_available" }
        : { status: "reported", source: original.sourceDescriptor };
    input.retainSuperseded(
      failureRecord(input.procedure, body.fact, pseudocodeFailure(null), {
        limitations: [...new Set([...infoCaveats, ...original.limitations])],
        providerSource: originalSource,
        pseudocodeAbsence: original.pseudocodeAbsence,
      }),
    );
    superseded = true;
    if (isAborted(input.signal))
      return attempt({
        kind: "stopped",
        error: cancelledBy("decompile_all", input.signal),
      });
    decompiled = await input.providerWait(
      "procedure_pseudo_code",
      input.analysis.execute(
        "procedure_pseudo_code",
        { procedure: input.procedure.address, analysis: "independent_fresh" },
        executionOptions(input.signal),
      ),
    );
    if (!decompiled.ok && decompiled.error.cleanupIncomplete)
      return attempt({ kind: "stopped", error: decompiled.error });
  }
  if (!decompiled.ok) {
    if (decompiled.error instanceof AnalysisCancelledError)
      return attempt({ kind: "stopped", error: decompiled.error });
    return failed(failureReason(decompiled.error), {
      limitations: infoCaveats,
    });
  }
  const mismatch = observationMismatch(input.identity, decompiled.value);
  if (mismatch !== undefined)
    return failed(mismatch, { limitations: infoCaveats });
  input.analysis.recordItemLimitations?.(
    "procedure_pseudo_code",
    decompiled.value,
  );
  const caveats = [
    ...new Set([
      ...infoCaveats,
      ...decompiled.value.limitations,
      ...(input.retryFailed === "independent_fresh" &&
      !superseded &&
      decompiled.value.result === null &&
      decompiled.value.pseudocodeAbsence?.kind !== "provider-failure"
        ? [
            "Independent retry was not attempted because the provider did not report a function failure for this observation.",
          ]
        : []),
    ]),
  ];
  const observationSource: NonNullable<
    DecompileDirectoryFunctionRecord["provider_source"]
  > =
    decompiled.value.sourceDescriptor === undefined
      ? { status: "unknown", reason: "source_not_available" }
      : { status: "reported", source: decompiled.value.sourceDescriptor };
  const pseudocode = decompiled.value.result;
  if (typeof pseudocode !== "string" || pseudocode.length === 0) {
    const reason =
      input.retryFailed === undefined &&
      pseudocode === null &&
      decompiled.value.pseudocodeAbsence?.kind === "provider-failure"
        ? {
            code: "no_pseudocode",
            message:
              "The provider reported a function decompilation failure. If it supports independent decompilation, resume this export with retry_failed: independent_fresh. The retry may use different analysis context.",
          }
        : pseudocodeFailure(pseudocode);
    return failed(
      reason,
      {
        limitations: caveats,
        providerSource: observationSource,
        ...(decompiled.value.pseudocodeAbsence === undefined
          ? {}
          : { pseudocodeAbsence: decompiled.value.pseudocodeAbsence }),
      },
      decompiled.value.pseudocodeAbsence,
    );
  }
  // Settled failures are classified and journaled despite a later caller
  // abort. A valid result still needs an active caller before a new function
  // file is staged.
  if (isAborted(input.signal))
    return attempt({
      kind: "stopped",
      error: cancelledBy("decompile_all", input.signal),
    });
  const bytes = Buffer.from(
    functionFileText({
      procedure: input.procedure,
      body: body.fact,
      identity: input.identity,
      limitations: caveats,
      pseudocode,
    }),
    "utf8",
  );
  return attempt({
    kind: "file",
    relativePath: input.session.pathFor(input.procedure.address),
    bytes,
    staged: input.session.stageFunctionFile(bytes),
    body: body.fact,
    caveats,
    providerSource: observationSource,
  });
};

const readBody = async (
  analysis: WorkflowAnalysisPort,
  address: string,
  identity: ExportIdentity,
  signal: AbortSignal | undefined,
  support: "unknown" | "unavailable",
  providerWait: ProviderWait,
): Promise<
  | {
      readonly kind: "body";
      readonly fact: FunctionBody;
      readonly support: "unknown" | "unavailable";
      /**
       * Caveats of a procedure_info observation for this export's target and
       * profile. An observation for another target or profile, or with a
       * validated different entry point, contributes no caveats.
       */
      readonly limitations?: readonly string[];
      /**
       * procedure_info for this export classifies the function as external.
       * Absent when the classification is unknown or not external.
       */
      readonly external?: true;
    }
  | {
      readonly kind: "unavailable";
      readonly fact: FunctionBody;
      readonly support: "unavailable";
    }
  | { readonly kind: "error"; readonly error: AnalysisError }
> => {
  if (support === "unavailable")
    return {
      kind: "unavailable",
      fact: unavailableBody(BODY_UNAVAILABLE),
      support,
    };
  const observed = await providerWait(
    "procedure_info",
    analysis.execute(
      "procedure_info",
      { procedure: address },
      executionOptions(signal),
    ),
  );
  if (!observed.ok) {
    if (
      observed.error.cleanupIncomplete ||
      observed.error instanceof AnalysisCancelledError
    )
      return { kind: "error", error: observed.error };
    if (observed.error instanceof AnalysisCapabilityUnavailableError)
      return {
        kind: "unavailable",
        fact: unavailableBody(BODY_UNAVAILABLE),
        support: "unavailable",
      };
    return {
      kind: "body",
      fact: unavailableBody(failureReason(observed.error).message),
      support,
    };
  }
  const mismatch = observationMismatch(identity, observed.value);
  if (mismatch !== undefined)
    return {
      kind: "body",
      fact: unavailableBody(`procedure_info: ${mismatch.message}`),
      support,
    };
  const parsed = procedureInfoSchema.safeParse(observed.value.result);
  if (parsed.success && !sameAddress(parsed.data.entrypoint, address))
    return {
      kind: "body",
      fact: unavailableBody(
        "procedure_info described a different entry point than this function.",
      ),
      support,
    };
  analysis.recordItemLimitations?.("procedure_info", observed.value);
  if (!parsed.success)
    return {
      kind: "body",
      fact: unavailableBody("procedure_info returned an invalid body."),
      support,
      limitations: observed.value.limitations,
    };
  const external =
    parsed.data.classification?.external === true
      ? { external: true as const }
      : {};
  if (!parsed.data.body.available)
    return {
      kind: "body",
      fact: unavailableBody(parsed.data.body.reason),
      support,
      limitations: observed.value.limitations,
      ...external,
    };
  return {
    kind: "body",
    fact: {
      available: true,
      ranges: parsed.data.body.ranges,
      non_contiguous: parsed.data.body.non_contiguous,
    },
    support,
    limitations: observed.value.limitations,
    ...external,
  };
};

type ExistingFile =
  | "skip"
  | "write"
  | "conflict"
  | "io"
  | { readonly error: AnalysisError };

const existingFile = async (
  session: DecompileExport,
  address: string,
  signal: AbortSignal | undefined,
): Promise<ExistingFile> => {
  const record = session.lastWritten(address);
  if (
    record === undefined ||
    record.sha256 === undefined ||
    record.relative_path === undefined
  )
    return "write";
  const digest = await session
    .hashFile(record.relative_path, signal)
    .catch((cause: unknown) => cause);
  if (digest instanceof ArtifactReaderFailure && digest.cleanup !== undefined)
    return {
      error: exportOutputFailure(
        "decompile file verification cleanup failed",
        digest,
      ),
    };
  if (typeof digest === "string")
    return digest === record.sha256 ? "skip" : "conflict";
  return nodeAbsent(digest) ? "write" : "io";
};

const PROFILE_CHANGED: FailureReason = {
  code: "profile_changed",
  message:
    "The decompiler observation does not match this export's provider or analysis profile.",
};

const TARGET_CHANGED: FailureReason = {
  code: "target_changed",
  message:
    "The decompiler observation names a different target than this export.",
};

/** Why a per-function observation cannot join this export, if it cannot. */
const observationMismatch = (
  identity: ExportIdentity,
  execution: AnalysisExecution,
): FailureReason | undefined => {
  const provider = execution.provider;
  if (
    provider.id !== identity.provider.id ||
    provider.name !== identity.provider.name ||
    provider.version !== identity.provider.version
  )
    return PROFILE_CHANGED;
  // A missing profile is unknown, not a match for a committed one.
  if (
    (execution.analysisProfile?.digest ?? null) !==
    identity.analysisProfileDigest
  )
    return PROFILE_CHANGED;
  // A per-function observation may omit its subject; one that names a
  // different target is not this export's target.
  const target = execution.subject?.sha256;
  return target === undefined || target === identity.targetSha256
    ? undefined
    : TARGET_CHANGED;
};

/** Same canonical address; numeric when both parse, otherwise exact text. */
const sameAddress = (left: string, right: string): boolean => {
  const a = addressCoordinate(left);
  const b = addressCoordinate(right);
  return a === null || b === null
    ? left === right
    : a.space === b.space && a.offset === b.offset;
};

const failureReason = (error: AnalysisError): FailureReason => {
  if (error instanceof AnalysisTimeoutError)
    return { code: "deadline", message: "The decompiler deadline elapsed." };
  const projected = projectAnalysisError(error);
  const message = projected.message.replace(/\s+/gu, " ").trim().slice(0, 300);
  return {
    code: projected.code.slice(0, 80),
    message: message.length === 0 ? projected.code : message,
  };
};

const outputStoppedAccepting = (state: PublishState): AnalysisOutputError =>
  new AnalysisOutputError(
    "decompile_all",
    "output directory stopped accepting function files",
    {
      userMessage: `Stopped after ${OUTPUT_IO_STREAK_LIMIT.toString()} function files in a row could not be written or read, for example because the disk is full or permissions changed. Files already written are kept and recorded in ${DECOMPILE_DIRECTORY_INDEX_NAME}. Fix the output directory, then resume.`,
      remediationAction:
        "Free space or restore write access in the output directory, then rerun with resume.",
      diagnostics: {
        attempted: state.attempted,
        written: state.written,
        failed: state.failed,
        external: state.external,
        skipped: state.skipped,
        consecutive_output_io: state.outputIoStreak,
        last_failures: state.recentFailures.map((failure) => ({ ...failure })),
        last_failures_omitted:
          Math.min(state.failed, OUTPUT_IO_STREAK_LIMIT) -
          state.recentFailures.length,
      },
    },
  );

const recordFailure = (
  state: PublishState,
  procedure: SelectedProcedure,
  reason: FailureReason,
  pseudocodeAbsence?: PseudocodeAbsence,
): void => {
  state.failed += 1;
  const failure: NamedFailure = {
    address: procedure.address,
    name: procedure.name,
    code: reason.code,
    message: reason.message,
    ...(pseudocodeAbsence === undefined
      ? {}
      : { pseudocode_absence: pseudocodeAbsence }),
  };
  if (state.failures.length < DECOMPILE_DIRECTORY_INLINE_FAILURE_LIMIT) {
    const comma = state.failures.length === 0 ? 0 : 1;
    const fitted = fitInlineFailure(
      failure,
      DECOMPILE_DIRECTORY_INLINE_FAILURE_BYTES -
        state.inlineFailureBytes -
        comma,
    );
    if (fitted !== undefined) {
      state.failures.push(fitted.row);
      state.inlineFailureBytes += comma + fitted.bytes;
    }
  }
  const recent = fitInlineFailure(
    failure,
    DECOMPILE_DIRECTORY_INLINE_FAILURE_BYTES - 2,
  );
  // An oversized latest row cannot leave an older example labelled as recent.
  if (recent === undefined) state.recentFailures.length = 0;
  else state.recentFailures.push(recent.row);
  while (
    state.recentFailures.length > OUTPUT_IO_STREAK_LIMIT ||
    jsonValueByteLength(
      state.recentFailures,
      DECOMPILE_DIRECTORY_INLINE_FAILURE_BYTES,
    ) > DECOMPILE_DIRECTORY_INLINE_FAILURE_BYTES
  )
    state.recentFailures.shift();
};

const fitInlineFailure = (
  failure: NamedFailure,
  budget: number,
): { readonly row: InlineFailure; readonly bytes: number } | undefined => {
  const bytes = jsonValueByteLength(failure, budget);
  if (bytes <= budget) return { row: failure, bytes };
  // Name is display context; address remains the complete lookup identity.
  const { name: _name, ...withoutName } = failure;
  const compactBytes = jsonValueByteLength(withoutName, budget);
  if (compactBytes <= budget) return { row: withoutName, bytes: compactBytes };
  // The provider's reason is kept in the index record, so it goes next.
  const { pseudocode_absence: _absence, ...minimal } = withoutName;
  const minimalBytes = jsonValueByteLength(minimal, budget);
  return minimalBytes <= budget
    ? { row: minimal, bytes: minimalBytes }
    : undefined;
};

const failureRecord = (
  procedure: SelectedProcedure,
  body: FunctionBody,
  reason: FailureReason,
  options: {
    readonly relativePath?: string;
    /** Caveats of the observations this attempt used. */
    readonly limitations?: readonly string[];
    readonly providerSource?: DecompileDirectoryFunctionRecord["provider_source"];
    readonly pseudocodeAbsence?: DecompileDirectoryFunctionRecord["pseudocode_absence"];
  } = {},
): DecompileDirectoryFunctionRecord => ({
  address: procedure.address,
  name: procedure.name,
  status: "failed",
  body: bodyRecord(body),
  failure: reason,
  ...(options.providerSource === undefined
    ? {}
    : { provider_source: options.providerSource }),
  ...(options.pseudocodeAbsence === undefined
    ? {}
    : { pseudocode_absence: options.pseudocodeAbsence }),
  ...(options.relativePath === undefined
    ? {}
    : { relative_path: options.relativePath }),
  ...(options.limitations === undefined || options.limitations.length === 0
    ? {}
    : { limitations: [...options.limitations] }),
});

/** Why a successful pseudocode observation still produced no file. */
const pseudocodeFailure = (pseudocode: unknown): FailureReason => {
  if (pseudocode === null)
    return {
      code: "no_pseudocode",
      message: "The provider returned null pseudocode for this function.",
    };
  return typeof pseudocode === "string"
    ? {
        code: "empty_pseudocode",
        message: "The provider returned no pseudocode.",
      }
    : {
        code: "invalid_pseudocode",
        message: "The provider returned pseudocode that is not text.",
      };
};

const externalRecord = (
  procedure: SelectedProcedure,
  body: FunctionBody,
  limitations: readonly string[],
): DecompileDirectoryFunctionRecord => ({
  address: procedure.address,
  name: procedure.name,
  status: "external",
  body: bodyRecord(body),
  ...(limitations.length === 0 ? {} : { limitations: [...limitations] }),
});

const unavailableBody = (reason: string): FunctionBody => ({
  available: false,
  reason: reason.length === 0 ? "unavailable" : reason,
});

/** Preserve the observations and their caveats when a file cannot be reused. */
const retainedObservation = (
  session: DecompileExport,
  address: string,
): { body: FunctionBody; options: { limitations?: readonly string[] } } => {
  const record = session.record(address);
  return {
    body: record?.body ?? unavailableBody("not rewritten"),
    options:
      record?.limitations === undefined
        ? {}
        : { limitations: record.limitations },
  };
};

const exportLimitations = (
  layout: DecompileDirectoryInput["layout"],
  identity: ExportIdentity,
  collapsedDuplicates: boolean,
  unknownBodies: UnknownBodies,
  unaddressed: number,
): readonly string[] => [
  ...(layout === "dwarf" ? [DWARF_LAYOUT_UNAVAILABLE] : []),
  ...(identity.targetSha256 === null ? [TARGET_DIGEST_UNAVAILABLE] : []),
  ...(identity.analysisProfileDigest === null ? [PROFILE_UNAVAILABLE] : []),
  ...(collapsedDuplicates ? [DUPLICATE_ADDRESSES] : []),
  ...(unaddressed > 0 ? [unaddressedRows(unaddressed)] : []),
  ...(unknownBodies.count > 0 ? [unknownBodyRecords(unknownBodies)] : []),
];

const layoutStatus = (
  layout: DecompileDirectoryInput["layout"],
): "address" | "debug_layout_unavailable" =>
  layout === "dwarf" ? "debug_layout_unavailable" : "address";

const manifestOf = (input: {
  readonly root: string;
  readonly input: DecompileDirectoryInput;
  readonly identity: ExportIdentity;
  readonly selected: number;
  readonly excluded: number;
  readonly state: PublishState;
  readonly limitations: readonly string[];
  readonly inventoryLimitations: readonly string[];
}) => {
  const requested =
    input.state.written + input.state.failed + input.state.external;
  const shown = input.state.failures.slice(
    0,
    DECOMPILE_DIRECTORY_INLINE_FAILURE_LIMIT,
  );
  return {
    output_directory: input.root,
    index_path: join(input.root, DECOMPILE_DIRECTORY_INDEX_NAME),
    layout: input.input.layout,
    layout_status: layoutStatus(input.input.layout),
    counts: {
      selected: input.selected,
      excluded: input.excluded,
      requested,
      written: input.state.written,
      failed: input.state.failed,
      external: input.state.external,
      skipped: input.state.skipped,
      remaining: input.selected - input.state.skipped - requested,
    },
    failures: shown,
    failures_omitted: input.state.failed - shown.length,
    provider: input.identity.provider,
    analysis_profile_digest: input.identity.analysisProfileDigest,
    target_sha256: input.identity.targetSha256,
    inventory_limitations: [...input.inventoryLimitations],
    limitations: [...input.limitations],
    resume: input.input.resume,
  };
};

const executionOptions = (signal: AbortSignal | undefined) => ({
  ...(signal === undefined ? {} : { signal }),
  selectorOrigin: "provider" as const,
});

const nodeAbsent = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";
