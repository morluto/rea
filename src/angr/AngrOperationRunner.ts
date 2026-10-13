import { z } from "zod";
import { analysisSearchInput } from "../contracts/analysisSearchContract.js";
import {
  AnalysisInputError,
  AnalysisCancelledError,
  AnalysisProtocolError,
} from "../domain/analysisErrorCore.js";
import {
  functionDossierSchema,
  functionInstructionWindowSchema,
  type functionBodySchema,
  type procedureIdentitySchema,
} from "../domain/hopperValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";
import { combineFunctionRelationshipCoverage } from "../domain/functionCallCoverage.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import type { AngrMcpConnection } from "./AngrMcpConnection.js";
import type { AngrOperation } from "./AngrProviderCapabilities.js";
import {
  ANGR_LIMITATIONS,
  ANGR_MUTATING_OPERATIONS,
} from "./AngrProviderCapabilities.js";
import { AngrEditRunner } from "./AngrEditRunner.js";
import {
  angrAddressSchema,
  basicBlocksSchema,
  callGraphSchema,
  decompileSchema,
  functionInfoSchema,
  functionPageSchema,
  stringsSchema,
  xrefsSchema,
  type AngrBasicBlock,
  type AngrCallGraph,
  type AngrFunction,
} from "./AngrProtocolValues.js";

/** One operation's raw upstream observations, retained alongside normalized results. */
export interface AngrRawObservation {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
}

type ProcedureIdentity = z.infer<typeof procedureIdentitySchema>;
type FunctionBody = z.infer<typeof functionBodySchema>;

const FUNCTION_PAGE_SIZE = 1000;
const STRING_LIMIT = 1_000_000;
const searchQuerySchema = z.object(analysisSearchInput);
/** Only these upstream answers prove the selector names no analyzed function. */
const MISSING_FUNCTION_ANSWER = /No function (?:found at address|named)/u;
const CALL_GRAPH_LIMITATION =
  "angr's call graph omits unresolved indirect calls; additional relationships may exist.";

const classification = (fn: {
  readonly is_plt: boolean;
  readonly is_simprocedure?: boolean;
}) => ({
  external: fn.is_plt || fn.is_simprocedure === true,
  thunk: fn.is_plt,
  thunk_target: null,
  provenance: "angr function flags",
});
const unrequestedBody: FunctionBody = {
  available: false,
  reason: "Function body ranges were not requested for related procedures.",
};
const summaryIdentity = (fn: {
  readonly address: string;
  readonly name: string;
  readonly is_plt: boolean;
}): ProcedureIdentity => ({
  address: fn.address,
  name: fn.name,
  classification: classification(fn),
  body: unrequestedBody,
});

/** Complete inclusive body ranges from angr's observed basic blocks. */
const bodyFromBlocks = (
  entry: string,
  blocks: readonly AngrBasicBlock[],
): FunctionBody => {
  const sized = blocks.filter((block) => block.size > 0);
  if (sized.length === 0)
    return {
      available: false,
      reason: "angr reports no sized basic blocks for this function.",
    };
  const sorted = sized
    .map((block) => {
      const start = BigInt(block.address);
      return { start, end: start + BigInt(block.size) - 1n };
    })
    .sort((left, right) => (left.start < right.start ? -1 : 1));
  // Adjacent or overlapping blocks merge into maximal disjoint ranges.
  const ranges: { start: bigint; end: bigint }[] = [];
  for (const range of sorted) {
    const previous = ranges[ranges.length - 1];
    if (previous !== undefined && range.start <= previous.end + 1n)
      previous.end = range.end > previous.end ? range.end : previous.end;
    else ranges.push({ ...range });
  }
  const entryAddress = BigInt(entry);
  const total = ranges.reduce(
    (sum, { start, end }) => sum + end - start + 1n,
    0n,
  );
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined)
    throw new AnalysisProtocolError("angr basic blocks vanished.");
  const span = last.end - first.start + 1n;
  return {
    available: true,
    provenance: "angr function basic blocks",
    ranges: ranges.map(({ start, end }) => ({
      start: `0x${start.toString(16)}`,
      end: `0x${end.toString(16)}`,
    })),
    total_bytes: Number(total),
    span_bytes: Number(span),
    non_contiguous: ranges.length > 1,
    contains_entry: ranges.some(
      ({ start, end }) => entryAddress >= start && entryAddress <= end,
    ),
  };
};

