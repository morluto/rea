import {
  canonicalExportShapeValue,
  digestExportShapeValue,
} from "./javascriptExportShapeComparisonIdentity.js";
import type {
  JavaScriptExportShapeComparisonChange,
  JavaScriptExportShapeComparisonResult,
  JavaScriptExportShapePropertyInventory,
  ProjectedExportReturnShapes,
} from "./javascriptExportShapeComparisonSchemas.js";
import { compareCodePoints, uniqueSorted } from "../canonicalOrdering.js";
import type { SelectedJavaScriptExport } from "./javascriptExportShapeSelection.js";

type Primitive = string | number | boolean | null;
type Shape = ProjectedExportReturnShapes["static_return_shapes"][number];
type Field = Shape["fields"][number];
type SelectorResult = JavaScriptExportShapeComparisonResult["left"];
type ValueAvailability = JavaScriptExportShapeComparisonChange["left"];
type PropertyPresence =
  JavaScriptExportShapeComparisonChange["presence"]["left"];
type Discriminant = NonNullable<
  JavaScriptExportShapeComparisonChange["discriminant"]
>;
const UNKNOWN_COVERAGE_PRESENCE = {
  left: "unknown-coverage",
  right: "unknown-coverage",
} as const satisfies JavaScriptExportShapeComparisonChange["presence"];

interface VariantPair {
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly discriminant: Discriminant;
}

/** Unique-only return-variant pairings plus every unpaired retained variant. */
export interface JavaScriptExportShapePairing {
  readonly pairs: readonly VariantPair[];
  readonly unpairedLeft: readonly number[];
  readonly unpairedRight: readonly number[];
}

/** Pair variants only through reciprocal unique exact literal discriminants. */
export const pairJavaScriptExportShapeVariants = (
  left: readonly Shape[],
  right: readonly Shape[],
): JavaScriptExportShapePairing => {
  const leftKeys = discriminantOccurrences(left);
  const rightKeys = discriminantOccurrences(right);
  const edges = new Map<string, Discriminant[]>();
  const leftTargets = new Map<number, Set<number>>();
  const rightTargets = new Map<number, Set<number>>();
  for (const [key, leftOccurrence] of leftKeys) {
    const rightOccurrence = rightKeys.get(key);
    if (
      leftOccurrence.indexes.length !== 1 ||
      rightOccurrence?.indexes.length !== 1
    )
      continue;
    const leftIndex = leftOccurrence.indexes[0];
    const rightIndex = rightOccurrence.indexes[0];
    if (leftIndex === undefined || rightIndex === undefined) continue;
    const edgeKey = `${String(leftIndex)}:${String(rightIndex)}`;
    edges.set(edgeKey, [
      ...(edges.get(edgeKey) ?? []),
      leftOccurrence.discriminant,
    ]);
    addTarget(leftTargets, leftIndex, rightIndex);
    addTarget(rightTargets, rightIndex, leftIndex);
  }
  const pairs = reciprocalPairs(leftTargets, rightTargets, edges);
  const pairedLeft = new Set(pairs.map(({ leftIndex }) => leftIndex));
  const pairedRight = new Set(pairs.map(({ rightIndex }) => rightIndex));
  return {
    pairs,
    unpairedLeft: indexesNotIn(left, pairedLeft),
    unpairedRight: indexesNotIn(right, pairedRight),
  };
};

interface ChangeBuildInput {
  readonly leftSelection: SelectedJavaScriptExport;
  readonly rightSelection: SelectedJavaScriptExport;
  readonly pairing: JavaScriptExportShapePairing;
  readonly leftShapes: readonly Shape[];
  readonly rightShapes: readonly Shape[];
  readonly evidenceLinks: [string, string];
}

