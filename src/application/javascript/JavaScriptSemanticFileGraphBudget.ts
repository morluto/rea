import type { JavaScriptSemanticEvidenceContextRegistry } from "../../domain/javascript/javascriptSemanticGraph.js";
import type {
  JavaScriptSemanticGraphNode,
  JavaScriptSemanticGraphUnknown,
  JavaScriptSemanticFingerprint,
} from "../../domain/javascript/javascriptSemanticGraphSchemas.js";

interface SemanticFact {
  readonly evidence: { readonly context_id: string };
}

// Projection-owned ID arrays stay immutable; weak keys bound cache lifetime to their graphs.
const encodedIdArrays = new WeakMap<readonly string[], number>();

/** Measure ID-array expansion without allocating its combined JSON string. */
export const serializedSemanticFactBytes = (value: unknown): number => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return Buffer.byteLength(JSON.stringify(value)) + 1;
  const copy: Record<string, unknown> = { ...value };
  let arrayBytes = 0;
  for (const key of ["application_node_ids", "candidate_node_ids"]) {
    const ids = copy[key];
    if (!Array.isArray(ids)) continue;
    let bytes = encodedIdArrays.get(ids);
    if (bytes === undefined) {
      if (!ids.every((id) => typeof id === "string")) continue;
      bytes = 2;
      for (const id of ids) bytes += Buffer.byteLength(JSON.stringify(id)) + 1;
      if (ids.length > 0) bytes -= 1;
      encodedIdArrays.set(ids, bytes);
    }
    delete copy[key];
    arrayBytes += Buffer.byteLength(JSON.stringify(key)) + 2 + bytes;
  }
  return Buffer.byteLength(JSON.stringify(copy)) + arrayBytes + 1;
};

/** One source's fact admission and bounded temporary projection storage. */
export class SemanticFileGraphBudget {
  readonly limit: number | null;
  readonly nodeLimit: number | null;
  #used = 0;
  #nodes = 0;
  #pendingBytes = 0;
  #closed = false;
  #incomplete = false;
  #nodeLimitReached = false;
  #byteLimitReached = false;
  readonly #chargedContexts = new Set<string>();
  readonly #pendingContexts = new Map<string, number>();
  readonly #omittedNodes = new Set<string>();
  readonly #omittedRelations = new Set<string>();
  readonly #unknownTotalsIncomplete = new Set<string>();
  readonly #unknownCounts = new Map<
    string,
    {
      family: JavaScriptSemanticGraphUnknown["family"];
      reason: JavaScriptSemanticGraphUnknown["reason"];
      total: number;
      retained: number;
    }
  >();
  readonly retainedFingerprints = new Map<
    string,
    JavaScriptSemanticFingerprint
  >();
  readonly pendingNodes = new Map<string, JavaScriptSemanticGraphNode>();
  readonly deferredUnknowns = new Map<string, JavaScriptSemanticGraphUnknown>();
  readonly #reservations = new Map<string, number>();

  constructor(limit: number | null, nodeLimit: number | null = null) {
    for (const value of [limit, nodeLimit])
      if (value !== null && (!Number.isSafeInteger(value) || value < 0))
        throw new RangeError(
          "Semantic file graph budget must be a nonnegative safe integer",
        );
    this.limit = limit;
    this.nodeLimit = nodeLimit;
  }