const sortedBlocks = (blocks: readonly AngrBasicBlock[]) =>
  [...blocks].sort((left, right) => {
    const a = BigInt(left.address);
    const b = BigInt(right.address);
    return a < b ? -1 : a > b ? 1 : 0;
  });

const instructionLines = (blocks: readonly AngrBasicBlock[]): string[] =>
  sortedBlocks(blocks).flatMap((block) =>
    (block.instructions ?? []).map(
      ({ address, mnemonic, op_str }) =>
        `${address}: ${mnemonic}${op_str.length > 0 ? ` ${op_str}` : ""}`,
    ),
  );

/** Translate explicit analyst questions into a closed set of read-only upstream requests. */
export class AngrOperationRunner {
  readonly raw: AngrRawObservation[] = [];
  readonly locations: EvidenceLocation[] = [];
  readonly limitations: string[] = [];
  relationshipCoverage: RelationshipCoverage | undefined;
  constructor(
    private readonly connection: AngrMcpConnection,
    private readonly projectId: string,
    private readonly options: {
      readonly signal?: AbortSignal | undefined;
      readonly selectorOrigin?: "provider" | undefined;
      /** Session-cached call graph; angr's recovered graph is static after CFG recovery. */
      readonly callGraph: (
        load: () => Promise<AngrCallGraph>,
      ) => Promise<AngrCallGraph>;
      /** Whether the connected server advertises the decompilation-flavor tools. */
      readonly flavorToolsAvailable: boolean;
      /** Called after an upstream edit applied; session caches derived from names are stale. */
      readonly onMutation: () => void;
      readonly onFlavor: (flavor: string) => void;
    },
  ) {}

  async call(
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    if (this.options.signal?.aborted) throw new AnalysisCancelledError(tool);
    const scoped = { ...args, project_id: this.projectId };
    const result = await this.connection.call(tool, scoped);
    this.raw.push({ tool, arguments: scoped, result });
    if (this.options.signal?.aborted) throw new AnalysisCancelledError(tool);
    return result;
  }

  async functions() {
    const result: { address: string; value: string }[] = [];
    let offset = 0;
    for (;;) {
      const page = functionPageSchema.parse(
        await this.call("list_functions", {
          offset,
          limit: FUNCTION_PAGE_SIZE,
        }),
      );
      result.push(
        ...page.functions.map((fn) => ({
          address: fn.address,
          value: fn.name,
        })),
      );
      if (page.offset !== offset)
        throw new AnalysisProtocolError(
          "angr MCP answered a different function page than requested.",
        );
      offset += page.functions.length;
      if (offset >= page.total) return result;
      if (page.functions.length === 0)
        throw new AnalysisProtocolError(
          "angr MCP function pagination did not advance.",
        );
    }
  }

  /**
   * Resolves a procedure. When `requestedBy` names the caller's operation, an
   * upstream "no function" answer is reported as invalid input; every other
   * failed lookup stays a producer fault. Provider-derived selectors pass none.
   */
  async resolve(query: string, requestedBy?: string): Promise<AngrFunction> {
    const address = angrAddressSchema.safeParse(
      /^0x/iu.test(query) ? query : undefined,
    );
    let raw: JsonValue;
    try {
      raw = await this.call(
        "get_function_info",
        address.success ? { address: address.data } : { name: query },
      );
    } catch (cause: unknown) {
      if (
        requestedBy !== undefined &&
        cause instanceof AnalysisProtocolError &&
        MISSING_FUNCTION_ANSWER.test(cause.message)
      )
        throw new AnalysisInputError(requestedBy, { cause }, [
          {
            path: [],
            reason: "invalid_value",
            message: `angr could not resolve procedure ${JSON.stringify(query)}.`,
          },
        ]);
      throw cause;
    }
    return functionInfoSchema.parse(raw);
  }

  async strings(): Promise<{ address: string; value: string }[]> {
    const page = stringsSchema.parse(
      await this.call("get_strings", { min_length: 1, limit: STRING_LIMIT }),
    );
    if (page.strings.length >= STRING_LIMIT)
      this.limitations.push(
        `angr string inventory was capped at ${STRING_LIMIT} entries; additional strings remain unknown.`,
      );
    return page.strings.map(({ address, content }) => ({
      address,
      value: content,
    }));
  }