/** Build bounded-ready field and unpaired-variant changes before caller slicing. */
export const buildJavaScriptExportShapeChanges = (
  input: ChangeBuildInput,
): JavaScriptExportShapeComparisonChange[] => {
  if (
    input.leftSelection.selection.status !== "selected" ||
    input.rightSelection.selection.status !== "selected"
  )
    return [selectionUnknownChange(input)];
  if (input.leftShapes.length === 0 || input.rightShapes.length === 0)
    return [emptyShapeUnknownChange(input)];
  const paired = input.pairing.pairs.flatMap((pair) => {
    const left = input.leftShapes[pair.leftIndex];
    const right = input.rightShapes[pair.rightIndex];
    return left === undefined || right === undefined
      ? []
      : diffPair(left, right, pair.discriminant, input.evidenceLinks);
  });
  const unpairedLeft = input.pairing.unpairedLeft.flatMap((index) => {
    const shape = input.leftShapes[index];
    return shape === undefined
      ? []
      : [unpairedChange("left", shape, input.evidenceLinks)];
  });
  const unpairedRight = input.pairing.unpairedRight.flatMap((index) => {
    const shape = input.rightShapes[index];
    return shape === undefined
      ? []
      : [unpairedChange("right", shape, input.evidenceLinks)];
  });
  return [...paired, ...unpairedLeft, ...unpairedRight];
};

/** List observed property names per retained variant, including unknown values. */
export const buildJavaScriptExportShapeInventories = (input: {
  readonly pairing: JavaScriptExportShapePairing;
  readonly leftShapes: readonly Shape[];
  readonly rightShapes: readonly Shape[];
}): JavaScriptExportShapePropertyInventory[] => {
  const leftPairs = new Map(
    input.pairing.pairs.map((pair) => [pair.leftIndex, pair]),
  );
  const rightPairs = new Map(
    input.pairing.pairs.map((pair) => [pair.rightIndex, pair]),
  );
  return [
    ...input.leftShapes.map((shape, index) =>
      inventoryFor("left", index, shape, leftPairs.get(index)),
    ),
    ...input.rightShapes.map((shape, index) =>
      inventoryFor("right", index, shape, rightPairs.get(index)),
    ),
  ];
};

const inventoryFor = (
  side: JavaScriptExportShapePropertyInventory["side"],
  variantIndex: number,
  shape: Shape,
  pair: VariantPair | undefined,
): JavaScriptExportShapePropertyInventory => ({
  side,
  variant_index: variantIndex,
  discriminant: pair?.discriminant ?? null,
  paired: pair !== undefined,
  source_range: shape.source_range,
  properties: uniqueSorted([
    ...shape.fields
      .filter((field) => fieldPresence(shape, field, field.path) === "present")
      .map(({ path }) => path),
    ...shape.property_coverage.map(({ path }) => path),
  ]).filter((path) => path !== ""),
  property_coverage: shape.property_coverage.map(({ path, status }) => ({
    path,
    status,
  })),
});

/** Report whether any retained shape lacks complete property coverage. */
export const hasPartialJavaScriptExportPropertyCoverage = (
  shapes: readonly Shape[],
): boolean =>
  shapes.some(
    (shape) =>
      shape.property_coverage.some(({ status }) => status === "partial") ||
      shape.fields.some(
        (field) =>
          fieldPresence(shape, field, field.path) === "unknown-coverage",
      ),
  );

interface DiscriminantOccurrence {
  readonly discriminant: Discriminant;
  readonly indexes: number[];
}

const discriminantOccurrences = (
  shapes: readonly Shape[],
): Map<string, DiscriminantOccurrence> => {
  const output = new Map<string, DiscriminantOccurrence>();
  shapes.forEach((shape, index) => {
    for (const field of shape.fields) {
      const value = literalValue(field);
      if (!value.found) continue;
      const discriminant = { path: field.path, value: value.value };
      const key = canonicalExportShapeValue(discriminant);
      const current = output.get(key);
      output.set(key, {
        discriminant,
        indexes: [...(current?.indexes ?? []), index],
      });
    }
  });
  return output;
};

const reciprocalPairs = (
  leftTargets: ReadonlyMap<number, ReadonlySet<number>>,
  rightTargets: ReadonlyMap<number, ReadonlySet<number>>,
  edges: ReadonlyMap<string, readonly Discriminant[]>,
): VariantPair[] => {
  const pairs: VariantPair[] = [];
  for (const [leftIndex, targets] of leftTargets) {
    if (targets.size !== 1) continue;
    const rightIndex = [...targets][0];
    if (
      rightIndex === undefined ||
      rightTargets.get(rightIndex)?.size !== 1 ||
      !rightTargets.get(rightIndex)?.has(leftIndex)
    )
      continue;
    const discriminants = edges
      .get(`${String(leftIndex)}:${String(rightIndex)}`)
      ?.toSorted(compareDiscriminants);
    const discriminant = discriminants?.[0];
    if (discriminant !== undefined)
      pairs.push({ leftIndex, rightIndex, discriminant });
  }
  return pairs.sort((first, second) =>
    compareDiscriminants(first.discriminant, second.discriminant),
  );
};

