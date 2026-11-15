import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { ExecutionOptions } from "../application/AnalysisProvider.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import {
  referenceEdgeSchema,
  unresolvedCallSchema,
} from "../domain/native/nativeReference.js";
import { procedureIdentitySchema } from "../domain/native/procedureInfo.js";
import { nativeCallClassificationSchema } from "../domain/native/nativeCallReference.js";
import { err, ok, type Result } from "../domain/result.js";
import type { HopperClient } from "./HopperClient.js";
import { parseHopperReply, type HopperReply } from "./HopperReplyContracts.js";
import { analysisClientFailureForOperation } from "../providers/AnalysisClientFailure.js";
import {
  hopperCallerScanBudgetForMilliseconds,
  hopperCallerScanRecovery,
  type HopperCallerScanBudget,
} from "../config/hopperCallerScanBudget.js";
import {
  formatHopperCallerScanReason,
  hopperCallerReconciliationPartialSchema,
  HOPPER_CALLER_PAGE_ALLOWANCE_BYTES,
  HOPPER_CALLER_SCAN_RETENTION_BYTES,
  type HopperCallerReconciliationPartial,
  type HopperCallerScanCounts,
  type HopperCallerScanFacts,
  type HopperCallerScanStop,
} from "../domain/native/hopperCallerReconciliation.js";

type Operation =
  | "procedure_callers"
  | "procedure_references"
  | "analyze_function";
type Identity = z.infer<typeof procedureIdentitySchema>;
type Edge = z.infer<typeof referenceEdgeSchema>;
type CompactEdge =
  HopperReply<"rea_caller_scan_page">["items"][number]["references"][number];
type Destination = {
  callers: Map<string, Identity>;
  references: Array<{ caller: Identity; edge: CompactEdge }>;
};
type Index = {
  destinations: Map<string, Destination>;
  counts: HopperCallerScanCounts;
};
type ScanFailure = {
  readonly error: AnalysisError;
  readonly counts: HopperCallerScanCounts;
  readonly destinations: Map<string, Destination>;
  readonly unreadPage?: JsonValue;
};

/** A child bridge request is a phase of the enclosing user operation. */
export function reconciliationChildOptions(
  options: ExecutionOptions | undefined,
): ExecutionOptions | undefined {
  if (options?.progress === undefined) return options;
  const progress = options.progress;
  return {
    ...options,
    progress: {
      report: (update) =>
        progress.report({
          ...update,
          completed: 0,
          total: null,
          terminal: false,
        }),
    },
  };
}

async function reportScanProgress(
  options: ExecutionOptions | undefined,
  start: number,
  total: number | undefined,
  final = false,
): Promise<void> {
  try {
    await options?.progress?.report({
      phase: "hopper_caller_reconciliation",
      completed: 0,
      total: null,
      message: `Examined ${start} of ${total ?? "unknown"} procedures`,
      ...(final ? { terminal: true } : {}),
    });
  } catch {
    // Progress is observational and cannot change the analysis result.
  }
}

const scanCounts = (
  stop: HopperCallerScanStop,
  examined: number,
  procedureTotal: number | undefined,
  retainedBytes: number,
): HopperCallerScanCounts => ({
  examined_procedures: examined,
  procedure_total: procedureTotal ?? null,
  retained_bytes: retainedBytes,
  stop,
});

