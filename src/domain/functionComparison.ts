import { diffLines } from "diff";

import {
  parseFunctionEvidence,
  type FunctionCollection,
  type FunctionSnapshot,
} from "./functionDossierEvidence.js";
import {
  commentProjection,
  combineCoverage,
  functionMatch,
  identityProjection,
  isAutoName,
  normalizeCfg,
  project,
  referenceKindProjection,
  referenceProjection,
  sorted,
  stringAndNameProjection,
} from "./functionComparisonNormalization.js";
import {
  functionComparisonResultSchema,
  type DimensionName,
  type FunctionComparisonResult,
  type FunctionDimension,
} from "./functionComparisonSchemas.js";
import {
  canonicalJson,
  dimensionResult,
  overallStatus,
  summarize,
  unresolvedDimension as buildUnresolvedDimension,
} from "./functionComparisonResults.js";

export {
  functionComparisonInputSchema,
  functionComparisonResultSchema,
} from "./functionComparisonSchemas.js";

const unresolvedDimension = (
  ...[dimension, status, links, leftCount, rightCount, limitations]: readonly [
    DimensionName,
    "truncated" | "unknown",
    readonly string[],
    number | null,
    number | null,
    readonly string[],
  ]
): FunctionDimension =>
  buildUnresolvedDimension({
    dimension,
    status,
    links,
    leftCount,
    rightCount,
    limitations,
  });

/** Compare two explicit function Evidence page sets without fuzzy matching. */
export const compareFunctions = (
  leftInput: unknown,
  rightInput: unknown,
  offset: number,
  limit: number,
): FunctionComparisonResult => {
  const left = parseFunctionEvidence(leftInput);
  const right = parseFunctionEvidence(rightInput);
  const links = [
    ...left.evidence.map(({ evidence_id: id }) => id),
    ...right.evidence.map(({ evidence_id: id }) => id),
  ];
  const providersDiffer =
    canonicalJson(left.provider) !== canonicalJson(right.provider);
  const dimensions = compareDimensions(left, right, links, providersDiffer);
  const match = functionMatch(left, right);
  const changes = dimensions.filter(({ status }) => status !== "unchanged");
  const page = changes.slice(offset, offset + limit);
  return functionComparisonResultSchema.parse({
    status: overallStatus(dimensions, match.status),
    function_match: match,
    left_subject_sha256: left.subject.digest.sha256,
    right_subject_sha256: right.subject.digest.sha256,
    summary: summarize(dimensions),
    dimensions,
    changes: {
      items: page,
      offset,
      limit,
      total: changes.length,
      next_offset:
        offset + page.length < changes.length ? offset + page.length : null,
    },
    limitations: [
      ...new Set([
        ...left.limitations.map((item) => `Left: ${item}`),
        ...right.limitations.map((item) => `Right: ${item}`),
        ...(providersDiffer
          ? [
              "Provider-specific pseudocode and assembly representations were not equated.",
            ]
          : []),
      ]),
    ].sort((a, b) => a.localeCompare(b)),
  });
};

const compareDimensions = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  links: readonly string[],
  providersDiffer: boolean,
): FunctionDimension[] => [
  compareIdentity(left, right, links, providersDiffer),
  compareText(
    "pseudocode",
    left.pseudocode.text,
    right.pseudocode.text,
    left.pseudocode.complete,
    right.pseudocode.complete,
    links,
    providersDiffer,
  ),
  compareText(
    "assembly",
    left.collections.assembly.items.join("\n"),
    right.collections.assembly.items.join("\n"),
    left.collections.assembly.complete,
    right.collections.assembly.complete,
    links,
    providersDiffer,
    left.collections.assembly.truncated || right.collections.assembly.truncated,
    "Assembly is opaque provider text; relocation normalization is unavailable.",
  ),
  compareComments(left, right, links, providersDiffer),
  compareCalls(left, right, links, providersDiffer),
  compareReferences(left, right, links, providersDiffer),
  compareStringsAndNames(left, right, links, providersDiffer),
  compareCfg(left, right, links, providersDiffer),
];