const addTarget = (
  map: Map<number, Set<number>>,
  source: number,
  target: number,
): void => {
  const values = map.get(source) ?? new Set<number>();
  values.add(target);
  map.set(source, values);
};

const indexesNotIn = (
  shapes: readonly Shape[],
  paired: ReadonlySet<number>,
): number[] =>
  shapes.map((_, index) => index).filter((index) => !paired.has(index));

const compareDiscriminants = (
  left: Discriminant,
  right: Discriminant,
): number =>
  compareCodePoints(
    canonicalExportShapeValue(left),
    canonicalExportShapeValue(right),
  );

const selectionUnknownChange = (
  input: ChangeBuildInput,
): JavaScriptExportShapeComparisonChange =>
  changeWithId({
    status: "unknown",
    path: "",
    discriminant: null,
    presence: UNKNOWN_COVERAGE_PRESENCE,
    left: selectionAvailability(input.leftSelection.selection, "left"),
    right: selectionAvailability(input.rightSelection.selection, "right"),
    left_source_range: null,
    right_source_range: null,
    evidence_links: input.evidenceLinks,
    limitations: [
      "Both selectors must resolve one exact export with trusted static return shapes before comparison.",
    ],
  });

const emptyShapeUnknownChange = (
  input: ChangeBuildInput,
): JavaScriptExportShapeComparisonChange =>
  changeWithId({
    status: "unknown",
    path: "",
    discriminant: null,
    presence: UNKNOWN_COVERAGE_PRESENCE,
    left: emptyShapeAvailability(input.leftShapes, "left"),
    right: emptyShapeAvailability(input.rightShapes, "right"),
    left_source_range: null,
    right_source_range: null,
    evidence_links: input.evidenceLinks,
    limitations: [
      "At least one selected export has no retained direct return shape.",
    ],
  });

const diffPair = (
  left: Shape,
  right: Shape,
  discriminant: Discriminant,
  evidenceLinks: [string, string],
): JavaScriptExportShapeComparisonChange[] => {
  const leftFields = new Map(left.fields.map((field) => [field.path, field]));
  const rightFields = new Map(right.fields.map((field) => [field.path, field]));
  const paths = uniqueSorted([
    ...leftFields.keys(),
    ...rightFields.keys(),
    ...left.property_coverage.map(({ path }) => path),
    ...right.property_coverage.map(({ path }) => path),
  ]);
  return paths.flatMap((path) => {
    const leftField = fieldAtPath(left, leftFields, path);
    const rightField = fieldAtPath(right, rightFields, path);
    const status = fieldChangeStatus({
      leftShape: left,
      rightShape: right,
      path,
      leftField,
      rightField,
    });
    if (status === null) return [];
    return [
      changeWithId({
        status,
        path,
        discriminant,
        presence: {
          left: fieldPresence(left, leftField, path),
          right: fieldPresence(right, rightField, path),
        },
        left: fieldAvailability(leftField),
        right: fieldAvailability(rightField),
        left_source_range: left.source_range,
        right_source_range: right.source_range,
        evidence_links: evidenceLinks,
        limitations:
          status === "unknown"
            ? [
                "The static value or relevant parent-property coverage is incomplete.",
              ]
            : [],
      }),
    ];
  });
};

const fieldAtPath = (
  shape: Shape,
  fields: ReadonlyMap<string, Field>,
  path: string,
): Field | undefined => {
  const field = fields.get(path);
  if (field !== undefined) return field;
  if (!shape.property_coverage.some((coverage) => coverage.path === path))
    return undefined;
  return {
    path,
    presence: "present",
    state: "unknown",
    value: null,
    reason:
      "A static container is retained at this path, but no primitive field value is projected.",
  };
};

interface FieldChangeInput {
  readonly leftShape: Shape;
  readonly rightShape: Shape;
  readonly path: string;
  readonly leftField: Field | undefined;
  readonly rightField: Field | undefined;
}