  async blocks(fn: AngrFunction): Promise<AngrBasicBlock[]> {
    const result = basicBlocksSchema.parse(
      await this.call("get_basic_blocks", {
        function_address: fn.address,
        include_disasm: true,
      }),
    );
    if (
      result.function_address !== fn.address ||
      result.function_name !== fn.name
    )
      throw new AnalysisProtocolError(
        "angr basic blocks identify a different function than the resolved entry.",
      );
    const undisassembled = result.blocks.filter(
      (block) => block.disasm_error !== undefined,
    );
    if (undisassembled.length > 0)
      this.limitations.push(
        `angr could not disassemble ${undisassembled.length} basic block(s): ${undisassembled.map(({ address }) => address).join(", ")}.`,
      );
    return result.blocks;
  }

  identity(
    fn: AngrFunction,
    blocks: readonly AngrBasicBlock[],
  ): ProcedureIdentity {
    return {
      address: fn.address,
      name: fn.name,
      classification: classification(fn),
      body: bodyFromBlocks(fn.address, blocks),
    };
  }

  async pseudocode(fn: AngrFunction): Promise<string> {
    const result = decompileSchema.parse(
      await this.call("decompile_function", { address: fn.address }),
    );
    if (result.function_address !== fn.address)
      throw new AnalysisProtocolError(
        "angr pseudocode identifies a different function than the resolved entry.",
      );
    return result.code;
  }

  async xrefs(address: string): Promise<string[]> {
    const result = xrefsSchema.parse(
      await this.call("get_xrefs", { address, direction: "to" }),
    );
    if (result.address !== address)
      throw new AnalysisProtocolError(
        "angr xrefs answered for a different address than requested.",
      );
    this.limitations.push(
      "angr xrefs report data references recorded during CFG recovery. Call and jump references are not included; use procedure_callers for call relationships.",
    );
    return [
      ...new Set(
        result.xrefs.flatMap(({ from_address }) =>
          from_address === null ? [] : [from_address],
        ),
      ),
    ];
  }