const compareText = (
  ...[
    dimension,
    left,
    right,
    leftComplete,
    rightComplete,
    links,
    providersDiffer,
    explicitTruncation,
    limitation,
  ]: readonly [
    "pseudocode" | "assembly",
    string,
    string,
    boolean,
    boolean,
    readonly string[],
    boolean,
    boolean?,
    string?,
  ]
): FunctionDimension => {
  const truncated = explicitTruncation ?? (!leftComplete || !rightComplete);
  if (!leftComplete || !rightComplete || providersDiffer)
    return unresolvedDimension(
      dimension,
      truncated ? "truncated" : "unknown",
      links,
      left.length,
      right.length,
      [
        ...(limitation === undefined ? [] : [limitation]),
        ...(providersDiffer
          ? ["Exact text comparison requires one provider identity."]
          : []),
      ],
    );
  const changes = diffLines(left, right, {
    timeout: 100,
    maxEditLength: 10_000,
  });
  if (changes === undefined)
    return unresolvedDimension(
      dimension,
      "unknown",
      links,
      left.length,
      right.length,
      ["Bounded line diff exceeded its time or edit-distance limit."],
    );
  const delta = changes.reduce(
    (summary, change) => ({
      added_lines:
        summary.added_lines + (change.added ? (change.count ?? 0) : 0),
      removed_lines:
        summary.removed_lines + (change.removed ? (change.count ?? 0) : 0),
      hunks: summary.hunks + (change.added || change.removed ? 1 : 0),
    }),
    { added_lines: 0, removed_lines: 0, hunks: 0 },
  );
  return dimensionResult({
    dimension,
    status: delta.hunks === 0 ? "unchanged" : "changed",
    left,
    right,
    links,
    providersDiffer,
    leftCount: [...left].length,
    rightCount: [...right].length,
    textDelta: delta,
    limitations: limitation === undefined ? [] : [limitation],
  });
};

const compareCollections = (
  ...[
    dimension,
    left,
    right,
    leftCoverage,
    rightCoverage,
    links,
    providersDiffer,
  ]: readonly [
    DimensionName,
    readonly unknown[],
    readonly unknown[],
    Pick<FunctionCollection, "complete" | "truncated">,
    Pick<FunctionCollection, "complete" | "truncated">,
    readonly string[],
    boolean,
  ]
): FunctionDimension => {
  if (!leftCoverage.complete || !rightCoverage.complete)
    return unresolvedDimension(
      dimension,
      leftCoverage.truncated || rightCoverage.truncated
        ? "truncated"
        : "unknown",
      links,
      left.length,
      right.length,
      [],
    );
  return compareValues(
    dimension,
    sorted(left),
    sorted(right),
    links,
    true,
    true,
    providersDiffer,
  );
};

const compareComments = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  links: readonly string[],
  providersDiffer: boolean,
): FunctionDimension => {
  const leftValues = commentProjection(left);
  const rightValues = commentProjection(right);
  if (leftValues === null || rightValues === null)
    return unresolvedDimension(
      "comments",
      "unknown",
      links,
      left.collections.comments.items.length,
      right.collections.comments.items.length,
      ["Comment locations could not be normalized relative to the function."],
    );
  return compareCollections(
    "comments",
    leftValues,
    rightValues,
    left.collections.comments,
    right.collections.comments,
    links,
    providersDiffer,
  );
};

const compareStringsAndNames = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  links: readonly string[],
  providersDiffer: boolean,
): FunctionDimension => {
  const leftValues = stringAndNameProjection(left);
  const rightValues = stringAndNameProjection(right);
  if (leftValues === null || rightValues === null)
    return unresolvedDimension("strings_names", "unknown", links, null, null, [
      "Reference source locations could not be normalized to function offsets.",
    ]);
  return compareCollections(
    "strings_names",
    leftValues,
    rightValues,
    combineCoverage(
      left.collections.referenced_strings,
      left.collections.referenced_names,
    ),
    combineCoverage(
      right.collections.referenced_strings,
      right.collections.referenced_names,
    ),
    links,
    providersDiffer,
  );
};

