import { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  compareKunaAddresses,
  isCanonicalKunaHexAddress,
  normalizeKunaAddress,
} from "./KunaAddress.js";
import { KunaDocumentError } from "./KunaDocumentError.js";
import { parseKunaJson } from "./KunaJson.js";
import { KunaJsonDocumentReader, parseKunaRow } from "./KunaJsonStream.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { isRecord } from "../kernel/isRecord.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

/** The raw xref budget also bounds its materialized rows. */
export const KUNA_XREF_OUTPUT_BYTES = 16 * 1024 * 1024;

const addressKeys = new Set(["address", "from_address", "to_address"]);
const address = z.string().regex(/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/u);
const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const kind = z.enum(["call", "jump", "data", "read", "write"]);

const graphHeader = z.object({
  schemaVersion: z.literal(4),
  binary: z.object({
    sourcePath: z.string(),
    functionCount: count,
    edgeCount: count,
  }),
});
const graphNode = z.object({
  address,
  name: z.string().min(1),
  kind: z.string().min(1),
  hasIndirectCalls: z.boolean(),
  forwardsTo: address.nullable(),
  codeC: z.null(),
  assembly: z.null(),
  error: z.null(),
});
const graphEdge = z.object({
  callerAddress: address,
  calleeAddress: address,
  kind,
  calleeOrder: count,
});

export type KunaGraphNode = z.infer<typeof graphNode>;
export interface KunaCallGraph {
  readonly sha256: string;
  readonly bytes: number;
  readonly edgeCount: number;
  readonly hasIndirectCalls: boolean;
  readonly nodes: ReadonlyMap<string, KunaGraphNode>;
  readonly callers: ReadonlyMap<string, readonly string[]>;
  readonly callees: ReadonlyMap<string, readonly string[]>;
}

const fieldsOf = (schema: z.ZodObject, excluded: readonly string[]) =>
  new Set(Object.keys(schema.shape).filter((key) => !excluded.includes(key)));

const GRAPH_DOCUMENT = {
  header: new Set(["schemaVersion"]),
  sections: new Map([
    ["binary", new Set(Object.keys(graphHeader.shape.binary.shape))],
  ]),
  rows: new Map([
    [
      "functions",
      {
        fields: fieldsOf(graphNode, [
          "address",
          "forwardsTo",
          "codeC",
          "assembly",
          "error",
        ]),
        addresses: new Set(["address", "forwardsTo"]),
        empty: new Set<string>(),
        // `--functions ''` requests no bodies; one is refused unassembled.
        nulls: new Set(["codeC", "assembly", "error"]),
      },
    ],
    [
      "edges",
      {
        fields: fieldsOf(graphEdge, ["callerAddress", "calleeAddress"]),
        addresses: new Set(["callerAddress", "calleeAddress"]),
        empty: new Set<string>(),
        nulls: new Set<string>(),
      },
    ],
  ]),
};

interface CallerEdgeState {
  readonly targets: Set<string>;
  /** Next expected sequential calleeOrder while orders arrive as 0, 1, 2, ... */
  sequentialCount: number;
  maxOrder: number;
  /** Allocated only when calleeOrder arrives out of sequential 0..n-1 order. */
  orders: Set<number> | undefined;
}

const isEdgeKind = (value: unknown): value is z.infer<typeof kind> =>
  value === "call" ||
  value === "jump" ||
  value === "data" ||
  value === "read" ||
  value === "write";

