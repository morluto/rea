import { BinaryReader } from "../domain/binaryContainer.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import {
  cancelledBy,
  carriedReason,
  AnalysisInputError,
  AnalysisProtocolError,
  measuredResourceConstraint,
} from "../domain/analysisErrorCore.js";
import { constants as bufferConstants } from "node:buffer";
import { getHeapStatistics } from "node:v8";
import type { RegexMatchingDeadline } from "../config/regexMatchingDeadline.js";
import type { RegexWorkerHeapRequest } from "../config/regexWorkerHeapRequest.js";
import { matchRegexValues } from "../process/RegexMatcher.js";
import {
  analysisSearchPredicate,
  analysisSearchQuerySchema,
} from "../domain/analysisSearch.js";
import type { EvidenceLocation } from "../domain/evidence.js";
import { combineFunctionRelationshipCoverage } from "../domain/functionCallCoverage.js";
import {
  functionDossierSchema,
  functionInstructionWindowSchema,
} from "../domain/native/functionDossier.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";
import {
  BinaryNinjaToolError,
  type BinaryNinjaMcpConnection,
  type BinaryNinjaToolReply,
} from "./BinaryNinjaMcpConnection.js";
import { drainBinaryNinjaPages } from "./BinaryNinjaPaging.js";
import {
  BINARY_NINJA_LIMITATIONS,
  BINARY_NINJA_XREF_LIMITATION,
  type BinaryNinjaOperation,
} from "./BinaryNinjaProviderCapabilities.js";
import {
  BINARY_NINJA_COLUMNS,
  binaryNinjaAddressSchema,
  binaryNinjaMemoryReadSchema,
  parseBinaryNinjaCodeBlock,
  parseBinaryNinjaDocument,
  parseBinaryNinjaFunctionReferences,
  parseBinaryNinjaTable,
  type BinaryNinjaDocument,
  type BinaryNinjaPage,
  type BinaryNinjaTableTool,
} from "./BinaryNinjaProtocolValues.js";

/** One operation's raw producer replies, retained alongside normalized results. */
export interface BinaryNinjaRawObservation {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly result: JsonValue;
}

/** A function identified by its start address and the architecture that disambiguates it. */
export interface BinaryNinjaFunction {
  readonly address: string;
  readonly architecture: string;
  readonly name: string;
}

/** The largest byte span one `bn_memory_read` call accepts. */
export const BINARY_NINJA_MEMORY_READ_LIMIT = 65_536;
/** The largest string preview `bn_string_list` renders. */
const STRING_PREVIEW_BYTES = 256;

/** Architectures whose Binary Ninja views store multi-byte string units little-endian. */
const LITTLE_ENDIAN_ARCHITECTURES: ReadonlySet<string> = new Set([
  "x86",
  "x86_64",
  "aarch64",
  "armv7",
  "thumb2",
  "mipsel32",
  "mipsel64",
  "rv32gc",
  "rv64gc",
]);

const unknownBody = {
  available: false,
  reason: "Binary Ninja MCP does not report complete function body ranges.",
} as const;
const identity = (fn: Pick<BinaryNinjaFunction, "address" | "name">) => ({
  address: fn.address,
  name: fn.name,
  classification: null,
  body: unknownBody,
});
type ProcedureIdentity = ReturnType<typeof identity>;

interface Relationships {
  readonly items: ProcedureIdentity[];
  readonly coverage: RelationshipCoverage;
}

const INSTRUCTION_LINE = /^(0x[0-9a-f]+) {2}(.*)$/iu;
const BLOCK_RANGE = /^(0x[0-9a-f]+)-(0x[0-9a-f]+) \(\d+ bytes\)$/iu;
const isHexAddress = (value: string): boolean => /^0x[0-9a-f]+$/iu.test(value);

