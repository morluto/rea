import type { z } from "zod";

import type {
  AnalysisOperation,
  AnalysisOperationPort,
} from "./AnalysisProvider.js";
import type { EnhancedToolName } from "../contracts/enhancedInputs.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  projectAnalysisError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  addressDistance,
  functionDossierSchema,
  parseDocuments,
  parseFunctionDossier,
  parseListCount,
  parseRelatedAddresses,
  parseSegments,
} from "../domain/hopperValues.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  categorizeSwiftTypes,
  discoverObjcClasses,
  discoverObjcProtocols,
  discoverSwiftClasses,
} from "../domain/symbolAnalysis.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

import {
  invalidEnhancedInput,
  type EnhancedResult,
  type ValidatedEnhancedCall,
} from "./EnhancedToolTypes.js";
import { readAllAddressed } from "./EnhancedToolPagination.js";
import { traceCallPath } from "./CallPathTracing.js";
import { traceLiteralFeature } from "./EnhancedLiteralTracing.js";
import { projectNativeApiInspection } from "./NativeApiInspection.js";
export type { ValidatedEnhancedCall } from "./EnhancedToolTypes.js";

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
    if (
      name === "trace_feature" ||
      name === "find_code_for_string" ||
      name === "trace_call_path"
    )
      return this.#executeTracing(name, input, signal);
    if (name === "analyze_function" || name === "inspect_native_api")
      return this.#executeFunctionAnalysis(name, input, signal);
    switch (name) {
      case "swift_classes": {
        const parsed = enhancedInputSchemas.swift_classes.safeParse(input);
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
      case "get_objc_protocols":
        return this.executeValidated({ name, input: {} }, signal);
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
      case "analyze_swift_types":
        return this.executeValidated({ name, input: {} }, signal);
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
      case "swift_classes":
        return this.#swiftClasses(call.input.pattern, signal);
      case "get_objc_classes":
        return this.#objcClasses(call.input.pattern, signal);
      case "get_objc_protocols":
        return this.#objcProtocols(signal);
      case "batch_decompile":
        return this.#batchDecompile(call.input.addresses, signal);
      case "get_call_graph":
        return this.#callGraph(call.input, signal);
      case "analyze_swift_types":
        return this.#analyzeSwiftTypes(signal);
      case "find_xrefs_to_name":
        return this.#findXrefs(call.input.name, signal);
      case "binary_overview":
        return this.#binaryOverview(call.input, signal);
      case "analyze_function":
        return this.#analyzeFunction(call.input, signal);
      case "inspect_native_api":
        return this.#inspectNativeApi(call.input, signal);
      case "trace_feature":
        return traceLiteralFeature(
          (name, arguments_, operationSignal) =>
            this.#call(name, arguments_, operationSignal),
          call.input,
          "feature",
          signal,
        );
      case "find_code_for_string":
        return traceLiteralFeature(
          (name, arguments_, operationSignal) =>
            this.#call(name, arguments_, operationSignal),
          call.input,
          "string",
          signal,
        );
      case "trace_call_path":
        return traceCallPath(
          (name, arguments_, operationSignal) =>
            this.#call(name, arguments_, operationSignal),
          call.input,
          signal,
        );
    }
  }

  #executeTracing(
    name: "trace_feature" | "find_code_for_string" | "trace_call_path",
    input: unknown,
    signal?: AbortSignal,
  ): EnhancedResult {
    if (name === "trace_call_path") {
      const parsed = enhancedInputSchemas.trace_call_path.safeParse(input);
      if (!parsed.success) return invalidEnhancedInput(name, parsed.error);
      return this.executeValidated({ name, input: parsed.data }, signal);
    }
    if (name === "trace_feature") {
      const parsed = enhancedInputSchemas.trace_feature.safeParse(input);
      if (!parsed.success) return invalidEnhancedInput(name, parsed.error);
      return this.executeValidated({ name, input: parsed.data }, signal);
    }
    const parsed = enhancedInputSchemas.find_code_for_string.safeParse(input);
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
      include_assembly: true,
      max_pseudocode_chars: input.max_pseudocode_chars,
      max_instructions: input.max_instructions,
    });
    const result = await this.#call("analyze_function", analysisInput, signal);
    if (!result.ok) return result;
    const parsed = parseFunctionDossier(result.value);
    if (!parsed.ok) return parsed;
    const dossier = functionDossierSchema.parse(parsed.value);
    return ok(jsonValueSchema.parse(projectNativeApiInspection(dossier)));
  }

  async #swiftClasses(pattern: string, signal?: AbortSignal): EnhancedResult {
    const procedures = await this.#allAddressed("list_procedures", signal);
    return procedures.ok
      ? ok(discoverSwiftClasses(procedures.value, pattern))
      : procedures;
  }

  async #objcClasses(pattern: string, signal?: AbortSignal): EnhancedResult {
    const names = await this.#allAddressed("list_names", signal);
    return names.ok ? ok(discoverObjcClasses(names.value, pattern)) : names;
  }

  async #objcProtocols(signal?: AbortSignal): EnhancedResult {
    const names = await this.#allAddressed("list_names", signal);
    return names.ok ? ok(discoverObjcProtocols(names.value)) : names;
  }

  async #batchDecompile(
    addresses: readonly string[],
    signal?: AbortSignal,
  ): EnhancedResult {
    const items = await Promise.all(
      addresses.map(async (address) => {
        const result = await this.#call(
          "procedure_pseudo_code",
          { procedure: address },
          signal,
        );
        if (!result.ok)
          return {
            address,
            status: "error" as const,
            error: projectAnalysisError(result.error),
          };
        if (typeof result.value !== "string" || result.value.length === 0)
          return {
            address,
            status: "error" as const,
            error: projectAnalysisError(
              new AnalysisOutputError(
                "procedure_pseudo_code",
                "provider returned empty pseudocode",
              ),
            ),
          };
        return { address, status: "ok" as const, pseudocode: result.value };
      }),
    );
    const succeeded = items.filter(({ status }) => status === "ok").length;
    return ok({
      items,
      total: items.length,
      succeeded,
      failed: items.length - succeeded,
    });
  }

  async #callGraph(
    input: {
      readonly address: string;
      readonly direction: "forward" | "backward";
      readonly depth: number;
    },
    signal?: AbortSignal,
  ): EnhancedResult {
    const relation = input.direction === "forward" ? "callees" : "callers";
    const tool =
      input.direction === "forward" ? "procedure_callees" : "procedure_callers";
    const discovered = new Set([input.address]);
    const queue: Array<{ address: string; depth: number }> = [
      { address: input.address, depth: 0 },
    ];
    let queueIndex = 0;
    const graph: Record<string, JsonValue[]> = {};

    while (queueIndex < queue.length) {
      const current = queue[queueIndex++];
      if (current === undefined || current.depth >= input.depth) {
        continue;
      }
      const level = String(current.depth);
      graph[level] ??= [];

      const result = await this.#call(
        tool,
        { procedure: current.address },
        signal,
      );
      if (!result.ok) {
        graph[level].push({
          address: current.address,
          status: "error",
          error: projectAnalysisError(result.error),
        });
        continue;
      }
      const related = parseRelatedAddresses(result.value, relation);
      if (!related.ok) {
        graph[level].push({
          address: current.address,
          status: "error",
          error: projectAnalysisError(related.error),
        });
        continue;
      }
      graph[level].push({
        address: current.address,
        status: "ok",
        calls: [...related.value],
      });
      if (current.depth + 1 < input.depth) {
        for (const address of related.value) {
          if (!discovered.has(address)) {
            discovered.add(address);
            queue.push({ address, depth: current.depth + 1 });
          }
        }
      }
    }
    return ok(graph);
  }

  async #analyzeSwiftTypes(signal?: AbortSignal): EnhancedResult {
    const procedures = await this.#allAddressed("list_procedures", signal);
    return procedures.ok
      ? ok(categorizeSwiftTypes(procedures.value))
      : procedures;
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

  async #binaryOverview(
    input: { detail: "concise" | "detailed"; limit: number },
    signal?: AbortSignal,
  ): EnhancedResult {
    const [segmentsResult, documentsResult, proceduresResult, stringsResult] =
      await Promise.all([
        this.#call("list_segments", {}, signal),
        this.#call("list_documents", {}, signal),
        this.#call("list_procedures", { offset: 0, limit: 1 }, signal),
        this.#call("list_strings", { offset: 0, limit: 1 }, signal),
      ]);
    if (!segmentsResult.ok) return segmentsResult;
    if (!documentsResult.ok) return documentsResult;
    if (!proceduresResult.ok) return proceduresResult;
    if (!stringsResult.ok) return stringsResult;

    const segments = parseSegments(segmentsResult.value);
    if (!segments.ok) return segments;
    const documents = parseDocuments(documentsResult.value);
    if (!documents.ok) return documents;
    const procedureCount = parseListCount(proceduresResult.value, "procedures");
    if (!procedureCount.ok) return procedureCount;
    const stringCount = parseListCount(stringsResult.value, "strings");
    if (!stringCount.ok) return stringCount;

    return ok({
      document: documents.value[0] ?? "unknown",
      detail: input.detail,
      segments: segments.value
        .slice(0, input.limit)
        .map(({ name, start, end }) =>
          input.detail === "detailed"
            ? { name, start, end, length: addressDistance(start, end) }
            : { name, start, end },
        ),
      segment_count: segments.value.length,
      procedure_count: procedureCount.value,
      string_count: stringCount.value,
    });
  }

  async #allAddressed(
    tool: "list_names" | "list_procedures",
    signal?: AbortSignal,
  ) {
    return readAllAddressed({
      call: (name, arguments_, operationSignal) =>
        this.#call(name, arguments_, operationSignal),
      tool,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #call(
    name: AnalysisOperation,
    arguments_: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<JsonValue, AnalysisError>> {
    if (signal?.aborted === true) return err(new AnalysisCancelledError(name));
    const execution = await this.analysis.execute(
      name,
      arguments_,
      signal === undefined ? {} : { signal },
    );
    return execution.ok ? ok(execution.value.result) : execution;
  }
}