const compareReferences = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  links: readonly string[],
  providersDiffer: boolean,
): FunctionDimension => {
  const leftCoverage = combineCoverage(
    left.collections.incoming_references,
    left.collections.outgoing_references,
  );
  const rightCoverage = combineCoverage(
    right.collections.incoming_references,
    right.collections.outgoing_references,
  );
  if (!leftCoverage.complete || !rightCoverage.complete)
    return unresolvedDimension(
      "references",
      leftCoverage.truncated || rightCoverage.truncated
        ? "truncated"
        : "unknown",
      links,
      leftCoverage.items.length,
      rightCoverage.items.length,
      [],
    );
  const leftProjection = referenceProjection(left);
  const rightProjection = referenceProjection(right);
  if (leftProjection.length === 0 && rightProjection.length === 0)
    return compareValues(
      "references",
      leftProjection,
      rightProjection,
      links,
      true,
      true,
      providersDiffer,
    );
  if (canonicalJson(leftProjection) !== canonicalJson(rightProjection))
    return dimensionResult({
      dimension: "references",
      status: "changed",
      left: leftProjection,
      right: rightProjection,
      links,
      providersDiffer,
      leftCount: leftProjection.length,
      rightCount: rightProjection.length,
      textDelta: null,
      limitations: [
        "Reference endpoints differ independently of provider reference-kind metadata.",
      ],
    });
  const leftKinds = referenceKindProjection(left);
  const rightKinds = referenceKindProjection(right);
  if (leftKinds !== null && rightKinds !== null)
    return compareValues(
      "references",
      leftKinds,
      rightKinds,
      links,
      true,
      true,
      providersDiffer,
    );
  return unresolvedDimension(
    "references",
    "unknown",
    links,
    leftProjection.length,
    rightProjection.length,
    [
      "At least one provider did not expose reference kinds, so equal endpoints do not prove equal edge semantics.",
    ],
  );
};

const compareIdentity = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  links: readonly string[],
  providersDiffer: boolean,
): FunctionDimension => {
  if (isAutoName(left.procedure.name) || isAutoName(right.procedure.name))
    return unresolvedDimension("identity", "unknown", links, null, null, [
      "Address-derived function names are not stable cross-version identity.",
    ]);
  return compareValues(
    "identity",
    identityProjection(left),
    identityProjection(right),
    links,
    true,
    true,
    providersDiffer,
  );
};

const compareCalls = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  links: readonly string[],
  providersDiffer: boolean,
): FunctionDimension => {
  const leftValues = callProjection(left);
  const rightValues = callProjection(right);
  if ([...leftValues, ...rightValues].some(({ name }) => isAutoName(name)))
    return unresolvedDimension(
      "calls",
      "unknown",
      links,
      leftValues.length,
      rightValues.length,
      ["Address-derived callee or caller names cannot be matched safely."],
    );
  return compareCollections(
    "calls",
    leftValues,
    rightValues,
    combineCoverage(left.collections.callers, left.collections.callees),
    combineCoverage(right.collections.callers, right.collections.callees),
    links,
    providersDiffer,
  );
};

const callProjection = (snapshot: FunctionSnapshot) => [
  ...project(snapshot.collections.callers, ({ name }) => ({
    direction: "in" as const,
    name,
  })),
  ...project(snapshot.collections.callees, ({ name }) => ({
    direction: "out" as const,
    name,
  })),
];

const compareCfg = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  links: readonly string[],
  providersDiffer: boolean,
): FunctionDimension => {
  const leftBlocks = left.collections.basic_blocks;
  const rightBlocks = right.collections.basic_blocks;
  if (!leftBlocks.complete || !rightBlocks.complete)
    return unresolvedDimension(
      "cfg",
      leftBlocks.truncated || rightBlocks.truncated ? "truncated" : "unknown",
      links,
      leftBlocks.items.length,
      rightBlocks.items.length,
      [],
    );
  const leftGraph = normalizeCfg(leftBlocks.items);
  const rightGraph = normalizeCfg(rightBlocks.items);
  if (leftGraph === null || rightGraph === null)
    return unresolvedDimension(
      "cfg",
      "unknown",
      links,
      leftBlocks.items.length,
      rightBlocks.items.length,
      ["CFG addresses could not be normalized to local block indices."],
    );
  return compareValues(
    "cfg",
    leftGraph,
    rightGraph,
    links,
    true,
    true,
    providersDiffer,
  );
};

const compareValues = (
  ...[
    dimension,
    left,
    right,
    links,
    leftComplete,
    rightComplete,
    providersDiffer,
  ]: readonly [
    DimensionName,
    unknown,
    unknown,
    readonly string[],
    boolean,
    boolean,
    boolean,
  ]
): FunctionDimension => {
  if (!leftComplete || !rightComplete)
    return unresolvedDimension(dimension, "unknown", links, null, null, []);
  const leftJson = canonicalJson(left);
  const rightJson = canonicalJson(right);
  return dimensionResult({
    dimension,
    status: leftJson === rightJson ? "unchanged" : "changed",
    left,
    right,
    links,
    providersDiffer,
    leftCount: Array.isArray(left) ? left.length : null,
    rightCount: Array.isArray(right) ? right.length : null,
    textDelta: null,
    limitations: [],
  });
};