async function buildIndex(
  client: HopperClient,
  operation: Operation,
  document: JsonValue | undefined,
  options: ExecutionOptions | undefined,
  budgetMs: number,
): Promise<Result<Index, ScanFailure>> {
  const destinations = new Map<string, Destination>();
  const destination = (address: string): Destination => {
    let value = destinations.get(address);
    if (value === undefined) {
      value = { callers: new Map(), references: [] };
      destinations.set(address, value);
    }
    return value;
  };
  let start = 0,
    total: number | undefined,
    bytes = 0;
  const began = performance.now();
  let stop: HopperCallerScanStop = { code: "complete" };
  // Called only after the caller's signal aborted.
  const cancelled = (): AnalysisCancelledError =>
    cancelledBy(operation, carriedReason(options?.signal?.reason));
  const fail = (
    error: AnalysisError,
    failureStop: HopperCallerScanStop,
    unreadPage?: JsonValue,
  ): Result<Index, ScanFailure> =>
    err({
      error,
      counts: scanCounts(failureStop, start, total, bytes),
      destinations,
      ...(unreadPage === undefined ? {} : { unreadPage }),
    });
  do {
    if (options?.signal?.aborted)
      return fail(cancelled(), { code: "cancelled" });
    if (start > 0 && performance.now() - began >= budgetMs) {
      stop = { code: "work_budget", budget_ms: budgetMs };
      break;
    }
    if (start > 0) await reportScanProgress(options, start, total);
    const args: Record<string, JsonValue> = { start };
    if (document !== undefined) args.document = document;
    const pageOptions =
      options?.progress === undefined
        ? options
        : {
            ...options,
            progress: {
              report: (update: { readonly terminal?: boolean }) =>
                update.terminal === true
                  ? Promise.resolve()
                  : reportScanProgress(options, start, total),
            },
          };
    const page = await client.callTool(
      "rea_caller_scan_page",
      args,
      pageOptions,
    );
    if (!page.ok)
      return options?.signal?.aborted
        ? fail(cancelled(), { code: "cancelled" })
        : fail(
            analysisClientFailureForOperation(page.error, "hopper", operation),
            { code: "page_failure" },
          );
    const decoded = parseHopperReply(
      "rea_caller_scan_page",
      page.value,
      operation,
    );
    if (!decoded.ok)
      return options?.signal?.aborted
        ? fail(cancelled(), { code: "cancelled" }, page.value)
        : fail(decoded.error, { code: "invalid_page" }, page.value);
    const value = decoded.value;
    if (
      value.start !== start ||
      value.next < start ||
      value.next > value.total ||
      value.next - start > 64 ||
      (value.next === start &&
        value.next !== value.total &&
        !value.oversized) ||
      value.items.length !== value.next - start ||
      (value.oversized && value.next !== start)
    )
      return options?.signal?.aborted
        ? fail(cancelled(), { code: "cancelled" }, page.value)
        : fail(
            new AnalysisOutputError(
              operation,
              "Invalid Hopper caller scan progress",
            ),
            { code: "invalid_progress" },
            page.value,
          );
    if (total !== undefined && value.total !== total) {
      stop = { code: "inventory_changed" };
      break;
    }
    total = value.total;
    if (value.oversized) {
      stop = {
        code: "page_allowance",
        allowance_bytes: HOPPER_CALLER_PAGE_ALLOWANCE_BYTES,
      };
      break;
    }
    const pageBytes = Buffer.byteLength(JSON.stringify(page.value));
    if (pageBytes > HOPPER_CALLER_SCAN_RETENTION_BYTES - bytes) {
      stop = {
        code: "retention_budget",
        allowance_bytes: HOPPER_CALLER_SCAN_RETENTION_BYTES,
      };
      break;
    }
    bytes += pageBytes;
    for (const item of value.items) {
      for (const callee of item.callees)
        destination(callee).callers.set(item.caller.address, item.caller);
      for (const edge of item.references) {
        destination(edge.target_procedure).references.push({
          caller: item.caller,
          edge,
        });
      }
    }
    start = value.next;
    if (options?.signal?.aborted)
      return fail(cancelled(), { code: "cancelled" });
    await reportScanProgress(options, start, total);
    if (options?.signal?.aborted)
      return fail(cancelled(), { code: "cancelled" });
  } while (start < (total ?? 0));
  await reportScanProgress(options, start, total, true);
  if (options?.signal?.aborted) return fail(cancelled(), { code: "cancelled" });
  return ok({
    destinations,
    counts: scanCounts(stop, start, total, bytes),
  });
}

/** Instruction lists are a scan filter, not part of the retained caller reply. */
const omitInstructionPayload = (value: JsonValue): JsonValue => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  if (!Object.hasOwn(value, "instructions")) return value;
  const { instructions: _instructions, ...rest } = value;
  return rest;
};

/**
 * `source_procedure: "caller"` means the enclosing page item. Keep that
 * owner's address on the site so the compact record does not depend on a
 * separate inventory list or a copied identity.
 */
