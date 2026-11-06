import { CALL_RELATIONSHIP_TRAVERSALS } from "./CallRelationshipTraversal.js";
import { z } from "zod";

import type {
  AnalysisExecution,
  AnalysisOperation,
  AnalysisOperationPort,
  ExecutionOptions,
} from "./AnalysisProvider.js";
import {
  enhancedInputSchemas,
  MAX_ENHANCED_RECORDS,
  type CallRelationshipDirection,
  type EnhancedToolName,
} from "../contracts/enhancedInputs.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { NoBinaryOpenError } from "../domain/configurationErrors.js";
import { NATIVE_MACOS_PROVIDER_IDENTITY } from "../native/NativeMacOSProviderMetadata.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  functionDossierSchema,
  parseFunctionDossier,
  parseListCount,
  parseRelatedAddresses,
  parseSegments,
  projectBinaryOverview,
} from "../domain/hopperValues.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  categorizeSwiftTypes,
  discoverObjcProtocols,
  projectObjcClassCandidates,
  selectObjcClassCandidates,
} from "../domain/symbolAnalysis.js";
import { inspectNativeDispatch } from "./native/NativeDispatchMetadataInspection.js";
import { traceNativeValues } from "./native/NativeValueTrace.js";
import { traceNativeUiAction } from "./native/NativeUiActionTrace.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { addressedValueSchema } from "../domain/native/nativeInventory.js";
import { nativeDispatchMetadataResultSchema } from "../domain/native/objcSwiftMetadata.js";
import { isMachOFormat } from "../domain/binaryTargetTypes.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import {
  machoTargetSelectionMatchesArchitecture,
  machoTargetSelectionMatchesFormat,
  profileMachoTargetSelection,
  sameMachoTargetSelection,
} from "../domain/apple/machoTargetSelection.js";

import {
  invalidEnhancedInput,
  type EnhancedResult,
  type ValidatedEnhancedCall,
} from "./EnhancedToolTypes.js";
import { resolveAnalysisDocument } from "./AnalysisDocument.js";
import { traceCallPath } from "./CallPathTracing.js";
import { resolveProcedureAddress } from "./ProcedureAddressResolution.js";
import { traceLiteralFeature } from "./EnhancedLiteralTracing.js";
import { projectNativeApiInspection } from "./native/NativeApiInspection.js";

type BatchProcedureIdentity =
  | {
      readonly status: "resolved";
      readonly address: string;
      readonly name: string | null;
      readonly name_error?: ReturnType<typeof projectAnalysisError>;
    }
  | {
      readonly status: "unknown";
      readonly error: ReturnType<typeof projectAnalysisError>;
    };

type BatchResolution = {
  readonly address: string;
  readonly result: Result<string, AnalysisError>;
};

type BatchReadyItem = {
  readonly address: string;
  readonly procedure: BatchProcedureIdentity;
  readonly providerProcedure: string;
};

type BatchDecompileItem = {
  readonly address: string;
  readonly procedure: BatchProcedureIdentity;
  readonly status: "ok" | "error";
  readonly pseudocode?: string;
  readonly error?: ReturnType<typeof projectAnalysisError>;
};

const isAnalysisCancellation = (
  error: AnalysisError,
): error is AnalysisCancelledError => error._tag === "AnalysisCancelledError";

const firstAnalysisCancellation = <Value>(
  results: readonly Result<Value, AnalysisError>[],
): AnalysisCancelledError | undefined => {
  for (const result of results)
    if (!result.ok && isAnalysisCancellation(result.error)) return result.error;
  return undefined;
};

const macosUtilityRefusal = (
  operation: string,
  error: AnalysisError,
): AnalysisError =>
  process.platform !== "darwin" && error instanceof NoBinaryOpenError
    ? new AnalysisCapabilityUnavailableError(
        NATIVE_MACOS_PROVIDER_IDENTITY.id,
        operation,
        "Native macOS utilities require macOS.",
        { userMessage: "Native macOS utilities require macOS." },
      )
    : error;

