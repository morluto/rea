import type {
  AnalysisOperation,
  AnalysisOperationPort,
} from "./AnalysisProvider.js";
import type { z } from "zod";
import type { EnhancedToolName } from "../contracts/enhancedInputs.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import {
  AnalysisInputError,
  AnalysisCancelledError,
  AnalysisOutputError,
  projectAnalysisError,
  type AnalysisError,
} from "../domain/errors.js";
import {
  addressDistance,
  parseDocuments,
  parseFunctionDossier,
  parseAddressedPage,
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
import type { JsonValue } from "../domain/jsonValue.js";

type EnhancedResult = Promise<Result<JsonValue, AnalysisError>>;
type TraceMatch = { type: string; address: string; value: string };
type TraceReference = {
  target_address: string;
  source_address: string;
  containing_procedure: JsonValue;
};

/** One enhanced call whose input was parsed at its owning adapter boundary. */
export type ValidatedEnhancedCall = {
  [Name in EnhancedToolName]: {
    readonly name: Name;
    readonly input: z.output<(typeof enhancedInputSchemas)[Name]>;
  };
}[EnhancedToolName];

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
    switch (name) {
      case "swift_classes": {
        const parsed = enhancedInputSchemas.swift_classes.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
      }
      case "get_objc_classes": {
        const parsed = enhancedInputSchemas.get_objc_classes.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
      }
      case "get_objc_protocols":
        return this.executeValidated({ name, input: {} }, signal);
      case "batch_decompile": {
        const parsed = enhancedInputSchemas.batch_decompile.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
      }
      case "get_call_graph": {
        const parsed = enhancedInputSchemas.get_call_graph.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
      }
      case "analyze_swift_types":
        return this.executeValidated({ name, input: {} }, signal);
      case "find_xrefs_to_name": {
        const parsed = enhancedInputSchemas.find_xrefs_to_name.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
      }
      case "binary_overview": {
        const parsed = enhancedInputSchemas.binary_overview.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
      }
      case "analyze_function": {
        const parsed = enhancedInputSchemas.analyze_function.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
      }
      case "trace_feature": {
        const parsed = enhancedInputSchemas.trace_feature.safeParse(input);
        return parsed.success
          ? this.executeValidated({ name, input: parsed.data }, signal)
          : invalidInput(name, parsed.error);
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
      case "trace_feature":
        return this.#traceFeature(call.input, signal);
    }
  }

  async #analyzeFunction(
    input: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): EnhancedResult {
    const result = await this.#call("analyze_function", input, signal);
    return result.ok ? parseFunctionDossier(result.value) : result;
  }

  async #swiftClasses(pattern: string, signal?: AbortSignal): EnhancedResult {
    const procedures = await this.#allProcedures(signal);
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
    const procedures = await this.#allProcedures(signal);
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
    const [segmentsResult, documentsResult, procedures, stringsResult] =
      await Promise.all([
        this.#call("list_segments", {}, signal),
        this.#call("list_documents", {}, signal),
        this.#allProcedures(signal),
        this.#call("list_strings", {}, signal),
      ]);
    if (!segmentsResult.ok) return segmentsResult;
    if (!documentsResult.ok) return documentsResult;
    if (!procedures.ok) return procedures;
    if (!stringsResult.ok) return stringsResult;

    const segments = parseSegments(segmentsResult.value);
    if (!segments.ok) return segments;
    const documents = parseDocuments(documentsResult.value);
    if (!documents.ok) return documents;
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
      procedure_count: procedures.value.length,
      string_count: stringCount.value,
    });
  }

  async #traceFeature(
    input: {
      readonly query: string;
      readonly case_sensitive: boolean;
      readonly limit: number;
      readonly max_operations: number;
    },
    signal?: AbortSignal,
  ): EnhancedResult {
    const searched = await this.#literalMatches(input, signal);
    if (!searched.ok) return searched;
    const residual = new Set<string>();
    const traced = await this.#traceReferences(
      searched.value.matches,
      input.limit,
      input.max_operations - searched.value.operations,
      signal,
    );
    if (!traced.ok) return traced;
    for (const reason of traced.value.residual) residual.add(reason);
    const operations = searched.value.operations + traced.value.operations;
    if (operations >= input.max_operations)
      residual.add("Investigation reached the operation budget.");
    if (searched.value.matches.length >= input.limit)
      residual.add("Literal matches reached the configured limit.");
    return ok({
      query: input.query,
      search_mode: "literal",
      operations_used: operations,
      operation_budget: input.max_operations,
      matches: searched.value.matches,
      references: traced.value.references,
      truncated: residual.size > 0,
      residual_unknowns: [...residual],
    });
  }

  async #literalMatches(
    input: {
      readonly query: string;
      readonly case_sensitive: boolean;
      readonly limit: number;
      readonly max_operations: number;
    },
    signal?: AbortSignal,
  ): Promise<
    Result<{ matches: TraceMatch[]; operations: number }, AnalysisError>
  > {
    let operations = 0;
    const matches: TraceMatch[] = [];
    const needle = input.case_sensitive
      ? input.query
      : input.query.toLowerCase();
    for (const [tool, type] of [
      ["list_strings", "string"],
      ["list_procedures", "procedure"],
    ] as const) {
      let offset = 0;
      while (
        operations < input.max_operations &&
        matches.length < input.limit
      ) {
        operations += 1;
        const result = await this.#call(tool, { offset, limit: 500 }, signal);
        if (!result.ok) return result;
        const page = parseAddressedPage(result.value);
        if (!page.ok) return page;
        for (const item of page.value.items) {
          const haystack = input.case_sensitive
            ? item.name
            : item.name.toLowerCase();
          if (haystack.includes(needle))
            matches.push({ type, address: item.address, value: item.name });
          if (matches.length >= input.limit) break;
        }
        if (!page.value.hasMore || page.value.nextOffset === null) break;
        offset = page.value.nextOffset;
      }
    }
    return ok({ matches, operations });
  }

  async #traceReferences(
    matches: readonly TraceMatch[],
    limit: number,
    operationBudget: number,
    signal?: AbortSignal,
  ): Promise<
    Result<
      { references: TraceReference[]; operations: number; residual: string[] },
      AnalysisError
    >
  > {
    let operations = 0;
    const references: TraceReference[] = [];
    const residual = new Set<string>();
    for (const match of matches) {
      if (operations >= operationBudget) {
        residual.add("Reference traversal stopped at the operation budget.");
        break;
      }
      operations += 1;
      const xrefs = await this.#call(
        "xrefs",
        { address: match.address },
        signal,
      );
      if (!xrefs.ok) return xrefs;
      if (!Array.isArray(xrefs.value))
        return err(
          new AnalysisOutputError(
            "xrefs",
            "provider returned a non-array result",
          ),
        );
      for (const source of xrefs.value) {
        if (typeof source !== "string")
          return err(
            new AnalysisOutputError(
              "xrefs",
              "provider returned a non-address value",
            ),
          );
        if (operations >= operationBudget) {
          residual.add(
            "Containing-procedure resolution stopped at the operation budget.",
          );
          break;
        }
        operations += 1;
        const resolved = await this.#call(
          "resolve_containing_procedure",
          { address: source },
          signal,
        );
        if (!resolved.ok) return resolved;
        references.push({
          target_address: match.address,
          source_address: source,
          containing_procedure: resolved.value,
        });
        if (references.length >= limit) {
          residual.add("Reference results reached the configured limit.");
          break;
        }
      }
      if (references.length >= limit) break;
    }
    return ok({
      references,
      operations,
      residual: [...residual],
    });
  }

  async #allProcedures(signal?: AbortSignal) {
    return this.#allAddressed("list_procedures", signal);
  }

  async #allAddressed(
    tool: "list_names" | "list_procedures",
    signal?: AbortSignal,
  ) {
    const entries: Array<{ address: string; name: string }> = [];
    let offset = 0;
    while (true) {
      const result = await this.#call(tool, { offset, limit: 500 }, signal);
      if (!result.ok) return result;
      const page = parseAddressedPage(result.value);
      if (!page.ok) return page;
      entries.push(...page.value.items);
      if (!page.value.hasMore || page.value.nextOffset === null) {
        return ok(entries);
      }
      if (page.value.nextOffset <= offset) {
        return err(
          new AnalysisOutputError(
            tool,
            "provider returned a non-advancing pagination offset",
          ),
        );
      }
      offset = page.value.nextOffset;
    }
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

const invalidInput = (name: EnhancedToolName, cause: Error): EnhancedResult =>
  Promise.resolve(
    err(
      new AnalysisInputError(name, {
        cause,
      }),
    ),
  );