const parseGraphNodeFast = (
  fields: Readonly<Record<string, unknown>>,
): KunaGraphNode => {
  const {
    address: nodeAddress,
    name,
    kind: nodeKind,
    hasIndirectCalls,
    forwardsTo,
    codeC,
    assembly,
    error,
  } = fields;
  if (
    isCanonicalKunaHexAddress(nodeAddress) &&
    typeof name === "string" &&
    name.length >= 1 &&
    typeof nodeKind === "string" &&
    nodeKind.length >= 1 &&
    typeof hasIndirectCalls === "boolean" &&
    (forwardsTo === null || isCanonicalKunaHexAddress(forwardsTo)) &&
    codeC === null &&
    assembly === null &&
    error === null
  )
    return {
      address: nodeAddress,
      name,
      kind: nodeKind,
      hasIndirectCalls,
      forwardsTo,
      codeC: null,
      assembly: null,
      error: null,
    };
  return parseKunaRow(graphNode, "graph function", fields);
};

const parseGraphEdgeFast = (
  fields: Readonly<Record<string, unknown>>,
): z.infer<typeof graphEdge> => {
  const { callerAddress, calleeAddress, kind: edgeKind, calleeOrder } = fields;
  if (
    isCanonicalKunaHexAddress(callerAddress) &&
    isCanonicalKunaHexAddress(calleeAddress) &&
    isEdgeKind(edgeKind) &&
    typeof calleeOrder === "number" &&
    Number.isSafeInteger(calleeOrder) &&
    calleeOrder >= 0
  )
    return fields as unknown as z.infer<typeof graphEdge>;
  return parseKunaRow(graphEdge, "graph edge", fields);
};

/**
 * Validates `kuna decompile-graph --functions ''` as Kuna writes it and
 * retains only the facts call queries use.
 */
export class KunaCallGraphReader extends KunaJsonDocumentReader<KunaCallGraph> {
  readonly #nodes = new Map<string, KunaGraphNode>();
  /** Per-caller edge targets and callee orders, cleared once validated. */
  readonly #callerEdges = new Map<string, CallerEdgeState>();
  readonly #callers = new Map<string, string[]>();
  readonly #callees = new Map<string, string[]>();
  #edgeCount = 0;
  #hasIndirectCalls = false;

  constructor() {
    super("kuna:call-graph", "Kuna's call graph", GRAPH_DOCUMENT);
  }

