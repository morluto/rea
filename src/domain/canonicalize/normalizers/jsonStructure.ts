import { createHash } from "node:crypto";

import type {
  CanonicalizeFact,
  CanonicalizeReduction,
} from "../canonicalizeArtifact.js";
import {
  canonicalizeSample,
  type ArtifactNormalizer,
  type NormalizedArtifactFacts,
  type NormalizerBudget,
} from "../normalizer.js";

/** Multiplier bounding the pass's own node walk against structural inflation. */
const NODE_BUDGET_FACTOR = 256;
const MIN_NODE_BUDGET = 1024;
/** Maximum code units kept for one path segment (object key or array index). */
const MAX_SEGMENT_UNITS = 128;
/** Maximum code units kept for a whole structural path name. */
const MAX_PATH_UNITS = 1024;

type Container = Record<string, unknown> | unknown[];

const isContainer = (value: unknown): value is Container =>
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

/** Code units of SHA-256 hex embedded to disambiguate a shortened segment or path. */
const SHORT_HASH_UNITS = 12;

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** JSON Pointer escaping so a key containing `/` cannot forge a nested path. */
const escapeSegment = (segment: string): string =>
  segment.replace(/~/gu, "~0").replace(/\//gu, "~1");

interface ChildName {
  readonly path: string;
  /** SHA-256 of the exact key when its name was shortened; null otherwise. */
  readonly sha256: string | null;
}

/**
 * Build a child path, bounding each segment and the whole path. An artifact
 * controls key text, so an inflated key must never be repeated verbatim across
 * many fact names. A shortened segment embeds a short digest so two keys that
 * share a prefix do not collapse to one name, and the fact carries the full
 * key digest as an exact reference — identity stays separate from display.
 */
const childPath = (parentPath: string, rawSegment: string): ChildName => {
  const escaped = escapeSegment(rawSegment);
  let sha256: string | null = null;
  let segment = escaped;
  if (segment.length > MAX_SEGMENT_UNITS) {
    sha256 = sha256Hex(rawSegment);
    segment = `${segment.slice(0, MAX_SEGMENT_UNITS)}…#${sha256.slice(0, SHORT_HASH_UNITS)}(${String(escaped.length)})`;
  }
  let path = `${parentPath}/${segment}`;
  if (path.length > MAX_PATH_UNITS) {
    const full = path;
    path = `${path.slice(0, MAX_PATH_UNITS)}…#${sha256Hex(full).slice(0, SHORT_HASH_UNITS)}`;
    sha256 ??= sha256Hex(full);
  }
  return { path, sha256 };
};

/** Array indices are short and need no escaping, bounding or digest. */
const indexPath = (parentPath: string, index: number): ChildName => ({
  path: `${parentPath}/${String(index)}`,
  sha256: null,
});

const memberCount = (value: Container): number =>
  Array.isArray(value) ? value.length : Object.keys(value).length;

const scalarText = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value === null
      ? "null"
      : typeof value === "bigint"
        ? value.toString()
        : String(value as number | boolean);

const truncatedKeyDetail = (sha256: string | null): string =>
  sha256 === null
    ? ""
    : " Path name was shortened; sha256 identifies the exact key bytes.";

const containerSummaryFact = (
  path: string,
  value: Container,
  sha256: string | null,
): CanonicalizeFact => {
  const count = memberCount(value);
  return {
    collection: "json-node",
    name: path,
    classification: "behavior-relevant",
    bytes: 0,
    location: null,
    sha256,
    sample: null,
    detail: `${Array.isArray(value) ? "array" : "object"} with ${String(count)} ${Array.isArray(value) ? "elements" : "members"}.${truncatedKeyDetail(sha256)}`,
  };
};

const leafFact = (
  path: string,
  value: unknown,
  sampleUnits: number,
  sha256: string | null,
): CanonicalizeFact => {
  const kind = value === null ? "null" : typeof value;
  return {
    collection: "json-value",
    name: path,
    classification: "behavior-relevant",
    bytes: 0,
    location: null,
    sha256,
    sample: canonicalizeSample(
      Buffer.from(scalarText(value), "utf8"),
      sampleUnits,
    ),
    detail: `Behavior-relevant ${kind} value.${truncatedKeyDetail(sha256)}`,
  };
};

const unverifiedFact = (path: string, detail: string): CanonicalizeFact => ({
  collection: "json-node",
  name: path,
  classification: "unverified",
  bytes: 0,
  location: null,
  sha256: null,
  sample: null,
  detail,
});

const rootSummary = (root: Container): CanonicalizeFact => {
  const count = memberCount(root);
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

interface Frame {
  readonly value: Container;
  readonly depth: number;
  readonly path: string;
}

interface WalkState {
  readonly core: CanonicalizeFact[];
  readonly collapsed: CanonicalizeFact[];
  readonly stack: Frame[];
  /** Retained facts so far, including the root and container summaries. */
  retained: number;
  deepCollapsed: number;
  skippedChildren: number;
  maxDepthObserved: number;
  truncated: boolean;
}

/** Admit one child as a bounded fact; return false when the fact budget is full. */
const admitChild = (
  state: WalkState,
  budget: NormalizerBudget,
  depth: number,
  name: ChildName,
  child: unknown,
): boolean => {
  if (state.retained >= budget.maxFacts) return false;
  if (isContainer(child)) {
    state.core.push(containerSummaryFact(name.path, child, name.sha256));
    state.retained += 1;
    state.stack.push({ value: child, depth: depth + 1, path: name.path });
    return true;
  }
  state.core.push(leafFact(name.path, child, budget.sampleUnits, name.sha256));
  state.retained += 1;
  return true;
};

/** Record a run of budget-skipped children as unverified, never as padding. */
const recordSkipped = (
  state: WalkState,
  budget: NormalizerBudget,
  path: string,
  total: number,
  admitted: number,
): void => {
  const skipped = total - admitted;
  if (skipped <= 0) return;
  state.skippedChildren += skipped;
  state.truncated = true;
  if (state.collapsed.length < budget.maxFacts)
    state.collapsed.push(
      unverifiedFact(
        path,
        `${String(skipped)} of ${String(total)} children beyond the fact budget were not visited; their behavior relevance is unverified.`,
      ),
    );
};

/** Expand one container: collapse at the depth bound, else admit bounded children. */
const processFrame = (
  frame: Frame,
  budget: NormalizerBudget,
  state: WalkState,
): void => {
  state.maxDepthObserved = Math.max(state.maxDepthObserved, frame.depth);
  if (frame.depth >= budget.maxDepth) {
    state.deepCollapsed += 1;
    state.truncated = true;
    if (state.collapsed.length < budget.maxFacts)
      state.collapsed.push(
        unverifiedFact(
          frame.path,
          `Structure nested beyond max_depth (${String(budget.maxDepth)}); deeper structure is unverified.`,
        ),
      );
    return;
  }
  if (Array.isArray(frame.value)) {
    const total = frame.value.length;
    let admitted = 0;
    // Enumerate only admitted elements; never materialize the whole array as
    // key/value pairs, so a long array cannot exhaust the heap before the cap.
    for (let index = 0; index < total; index += 1) {
      if (
        !admitChild(
          state,
          budget,
          frame.depth,
          indexPath(frame.path, index),
          frame.value[index],
        )
      )
        break;
      admitted += 1;
    }
    recordSkipped(state, budget, frame.path, total, admitted);
    return;
  }
  let total = 0;
  let admitted = 0;
  for (const key in frame.value) {
    if (!Object.hasOwn(frame.value, key)) continue;
    total += 1;
    if (
      admitChild(
        state,
        budget,
        frame.depth,
        childPath(frame.path, key),
        (frame.value as Record<string, unknown>)[key],
      )
    )
      admitted += 1;
  }
  recordSkipped(state, budget, frame.path, total, admitted);
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
    core: [rootSummary(root)],
    collapsed: [],
    stack: [{ value: root, depth: 0, path: "$" }],
    retained: 1,
    deepCollapsed: 0,
    skippedChildren: 0,
    maxDepthObserved: 0,
    truncated: false,
  };
  const limitations: string[] = [];
  const nodeBudget = Math.max(
    budget.maxFacts * NODE_BUDGET_FACTOR,
    MIN_NODE_BUDGET,
  );
  let nodesWalked = 0;

  while (state.stack.length > 0) {
    if (nodesWalked >= nodeBudget) {
      state.truncated = true;
      limitations.push(
        `Stopped after ${String(nodeBudget)} structural nodes; deeper structure is unverified.`,
      );
      break;
    }
    nodesWalked += 1;
    processFrame(state.stack.pop()!, budget, state);
  }

  const reductions: CanonicalizeReduction[] = [];
  if (state.deepCollapsed > 0)
    reductions.push({
      collection: "json-depth",
      examined: state.deepCollapsed,
      retained: 0,
      collapsed: state.deepCollapsed,
      collapsed_bytes: 0,
      group_sha256: null,
      basis: `Subtrees nested beyond max_depth (${String(budget.maxDepth)}) were collapsed and left unverified; nesting depth is non-semantic, but their contents were not examined.`,
    });
  if (state.skippedChildren > 0)
    reductions.push({
      collection: "json-children",
      examined: state.skippedChildren,
      retained: 0,
      collapsed: state.skippedChildren,
      collapsed_bytes: 0,
      group_sha256: null,
      basis:
        "Children beyond the fact budget were counted, not retained, and left unverified; raise max_facts to retain more exemplars.",
    });
  limitations.push(
    `Maximum observed structural depth: ${String(state.maxDepthObserved)}.`,
  );

  return {
    detected_format: "json",
    normalizer: "json-structure",
    core: state.core,
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

/** Canonicalize structured JSON (including oversized tshark/pcap dumps) by bounding depth and retaining bounded content. */
export const jsonStructureNormalizer: ArtifactNormalizer = {
  id: "json-structure",
  format: "json",
  recognizes,
  canonicalize,
};
