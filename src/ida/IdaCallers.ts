import type { JsonValue } from "../domain/jsonValue.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";
import { readCallGraphTargetBatch } from "./IdaCallGraph.js";
import type { IdaFunction } from "./IdaProtocolValues.js";

// Upstream defaults to 200 edges per root. Limit each frame to at most 6,400
// default edges while amortizing MCP latency; producer truncation stays explicit.
const CALLER_ROOTS_PER_BATCH = 32;

/** A code reference is a candidate only; the root call graph must confirm a call. */
export const readModernCallers = async (
  call: (
    tool: string,
    args: Readonly<Record<string, JsonValue>>,
  ) => Promise<JsonValue>,
  target: IdaFunction,
  references: readonly {
    readonly type: string;
    readonly function: IdaFunction | null;
  }[],
  truncated: boolean | undefined,
): Promise<{
  readonly callers: readonly IdaFunction[];
  readonly coverage: RelationshipCoverage;
  readonly limitations: readonly string[];
}> => {
  const candidates = new Map<string, IdaFunction>();
  const limitations = new Set<string>([
    "Caller discovery examines incoming references to the selected entry only; callers targeting interior addresses remain unknown.",
  ]);
  if (truncated !== false)
    limitations.add(
      truncated === true
        ? "Upstream xrefs_to capped caller candidates; additional callers remain unknown."
        : "Upstream xrefs_to did not report candidate coverage; additional callers remain unknown.",
    );
  for (const reference of references) {
    if (reference.type === "data") continue;
    if (reference.type !== "code" || reference.function === null) {
      limitations.add(
        "Some incoming references could not be assigned to a code-reference function; additional callers remain unknown.",
      );
      continue;
    }
    candidates.set(reference.function.address, reference.function);
  }
  const callers: IdaFunction[] = [];
  const unique = [...candidates.values()];
  for (
    let offset = 0;
    offset < unique.length;
    offset += CALLER_ROOTS_PER_BATCH
  ) {
    const batch = unique.slice(offset, offset + CALLER_ROOTS_PER_BATCH);
    const graphs = await readCallGraphTargetBatch(
      call,
      batch.map(({ address }) => address),
    );
    for (const candidate of batch) {
      const graph = graphs.get(candidate.address)!;
      if (graph.addresses.includes(target.address)) callers.push(candidate);
      // A confirmed edge remains proven even if other edges were omitted. Only an
      // unconfirmed candidate needs complete coverage to establish its exclusion.
      else if (graph.coverage.status !== "complete")
        limitations.add(
          `Upstream callgraph did not completely examine caller candidate ${candidate.address}; its relationship remains unknown.`,
        );
    }
  }
  const diagnostics = [
    "Callers are functions with incoming code references to the selected entry and a confirmed root-only callgraph edge; interior-only references and unresolved indirect calls remain unknown.",
  ];
  return {
    callers,
    limitations: [...limitations],
    coverage: { status: "partial", limitations: [...limitations], diagnostics },
  };
};