  override finish(input: string): Result<KunaCallGraph, AnalysisError> {
    const completed = this.complete();
    if (!completed.ok) return completed;
    const header = graphHeader.safeParse(completed.value.header);
    if (!header.success)
      return err(this.unusable("the graph header is not Kuna's schema 4"));
    if (header.data.binary.sourcePath !== input)
      return err(this.unusable("graph names a different input"));
    if (
      header.data.binary.functionCount !== this.#nodes.size ||
      header.data.binary.edgeCount !== this.#edgeCount
    )
      return err(this.unusable("graph counts disagree with examined rows"));
    const invalid = this.#invalidEdges();
    // This index only validates edges; queries never read it.
    this.#callerEdges.clear();
    if (invalid !== undefined) return err(this.unusable(invalid));
    for (const index of [this.#callers, this.#callees])
      for (const list of index.values()) list.sort(compareKunaAddresses);
    return ok({
      nodes: this.#nodes,
      callers: this.#callers,
      callees: this.#callees,
      edgeCount: this.#edgeCount,
      hasIndirectCalls: this.#hasIndirectCalls,
      bytes: completed.value.bytes,
      sha256: completed.value.sha256,
    });
  }

  protected override acceptRow(
    member: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    if (member === "edges") {
      this.#index(parseGraphEdgeFast(fields));
      return;
    }
    const node = parseGraphNodeFast(fields);
    if (this.#nodes.has(node.address))
      throw new KunaDocumentError("repeated_function");
    this.#nodes.set(node.address, node);
    this.#hasIndirectCalls ||= node.hasIndirectCalls;
  }

  protected override discardRows(): void {
    for (const index of [
      this.#nodes,
      this.#callerEdges,
      this.#callers,
      this.#callees,
    ])
      index.clear();
  }

  /**
   * Index one edge as it arrives, so the working set grows under the row
   * admission instead of after it; endpoints are checked once every node is
   * known.
   */
  #index(edge: z.infer<typeof graphEdge>): void {
    const { callerAddress: caller, calleeAddress: callee, calleeOrder } = edge;
    this.#edgeCount += 1;
    let state = this.#callerEdges.get(caller);
    if (state === undefined) {
      state = {
        targets: new Set<string>(),
        sequentialCount: 0,
        maxOrder: -1,
        orders: undefined,
      };
      this.#callerEdges.set(caller, state);
    }
    if (state.targets.has(callee)) throw new KunaDocumentError("repeated_edge");
    state.targets.add(callee);
    this.#recordOrder(state, calleeOrder);
    if (edge.kind !== "call") return;
    let incoming = this.#callers.get(callee);
    if (incoming === undefined) {
      incoming = [];
      this.#callers.set(callee, incoming);
    }
    incoming.push(caller);
    let outgoing = this.#callees.get(caller);
    if (outgoing === undefined) {
      outgoing = [];
      this.#callees.set(caller, outgoing);
    }
    outgoing.push(callee);
  }

  #recordOrder(state: CallerEdgeState, calleeOrder: number): void {
    if (state.orders === undefined) {
      if (calleeOrder === state.sequentialCount) {
        state.sequentialCount += 1;
        return;
      }
      if (calleeOrder < state.sequentialCount)
        throw new KunaDocumentError("repeated_callee_order");
      const orders = new Set<number>();
      for (let i = 0; i < state.sequentialCount; i += 1) orders.add(i);
      orders.add(calleeOrder);
      state.orders = orders;
      state.maxOrder = calleeOrder;
      return;
    }
    if (state.orders.has(calleeOrder))
      throw new KunaDocumentError("repeated_callee_order");
    state.orders.add(calleeOrder);
    if (calleeOrder > state.maxOrder) state.maxOrder = calleeOrder;
  }

  /** Why the edges contradict the nodes, if they do. */
  #invalidEdges(): string | undefined {
    let missingOrder = false;
    for (const [caller, state] of this.#callerEdges) {
      if (!this.#nodes.has(caller)) return "graph edge has an unknown endpoint";
      for (const callee of state.targets)
        if (!this.#nodes.has(callee))
          return "graph edge has an unknown endpoint";
      // Distinct non-negative orders cover 0..n-1 iff maxOrder === size - 1.
      if (
        state.orders !== undefined &&
        state.maxOrder !== state.orders.size - 1
      )
        missingOrder = true;
    }
    return missingOrder ? "graph callee orders are incomplete" : undefined;
  }
}

const xrefFunction = z.object({
  name: z.string().min(1),
  address,
  address_hex: address,
});
const xrefRow = z.object({
  address,
  address_hex: address,
  kind,
  from_address: address,
  from_address_hex: address,
  to_address: address,
  to_address_hex: address,
  from_function: xrefFunction.nullable(),
  to_function: xrefFunction.nullable(),
  instruction: z.string(),
});
const xrefPointer = z.object({
  kind: z.literal("pointer"),
  from_address: address,
  from_address_hex: address,
  from_name: z.string().nullable(),
  to_address: address,
  to_address_hex: address,
  to_name: z.string().nullable(),
  width: z.int().positive(),
  source: z.string().min(1),
});
const xrefWalkCoverage = z.object({
  decoded: z.boolean(),
  section: z.string().nullable(),
  code_section: z.boolean().nullable(),
  executable: z.boolean().nullable(),
  unwalked: z.array(
    z.object({
      name: z.string().nullable(),
      address,
      address_hex: address,
      section: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});
const xrefsDocument = z.object({
  binary: z.string(),
  direction: z.literal("to"),
  count,
  target: z.object({
    address,
    address_hex: address,
    name: z.string().nullable(),
    aliases: z.array(xrefFunction),
  }),
  xrefs: z.array(z.unknown()),
  coverage: xrefWalkCoverage.optional(),
  data_refs_coverage: z.string().optional(),
  data_refs_count: count.optional(),
  data_refs: z.array(xrefPointer).optional(),
});

interface KunaArm64DirectCall {
  readonly from_address: string;
  readonly caller_address: string;
  readonly to_address: string;
  readonly instruction: string;
}

export interface KunaIncomingReferences {
  readonly arm64DirectCalls: readonly KunaArm64DirectCall[];
  readonly addresses: readonly string[];
  readonly sha256: string;
  readonly bytes: number;
  readonly rows: number;
  readonly excludedAliasRows: number;
  readonly targetAliases: readonly {
    readonly name: string;
    readonly address: string;
  }[];
  readonly walkCoverage: z.infer<typeof xrefWalkCoverage> | null;
  readonly pointerCoverage: string | null;
  readonly pointers: Array<
    Omit<z.infer<typeof xrefPointer>, "from_address_hex" | "to_address_hex">
  > | null;
}

/** Code from incoming-reference admission, plus the address field when one failed. */
export interface KunaIncomingReferenceError {
  readonly code: string;
  readonly field?: string;
}

const isValidXrefFunction = (
  fn: unknown,
): fn is z.infer<typeof xrefFunction> | null =>
  fn === null ||
  (isRecord(fn) &&
    typeof fn.name === "string" &&
    fn.name.length >= 1 &&
    isCanonicalKunaHexAddress(fn.address) &&
    (fn.address_hex === fn.address ||
      isCanonicalKunaHexAddress(fn.address_hex)));

const parseXrefRowFast = (raw: unknown): z.infer<typeof xrefRow> => {
  if (isRecord(raw)) {
    const {
      address: rowAddress,
      address_hex: rowAddressHex,
      kind: rowKind,
      from_address: fromAddress,
      from_address_hex: fromAddressHex,
      to_address: toAddress,
      to_address_hex: toAddressHex,
      from_function: fromFunction,
      to_function: toFunction,
      instruction,
    } = raw;
    if (
      isCanonicalKunaHexAddress(rowAddress) &&
      (rowAddressHex === rowAddress ||
        isCanonicalKunaHexAddress(rowAddressHex)) &&
      (fromAddress === rowAddress || isCanonicalKunaHexAddress(fromAddress)) &&
      (fromAddressHex === rowAddress ||
        isCanonicalKunaHexAddress(fromAddressHex)) &&
      isCanonicalKunaHexAddress(toAddress) &&
      (toAddressHex === toAddress || isCanonicalKunaHexAddress(toAddressHex)) &&
      isEdgeKind(rowKind) &&
      isValidXrefFunction(fromFunction) &&
      isValidXrefFunction(toFunction) &&
      typeof instruction === "string"
    )
      return raw as unknown as z.infer<typeof xrefRow>;
  }
  return xrefRow.parse(raw);
};

/** Native --to unifies forwarding aliases; REA xrefs asks for the exact address. */
export const parseKunaIncomingReferences = (
  text: string,
  input: string,
  target: string,
): Result<KunaIncomingReferences, KunaIncomingReferenceError> => {
  try {
    const document = xrefsDocument.parse(
      parseKunaJson(text, KUNA_XREF_OUTPUT_BYTES, addressKeys),
    );
    if (
      document.binary !== input ||
      document.target.address !== target ||
      document.target.address_hex !== target
    )
      throw new KunaDocumentError("xref_identity");
    if (document.count !== document.xrefs.length)
      throw new KunaDocumentError("xref_count");
    const aliases = new Set([target]);
    for (const alias of document.target.aliases) {
      if (alias.address !== alias.address_hex)
        throw new KunaDocumentError("xref_alias_hex");
      aliases.add(alias.address);
    }
    if (
      (document.data_refs === undefined) !==
      (document.data_refs_count === undefined)
    )
      throw new KunaDocumentError("xref_count");
    if (
      document.data_refs !== undefined &&
      document.data_refs.length !== document.data_refs_count
    )
      throw new KunaDocumentError("xref_count");
    for (const item of document.coverage?.unwalked ?? [])
      if (item.address !== item.address_hex)
        throw new KunaDocumentError("xref_endpoints");
    const addresses = new Set<string>();
    let excludedAliasRows = 0;
    const arm64DirectCalls: KunaArm64DirectCall[] = [];
    let pointers: Array<
      Omit<z.infer<typeof xrefPointer>, "from_address_hex" | "to_address_hex">
    > | null = null;
    if (document.data_refs !== undefined) {
      pointers = new Array(document.data_refs.length);
      for (let i = 0; i < document.data_refs.length; i += 1) {
        const pointer = document.data_refs[i]!;
        if (
          pointer.from_address !== pointer.from_address_hex ||
          pointer.to_address !== pointer.to_address_hex
        )
          throw new KunaDocumentError("xref_endpoints");
        if (!aliases.has(pointer.to_address))
          throw new KunaDocumentError("xref_target");
        if (pointer.to_address === target) addresses.add(pointer.from_address);
        else excludedAliasRows += 1;
        const {
          from_address_hex: _from,
          to_address_hex: _to,
          ...kept
        } = pointer;
        pointers[i] = kept;
      }
    }
    for (const raw of document.xrefs) {
      const row = parseXrefRowFast(raw);
      if (
        row.address !== row.address_hex ||
        row.address !== row.from_address ||
        row.from_address !== row.from_address_hex ||
        row.to_address !== row.to_address_hex
      )
        throw new KunaDocumentError("xref_endpoints");
      if (
        (row.from_function !== null &&
          row.from_function.address !== row.from_function.address_hex) ||
        (row.to_function !== null &&
          row.to_function.address !== row.to_function.address_hex)
      )
        throw new KunaDocumentError("xref_function_hex");
      if (!aliases.has(row.to_address))
        throw new KunaDocumentError("xref_target");
      if (row.to_address !== target) {
        excludedAliasRows += 1;
        continue;
      }
      addresses.add(row.from_address);
      // An exact incoming call row alone does not distinguish indirect forms.
      // Accept only Kuna's arm64 BL with a literal matching the parsed target.
      if (
        row.kind !== "call" ||
        row.from_function === null ||
        row.instruction.length < 4 ||
        row.instruction.length > "bl 0x0000000000000000".length
      )
        continue;
      const c0 = row.instruction.charCodeAt(0);
      const c1 = row.instruction.charCodeAt(1);
      if ((c0 !== 98 && c0 !== 66) || (c1 !== 108 && c1 !== 76)) continue;
      const operand = /^bl[ \t]+(0x[0-9a-f]{1,16})$/iu.exec(
        row.instruction,
      )?.[1];
      if (
        operand !== undefined &&
        (operand === target || normalizeKunaAddress(operand) === target)
      )
        arm64DirectCalls.push({
          from_address: row.from_address,
          caller_address: row.from_function.address,
          to_address: target,
          instruction: row.instruction,
        });
    }
    return ok({
      addresses: [...addresses].sort(compareKunaAddresses),
      arm64DirectCalls,
      rows: document.xrefs.length + (document.data_refs?.length ?? 0),
      excludedAliasRows,
      targetAliases: document.target.aliases.map(({ name, address }) => ({
        name,
        address,
      })),
      walkCoverage: document.coverage ?? null,
      pointerCoverage: document.data_refs_coverage ?? null,
      pointers,
      bytes: Buffer.byteLength(text),
      sha256: sha256Hex(text),
    });
  } catch (cause: unknown) {
    if (cause instanceof KunaDocumentError) {
      const field = cause.facts?.field;
      return err(
        typeof field === "string"
          ? { code: cause.code, field }
          : { code: cause.code },
      );
    }
    return err({
      code: errorMessage(cause),
    });
  }
};