/**
 * Composes direct provider operations into bounded reverse-engineering tools.
 * Direct callers use `execute`; adapters that own validation use
 * `executeValidated` so an MCP input is parsed exactly once.
 */
export class EnhancedTools {
  constructor(private readonly analysis: AnalysisOperationPort) {}

  /** Parse an untrusted direct-call input once, then dispatch exhaustively. */
  execute(
    name: EnhancedToolName,
    input: unknown,
    signal?: AbortSignal,
  ): EnhancedResult {
    if (name === "trace_feature" || name === "trace_call_path")
      return this.#executeTracing(name, input, signal);
    if (name === "trace_native_values") {
      const parsed = enhancedInputSchemas.trace_native_values.safeParse(input);
      return parsed.success
        ? this.executeValidated({ name, input: parsed.data }, signal)
        : invalidEnhancedInput(name, parsed.error);
    }
    if (name === "trace_native_ui_action") {
      const parsed =
        enhancedInputSchemas.trace_native_ui_action.safeParse(input);
      return parsed.success
        ? this.executeValidated({ name, input: parsed.data }, signal)
        : invalidEnhancedInput(name, parsed.error);
    }
    if (name === "analyze_function" || name === "inspect_native_api")
      return this.#executeFunctionAnalysis(name, input, signal);
    switch (name) {
      case "inspect_native_dispatch_metadata": {
        const parsed =
          enhancedInputSchemas.inspect_native_dispatch_metadata.safeParse(
            input,
          );
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
      case "get_objc_classes": {
        const parsed = enhancedInputSchemas.get_objc_classes.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
      case "get_objc_protocols": {
        const parsed = enhancedInputSchemas.get_objc_protocols.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
      case "batch_decompile": {
        const parsed = enhancedInputSchemas.batch_decompile.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
      case "get_call_graph": {
        const parsed = enhancedInputSchemas.get_call_graph.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
      case "analyze_swift_types": {
        const parsed =
          enhancedInputSchemas.analyze_swift_types.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
      case "find_xrefs_to_name": {
        const parsed = enhancedInputSchemas.find_xrefs_to_name.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
      case "binary_overview": {
        const parsed = enhancedInputSchemas.binary_overview.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidEnhancedInput(name, parsed.error);
      }
    }
  }

  /** Dispatch input already parsed by a trusted adapter boundary. */
  executeValidated(
    call: ValidatedEnhancedCall,
    signal?: AbortSignal,
  ): EnhancedResult {
    switch (call.name) {
      case "inspect_native_dispatch_metadata":
        return inspectNativeDispatch(this.analysis, call.input.max_records, {
          signal,
          objcClassImportAddresses: call.input.objc_class_import_addresses,
          objcClassImportAddressesComplete:
            call.input.objc_class_import_addresses_complete,
          maxInputBytes: call.input.max_input_bytes,
        });
      case "get_objc_classes":
        return this.#objcClasses(call.input.pattern, signal);
      case "get_objc_protocols":
        return this.#objcProtocols(signal);
      case "batch_decompile":
        return this.#batchDecompile(call.input.addresses, signal);
      case "get_call_graph":
        return this.#callGraph(call.input, signal);
      case "analyze_swift_types":
        return this.#analyzeSwiftTypes(call.input, signal);
      case "find_xrefs_to_name":
        return this.#findXrefs(call.input.name, signal);
      case "binary_overview":
        return this.#binaryOverview(signal);
      case "analyze_function":
        return this.#analyzeFunction(call.input, signal);
      case "inspect_native_api":
        return this.#inspectNativeApi(call.input, signal);
      case "trace_feature":
        return traceLiteralFeature(
          (name, arguments_, operationSignal) =>
            this.#call(name, arguments_, operationSignal),
          (name, arguments_, operationSignal) =>
            this.#observe(name, arguments_, operationSignal),
          call.input,
          signal,
        );
      case "trace_call_path":
        return traceCallPath(
          (name, arguments_, operationSignal, selectorOrigin) =>
            this.#call(name, arguments_, operationSignal, selectorOrigin),
          (name, arguments_, operationSignal, selectorOrigin) =>
            this.#observe(name, arguments_, operationSignal, selectorOrigin),
          call.input,
          signal,
        );
      case "trace_native_values":
        return traceNativeValues(this.analysis, call.input, signal);
      case "trace_native_ui_action": {
        return traceNativeUiAction(this.analysis, call.input, signal);
      }
    }
  }

  #executeTracing(
    name: "trace_feature" | "trace_call_path",
    input: unknown,
    signal?: AbortSignal,
  ): EnhancedResult {
    if (name === "trace_call_path") {
      const parsed = enhancedInputSchemas.trace_call_path.safeParse(input);
      if (!parsed.success) return invalidEnhancedInput(name, parsed.error);
      return this.executeValidated({ name, input: parsed.data }, signal);
    }
    const parsed = enhancedInputSchemas.trace_feature.safeParse(input);
    if (!parsed.success) return invalidEnhancedInput(name, parsed.error);
    return this.executeValidated({ name, input: parsed.data }, signal);
  }

  #executeFunctionAnalysis(
    name: "analyze_function" | "inspect_native_api",
    input: unknown,
    signal?: AbortSignal,
  ): EnhancedResult {
    if (name === "analyze_function") {
      const parsed = enhancedInputSchemas.analyze_function.safeParse(input);
      if (!parsed.success) return invalidEnhancedInput(name, parsed.error);
      return this.executeValidated({ name, input: parsed.data }, signal);
    }
    const parsed = enhancedInputSchemas.inspect_native_api.safeParse(input);
    if (!parsed.success) return invalidEnhancedInput(name, parsed.error);
    return this.executeValidated({ name, input: parsed.data }, signal);
  }

  async #analyzeFunction(
    input: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): EnhancedResult {
    const result = await this.#call("analyze_function", input, signal);
    return result.ok ? parseFunctionDossier(result.value) : result;
  }

  async #inspectNativeApi(
    input: z.output<typeof enhancedInputSchemas.inspect_native_api>,
    signal?: AbortSignal,
  ): EnhancedResult {
    const analysisInput = enhancedInputSchemas.analyze_function.parse({
      procedure: input.procedure,
    });
    const result = await this.#call("analyze_function", analysisInput, signal);
    if (!result.ok) return result;
    const parsed = parseFunctionDossier(result.value);
    if (!parsed.ok) return parsed;
    const dossier = functionDossierSchema.parse(parsed.value);
    return ok(jsonValueSchema.parse(projectNativeApiInspection(dossier)));
  }

  async #objcClasses(pattern: string, signal?: AbortSignal): EnhancedResult {
    const namesExecution = await this.#observe("list_names", {}, signal);
    if (!namesExecution.ok)
      return err(macosUtilityRefusal("get_objc_classes", namesExecution.error));
    const names = this.#parseAddressed(
      "list_names",
      namesExecution.value.result,
    );
    if (!names.ok) return names;
    const candidates = selectObjcClassCandidates(names.value, pattern);
    if (candidates.length === 0)
      return ok(
        projectObjcClassCandidates(candidates, {
          bindings: [],
          coverage: { status: "not_applicable", reason: null },
        }),
      );

    const addresses = [...new Set(candidates.map(({ address }) => address))];
    const scannedAddresses = addresses.slice(0, MAX_ENHANCED_RECORDS);
    const bindingsExecution = await this.#observe(
      "inspect_native_dispatch_metadata",
      {
        max_records: MAX_ENHANCED_RECORDS,
        objc_class_import_addresses: scannedAddresses,
        objc_class_import_addresses_complete:
          addresses.length <= MAX_ENHANCED_RECORDS,
      },
      signal,
    );
    if (!bindingsExecution.ok) {
      if (bindingsExecution.error._tag === "AnalysisCancelledError")
        return bindingsExecution;
      if (bindingsExecution.error._tag !== "AnalysisCapabilityUnavailableError")
        return bindingsExecution;
      return ok(
        projectObjcClassCandidates(candidates, {
          bindings: [],
          coverage: {
            status: "unknown",
            reason: `Native class-import binding evidence is unavailable (${bindingsExecution.error._tag}).`,
          },
        }),
      );
    }

    const native = nativeDispatchMetadataResultSchema.safeParse(
      bindingsExecution.value.result,
    );
    const nameSubject = namesExecution.value.subject;
    const bindingSubject = bindingsExecution.value.subject;
    const namesSelection = profileMachoTargetSelection(
      namesExecution.value.analysisProfile,
    );
    const nativeSelection = native.success
      ? native.data.result.target_selection
      : undefined;
    if (
      !native.success ||
      nameSubject === null ||
      nameSubject === undefined ||
      bindingSubject === null ||
      bindingSubject === undefined ||
      nameSubject.sha256 !== bindingSubject.sha256 ||
      nameSubject.architecture === undefined ||
      bindingSubject.architecture === undefined ||
      nameSubject.architecture !== bindingSubject.architecture ||
      !isMachOFormat(nameSubject.format) ||
      nameSubject.format !== bindingSubject.format ||
      native.data.target_sha256 !== nameSubject.sha256 ||
      native.data.target_architecture !== nameSubject.architecture ||
      native.data.provider.id !== bindingsExecution.value.provider.id ||
      namesExecution.value.analysisProfile?.provider.id !==
        namesExecution.value.provider.id ||
      nativeSelection === undefined ||
      !machoTargetSelectionMatchesArchitecture(
        nativeSelection,
        nameSubject.architecture,
      ) ||
      !machoTargetSelectionMatchesFormat(nativeSelection, nameSubject.format) ||
      !sameMachoTargetSelection(namesSelection, nativeSelection) ||
      native.data.result.objc_class_import_bindings === undefined ||
      native.data.result.objc_class_import_binding_coverage === undefined
    )
      return ok(
        projectObjcClassCandidates(candidates, {
          bindings: [],
          coverage: {
            status: "unknown",
            reason:
              "Native class-import facts did not prove matching artifact, architecture, and complete producer identity.",
          },
        }),
      );

    const coverage = native.data.result.objc_class_import_binding_coverage;
    const inventoryLimitations = namesExecution.value.limitations;
    const inventoryIncomplete = inventoryLimitations.length > 0;
    const coverageReason = [
      coverage.reason,
      ...inventoryLimitations.map((limitation) => `list_names: ${limitation}`),
    ]
      .filter((reason): reason is string => reason !== null)
      .join("; ");
    return ok(
      projectObjcClassCandidates(candidates, {
        bindings: native.data.result.objc_class_import_bindings,
        coverage: {
          status:
            coverage.status === "not_requested"
              ? "unknown"
              : coverage.status === "complete" && inventoryIncomplete
                ? "partial"
                : coverage.status,
          reason: coverageReason.length === 0 ? null : coverageReason,
        },
      }),
    );
  }