/** Estimate without serializing or copying the reply being admitted. */
const retainedReplyCapacity = (value: JsonValue): bigint => {
  // Per UTF-16 unit: retained/parsed/normalized text (8 bytes), plus two
  // Evidence serializations at worst-case JSON escaping (2 * 6 * 2 bytes).
  // Object/array slots also cover normalized rows and their later copies.
  if (typeof value === "string") {
    // Rendered pages also become arrays of rows/lines; reserve their object
    // and array-slot overhead even when each line contains very little text.
    let lines = 1;
    for (let index = 0; index < value.length; index++)
      if (value.charCodeAt(index) === 10) lines++;
    return BigInt(value.length) * 32n + BigInt(lines) * 128n + 256n;
  }
  if (value === null || typeof value !== "object") return 256n;
  let bytes = 256n;
  if (Array.isArray(value)) {
    for (const item of value) bytes += retainedReplyCapacity(item);
  } else {
    for (const key in value)
      if (Object.hasOwn(value, key))
        bytes +=
          retainedReplyCapacity(key) + retainedReplyCapacity(value[key]!);
  }
  return bytes;
};

/** Translate explicit analyst questions into a closed set of read-only Binary Ninja requests. */
export class BinaryNinjaOperationRunner {
  readonly raw: BinaryNinjaRawObservation[] = [];
  readonly locations: EvidenceLocation[] = [];
  readonly limitations: string[] = [];
  relationshipCoverage: RelationshipCoverage | undefined;
  /** Whether the last `xrefs` read may omit references; never part of Evidence. */
  referencesTruncated: boolean | undefined;
  private retainedCapacity = 0n; // not-an-allowance: Tally of estimated retained bytes compared with live memory headroom.

  constructor(
    private readonly connection: BinaryNinjaMcpConnection,
    private readonly options: {
      /** The REA-admitted target, reported by `list_documents`. */
      readonly admittedDocument: string;
      /** Architecture of the bound BinaryView, which selects string decoding. */
      readonly architecture: string;
      readonly signal?: AbortSignal | undefined;
      readonly regexMatchingDeadline?: RegexMatchingDeadline | undefined;
      readonly regexWorkerHeapRequest?: RegexWorkerHeapRequest | undefined;
      readonly selectorOrigin?: "provider" | undefined;
    },
  ) {}

