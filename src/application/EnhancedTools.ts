import type { HopperToolPort } from "./HopperToolPort.js";
import type { EnhancedToolName } from "../contracts/enhancedInputs.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { HopperProtocolError, type HopperError } from "../domain/errors.js";
import {
  parseDocuments,
  parseListCount,
  parseNames,
  parseProcedures,
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
import type { JsonValue } from "../hopper/protocol.js";

type EnhancedResult = Promise<Result<JsonValue, HopperError>>;

/**
 * Composes official Hopper operations into bounded reverse-engineering tools.
 * Inputs are parsed again at this application boundary even though MCP normally
 * validates them, allowing direct callers to use the same service safely.
 */
export class EnhancedTools {
  constructor(private readonly hopper: HopperToolPort) {}

  /** Parse inputs again at the direct-call boundary, then dispatch exhaustively. */
  execute(
    name: EnhancedToolName,
    input: unknown,
    signal?: AbortSignal,
  ): EnhancedResult {
    switch (name) {
      case "swift_classes": {
        const parsed = enhancedInputSchemas.swift_classes.safeParse(input);
        return parsed.success
          ? this.#swiftClasses(parsed.data.pattern, signal)
          : invalidInput(name, parsed.error);
      }
      case "get_objc_classes": {
        const parsed = enhancedInputSchemas.get_objc_classes.safeParse(input);
        return parsed.success
          ? this.#objcClasses(parsed.data.pattern, signal)
          : invalidInput(name, parsed.error);
      }
      case "get_objc_protocols":
        return this.#objcProtocols(signal);
      case "batch_decompile": {
        const parsed = enhancedInputSchemas.batch_decompile.safeParse(input);
        return parsed.success
          ? this.#batchDecompile(parsed.data.addresses, signal)
          : invalidInput(name, parsed.error);
      }
      case "get_call_graph": {
        const parsed = enhancedInputSchemas.get_call_graph.safeParse(input);
        return parsed.success
          ? this.#callGraph(parsed.data, signal)
          : invalidInput(name, parsed.error);
      }
      case "analyze_swift_types":
        return this.#analyzeSwiftTypes(signal);
      case "find_xrefs_to_name": {
        const parsed = enhancedInputSchemas.find_xrefs_to_name.safeParse(input);
        return parsed.success
          ? this.#findXrefs(parsed.data.name, signal)
          : invalidInput(name, parsed.error);
      }
      case "binary_overview":
        return this.#binaryOverview(signal);
    }
  }

  async #swiftClasses(pattern: string, signal?: AbortSignal): EnhancedResult {
    const result = await this.#call("list_procedures", {}, signal);
    if (!result.ok) return result;
    const procedures = parseProcedures(result.value);
    return procedures.ok
      ? ok(discoverSwiftClasses(procedures.value, pattern))
      : procedures;
  }

  async #objcClasses(pattern: string, signal?: AbortSignal): EnhancedResult {
    const result = await this.#call("list_names", {}, signal);
    if (!result.ok) return result;
    const names = parseNames(result.value);
    return names.ok ? ok(discoverObjcClasses(names.value, pattern)) : names;
  }

  async #objcProtocols(signal?: AbortSignal): EnhancedResult {
    const result = await this.#call("list_names", {}, signal);
    if (!result.ok) return result;
    const names = parseNames(result.value);
    return names.ok ? ok(discoverObjcProtocols(names.value)) : names;
  }

  async #batchDecompile(
    addresses: readonly string[],
    signal?: AbortSignal,
  ): EnhancedResult {
    if (addresses.length === 0) return ok({ error: "No addresses provided" });

    const entries = await Promise.all(
      addresses.map(async (address) => {
        const result = await this.#call(
          "procedure_pseudo_code",
          { procedure: address },
          signal,
        );
        return [
          address,
          result.ok
            ? result.value === null || result.value === ""
              ? "No output"
              : result.value
            : `Error: ${result.error.message}`,
        ] as const;
      }),
    );
    return ok(Object.fromEntries(entries));
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
          error: result.error.message,
        });
        continue;
      }
      const related = parseRelatedAddresses(result.value, relation);
      if (!related.ok) {
        graph[level].push({
          address: current.address,
          error: related.error.message,
        });
        continue;
      }
      graph[level].push({
        address: current.address,
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
    const result = await this.#call("list_procedures", {}, signal);
    if (!result.ok) return result;
    const procedures = parseProcedures(result.value);
    return procedures.ok
      ? ok(categorizeSwiftTypes(procedures.value))
      : procedures;
  }

  async #findXrefs(name: string, signal?: AbortSignal): EnhancedResult {
    const resolved = await this.#call(
      "address_name",
      { address: name },
      signal,
    );
    if (!resolved.ok) return resolved;
    const address = resolveAddress(resolved.value);
    if (address === undefined)
      return ok({ error: `Could not resolve name: ${name}` });

    const xrefs = await this.#call("xrefs", { address }, signal);
    if (!xrefs.ok) return xrefs;
    return ok(
      Array.isArray(xrefs.value) ? { xrefs: xrefs.value } : xrefs.value,
    );
  }

  async #binaryOverview(signal?: AbortSignal): EnhancedResult {
    const [segmentsResult, documentsResult, proceduresResult, stringsResult] =
      await Promise.all([
        this.#call("list_segments", {}, signal),
        this.#call("list_documents", {}, signal),
        this.#call("list_procedures", {}, signal),
        this.#call("list_strings", {}, signal),
      ]);
    if (!segmentsResult.ok) return segmentsResult;
    if (!documentsResult.ok) return documentsResult;
    if (!proceduresResult.ok) return proceduresResult;
    if (!stringsResult.ok) return stringsResult;

    const segments = parseSegments(segmentsResult.value);
    if (!segments.ok) return segments;
    const documents = parseDocuments(documentsResult.value);
    if (!documents.ok) return documents;
    const procedures = parseProcedures(proceduresResult.value);
    if (!procedures.ok) return procedures;
    const stringCount = parseListCount(stringsResult.value, "strings");
    if (!stringCount.ok) return stringCount;

    return ok({
      document: documents.value[0] ?? "unknown",
      segments: segments.value
        .slice(0, 10)
        .map(({ name, start, end }) => ({ name, start, end })),
      segment_count: segments.value.length,
      procedure_count: procedures.value.length,
      string_count: stringCount.value,
    });
  }

  #call(
    name: string,
    arguments_: Readonly<Record<string, JsonValue>>,
    signal?: AbortSignal,
  ): Promise<Result<JsonValue, HopperError>> {
    return this.hopper.callTool(
      name,
      arguments_,
      signal === undefined ? {} : { signal },
    );
  }
}

const invalidInput = (name: EnhancedToolName, cause: Error): EnhancedResult =>
  Promise.resolve(
    err(
      new HopperProtocolError(`Invalid ${name} input after MCP validation`, {
        cause,
      }),
    ),
  );

const resolveAddress = (value: JsonValue): string | undefined => {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value.address ?? value.name;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};