const compactCallReference = (
  caller: Identity,
  edge: CompactEdge,
): {
  readonly caller_address: string;
  readonly source_address: string;
  readonly target_address: string;
  readonly source_procedure: string | null;
  readonly target_procedure: string;
  readonly call?: CompactEdge["call"];
} => ({
  caller_address: caller.address,
  source_address: edge.source_address,
  target_address: edge.target_address,
  source_procedure:
    edge.source_procedure === null || edge.source_procedure === "caller"
      ? edge.source_procedure === "caller"
        ? caller.address
        : null
      : edge.source_procedure.address,
  target_procedure: edge.target_procedure,
  ...(edge.call === undefined ? {} : { call: edge.call }),
});

/** One shared identity record; destinations cite addresses instead of copies. */
const compactForwardDestinations = (
  destinations: Map<string, Destination>,
): JsonValue => {
  const identities = new Map<string, Identity>();
  const remember = (identity: Identity): void => {
    if (!identities.has(identity.address))
      identities.set(identity.address, identity);
  };
  const rows = [...destinations.entries()].map(([address, value]) => {
    const callerAddresses: string[] = [];
    for (const caller of value.callers.values()) {
      remember(caller);
      callerAddresses.push(caller.address);
    }
    return {
      address,
      caller_addresses: callerAddresses,
      references: value.references.map(({ caller, edge }) => {
        remember(caller);
        if (
          edge.source_procedure !== null &&
          edge.source_procedure !== "caller"
        )
          remember(edge.source_procedure);
        return compactCallReference(caller, edge);
      }),
    };
  });
  return {
    identities: [...identities.values()],
    destinations: rows,
  };
};

export const reconcileHopperCallers = async (
  client: HopperClient,
  operation: Operation,
  parameters: Readonly<Record<string, JsonValue>>,
  original: JsonValue,
  options: ExecutionOptions | undefined,
  budget: number | HopperCallerScanBudget,
): Promise<
  Result<
    {
      result: JsonValue;
      rawResult: JsonValue;
      reason: string;
      scan?: HopperCallerScanFacts;
    },
    AnalysisError
  >