const fieldChangeStatus = ({
  leftShape,
  rightShape,
  path,
  leftField,
  rightField,
}: FieldChangeInput):
  | JavaScriptExportShapeComparisonChange["status"]
  | null => {
  const leftPresence = fieldPresence(leftShape, leftField, path);
  const rightPresence = fieldPresence(rightShape, rightField, path);
  if (leftPresence === "absent" && rightPresence === "absent") return null;
  if (
    leftPresence === "unknown-coverage" ||
    rightPresence === "unknown-coverage"
  )
    return "unknown";
  if (leftPresence === "absent") return "added";
  if (rightPresence === "absent") return "removed";
  if (leftField !== undefined && rightField !== undefined) {
    if (
      canonicalExportShapeValue({ ...leftField, presence: leftPresence }) ===
      canonicalExportShapeValue({ ...rightField, presence: rightPresence })
    )
      return null;
    return leftField.state === "unknown" || rightField.state === "unknown"
      ? "unknown"
      : "changed";
  }
  return null;
};

const fieldPresence = (
  shape: Shape,
  field: Field | undefined,
  path: string,
): PropertyPresence => {
  // Legacy unknown fields did not distinguish unresolved values from uncertain slots.
  if (field !== undefined)
    return (
      field.presence ??
      (field.state === "unknown" ? "unknown-coverage" : "present")
    );
  return propertyCoverageComplete(shape, parentPointer(path))
    ? "absent"
    : "unknown-coverage";
};

const propertyCoverageComplete = (shape: Shape, path: string | null): boolean =>
  path !== null &&
  shape.property_coverage.some(
    (coverage) => coverage.path === path && coverage.status === "complete",
  );

const parentPointer = (path: string): string | null => {
  if (path === "") return null;
  const separator = path.lastIndexOf("/");
  return separator < 0 ? null : path.slice(0, separator);
};

const fieldAvailability = (field: Field | undefined): ValueAvailability => {
  if (field === undefined || field.presence === "absent")
    return { availability: "absent" };
  if (field.state === "unknown")
    return {
      availability: "unknown",
      reason: field.reason ?? "Static field value is unknown.",
    };
  if (field.state === "union")
    return { availability: "union", values: primitiveArray(field.value) };
  const literal = literalValue(field);
  return literal.found
    ? { availability: "literal", value: literal.value }
    : {
        availability: "unknown",
        reason: "Static literal field failed its projection boundary.",
      };
};

const selectionAvailability = (
  selection: SelectorResult,
  side: "left" | "right",
): ValueAvailability => ({
  availability: "unknown",
  reason: `${capitalize(side)} export selection is ${selection.status}.`,
});

const emptyShapeAvailability = (
  shapes: readonly Shape[],
  side: "left" | "right",
): ValueAvailability => ({
  availability: "unknown",
  reason:
    shapes.length === 0
      ? `${capitalize(side)} export has no retained direct return shape.`
      : `${capitalize(side)} export return shape cannot be paired without an opposite variant.`,
});

const unpairedChange = (
  side: "left" | "right",
  shape: Shape,
  evidenceLinks: [string, string],
): JavaScriptExportShapeComparisonChange =>
  changeWithId({
    status: "unknown",
    path: "",
    discriminant: null,
    presence: UNKNOWN_COVERAGE_PRESENCE,
    left: {
      availability: "unknown",
      reason:
        side === "left"
          ? "Left return variant has no unique exact cross-version pairing."
          : "No left return variant was uniquely paired with this right variant.",
    },
    right: {
      availability: "unknown",
      reason:
        side === "right"
          ? "Right return variant has no unique exact cross-version pairing."
          : "No right return variant was uniquely paired with this left variant.",
    },
    left_source_range: side === "left" ? shape.source_range : null,
    right_source_range: side === "right" ? shape.source_range : null,
    evidence_links: evidenceLinks,
    limitations: [
      "The return variant was not paired because no reciprocal unique literal discriminant exists.",
    ],
  });

const changeWithId = (
  semantic: Omit<JavaScriptExportShapeComparisonChange, "change_id">,
): JavaScriptExportShapeComparisonChange => ({
  ...semantic,
  change_id: `jesc_change_${digestExportShapeValue(semantic)}`,
});

const literalValue = (
  field: Field,
):
  | { readonly found: true; readonly value: Primitive }
  | { readonly found: false } =>
  field.state === "literal" && isPrimitive(field.value)
    ? { found: true, value: field.value }
    : { found: false };

const primitiveArray = (value: unknown): Primitive[] =>
  Array.isArray(value) ? value.filter(isPrimitive) : [];

const isPrimitive = (value: unknown): value is Primitive =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

const capitalize = (value: string): string =>
  `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