  get closed(): boolean {
    return this.#closed;
  }
  get incomplete(): boolean {
    return this.#incomplete;
  }
  get nodeLimitReached(): boolean {
    return this.#nodeLimitReached;
  }
  get byteLimitReached(): boolean {
    return this.#byteLimitReached;
  }
  get used(): number {
    return this.#used;
  }
  get unknownCounts() {
    return [...this.#unknownCounts.values()].map((count) => ({
      ...count,
      total:
        this.#incomplete ||
        this.#unknownTotalsIncomplete.has(
          `${count.family}\u0000${count.reason}`,
        )
          ? null
          : count.total,
    }));
  }

  /** Skipped projection has unknown totals, rather than manufactured zeroes. */
  markIncomplete(): void {
    this.#incomplete = true;
  }

  markNodeLimitReached(): void {
    this.#nodeLimitReached = true;
    this.markIncomplete();
  }

  /**
   * Reserve temporary full facts before retaining them in projection indexes.
   * Scratch shares the byte limit; the node limit counts admitted nodes only,
   * so pending nodes are offered in order until it refuses one.
   */
  reservePending(
    id: string,
    fact: SemanticFact,
    contexts: JavaScriptSemanticEvidenceContextRegistry,
  ): boolean {
    if (this.#closed) return false;
    const contextId = fact.evidence.context_id;
    const contextBytes =
      this.#chargedContexts.has(contextId) ||
      this.#pendingContexts.has(contextId)
        ? 0
        : serializedSemanticFactBytes(contexts.context(contextId));
    const bytes = serializedSemanticFactBytes(fact);
    if (
      this.limit !== null &&
      this.#used + this.#pendingBytes + bytes + contextBytes > this.limit
    ) {
      this.#closed = true;
      this.#byteLimitReached = true;
      this.markIncomplete();
      return false;
    }
    this.#pendingBytes += bytes + contextBytes;
    if (contextBytes > 0) this.#pendingContexts.set(contextId, contextBytes);
    this.#reservations.set(id, bytes);
    return true;
  }

  releasePending(id: string): void {
    this.#pendingBytes -= this.#reservations.get(id) ?? 0;
    this.#reservations.delete(id);
  }

  /** Dry-run a complete fact and its required nodes before mutating admission. */
  admitBatch(
    facts: readonly SemanticFact[],
    nodes: number,
    contexts: JavaScriptSemanticEvidenceContextRegistry,
    releasedReservations: readonly string[] = [],
    additionalBytes = 0,
  ): boolean {
    if (this.#closed) return false;
    const addedContexts = new Set<string>();
    let bytes = additionalBytes;
    for (const fact of facts) {
      bytes += serializedSemanticFactBytes(fact);
      const id = fact.evidence.context_id;
      if (!this.#chargedContexts.has(id) && !addedContexts.has(id)) {
        bytes += serializedSemanticFactBytes(contexts.context(id));
        addedContexts.add(id);
      }
    }
    const releasedBytes =
      releasedReservations.reduce(
        (total, id) => total + (this.#reservations.get(id) ?? 0),
        0,
      ) +
      [...addedContexts].reduce(
        (total, id) => total + (this.#pendingContexts.get(id) ?? 0),
        0,
      );
    const exceedsNodes =
      this.nodeLimit !== null && this.#nodes + nodes > this.nodeLimit;
    const exceedsBytes =
      this.limit !== null &&
      this.#used + this.#pendingBytes + bytes - releasedBytes > this.limit;
    if (exceedsNodes || exceedsBytes) {
      // A node ceiling does not exhaust the independent unknown frontier
      // capacity. Continue examining the file unless its byte budget ran out.
      this.#closed = exceedsBytes;
      this.#nodeLimitReached ||= exceedsNodes;
      this.#byteLimitReached ||= exceedsBytes;
      this.markIncomplete();
      return false;
    }
    this.#used += bytes;
    this.#nodes += nodes;
    for (const id of addedContexts) {
      this.#chargedContexts.add(id);
      this.#pendingBytes -= this.#pendingContexts.get(id) ?? 0;
      this.#pendingContexts.delete(id);
    }
    return true;
  }

  admit(
    fact: SemanticFact,
    contexts: JavaScriptSemanticEvidenceContextRegistry,
  ): boolean {
    return this.admitBatch([fact], 0, contexts);
  }
  admitNode(
    node: SemanticFact,
    contexts: JavaScriptSemanticEvidenceContextRegistry,
  ): boolean {
    return this.admitBatch([node], 1, contexts);
  }

  /** Closed sources retain bounded counters, never additional frontier objects. */
  countUnknown(
    unknown: JavaScriptSemanticGraphUnknown,
    retained = false,
  ): void {
    const key = `${unknown.family}\u0000${unknown.reason}`;
    const count = this.#unknownCounts.get(key) ?? {
      family: unknown.family,
      reason: unknown.reason,
      total: 0,
      retained: 0,
    };
    if (retained) count.retained += 1;
    else count.total += 1;
    this.#unknownCounts.set(key, count);
  }

  /** An omitted occurrence does not establish how many distinct frontiers were lost. */
  omitUnknown(
    family: JavaScriptSemanticGraphUnknown["family"],
    reason: JavaScriptSemanticGraphUnknown["reason"],
  ): void {
    const key = `${family}\u0000${reason}`;
    if (!this.#unknownCounts.has(key))
      this.#unknownCounts.set(key, { family, reason, total: 0, retained: 0 });
    this.#unknownTotalsIncomplete.add(key);
  }

  omitNode(nodeId: string): void {
    if (this.#closed) this.markIncomplete();
    else this.#omittedNodes.add(nodeId);
  }
  omitRelation(relationId: string): void {
    if (this.#closed) this.markIncomplete();
    else this.#omittedRelations.add(relationId);
  }
  get omittedNodes(): number {
    return this.#omittedNodes.size;
  }
  get omittedRelations(): number {
    return this.#omittedRelations.size;
  }
  references(contextId: string): boolean {
    return this.#chargedContexts.has(contextId);
  }
}