> => {
  const scanBudget =
    typeof budget === "number"
      ? hopperCallerScanBudgetForMilliseconds(budget)
      : budget;
  const budgetMs = scanBudget.milliseconds;
  const describeScan = (facts: HopperCallerScanFacts): string => {
    const observed = formatHopperCallerScanReason(facts);
    const recovery = hopperCallerScanRecovery(facts, scanBudget);
    return recovery === "" ? observed : `${observed} ${recovery}`;
  };
  const retainNative = (
    error: AnalysisError,
    partial: {
      readonly scan: HopperCallerScanFacts | null;
      readonly destinations: Map<string, Destination> | null;
      readonly unreadPage?: JsonValue;
    },
  ): AnalysisError => {
    const observation: HopperCallerReconciliationPartial = {
      kind: "hopper-caller-reconciliation",
      native_result: original,
      scan: partial.scan,
      forward_destinations:
        partial.destinations === null
          ? null
          : compactForwardDestinations(partial.destinations),
      coverage: {
        status: "unknown",
        reason:
          partial.scan === null
            ? "Hopper caller reconciliation did not examine the procedure inventory; unexamined procedure relationships are unknown."
            : describeScan(partial.scan),
        limited_directions:
          operation === "analyze_function"
            ? ["callers", "callees"]
            : ["callers"],
      },
      ...(partial.unreadPage === undefined
        ? {}
        : { unread_page: partial.unreadPage }),
    };
    error.retainPartialObservation(
      hopperCallerReconciliationPartialSchema.parse(observation),
    );
    return error;
  };
  // Each native reply is validated once by its bridge reply contract.
  const nativeReply =
    operation === "procedure_callers"
      ? parseHopperReply("rea_caller_base", original, operation)
      : operation === "analyze_function"
        ? parseHopperReply("analyze_function", original, operation)
        : parseHopperReply("procedure_references", original, operation);
  if (!nativeReply.ok)
    return err(
      retainNative(nativeReply.error, { scan: null, destinations: null }),
    );
  const native = nativeReply.value;
  const base = "callers_complete" in native ? native : undefined;
  const args: Record<string, JsonValue> = {};
  if (parameters.document !== undefined) args.document = parameters.document;
  if (parameters.procedure !== undefined) args.procedure = parameters.procedure;
  // The callers base already carries its scan target.
  const targetResponse =
    base !== undefined
      ? ok<JsonValue>(original)
      : await client.callTool(
          "rea_caller_scan_target",
          args,
          reconciliationChildOptions(options),
        );
  if (!targetResponse.ok)
    return err(
      retainNative(
        analysisClientFailureForOperation(
          targetResponse.error,
          "hopper",
          operation,
        ),
        { scan: null, destinations: null },
      ),
    );
  if (options?.signal?.aborted)
    return err(
      retainNative(cancelledBy(operation, options.signal), {
        scan: null,
        destinations: null,
      }),
    );
  const selected =
    base !== undefined
      ? ok(base)
      : parseHopperReply(
          "rea_caller_scan_target",
          targetResponse.value,
          operation,
        );
  if (!selected.ok)
    return err(
      retainNative(selected.error, { scan: null, destinations: null }),
    );
  const { target, instructions, instructions_complete } = selected.value;
  if (
    operation !== "procedure_callers" &&
    "procedure" in native &&
    native.procedure.address !== target.address
  )
    return ok({
      result: original,
      rawResult: original,
      reason:
        "The selected procedure changed during reconciliation. Relationship coverage is unknown.",
    });
  const documentKey =
    parameters.document === undefined
      ? "default"
      : `document:${String(parameters.document)}`;
  let indexByDocument = options?.workScope?.get<Map<string, Index>>(client);
  let index = indexByDocument?.get(documentKey);
  if (index === undefined) {
    const scanned = await buildIndex(
      client,
      operation,
      parameters.document,
      options,
      budgetMs,
    );
    if (!scanned.ok) {
      const failure = scanned.error;
      return err(
        retainNative(failure.error, {
          scan: {
            ...failure.counts,
            instructions_complete,
            native_callers_complete:
              base !== undefined ? base.callers_complete : null,
          },
          destinations: failure.destinations,
          ...(failure.unreadPage === undefined
            ? {}
            : { unreadPage: failure.unreadPage }),
        }),
      );
    }
    index = scanned.value;
    if (options?.workScope !== undefined) {
      if (indexByDocument === undefined) {
        indexByDocument = new Map();
        options.workScope.set(client, indexByDocument);
      }
      indexByDocument.set(documentKey, index);
    }
  }
  const addresses = new Set(instructions);
  addresses.add(target.address);
  const selectedDestination = index.destinations.get(target.address);
  const callers = new Map(selectedDestination?.callers ?? []);
  const selectedReferences: Array<{ caller: Identity; edge: CompactEdge }> = [];
  for (const item of selectedDestination?.references ?? []) {
    if (!addresses.has(item.edge.target_address)) continue;
    const source =
      item.edge.source_procedure === "caller"
        ? item.caller
        : item.edge.source_procedure;
    if (source !== null) callers.set(source.address, source);
    selectedReferences.push(item);
  }
  const unavailableKind = {
    available: false as const,
    reason:
      "Hopper exposes partial CallReference classification, but not detailed reference flags",
  };
  // The scan budget counted compact pages. Expanded edges repeat each
  // identity, so measure that copy before allocating it.
  const expandedReferenceBytes = (): number => {
    let bytes = 2;
    const targetBytes = Buffer.byteLength(JSON.stringify(target));
    const kindBytes = Buffer.byteLength(JSON.stringify(unavailableKind));
    for (const { caller, edge } of selectedReferences) {
      const source =
        edge.source_procedure === "caller"
          ? caller
          : edge.source_procedure === null
            ? null
            : edge.source_procedure;
      const sourceBytes =
        source === null ? 4 : Buffer.byteLength(JSON.stringify(source));
      const callBytes =
        edge.call === undefined
          ? 0
          : Buffer.byteLength(JSON.stringify(edge.call));
      bytes +=
        64 +
        sourceBytes +
        targetBytes +
        kindBytes +
        callBytes +
        Buffer.byteLength(edge.source_address) +
        Buffer.byteLength(edge.target_address);
      if (bytes > HOPPER_CALLER_SCAN_RETENTION_BYTES) return bytes;
    }
    return bytes;
  };
  const retainedNativeResult = omitInstructionPayload(original);
  const compactReferences = selectedReferences.map(({ caller, edge }) =>
    compactCallReference(caller, edge),
  );
  const inventoryCallers = selectedDestination?.callers ?? new Map();
  const siteCallers = new Map<string, Identity>();
  for (const { caller } of selectedReferences)
    if (
      !inventoryCallers.has(caller.address) &&
      !siteCallers.has(caller.address)
    )
      siteCallers.set(caller.address, caller);
  if (
    operation !== "procedure_callers" &&
    expandedReferenceBytes() > HOPPER_CALLER_SCAN_RETENTION_BYTES
  ) {
    const scan: HopperCallerScanFacts = {
      ...index.counts,
      instructions_complete,
      native_callers_complete:
        base !== undefined ? base.callers_complete : null,
      stop: {
        code: "retention_budget",
        allowance_bytes: HOPPER_CALLER_SCAN_RETENTION_BYTES,
      },
    };
    return err(
      retainNative(
        new AnalysisResourceConstraintError(
          operation,
          "memory",
          describeScan(scan),
          { allowance_bytes: HOPPER_CALLER_SCAN_RETENTION_BYTES },
          {
            retryable: false,
            remediationAction: hopperCallerScanRecovery(scan, scanBudget),
          },
        ),
        { scan, destinations: index.destinations },
      ),
    );
  }
  const references = new Map<string, Edge>();
  if (operation !== "procedure_callers")
    for (const { caller, edge } of selectedReferences) {
      const source =
        edge.source_procedure === "caller" ? caller : edge.source_procedure;
      references.set(`${edge.source_address}:${edge.target_address}`, {
        source_address: edge.source_address,
        target_address: edge.target_address,
        source_procedure: source,
        target_procedure: target,
        kind: unavailableKind,
        call: edge.call,
      });
    }
  const mergeReferences = (
    existing: z.infer<typeof referenceEdgeSchema>[],
    excludeSource?: string,
  ) => {
    const merged = new Map(
      existing.map((edge) => [
        `${edge.source_address}:${edge.target_address}`,
        edge,
      ]),
    );
    for (const [key, edge] of references) {
      if (
        excludeSource !== undefined &&
        edge.source_procedure?.address === excludeSource
      )
        continue;
      const old = merged.get(key);
      merged.set(
        key,
        old === undefined
          ? edge
          : old.call === undefined && edge.call !== undefined
            ? { ...old, call: edge.call }
            : old,
      );
    }
    return [...merged.values()];
  };
  let result: JsonValue;
  if ("callers_complete" in native)
    result = [...new Set([...native.callers, ...callers.keys()])];
  else if ("incoming_references" in native) {
    const dossier = native;
    const identities = new Map(
      dossier.callers.map((item) => [item.address, item]),
    );
    for (const [address, caller] of callers)
      if (!identities.has(address)) identities.set(address, caller);
    result = {
      ...dossier,
      callers: [...identities.values()],
      incoming_references: mergeReferences(
        dossier.incoming_references,
        dossier.procedure.address,
      ),
    };
  } else {
    result = { ...native, references: mergeReferences(native.references) };
  }
  const scan: HopperCallerScanFacts = {
    ...index.counts,
    instructions_complete,
    native_callers_complete: base !== undefined ? base.callers_complete : null,
  };
  return ok({
    result,
    rawResult: {
      native_result: retainedNativeResult,
      forward_observations: {
        target,
        callee_inventory_callers: [
          ...(selectedDestination?.callers.values() ?? []),
        ],
        call_site_callers: [...siteCallers.values()],
        call_references: compactReferences,
        provenance:
          "hopper-public-python-api:getAllCalleeProcedures and CallReference",
      },
    },
    scan,
    reason: describeScan(scan),
  });
};
