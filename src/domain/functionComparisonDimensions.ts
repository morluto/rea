import { canonicalJson } from "./comparisonSemantics.js";
import { diffLines } from "diff";

import type { FunctionSnapshot } from "./functionDossierEvidence.js";
import {
  commentProjection,
  identityProjection,
  isAutoName,
  normalizeCfg,
  referenceKindProjection,
  referenceProjection,
  sorted,
  stringAndNameProjection,
} from "./functionComparisonNormalization.js";
import type {
  DimensionName,
  FunctionDimension,
} from "./functionComparisonSchemas.js";
import {
  dimensionResult,
  unresolvedDimension,
  type DimensionResultInput,
} from "./functionComparisonResults.js";

type ComparisonContext = Pick<
  DimensionResultInput,
  "links" | "providersDiffer"
>;

export const compareDimensions = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  context: ComparisonContext,
): FunctionDimension[] => {
  return [
    compareIdentity(left, right, context),
    compareText(
      "pseudocode",
      left.dossier.pseudocode,
      right.dossier.pseudocode,
      context,
    ),
    compareText(
      "assembly",
      left.dossier.assembly.join("\n"),
      right.dossier.assembly.join("\n"),
      context,
    ),
    compareComments(left, right, context),
    compareCalls(left, right, context),
    compareReferences(left, right, context),
    compareStringsAndNames(left, right, context),
    compareCfg(left, right, context),
  ];
};

const compareText = (
  dimension: "pseudocode" | "assembly",
  left: string,
  right: string,
  context: ComparisonContext,
): FunctionDimension => {
  const limitations =
    dimension === "assembly"
      ? [
          "Assembly is opaque provider text; relocation normalization is unavailable.",
        ]
      : [];
  if (context.providersDiffer)
    return unresolvedDimension({
      dimension,
      links: context.links,
      leftCount: [...left].length,
      rightCount: [...right].length,
      limitations: [
        ...limitations,
        "Exact text comparison requires one provider identity.",
      ],
    });
  const changes = diffLines(left, right, {
    timeout: 100,
    maxEditLength: 10_000,
  });
  if (changes === undefined)
    return unresolvedDimension({
      dimension,
      links: context.links,
      leftCount: [...left].length,
      rightCount: [...right].length,
      limitations: [
        "Bounded line diff exceeded its time or edit-distance limit.",
      ],
    });
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
    ...context,
    leftCount: [...left].length,
    rightCount: [...right].length,
    textDelta: delta,
    limitations,
  });
};

const compareComments = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  context: ComparisonContext,
): FunctionDimension => {
  const leftValues = commentProjection(left);
  const rightValues = commentProjection(right);
  if (leftValues === null || rightValues === null)
    return unresolvedDimension({
      dimension: "comments",
      links: context.links,
      leftCount: left.dossier.comments.length,
      rightCount: right.dossier.comments.length,
      limitations: [
        "Comment locations could not be normalized relative to the function.",
      ],
    });
  return compareValues("comments", leftValues, rightValues, context);
};

const compareStringsAndNames = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  context: ComparisonContext,
): FunctionDimension => {
  const leftValues = stringAndNameProjection(left);
  const rightValues = stringAndNameProjection(right);
  if (leftValues === null || rightValues === null)
    return unresolvedDimension({
      dimension: "strings_names",
      links: context.links,
      leftCount: null,
      rightCount: null,
      limitations: [
        "Reference source locations could not be normalized to function offsets.",
      ],
    });
  return compareValues("strings_names", leftValues, rightValues, context);
};

const compareReferences = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  context: ComparisonContext,
): FunctionDimension => {
  const leftProjection = referenceProjection(left);
  const rightProjection = referenceProjection(right);
  if (leftProjection.length === 0 && rightProjection.length === 0)
    return compareValues(
      "references",
      leftProjection,
      rightProjection,
      context,
    );
  if (
    canonicalJson(leftProjection, "Function comparison") !==
    canonicalJson(rightProjection, "Function comparison")
  )
    return dimensionResult({
      dimension: "references",
      status: "changed",
      left: leftProjection,
      right: rightProjection,
      ...context,
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
    return compareValues("references", leftKinds, rightKinds, context);
  return unresolvedDimension({
    dimension: "references",
    links: context.links,
    leftCount: leftProjection.length,
    rightCount: rightProjection.length,
    limitations: [
      "At least one provider did not expose reference kinds, so equal endpoints do not prove equal edge semantics.",
    ],
  });
};

const compareIdentity = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  context: ComparisonContext,
): FunctionDimension => {
  if (
    isAutoName(left.dossier.procedure.name) ||
    isAutoName(right.dossier.procedure.name)
  )
    return unresolvedDimension({
      dimension: "identity",
      links: context.links,
      leftCount: null,
      rightCount: null,
      limitations: [
        "Address-derived function names are not stable cross-version identity.",
      ],
    });
  return compareValues(
    "identity",
    identityProjection(left),
    identityProjection(right),
    context,
  );
};

const compareCalls = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  context: ComparisonContext,
): FunctionDimension => {
  const leftValues = callProjection(left);
  const rightValues = callProjection(right);
  if ([...leftValues, ...rightValues].some(({ name }) => isAutoName(name)))
    return unresolvedDimension({
      dimension: "calls",
      links: context.links,
      leftCount: leftValues.length,
      rightCount: rightValues.length,
      limitations: [
        "Address-derived callee or caller names cannot be matched safely.",
      ],
    });
  return compareValues(
    "calls",
    sorted(leftValues),
    sorted(rightValues),
    context,
  );
};

const callProjection = (snapshot: FunctionSnapshot) => [
  ...snapshot.dossier.callers.map(({ name }) => ({
    direction: "in" as const,
    name,
  })),
  ...snapshot.dossier.callees.map(({ name }) => ({
    direction: "out" as const,
    name,
  })),
];

const compareCfg = (
  left: FunctionSnapshot,
  right: FunctionSnapshot,
  context: ComparisonContext,
): FunctionDimension => {
  const leftBlocks = left.dossier.basic_blocks;
  const rightBlocks = right.dossier.basic_blocks;
  const leftGraph = normalizeCfg(leftBlocks);
  const rightGraph = normalizeCfg(rightBlocks);
  if (leftGraph === null || rightGraph === null)
    return unresolvedDimension({
      dimension: "cfg",
      links: context.links,
      leftCount: leftBlocks.length,
      rightCount: rightBlocks.length,
      limitations: [
        "CFG addresses could not be normalized to local block indices.",
      ],
    });
  return compareValues("cfg", leftGraph, rightGraph, context);
};

const compareValues = (
  dimension: DimensionName,
  left: unknown,
  right: unknown,
  context: ComparisonContext,
): FunctionDimension => {
  const leftJson = canonicalJson(left, "Function comparison");
  const rightJson = canonicalJson(right, "Function comparison");
  return dimensionResult({
    dimension,
    status: leftJson === rightJson ? "unchanged" : "changed",
    left,
    right,
    ...context,
    leftCount: Array.isArray(left) ? left.length : null,
    rightCount: Array.isArray(right) ? right.length : null,
    textDelta: null,
    limitations: [],
  });
};
