import type { AnalysisOperation } from "./AnalysisProvider.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { type AnalysisError } from "../domain/analysisErrorBase.js";
import { parseRelatedAddresses } from "../domain/hopperValues.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok, type Result } from "../domain/result.js";
import type { EnhancedResult } from "./EnhancedToolTypes.js";

type AnalysisCall = (
  name: AnalysisOperation,
  arguments_: Readonly<Record<string, JsonValue>>,
  signal?: AbortSignal,
) => Promise<Result<JsonValue, AnalysisError>>;

export interface CallPathTraceInput {
  readonly start: string;
  readonly goal?: string | undefined;
  readonly direction: "forward" | "backward";
}

interface TraceState {
  readonly visited: Map<
    string,
    { readonly depth: number; readonly path: string[] }
  >;
  readonly queue: string[];
  readonly edges: Map<
    string,
    {
      readonly source_address: string;
      readonly target_address: string;
      readonly discovery_depth: number;
    }
  >;
  readonly failures: Array<{
    readonly address: string;
    readonly error: ReturnType<typeof projectAnalysisError>;
  }>;
  readonly residual: Set<string>;
  queueIndex: number;
  traversalPath: string[];
}

interface AddressExpansion {
  readonly input: CallPathTraceInput;
  readonly state: TraceState;
  readonly address: string;
  readonly current: { readonly depth: number; readonly path: string[] };
  readonly signal?: AbortSignal;
}

interface DiscoveredEdge {
  readonly address: string;
  readonly relatedAddress: string;
  readonly discoveryDepth: number;
}

/** Trace direct caller/callee relationships until the graph is exhausted or the goal is reached. */
export const traceCallPath = async (
  call: AnalysisCall,
  input: CallPathTraceInput,
  signal?: AbortSignal,
): EnhancedResult => {
  const state = createTraceState(input);
  while (
    state.queueIndex < state.queue.length &&
    state.traversalPath.length === 0
  ) {
    const address = state.queue[state.queueIndex++];
    if (address === undefined) break;
    const current = state.visited.get(address);
    if (current === undefined) continue;
    const found = await expandAddress(call, {
      input,
      state,
      address,
      current,
      ...(signal === undefined ? {} : { signal }),
    });
    if (found) break;
  }
  return ok(projectTrace(input, state));
};

const createTraceState = (input: CallPathTraceInput): TraceState => ({
  visited: new Map([[input.start, { depth: 0, path: [input.start] }]]),
  queue: [input.start],
  edges: new Map(),
  failures: [],
  residual: new Set(),
  queueIndex: 0,
  traversalPath: input.goal === input.start ? [input.start] : [],
});

const expandAddress = async (
  call: AnalysisCall,
  expansion: AddressExpansion,
): Promise<boolean> => {
  const { input, state, address, current, signal } = expansion;
  const relation = input.direction === "forward" ? "callees" : "callers";
  const tool =
    input.direction === "forward" ? "procedure_callees" : "procedure_callers";
  const result = await call(tool, { procedure: address }, signal);
  if (!result.ok) {
    state.failures.push({
      address,
      error: projectAnalysisError(result.error),
    });
    state.residual.add(`Call relationships were unavailable for ${address}.`);
    return false;
  }
  const related = parseRelatedAddresses(result.value, relation);
  if (!related.ok) {
    state.failures.push({
      address,
      error: projectAnalysisError(related.error),
    });
    state.residual.add(`Call relationships were unreadable for ${address}.`);
    return false;
  }
  for (const relatedAddress of sortedUniqueAddresses(related.value)) {
    recordEdge(input, state, {
      address,
      relatedAddress,
      discoveryDepth: current.depth + 1,
    });
    const path = state.visited.get(relatedAddress)?.path ?? [
      ...current.path,
      relatedAddress,
    ];
    if (state.visited.has(relatedAddress)) {
      if (relatedAddress === input.goal) {
        state.traversalPath = path;
        return true;
      }
      continue;
    }
    state.visited.set(relatedAddress, {
      depth: current.depth + 1,
      path,
    });
    if (relatedAddress === input.goal) {
      state.traversalPath = path;
      return true;
    }
    state.queue.push(relatedAddress);
  }
  return false;
};

const recordEdge = (
  input: CallPathTraceInput,
  state: TraceState,
  edge: DiscoveredEdge,
): void => {
  const sourceAddress =
    input.direction === "forward" ? edge.address : edge.relatedAddress;
  const targetAddress =
    input.direction === "forward" ? edge.relatedAddress : edge.address;
  const edgeKey = `${sourceAddress}\u0000${targetAddress}`;
  if (state.edges.has(edgeKey)) return;
  state.edges.set(edgeKey, {
    source_address: sourceAddress,
    target_address: targetAddress,
    discovery_depth: edge.discoveryDepth,
  });
};

const projectTrace = (input: CallPathTraceInput, state: TraceState) => ({
  start: input.start,
  goal: input.goal ?? null,
  direction: input.direction,
  goal_status:
    input.goal === undefined
      ? "not_requested"
      : state.traversalPath.length > 0
        ? "reached"
        : "not_reached",
  nodes: [...state.visited.entries()]
    .map(([address, { depth }]) => ({ address, depth }))
    .sort(
      (left, right) =>
        left.depth - right.depth || compareAddress(left.address, right.address),
    ),
  edges: [...state.edges.values()].sort(
    (left, right) =>
      left.discovery_depth - right.discovery_depth ||
      compareAddress(left.source_address, right.source_address) ||
      compareAddress(left.target_address, right.target_address),
  ),
  traversal_path: state.traversalPath,
  failures: state.failures,
  traversal: {
    nodes_visited: state.visited.size,
  },
  truncated: state.residual.size > 0,
  residual_unknowns: [...state.residual],
  limitations: [
    "Direct provider call relationships may omit unresolved indirect calls.",
  ],
});

const compareAddress = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const sortedUniqueAddresses = (addresses: readonly string[]): string[] =>
  [...new Set(addresses)].sort(compareAddress);