  async #objcProtocols(signal?: AbortSignal): EnhancedResult {
    const names = await this.#allAddressed("list_names", signal);
    if (!names.ok)
      return err(macosUtilityRefusal("get_objc_protocols", names.error));
    return ok(discoverObjcProtocols(names.value));
  }

  async #batchDecompile(
    addresses: readonly string[],
    signal?: AbortSignal,
  ): EnhancedResult {
    const resolutions = await Promise.all(
      addresses.map(async (address) => {
        const result = await resolveProcedureAddress(
          this.#call.bind(this),
          address,
          signal,
        );
        return { address, result };
      }),
    );
    const resolutionCancellation = firstAnalysisCancellation(
      resolutions.map(({ result }) => result),
    );
    if (resolutionCancellation !== undefined)
      return err(resolutionCancellation);

    const identities = await this.#batchIdentities(resolutions, signal);
    const ready: BatchReadyItem[] = [];
    for (const identity of identities) {
      if (!identity.ok) return err(identity.error);
      ready.push(identity.value);
    }
    const decompilations = await this.#batchPseudocode(ready, signal);
    const items: BatchDecompileItem[] = [];
    for (const decompilation of decompilations) {
      if (!decompilation.ok) return err(decompilation.error);
      items.push(decompilation.value);
    }
    const succeeded = items.filter(({ status }) => status === "ok").length;
    return ok({
      items,
      total: items.length,
      succeeded,
      failed: items.length - succeeded,
    });
  }

  async #batchIdentities(
    resolutions: readonly BatchResolution[],
    signal?: AbortSignal,
  ): Promise<Result<BatchReadyItem, AnalysisCancelledError>[]> {
    return Promise.all(
      resolutions.map(async ({ address, result }) => {
        if (!result.ok)
          return ok({
            address,
            providerProcedure: address,
            procedure: {
              status: "unknown" as const,
              error: projectAnalysisError(result.error),
            },
          });
        const identity = await this.#batchProcedureIdentity(
          result.value,
          signal,
        );
        return identity.ok
          ? ok({
              address,
              providerProcedure: result.value,
              procedure: identity.value,
            })
          : err(identity.error);
      }),
    );
  }

  async #batchPseudocode(
    ready: readonly BatchReadyItem[],
    signal?: AbortSignal,
  ): Promise<Result<BatchDecompileItem, AnalysisCancelledError>[]> {
    return Promise.all(
      ready.map(async ({ address, procedure, providerProcedure }) => {
        const result = await this.#call(
          "procedure_pseudo_code",
          { procedure: providerProcedure },
          signal,
          procedure.status === "resolved" ? "provider" : undefined,
        );
        if (!result.ok && isAnalysisCancellation(result.error))
          return err(result.error);
        const item: BatchDecompileItem = !result.ok
          ? {
              address,
              procedure,
              status: "error",
              error: projectAnalysisError(result.error),
            }
          : typeof result.value !== "string" || result.value.length === 0
            ? {
                address,
                procedure,
                status: "error",
                error: projectAnalysisError(
                  new AnalysisOutputError(
                    "procedure_pseudo_code",
                    "provider returned empty pseudocode",
                  ),
                ),
              }
            : {
                address,
                procedure,
                status: "ok",
                pseudocode: result.value,
              };
        return ok(item);
      }),
    );
  }

  async #batchProcedureIdentity(
    address: string,
    signal?: AbortSignal,
  ): Promise<Result<BatchProcedureIdentity, AnalysisCancelledError>> {
    const observed = await this.#call("address_name", { address }, signal);
    if (!observed.ok && isAnalysisCancellation(observed.error))
      return err(observed.error);
    const named =
      observed.ok &&
      (typeof observed.value === "string" || observed.value === null);
    return ok({
      status: "resolved" as const,
      address,
      name: named ? observed.value : null,
      ...(named
        ? {}
        : {
            name_error: projectAnalysisError(
              observed.ok
                ? new AnalysisOutputError(
                    "address_name",
                    "provider returned an invalid entry label",
                  )
                : observed.error,
            ),
          }),
    });
  }

  async #callGraph(
    input: {
      readonly address: string;
      readonly direction: CallRelationshipDirection;
    },
    signal?: AbortSignal,
  ): EnhancedResult {
    const { relation, operation: tool } =
      CALL_RELATIONSHIP_TRAVERSALS[input.direction];
    const limitations = new Set<string>();
    const resolved = await this.#observe(
      "procedure_address",
      { procedure: input.address },
      signal,
    );
    if (!resolved.ok) return resolved;
    for (const limitation of resolved.value.limitations)
      limitations.add(limitation);
    const startAddress = resolved.value.result;
    if (typeof startAddress !== "string" || startAddress.length === 0)
      return err(
        new AnalysisOutputError(
          "procedure_address",
          "provider returned no canonical procedure address",
        ),
      );
    const discovered = new Set([startAddress]);
    const queue: Array<{ address: string; depth: number }> = [
      { address: startAddress, depth: 0 },
    ];
    let queueIndex = 0;
    const graph: Record<string, JsonValue[]> = {};

    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];
      if (current === undefined) continue;
      const level = String(current.depth);
      graph[level] ??= [];

      const result = await this.#observe(
        tool,
        { procedure: current.address },
        signal,
        "provider",
      );
      if (!result.ok) {
        if (isAnalysisCancellation(result.error)) return result;
        graph[level].push({
          address: current.address,
          status: "error",
          error: projectAnalysisError(result.error),
        });
        continue;
      }
      const related = parseRelatedAddresses(result.value.result, relation);
      if (!related.ok) {
        graph[level].push({
          address: current.address,
          status: "error",
          error: projectAnalysisError(related.error),
        });
        continue;
      }
      for (const limitation of result.value.limitations)
        limitations.add(limitation);
      const reportedCoverage = result.value.relationshipCoverage;
      const coverage = reportedCoverage ?? {
        status: "unknown" as const,
        reason: "Provider did not report relationship coverage.",
      };
      const relationshipLimitations =
        reportedCoverage === undefined
          ? [
              ...result.value.limitations,
              "Provider did not report relationship coverage.",
            ]
          : [
              ...(reportedCoverage.status === "partial"
                ? reportedCoverage.limitations
                : reportedCoverage.status === "unknown"
                  ? [reportedCoverage.reason]
                  : []),
              ...("diagnostics" in reportedCoverage
                ? reportedCoverage.diagnostics
                : []),
            ];
      const nodeLimitations = [...new Set(relationshipLimitations)].sort(
        compareUnicodeCodePoints,
      );
      graph[level].push({
        address: current.address,
        status: "ok",
        calls: [...related.value],
        relationship_coverage: coverage,
        ...(nodeLimitations.length === 0
          ? {}
          : { limitations: nodeLimitations }),
      });
      for (const address of related.value) {
        if (!discovered.has(address)) {
          discovered.add(address);
          queue.push({ address, depth: current.depth + 1 });
        }
      }
    }
    return ok({
      graph,
      limitations: [...limitations].sort(compareUnicodeCodePoints),
    });
  }

  async #analyzeSwiftTypes(
    input: z.output<typeof enhancedInputSchemas.analyze_swift_types>,
    signal?: AbortSignal,
  ): EnhancedResult {
    const procedures = await this.#allAddressed("list_procedures", signal);
    if (!procedures.ok)
      return err(macosUtilityRefusal("analyze_swift_types", procedures.error));
    const symbols = await this.#allAddressed("list_names", signal);
    if (
      !symbols.ok &&
      !(symbols.error instanceof AnalysisCapabilityUnavailableError)
    )
      return symbols;
    const result = categorizeSwiftTypes(
      procedures.value,
      input,
      symbols.ok ? symbols.value : [],
    );
    return ok(
      symbols.ok
        ? result
        : {
            ...result,
            symbol_inventory_error: projectAnalysisError(symbols.error),
            limitations: [
              ...result.limitations,
              "The provider's symbol inventory is unavailable; demangled procedures could not be joined to their Swift aliases.",
            ],
          },
    );
  }

  async #findXrefs(name: string, signal?: AbortSignal): EnhancedResult {
    const names = await this.#allAddressed("list_names", signal);
    if (!names.ok) return names;
    const resolved = names.value.find((entry) => entry.name === name);
    if (resolved === undefined)
      return ok({ status: "unresolved", name, reason: "name_not_found" });

    const xrefs = await this.#call(
      "xrefs",
      { address: resolved.address },
      signal,
    );
    if (!xrefs.ok) return xrefs;
    if (
      !Array.isArray(xrefs.value) ||
      xrefs.value.some((xref) => typeof xref !== "string")
    )
      return err(
        new AnalysisOutputError(
          "xrefs",
          "provider returned an invalid address list",
        ),
      );
    return ok({
      status: "resolved",
      name,
      address: resolved.address,
      xrefs: xrefs.value,
    });
  }

  async #binaryOverview(signal?: AbortSignal): EnhancedResult {
    const direct = await this.#call(
      "read_binary_inventory_summary",
      {},
      signal,
    );
    if (
      direct.ok ||
      !(direct.error instanceof AnalysisCapabilityUnavailableError) ||
      direct.error.cleanupIncomplete
    )
      return direct;
    const document = await resolveAnalysisDocument(
      this.analysis,
      undefined,
      signal,
    );
    if (!document.ok) return document;
    const [segmentsResult, proceduresResult, stringsResult] = await Promise.all(
      [
        this.#call("list_segments", {}, signal),
        this.#call("list_procedures", {}, signal),
        this.#call("list_strings", {}, signal),
      ],
    );
    if (
      !segmentsResult.ok &&
      !(segmentsResult.error instanceof AnalysisCapabilityUnavailableError)
    )
      return segmentsResult;
    if (!proceduresResult.ok) return proceduresResult;
    if (!stringsResult.ok) return stringsResult;

    const segments = segmentsResult.ok
      ? parseSegments(segmentsResult.value)
      : undefined;
    if (segments !== undefined && !segments.ok) return segments;
    const procedureCount = parseListCount(proceduresResult.value, "procedures");
    if (!procedureCount.ok) return procedureCount;
    const stringCount = parseListCount(stringsResult.value, "strings");
    if (!stringCount.ok) return stringCount;

    return ok(
      projectBinaryOverview({
        document: document.value,
        ...(segments?.ok ? { segments: segments.value } : {}),
        procedure_count: procedureCount.value,
        string_count: stringCount.value,
      }),
    );
  }

  async #allAddressed(
    tool: "list_names" | "list_procedures",
    signal?: AbortSignal,
  ) {
    const result = await this.#call(tool, {}, signal);
    if (!result.ok) return result;
    return this.#parseAddressed(tool, result.value);
  }

  #parseAddressed(tool: "list_names" | "list_procedures", value: JsonValue) {
    const parsed = z.array(addressedValueSchema).safeParse(value);
    return parsed.success
      ? ok(
          parsed.data.map(({ address, value: name, objc_class_label }) => ({
            address,
            name,
            ...(objc_class_label === undefined ? {} : { objc_class_label }),
          })),
        )
      : err(
          new AnalysisOutputError(
            tool,
            "provider returned an invalid inventory",
          ),
        );
  }

  async #call(
    name: AnalysisOperation,
    arguments_: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
    selectorOrigin?: ExecutionOptions["selectorOrigin"],
  ): Promise<Result<JsonValue, AnalysisError>> {
    const execution = await this.#observe(
      name,
      arguments_,
      signal,
      selectorOrigin,
    );
    return execution.ok ? ok(execution.value.result) : execution;
  }

  async #observe(
    name: AnalysisOperation,
    arguments_: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
    selectorOrigin?: ExecutionOptions["selectorOrigin"],
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (isAborted(signal))
      return err(new AnalysisCancelledError(name, { cause: signal?.reason }));
    const execution = await this.analysis.execute(name, arguments_, {
      ...(signal === undefined ? {} : { signal }),
      ...(selectorOrigin === undefined ? {} : { selectorOrigin }),
    });
    if (!execution.ok) return execution;
    if (isAborted(signal))
      return err(new AnalysisCancelledError(name, { cause: signal?.reason }));
    return execution;
  }
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;