  async call(
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<BinaryNinjaToolReply> {
    this.throwIfCancelled(tool);
    const reply = await this.connection.call(tool, args, this.options.signal);
    const required =
      retainedReplyCapacity(reply.text) +
      retainedReplyCapacity(reply.structured) +
      retainedReplyCapacity(args);
    this.requireCapacity(tool, this.retainedCapacity + required);
    this.retainedCapacity += required;
    this.raw.push({
      tool,
      arguments: args,
      result: jsonValueSchema.parse({
        text: reply.text,
        structured: reply.structured,
      }),
    });
    this.throwIfCancelled(tool);
    return reply;
  }

  private throwIfCancelled(tool: string): void {
    if (this.options.signal?.aborted === true)
      throw cancelledBy(tool, carriedReason(this.options.signal.reason));
  }

  private async document(
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<BinaryNinjaDocument> {
    const reply = await this.call(tool, args);
    if (reply.text === null)
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} omitted its rendered text.`,
      );
    return parseBinaryNinjaDocument(reply.text, tool);
  }

  /** Drain every page; a changed total means analysis changed while paging. */
  private async pages(
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
    consume: (document: BinaryNinjaDocument, page: BinaryNinjaPage) => void,
  ): Promise<void> {
    await drainBinaryNinjaPages(
      tool,
      (offset, limit) => this.document(tool, { ...args, offset, limit }),
      consume,
    );
  }

  private async table(
    tool: BinaryNinjaTableTool,
    args: Readonly<Record<string, JsonValue>>,
    fn?: BinaryNinjaFunction,
  ): Promise<Record<string, string>[]> {
    const rows: Record<string, string>[] = [];
    await this.pages(tool, args, (document, page) => {
      if (fn !== undefined)
        this.verifyFunctionPage(tool, fn, document.metadata);
      const pageRows = parseBinaryNinjaTable(
        document.body,
        BINARY_NINJA_COLUMNS[tool],
        tool,
      );
      if (pageRows.length !== page.count)
        throw new AnalysisProtocolError(
          `Binary Ninja ${tool} rendered ${String(pageRows.length)} rows for a page count of ${String(page.count)}.`,
        );
      rows.push(...pageRows);
    });
    return rows;
  }

  private functionArguments(
    fn: BinaryNinjaFunction,
  ): Record<string, JsonValue> {
    return { function: fn.address, arch: fn.architecture };
  }

  /** Every page must describe the resolved function; content is never cross-attributed. */
  private verifyFunctionPage(
    tool: string,
    fn: BinaryNinjaFunction,
    metadata: Readonly<Record<string, JsonValue>>,
  ): void {
    const address = binaryNinjaAddressSchema.safeParse(metadata.function);
    if (
      !address.success ||
      address.data !== fn.address ||
      metadata.name !== fn.name ||
      metadata.arch !== fn.architecture
    )
      throw new AnalysisProtocolError(
        `Binary Ninja ${tool} identifies a different function than the resolved entry.`,
      );
  }

  private async code(
    tool: "bn_function_decompile" | "bn_function_disassembly",
    fn: BinaryNinjaFunction,
    languages: readonly string[],
  ): Promise<string[]> {
    const lines: string[] = [];
    let stale = false;
    await this.pages(tool, this.functionArguments(fn), (document, page) => {
      this.verifyFunctionPage(tool, fn, document.metadata);
      if (document.metadata.needsUpdate === true) stale = true;
      const pageLines = parseBinaryNinjaCodeBlock(
        document.body,
        languages,
        tool,
      );
      if (pageLines.length !== page.count)
        throw new AnalysisProtocolError(
          `Binary Ninja ${tool} rendered ${String(pageLines.length)} lines for a page count of ${String(page.count)}.`,
        );
      lines.push(...pageLines);
    });
    if (stale)
      this.limitations.push(
        "Binary Ninja reported that this function's analysis needs an update; rendered text may be stale.",
      );
    return lines;
  }

  async functions(query?: string): Promise<BinaryNinjaFunction[]> {
    const rows =
      query === undefined
        ? await this.table("bn_function_list", {})
        : await this.table("bn_function_search", { query });
    return rows.map((row) => this.functionEntry(row));
  }

  private functionEntry(
    row: Readonly<Record<string, string>>,
  ): BinaryNinjaFunction {
    return {
      address: binaryNinjaAddressSchema.parse(row.function),
      architecture: row.arch ?? "",
      name: row.name ?? "",
    };
  }

  private invalidSelector(
    query: string,
    requestedBy: string | undefined,
    reason: string,
  ) {
    if (requestedBy === undefined)
      return new AnalysisProtocolError(`${reason}: ${query}`);
    return new AnalysisInputError(requestedBy, undefined, [
      {
        path: ["procedure"],
        reason: "invalid_value",
        message: `${reason}: ${query}`,
      },
    ]);
  }

  /**
   * Resolve a function by start address or exact name. Names are matched by
   * REA rather than evaluated as Binary Ninja expressions, so a name is never
   * reinterpreted as arithmetic. An absent function allows caller queries
   * to try the exact symbol lookup. Ambiguous functions are errors.
   */
  private async findFunction(
    query: string,
    requestedBy?: string,
  ): Promise<BinaryNinjaFunction | undefined> {
    if (isHexAddress(query)) {
      const address = binaryNinjaAddressSchema.parse(query);
      let document: BinaryNinjaDocument;
      try {
        document = await this.document("bn_function_info", {
          function: address,
        });
      } catch (cause: unknown) {
        if (
          cause instanceof BinaryNinjaToolError &&
          cause.code === "function_not_found"
        )
          return undefined;
        throw cause;
      }
      const fn = {
        address: binaryNinjaAddressSchema.parse(document.metadata.function),
        architecture: String(document.metadata.arch ?? ""),
        name: String(document.metadata.name ?? ""),
      };
      if (fn.address !== address || fn.name.length === 0)
        throw new AnalysisProtocolError(
          "Binary Ninja function lookup answered for a different entry.",
        );
      return fn;
    }
    const matches = (await this.functions(query)).filter(
      ({ name }) => name === query,
    );
    if (matches.length > 1)
      throw this.invalidSelector(
        query,
        requestedBy,
        "Several Binary Ninja functions share this name; supply the entry address",
      );
    return matches[0];
  }

  private async symbolAt(address: string): Promise<string | undefined> {
    const tool = "bn_symbol_list_at";
    const document = await this.document(tool, { address });
    const symbols = parseBinaryNinjaTable(
      document.body,
      BINARY_NINJA_COLUMNS[tool],
      tool,
    );
    for (const symbol of symbols)
      if (binaryNinjaAddressSchema.parse(symbol.symbol) !== address)
        throw new AnalysisProtocolError(
          "Binary Ninja returned a symbol at a different address.",
        );
    return symbols.find((symbol) => symbol.name)?.name;
  }

  private async callerSymbol(
    query: string,
    requestedBy?: string,
  ): Promise<string | undefined> {
    if (isHexAddress(query)) {
      const address = binaryNinjaAddressSchema.parse(query);
      return (await this.symbolAt(address)) === undefined ? undefined : address;
    }
    const symbols = (await this.table("bn_symbol_list", { query })).filter(
      ({ name, fullName }) => name === query || fullName === query,
    );
    // Binary Ninja may report both a concrete slot and an external placeholder
    // with the same imported name. Named calls target the concrete slot.
    const hasImportSlot = symbols.some(
      ({ type }) => type === "ImportAddressSymbol",
    );
    const matches = new Set(
      symbols
        .filter(({ type }) => !hasImportSlot || type !== "ExternalSymbol")
        .map(({ symbol }) => binaryNinjaAddressSchema.parse(symbol)),
    );
    if (matches.size > 1)
      throw this.invalidSelector(
        query,
        requestedBy,
        "Several Binary Ninja symbols share this name; supply the symbol address",
      );
    return matches.values().next().value;
  }

  async strings(
    selectedAddress?: string,
  ): Promise<{ address: string; value: string }[]> {
    const littleEndian = LITTLE_ENDIAN_ARCHITECTURES.has(
      this.options.architecture,
    );
    const result: { address: string; value: string }[] = [];
    const omitted = new Set<string>();
    const entries = (
      await this.table("bn_string_list", {
        previewBytes: STRING_PREVIEW_BYTES,
      })
    ).flatMap((row) => {
      const address = binaryNinjaAddressSchema.parse(row.string);
      if (selectedAddress !== undefined && address !== selectedAddress)
        return [];
      const length = BigInt(binaryNinjaAddressSchema.parse(row.length));
      return [{ row, address, length }];
    });
    this.requireStringCapacity(entries);
    for (const { row, address, length: declaredLength } of entries) {
      const length = Number(declaredLength);
      let bytes: Buffer = Buffer.from(row.previewHex ?? "", "hex");
      if (row.previewTruncated === "true") {
        bytes = await this.read(address, length);
      } else if (row.previewTruncated !== "false")
        throw new AnalysisProtocolError(
          "Binary Ninja bn_string_list returned an unrecognized previewTruncated value.",
        );
      if (bytes.length !== length)
        throw new AnalysisProtocolError(
          `Binary Ninja string ${address} rendered ${String(bytes.length)} of ${String(length)} bytes.`,
        );
      const value = decodeString(row.type ?? "", bytes, littleEndian);
      if (value === undefined) {
        omitted.add(
          `Binary Ninja ${row.type ?? "unknown"} strings that cannot be decoded for architecture ${this.options.architecture} are omitted.`,
        );
        continue;
      }
      result.push({ address, value });
    }
    this.limitations.push(...omitted);
    return result;
  }

  private requireStringCapacity(
    entries: readonly {
      readonly length: bigint;
      readonly row: Readonly<Record<string, string>>;
    }[],
  ): void {
    let requiredBytes = 0n;
    for (const { length, row } of entries) {
      // Both rendered and structured replies can retain two hex units per
      // input byte (4 * the shared 32-byte allowance), plus the buffer,
      // decoded text and normalized/serialized result (another 32 bytes).
      // Reserve 1 KiB per chunk for its reply envelope and retained objects.
      const chunks =
        (length + BigInt(BINARY_NINJA_MEMORY_READ_LIMIT) - 1n) /
        BigInt(BINARY_NINJA_MEMORY_READ_LIMIT);
      requiredBytes += length * 160n + chunks * 1024n;
      const codeUnits =
        row.type === "Utf32String" || row.type === "Utf16String"
          ? length / 2n
          : length;
      if (
        length > BigInt(bufferConstants.MAX_LENGTH) ||
        codeUnits > BigInt(bufferConstants.MAX_STRING_LENGTH)
      )
        throw measuredResourceConstraint(
          "binary_ninja_strings",
          "memory",
          "A declared Binary Ninja string exceeds the Node.js buffer or string length limit.",
          {
            declared_string_bytes: length.toString(),
            decoded_code_units_upper_bound: codeUnits.toString(),
            maximum_buffer_bytes: bufferConstants.MAX_LENGTH,
            maximum_string_code_units: bufferConstants.MAX_STRING_LENGTH,
          },
          {
            remediationAction:
              "Inspect the string in Binary Ninja or request a different string by address.",
          },
        );
    }
    this.requireCapacity(
      "binary_ninja_strings",
      this.retainedCapacity + requiredBytes,
    );
  }

  /** All reads share the retained-reply and future Evidence capacity budget. */
  private requireCapacity(operation: string, requiredBytes: bigint): void {
    const heap = getHeapStatistics();
    const hostAvailable =
      typeof process.availableMemory === "function"
        ? process.availableMemory()
        : heap.total_available_size;
    const availableBytes = Math.max(
      0,
      Math.floor(Math.min(heap.total_available_size, hostAvailable)),
    );
    if (requiredBytes > BigInt(availableBytes))
      throw measuredResourceConstraint(
        operation,
        "memory",
        "Insufficient runtime capacity for retained Binary Ninja replies, normalized results, and serialized Evidence.",
        {
          required_bytes: requiredBytes.toString(),
          available_bytes: availableBytes,
          available_heap_bytes: heap.total_available_size,
        },
        {
          remediationAction:
            "Free memory or raise the Node.js heap allowance for REA, then retry.",
        },
      );
  }

  private async read(address: string, length: number): Promise<Buffer> {
    const bytes = Buffer.alloc(length);
    for (let offset = 0; offset < length;) {
      const chunkLength = Math.min(
        BINARY_NINJA_MEMORY_READ_LIMIT,
        length - offset,
      );
      const chunkAddress = `0x${(BigInt(address) + BigInt(offset)).toString(16)}`;
      const reply = await this.call("bn_memory_read", {
        address: chunkAddress,
        length: chunkLength,
      });
      const read = binaryNinjaMemoryReadSchema.parse(reply.structured);
      if (read.address !== chunkAddress || read.bytesRead !== chunkLength)
        throw new AnalysisProtocolError(
          `Binary Ninja read ${String(read.bytesRead)} of ${String(chunkLength)} bytes at ${chunkAddress}.`,
        );
      Buffer.from(read.hex, "hex").copy(bytes, offset);
      offset += chunkLength;
    }
    return bytes;
  }

  async pseudocode(fn: BinaryNinjaFunction): Promise<string> {
    return this.joinCode(
      "procedure_pseudo_code",
      await this.code("bn_function_decompile", fn, ["bn-pseudoc"]),
    );
  }

  private joinCode(operation: string, lines: readonly string[]): string {
    const codeUnits = lines.reduce(
      (length, line) => length + line.length,
      Math.max(0, lines.length - 1),
    );
    if (codeUnits > bufferConstants.MAX_STRING_LENGTH)
      throw measuredResourceConstraint(
        operation,
        "memory",
        "The rendered Binary Ninja function exceeds the Node.js single-string length limit.",
        {
          required_string_code_units: codeUnits,
          maximum_string_code_units: bufferConstants.MAX_STRING_LENGTH,
        },
        { remediationAction: "Inspect the function in Binary Ninja." },
      );
    return lines.join("\n");
  }

  /** Instruction lines plus the rendered signature heading, when present. */
  async assembly(
    fn: BinaryNinjaFunction,
  ): Promise<{ instructions: string[]; signature: string | null }> {
    const lines = await this.code("bn_function_disassembly", fn, ["asm"]);
    const instructions: string[] = [];
    for (const line of lines) {
      const match = INSTRUCTION_LINE.exec(line);
      if (match !== null)
        instructions.push(
          `${binaryNinjaAddressSchema.parse(match[1])}: ${match[2] ?? ""}`,
        );
    }
    if (instructions.length === 0)
      throw new AnalysisProtocolError(
        "Binary Ninja disassembly rendered no instructions for the resolved function.",
      );
    const heading = lines[0];
    return {
      instructions,
      signature:
        heading !== undefined &&
        heading.startsWith("  ") &&
        !isHexAddress(heading.trim())
          ? heading.trim()
          : null,
    };
  }

  async callers(fn: BinaryNinjaFunction): Promise<Relationships> {
    const result = new Map<string, ProcedureIdentity>();
    let unattributed = 0;
    for (const row of await this.table(
      "bn_function_callers",
      this.functionArguments(fn),
      fn,
    )) {
      const references = parseBinaryNinjaFunctionReferences(
        row["Caller Function"] ?? "",
        "bn_function_callers",
      );
      if (references.length === 0) unattributed++;
      for (const reference of references)
        result.set(reference.address, identity(reference));
    }
    const limitation = `${String(unattributed)} call sites lie outside any analyzed function and are omitted.`;
    return {
      items: [...result.values()],
      coverage:
        unattributed === 0
          ? { status: "complete" }
          : {
              status: "partial",
              limitations: [limitation],
              limited_directions: ["callers"],
            },
    };
  }

  private async calleeRows(fn: BinaryNinjaFunction) {
    return this.table("bn_function_callees", this.functionArguments(fn), fn);
  }

  private async containsReference(
    fn: BinaryNinjaFunction,
    sources: readonly bigint[],
  ): Promise<boolean> {
    for (const row of await this.table(
      "bn_function_basic_blocks",
      this.functionArguments(fn),
      fn,
    )) {
      const range = BLOCK_RANGE.exec(row.Range ?? "");
      if (range === null)
        throw new AnalysisProtocolError(
          "Binary Ninja returned an invalid basic block range.",
        );
      const start = BigInt(range[1]!);
      const end = BigInt(range[2]!);
      if (sources.some((source) => start <= source && source < end))
        return true;
    }
    return false;
  }

  private async symbolCallers(address: string): Promise<Relationships> {
    const sources = (await this.dataReferenceSources(address)).map((source) =>
      BigInt(source),
    );
    const items = new Map<string, ProcedureIdentity>();
    for (const row of await this.table("bn_function_list", {})) {
      const fn = this.functionEntry(row);
      if (items.has(fn.address)) continue;
      const calls = await this.calleeRows(fn);
      if (
        calls.some(
          (call) =>
            binaryNinjaAddressSchema.parse(call["Callee Address"]) === address,
        )
      ) {
        items.set(fn.address, identity(fn));
        continue;
      }
      if (sources.length === 0) continue;
      const first = BigInt(binaryNinjaAddressSchema.parse(row.lowestAddress));
      const last = BigInt(binaryNinjaAddressSchema.parse(row.highestAddress));
      const candidates = sources.filter(
        (source) => first <= source && source <= last,
      );
      if (
        candidates.length > 0 &&
        (await this.containsReference(fn, candidates))
      )
        items.set(fn.address, identity(fn));
    }
    return {
      items: [...items.values()],
      coverage: {
        status: "partial",
        limited_directions: ["callers"],
        limitations: [
          "Binary Ninja MCP exposes calls from analyzed functions and data references to this symbol. Other code references to the symbol may be absent.",
        ],
      },
    };
  }

  private relationshipAddresses(relationships: Relationships): string[] {
    this.relationshipCoverage = relationships.coverage;
    if (relationships.coverage.status === "partial")
      this.limitations.push(...relationships.coverage.limitations);
    return relationships.items.map(({ address }) => address);
  }

  async callees(fn: BinaryNinjaFunction): Promise<Relationships> {
    const result = new Map<string, ProcedureIdentity>();
    const unnamed = new Set<string>();
    for (const row of await this.calleeRows(fn)) {
      const references = parseBinaryNinjaFunctionReferences(
        row["Callee Functions"] ?? "",
        "bn_function_callees",
      );
      for (const reference of references)
        result.set(reference.address, identity(reference));
      if (references.length > 0) continue;
      // Calls through import slots name a symbol rather than an analyzed function.
      const address = binaryNinjaAddressSchema.parse(row["Callee Address"]);
      if (result.has(address) || unnamed.has(address)) continue;
      const name = await this.symbolAt(address);
      if (name === undefined) unnamed.add(address);
      else result.set(address, identity({ address, name }));
    }
    for (const address of unnamed) result.delete(address);
    return {
      items: [...result.values()],
      coverage:
        unnamed.size === 0
          ? { status: "complete" }
          : {
              status: "partial",
              limited_directions: ["callees"],
              limitations: [
                `${String(unnamed.size)} callee addresses have neither an analyzed function nor a symbol and are omitted.`,
              ],
            },
    };
  }

  private async dataReferenceSources(address: string): Promise<string[]> {
    return (await this.table("bn_data_xrefs_to", { address })).map((row) =>
      binaryNinjaAddressSchema.parse(row.Source),
    );
  }

  /**
   * Binary Ninja MCP exposes data references to an exact address and call
   * sites into a function entry. Other code references into the address are
   * not observable, so the result is always reported as possibly incomplete.
   */
  async xrefs(address: string): Promise<string[]> {
    const sources = new Set(await this.dataReferenceSources(address));
    const entry = await this.findFunction(address);
    if (entry !== undefined)
      for (const row of await this.table(
        "bn_function_callers",
        this.functionArguments(entry),
        entry,
      ))
        sources.add(binaryNinjaAddressSchema.parse(row.Callsite));
    this.referencesTruncated = true;
    this.limitations.push(BINARY_NINJA_XREF_LIMITATION);
    return [...sources];
  }

  private async search<T extends { readonly value: string }>(
    operation: "search_procedures" | "search_strings",
    parameters: Readonly<Record<string, JsonValue>>,
    items: readonly T[],
  ): Promise<T[]> {
    const query = analysisSearchQuerySchema.parse(parameters);
    if (query.mode === "literal") {
      const matches = analysisSearchPredicate(query);
      return items.filter(({ value }) => matches(value));
    }
    const matched = await matchRegexValues({
      operation,
      pattern: query.pattern,
      caseSensitive: query.case_sensitive,
      values: items.map(({ value }) => value),
      signal: this.options.signal,
      deadline: this.options.regexMatchingDeadline,
      heapRequest: this.options.regexWorkerHeapRequest,
    });
    if (!matched.ok) throw matched.error;
    return matched.value.map((index) => items[index]!);
  }

  async run(
    operation: BinaryNinjaOperation,
    parameters: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    if (operation === "list_procedures" || operation === "search_procedures") {
      const items = (await this.functions()).map((fn) => ({
        address: fn.address,
        value: fn.name,
      }));
      if (operation === "list_procedures") return items;
      return this.search(operation, parameters, items);
    }
    if (operation === "list_strings") {
      const address =
        parameters.address === undefined
          ? undefined
          : binaryNinjaAddressSchema.parse(parameters.address);
      return this.strings(address);
    }
    if (operation === "search_strings")
      return this.search(operation, parameters, await this.strings());
    if (operation === "list_documents") return [this.options.admittedDocument];
    if (operation === "xrefs") {
      const address = binaryNinjaAddressSchema.parse(parameters.address);
      this.locations.push({ kind: "address", address });
      return this.xrefs(address);
    }
    const query = String(parameters.procedure);
    const requestedBy =
      this.options.selectorOrigin === "provider" ? undefined : operation;
    const fn = await this.findFunction(query, requestedBy);
    if (fn === undefined) {
      if (operation === "procedure_callers") {
        const symbol = await this.callerSymbol(query, requestedBy);
        if (symbol !== undefined) {
          this.locations.push({ kind: "address", address: symbol });
          return this.relationshipAddresses(await this.symbolCallers(symbol));
        }
      }
      const kind =
        operation === "procedure_callers" ? "function or symbol" : "function";
      throw this.invalidSelector(
        query,
        requestedBy,
        isHexAddress(query)
          ? `No Binary Ninja ${kind} starts at this address`
          : `No Binary Ninja ${kind} has this exact name`,
      );
    }
    this.locations.push({ kind: "address", address: fn.address });
    switch (operation) {
      case "procedure_address":
        return fn.address;
      case "procedure_pseudo_code":
        return this.pseudocode(fn);
      case "procedure_assembly":
        return this.joinCode(operation, (await this.assembly(fn)).instructions);
      case "procedure_callers":
        return this.relationshipAddresses(await this.callers(fn));
      case "procedure_callees":
        return this.relationshipAddresses(await this.callees(fn));
      case "read_function_instructions":
        return functionInstructionWindowSchema.parse({
          procedure: identity(fn),
          instructions: (await this.assembly(fn)).instructions,
          limitations: BINARY_NINJA_LIMITATIONS,
        });
      case "analyze_function":
        return this.dossier(fn);
    }
  }

  private async dossier(fn: BinaryNinjaFunction): Promise<JsonValue> {
    const assembly = await this.assembly(fn);
    const pseudocode = await this.pseudocode(fn);
    const callers = await this.callers(fn);
    const callees = await this.callees(fn);
    this.relationshipCoverage = combineFunctionRelationshipCoverage(
      callers.coverage,
      callees.coverage,
    );
    const partial = [callers.coverage, callees.coverage].flatMap((coverage) =>
      coverage.status === "partial" ? coverage.limitations : [],
    );
    return functionDossierSchema.parse({
      procedure: { ...identity(fn), signature: assembly.signature, locals: [] },
      pseudocode,
      assembly: assembly.instructions,
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
      facet_availability: {
        pseudocode: { available: true },
        assembly: { available: true },
        comments: {
          available: false,
          reason: "Binary Ninja adapter does not expose typed comments.",
        },
        callers: { available: true },
        callees: { available: true },
        references: {
          available: false,
          reason: "Binary Ninja adapter does not expose typed reference edges.",
        },
        strings_names: {
          available: false,
          reason:
            "Binary Ninja adapter does not expose function-referenced strings and names.",
        },
        cfg: {
          available: false,
          reason: "Binary Ninja adapter does not expose basic blocks.",
        },
      },
      limitations: [
        ...BINARY_NINJA_LIMITATIONS,
        ...this.limitations,
        ...partial,
        "Rendered Pseudo C is Binary Ninja's decompiler view and does not establish complete source recovery.",
      ],
    });
  }
}

/** Decode one string's exact bytes by Binary Ninja's reported string type. */
const decodeString = (
  type: string,
  bytes: Buffer,
  littleEndian: boolean,
): string | undefined => {
  switch (type) {
    case "AsciiString":
      return bytes.toString("latin1");
    case "Utf8String":
      try {
        return decodeStrictUtf8(bytes, "preserve");
      } catch {
        return undefined;
      }
    case "Utf16String":
      if (!littleEndian || bytes.length % 2 !== 0) return undefined;
      try {
        return new TextDecoder("utf-16le", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch {
        return undefined;
      }
    case "Utf32String": {
      if (!littleEndian || bytes.length % 4 !== 0) return undefined;
      const reader = new BinaryReader(bytes, littleEndian, "UTF-32");
      const points: number[] = [];
      const parts: string[] = [];
      for (let index = 0; index < bytes.length; index += 4) {
        const point = reader.u32(index);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff))
          return undefined;
        points.push(point);
        // Bound the argument count independently of the total string length.
        if (points.length === 1024) {
          parts.push(String.fromCodePoint(...points));
          points.length = 0;
        }
      }
      parts.push(String.fromCodePoint(...points));
      return parts.join("");
    }
    default:
      return undefined;
  }
};
