import type {
  CanonicalizeFact,
  CanonicalizeReduction,
} from "../canonicalizeArtifact.js";
import type {
  ArtifactNormalizer,
  NormalizedArtifactFacts,
  NormalizerBudget,
} from "../normalizer.js";

/** Multiplier bounding the pass's own node walk against structural inflation. */
const NODE_BUDGET_FACTOR = 256;
const MIN_NODE_BUDGET = 1024;

const isContainer = (
  value: unknown,
): value is Record<string, unknown> | unknown[] =>
  typeof value === "object" && value !== null;

const firstNonWhitespace = (bytes: Buffer): number => {
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)
      return byte;
  }
  return -1;
};

const recognizes = (bytes: Buffer): boolean => {
  const byte = firstNonWhitespace(bytes);
  return byte === 0x7b /* { */ || byte === 0x5b; /* [ */
};

interface Frame {
  readonly value: Record<string, unknown> | unknown[];
  readonly depth: number;
  readonly path: string;
}

const entriesOf = (
  value: Record<string, unknown> | unknown[],
): [string, unknown][] =>
  Array.isArray(value)
    ? value.map((child, index) => [String(index), child])
    : Object.entries(value);

const rootSummary = (
  root: Record<string, unknown> | unknown[],
): CanonicalizeFact => {
  const count = Array.isArray(root) ? root.length : Object.keys(root).length;
  return {
    collection: "json-root",
    name: Array.isArray(root) ? "array" : "object",
    classification: "behavior-relevant",
    bytes: 0,
    location: null,
    sha256: null,
    sample: null,
    detail: `${String(count)} top-level ${Array.isArray(root) ? "elements" : "members"}`,
  };
};

const depthFact = (path: string, maxDepth: number): CanonicalizeFact => ({
  collection: "json-node",
  name: path,
  classification: "non-semantic-padding",
  bytes: 0,
  location: null,
  sha256: null,
  sample: null,
  detail: `Structure nested beyond max_depth (${String(maxDepth)}); collapsed.`,
});

const cardinalityFact = (
  path: string,
  children: number,
  retained: number,
): CanonicalizeFact => ({
  collection: "json-node",
  name: path,
  classification: "non-semantic-padding",
  bytes: 0,
  location: null,
  sha256: null,
  sample: null,
  detail: `High-cardinality node with ${String(children)} children; retained ${String(retained)} exemplars.`,
});

interface WalkState {
  readonly collapsed: CanonicalizeFact[];
  readonly stack: Frame[];
  deepCollapsed: number;
  redundantCollapsed: number;
  truncated: boolean;
}

/** Expand one container frame: collapse at the depth bound, cap wide runs, enqueue children. */
const processFrame = (
  frame: Frame,
  budget: NormalizerBudget,
  state: WalkState,
): void => {
  if (frame.depth >= budget.maxDepth) {
    state.deepCollapsed += 1;
    state.truncated = true;
    if (state.collapsed.length < budget.maxFacts)
      state.collapsed.push(depthFact(frame.path, budget.maxDepth));
    return;
  }
  const entries = entriesOf(frame.value);
  const retain = Math.min(entries.length, budget.maxFacts);
  if (entries.length > budget.maxFacts) {
    state.redundantCollapsed += entries.length - retain;
    if (state.collapsed.length < budget.maxFacts)
      state.collapsed.push(cardinalityFact(frame.path, entries.length, retain));
  }
  for (let index = retain - 1; index >= 0; index -= 1) {
    const [key, child] = entries[index]!;
    if (isContainer(child))
      state.stack.push({
        value: child,
        depth: frame.depth + 1,
        path: `${frame.path}/${key}`,
      });
  }
};

const parseFailure = (message: string): NormalizedArtifactFacts => ({
  detected_format: "json",
  normalizer: "json-structure",
  core: [],
  collapsed: [],
  reductions: [],
  coverage: { status: "partial", examined: 0, total: null, truncated: false },
  limitations: [message],
});

const canonicalize = (
  bytes: Buffer,
  budget: NormalizerBudget,
): NormalizedArtifactFacts => {
  let root: unknown;
  try {
    root = JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    return parseFailure(
      `JSON parse failed; structure unverified: ${cause instanceof Error ? cause.message : "unknown error"}`,
    );
  }
  if (!isContainer(root))
    return {
      ...parseFailure(
        "JSON root is a scalar; no structural canonicalization applies.",
      ),
      coverage: { status: "complete", examined: 1, total: 1, truncated: false },
    };

  const state: WalkState = {
    collapsed: [],
    stack: [{ value: root, depth: 0, path: "$" }],
    deepCollapsed: 0,
    redundantCollapsed: 0,
    truncated: false,
  };
  const limitations: string[] = [];
  const nodeBudget = Math.max(
    budget.maxFacts * NODE_BUDGET_FACTOR,
    MIN_NODE_BUDGET,
  );
  let nodesWalked = 0;
  let maxDepthObserved = 0;

  while (state.stack.length > 0) {
    if (nodesWalked >= nodeBudget) {
      state.truncated = true;
      limitations.push(
        `Stopped after ${String(nodeBudget)} structural nodes; deeper structure is unverified.`,
      );
      break;
    }
    const frame = state.stack.pop()!;
    nodesWalked += 1;
    maxDepthObserved = Math.max(maxDepthObserved, frame.depth);
    processFrame(frame, budget, state);
  }

  const reductions: CanonicalizeReduction[] = [];
  if (state.deepCollapsed > 0)
    reductions.push({
      collection: "json-depth",
      examined: state.deepCollapsed,
      retained: 0,
      collapsed: state.deepCollapsed,
      collapsed_bytes: 0,
      basis: `Subtrees nested beyond max_depth (${String(budget.maxDepth)}) were collapsed; nesting is non-semantic padding.`,
    });
  if (state.redundantCollapsed > 0)
    reductions.push({
      collection: "json-siblings",
      examined: state.redundantCollapsed,
      retained: 0,
      collapsed: state.redundantCollapsed,
      collapsed_bytes: 0,
      basis:
        "High-cardinality sibling runs were reduced to exemplars plus counts.",
    });
  limitations.push(
    `Maximum observed structural depth: ${String(maxDepthObserved)}.`,
  );

  return {
    detected_format: "json",
    normalizer: "json-structure",
    core: [rootSummary(root)],
    collapsed: state.collapsed,
    reductions,
    coverage: {
      status: state.truncated ? "partial" : "complete",
      examined: nodesWalked,
      total: state.truncated ? null : nodesWalked,
      truncated: state.truncated,
    },
    limitations,
  };
};

/** Canonicalize structured JSON (including oversized tshark/pcap dumps) by bounding depth and collapsing redundant runs. */
export const jsonStructureNormalizer: ArtifactNormalizer = {
  id: "json-structure",
  format: "json",
  recognizes,
  canonicalize,
};