  async relationships(
    fn: AngrFunction,
    direction: "callers" | "callees",
  ): Promise<{ items: ProcedureIdentity[]; coverage: RelationshipCoverage }> {
    const graph = await this.options.callGraph(async () =>
      callGraphSchema.parse(await this.call("get_callgraph", {})),
    );
    const nodes = new Map(graph.nodes.map((node) => [node.address, node]));
    const related = new Set<string>();
    for (const edge of graph.edges) {
      if (direction === "callers" && edge.to === fn.address)
        related.add(edge.from);
      if (direction === "callees" && edge.from === fn.address)
        related.add(edge.to);
    }
    const items: ProcedureIdentity[] = [];
    const unlisted: string[] = [];
    for (const address of related) {
      const node = nodes.get(address);
      if (node === undefined) unlisted.push(address);
      else items.push(summaryIdentity(node));
    }
    items.sort((left, right) => {
      const a = BigInt(left.address);
      const b = BigInt(right.address);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const limitations = [CALL_GRAPH_LIMITATION];
    if (unlisted.length > 0)
      limitations.push(
        `angr's call graph has ${direction} edges to addresses it lists no function for (${unlisted.sort().join(", ")}); those ${direction} are omitted.`,
      );
    this.limitations.push(...limitations);
    return { items, coverage: { status: "partial", limitations } };
  }

  /** The function whose entry is exactly `address`, or undefined when angr lists none there. */
  async functionEntryAt(address: string): Promise<AngrFunction | undefined> {
    try {
      const fn = await this.resolve(address);
      return fn.address === address ? fn : undefined;
    } catch (cause: unknown) {
      if (
        cause instanceof AnalysisProtocolError &&
        MISSING_FUNCTION_ANSWER.test(cause.message)
      )
        return undefined;
      throw cause;
    }
  }

  async run(
    operation: AngrOperation,
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    if (
      ANGR_MUTATING_OPERATIONS.has(operation) ||
      operation === "inspect_native_decompilation_flavor"
    )
      return new AngrEditRunner(this, {
        flavorToolsAvailable: this.options.flavorToolsAvailable,
        onMutation: this.options.onMutation,
        onFlavor: this.options.onFlavor,
      }).run(operation, parameters);
    if (
      operation === "list_procedures" ||
      operation === "search_procedures" ||
      operation === "list_strings" ||
      operation === "search_strings"
    )
      return this.inventory(operation, parameters);
    if (operation === "xrefs") {
      const inspectedAddress = angrAddressSchema.parse(parameters.address);
      this.locations.push({ kind: "address", address: inspectedAddress });
      return this.xrefs(inspectedAddress);
    }
    const fn = await this.resolve(
      z.string().min(1).parse(parameters.procedure),
      this.options.selectorOrigin === "provider" ? undefined : operation,
    );
    this.locations.push({ kind: "address", address: fn.address });
    switch (operation) {
      case "procedure_address":
        return fn.address;
      case "procedure_pseudo_code":
        return this.pseudocode(fn);
      case "procedure_assembly":
        return instructionLines(await this.blocks(fn)).join("\n");
      case "procedure_callers":
      case "procedure_callees": {
        const relationships = await this.relationships(
          fn,
          operation === "procedure_callers" ? "callers" : "callees",
        );
        this.relationshipCoverage = relationships.coverage;
        return relationships.items.map(({ address }) => address);
      }
      case "read_function_instructions": {
        const blocks = await this.blocks(fn);
        return functionInstructionWindowSchema.parse({
          procedure: this.identity(fn, blocks),
          instructions: instructionLines(blocks),
          limitations: [...ANGR_LIMITATIONS, ...this.limitations],
        });
      }
      case "analyze_function":
        return this.dossier(fn);
      default:
        throw new AnalysisProtocolError(
          `angr operation ${operation} has no read implementation.`,
        );
    }
  }

  private async inventory(
    operation:
      | "list_procedures"
      | "search_procedures"
      | "list_strings"
      | "search_strings",
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    const matches = operation.startsWith("search_")
      ? this.searchPredicate(searchQuerySchema.parse(parameters))
      : undefined;
    const items =
      operation === "list_procedures" || operation === "search_procedures"
        ? await this.functions()
        : await this.strings();
    if (matches !== undefined)
      return items.filter(({ value }) => matches(value));
    if (operation === "list_strings" && parameters.address !== undefined) {
      const address = angrAddressSchema.parse(parameters.address);
      return items.filter((item) => item.address === address);
    }
    return items;
  }

  private searchPredicate(
    query: z.infer<typeof searchQuerySchema>,
  ): (value: string) => boolean {
    if (query.mode === "regex") {
      let regex: RegExp;
      try {
        regex = new RegExp(query.pattern, query.case_sensitive ? "u" : "iu");
      } catch (cause: unknown) {
        throw new AnalysisInputError("search", { cause });
      }
      return (value) => regex.test(value);
    }
    const needle = query.case_sensitive
      ? query.pattern
      : query.pattern.toLowerCase();
    return (value) =>
      (query.case_sensitive ? value : value.toLowerCase()).includes(needle);
  }

  async dossier(fn: AngrFunction): Promise<JsonValue> {
    const blocks = await this.blocks(fn);
    let pseudocode: string | null;
    try {
      pseudocode = await this.pseudocode(fn);
    } catch (cause: unknown) {
      if (!(cause instanceof AnalysisProtocolError)) throw cause;
      pseudocode = null;
      this.limitations.push(`Pseudocode is unavailable: ${cause.message}`);
    }
    const callers = await this.relationships(fn, "callers");
    const callees = await this.relationships(fn, "callees");
    this.relationshipCoverage = combineFunctionRelationshipCoverage(
      callers.coverage,
      callees.coverage,
    );
    return functionDossierSchema.parse({
      procedure: {
        ...this.identity(fn, blocks),
        signature: fn.prototype ?? null,
        locals: [],
      },
      pseudocode: pseudocode ?? "",
      assembly: instructionLines(blocks),
      comments: [],
      callers: callers.items,
      callees: callees.items,
      incoming_references: [],
      outgoing_references: [],
      referenced_strings: [],
      referenced_names: [],
      basic_blocks: [],
      native_api: null,
      native_value_flow: null,
      limitations: [
        ...ANGR_LIMITATIONS,
        ...new Set(this.limitations),
        "Function prototypes are angr's recovered or guessed signatures, not source declarations. Locals are not reported.",
      ],
    });
  }
}
