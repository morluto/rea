import { z } from "zod";
import { androidResultSchemas } from "./androidAnalysis.js";
import {
  androidManifestComponentSchema,
  type AndroidManifestComponent,
} from "./androidManifestComponents.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { digestSchema, prefixedDigestSchema } from "../digests.js";

export type AndroidPackageDeclarations = z.output<
  typeof androidResultSchemas.inspect_android_package
>;

const fieldState = z.enum(["changed", "unchanged", "unknown"]);
const changeState = z.enum([
  "added",
  "removed",
  "changed",
  "unchanged",
  "unknown",
]);
const sideSchema = z.strictObject({
  evidence_id: prefixedDigestSchema("ev"),
  artifact: z.strictObject({ path: z.string(), sha256: digestSchema }),
  input_path: z.string(),
  package_name: z.string().nullable(),
  version_name: z.string().nullable(),
  version_code: z.string().nullable(),
  engine: androidResultSchemas.inspect_android_package.shape.engine,
  manifest_status:
    androidResultSchemas.inspect_android_package.shape.manifest.shape.status,
  components_status:
    androidResultSchemas.inspect_android_package.shape.components.shape.status,
  limitations: z.array(z.string()),
});
const sdkChangeSchema = z.strictObject({
  left: z.string().nullable(),
  right: z.string().nullable(),
  state: fieldState,
});
/** Exact source coordinates and compared facts, without unrelated manifest details. */
const occurrenceSchema = androidManifestComponentSchema
  .pick({
    kind: true,
    name: true,
    declared_name: true,
    declaration_index: true,
    location: true,
    declaration_coverage: true,
    exported: true,
    exported_default: true,
    permission: true,
    permission_source: true,
    authorities: true,
  })
  .extend({ source_index: z.int().nonnegative() });
export const androidDeclarationComparisonSchema = z.strictObject({
  left: sideSchema,
  right: sideSchema,
  sdk: z.strictObject({
    min_sdk: sdkChangeSchema,
    target_sdk: sdkChangeSchema,
  }),
  permissions: z.strictObject({
    coverage: z.literal("unknown"),
    left: z.array(z.string()),
    right: z.array(z.string()),
    observed_only_left: z.array(z.string()),
    observed_only_right: z.array(z.string()),
    observed_both: z.array(z.string()),
  }),
  components: z.strictObject({
    coverage: z.enum(["complete-within-inputs", "partial", "unknown"]),
    changes: z.array(
      z.strictObject({
        kind: androidManifestComponentSchema.shape.kind,
        name: z.string(),
        state: changeState,
        left: z.array(occurrenceSchema),
        right: z.array(occurrenceSchema),
        fields: z
          .strictObject({
            exported: fieldState,
            permission: fieldState,
            authorities: fieldState,
          })
          .nullable(),
        reason: z.string().nullable(),
      }),
    ),
    summary: z.strictObject({
      added: z.int().nonnegative(),
      removed: z.int().nonnegative(),
      changed: z.int().nonnegative(),
      unchanged: z.int().nonnegative(),
      unknown: z.int().nonnegative(),
    }),
  }),
  limitations: z.array(z.string()),
});
export type AndroidDeclarationComparison = z.output<
  typeof androidDeclarationComparisonSchema
>;
type Occurrence = z.output<typeof occurrenceSchema>;
type FieldState = z.output<typeof fieldState>;

/** Shared projection for comparison and admission; unrelated facets stay borrowed. */
export const androidDeclarationOccurrence = (
  item: AndroidManifestComponent,
  source_index: number,
): Occurrence => ({
  source_index,
  kind: item.kind,
  name: item.name,
  declared_name: item.declared_name,
  declaration_index: item.declaration_index,
  location: item.location,
  declaration_coverage: item.declaration_coverage,
  exported: item.exported,
  exported_default: item.exported_default,
  permission: item.permission,
  permission_source: item.permission_source,
  authorities: item.authorities,
});

export const ANDROID_DECLARATION_COMPARISON_REASONS = {
  duplicate:
    "Duplicate kind/name declarations cannot be paired; all occurrences are retained.",
  inventory:
    "Incomplete component inventories cannot establish per-key uniqueness or absence.",
  declaration:
    "A retained declaration is partial; compared attributes or identity may be unresolved.",
  attribute:
    "At least one compared attribute is unknown; unchanged fields do not establish unchanged effective access.",
} as const;

export const ANDROID_DECLARATION_COMPARISON_LIMITATIONS = [
  "Only retained SDK, permission-list and selected component declaration facts are compared; unchanged does not cover other manifest attributes or runtime/installation behavior.",
  "Component changes omit unchanged groups; summary counts include them. Exact complete source records remain available by evidence_id.",
  "Permission-list coverage is not declared by inspect_android_package. observed_only_left/right/both compare distinct retained names, not duplicate counts, complete permission declarations or established additions/removals.",
  "Components match only by unique kind and producer-resolved name within complete inventories. No rename or cross-package correspondence is inferred.",
  "Exported declarations/defaults and permission provenance remain separate facts; authority arrays compare as sets while source spelling and order are retained. No effective access or security classification is inferred.",
  "Null SDK declarations and unresolved attributes remain unknown; comparisons do not infer SDK defaults or order versions.",
] as const;

const sdkChange = (left: string | null, right: string | null) => ({
  left,
  right,
  state:
    left === null || right === null
      ? ("unknown" as const)
      : left === right
        ? ("unchanged" as const)
        : ("changed" as const),
});
const sameSet = (left: readonly string[], right: readonly string[]) => {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
};

/** Compare established declaration and default facts without deriving effective access. */
const exportedState = (left: Occurrence, right: Occurrence): FieldState => {
  // A literal establishes the declaration; a known default beside a null
  // literal preserves the producer's omitted declaration. Null/null remains
  // ambiguous, including unresolved nonliteral declarations.
  const knownDeclaration = (value: Occurrence) =>
    value.exported !== null || value.exported_default !== null;
  const declarationsKnown = knownDeclaration(left) && knownDeclaration(right);
  const defaultsKnown =
    left.exported_default !== null && right.exported_default !== null;
  if (declarationsKnown && left.exported !== right.exported) return "changed";
  if (defaultsKnown && left.exported_default !== right.exported_default)
    return "changed";
  // A known literal must not turn an unknown default into evidence of either
  // difference or equality. A separate established difference still wins.
  return declarationsKnown && defaultsKnown ? "unchanged" : "unknown";
};
const permissionState = (left: Occurrence, right: Occurrence): FieldState => {
  if (
    left.permission_source === "unknown" ||
    right.permission_source === "unknown"
  )
    return "unknown";
  return left.permission === right.permission &&
    left.permission_source === right.permission_source
    ? "unchanged"
    : "changed";
};
const authoritiesState = (left: Occurrence, right: Occurrence): FieldState => {
  // Authorities do not apply to non-provider declarations. A provider's null
  // value is not an observed empty set and cannot establish unchanged access.
  if (left.kind !== "provider") return "unchanged";
  if (left.authorities === null || right.authorities === null) return "unknown";
  return sameSet(left.authorities, right.authorities) ? "unchanged" : "changed";
};

/** No XML, defaults, name resolution or runtime policy is interpreted here. */
export const compareAndroidDeclarationFacts = (
  left: AndroidPackageDeclarations,
  right: AndroidPackageDeclarations,
): Pick<
  AndroidDeclarationComparison,
  "sdk" | "permissions" | "components" | "limitations"
> => {
  const groups = new Map<
    string,
    {
      kind: Occurrence["kind"];
      name: string;
      left: Occurrence[];
      right: Occurrence[];
    }
  >();
  for (const [side, report] of [
    ["left", left],
    ["right", right],
  ] as const) {
    for (const [source_index, item] of report.components.items.entries()) {
      const key = JSON.stringify([item.kind, item.name]);
      let group = groups.get(key);
      if (group === undefined) {
        group = { kind: item.kind, name: item.name, left: [], right: [] };
        groups.set(key, group);
      }
      group[side].push(androidDeclarationOccurrence(item, source_index));
    }
  }
  const complete =
    left.components.status === "complete" &&
    right.components.status === "complete";
  const summary = {
    added: 0,
    removed: 0,
    changed: 0,
    unchanged: 0,
    unknown: 0,
  };
  const changes: AndroidDeclarationComparison["components"]["changes"] = [];
  let hasUnknownAttributes = false;
  for (const group of groups.values()) {
    const l = group.left[0];
    const r = group.right[0];
    let state: keyof typeof summary;
    let reason: string | null = null;
    let fields: AndroidDeclarationComparison["components"]["changes"][number]["fields"] =
      null;
    if (group.left.length > 1 || group.right.length > 1) {
      state = "unknown";
      reason = ANDROID_DECLARATION_COMPARISON_REASONS.duplicate;
    } else if (!complete) {
      state = "unknown";
      reason = ANDROID_DECLARATION_COMPARISON_REASONS.inventory;
    } else if (
      [l, r].some(
        (item) =>
          item !== undefined && item.declaration_coverage !== "complete",
      )
    ) {
      state = "unknown";
      reason = ANDROID_DECLARATION_COMPARISON_REASONS.declaration;
    } else if (l === undefined) state = "added";
    else if (r === undefined) state = "removed";
    else {
      fields = {
        exported: exportedState(l, r),
        permission: permissionState(l, r),
        authorities: authoritiesState(l, r),
      };
      const states = Object.values(fields);
      const unresolvedAttributes =
        states.includes("unknown") ||
        l.exported_default === null ||
        r.exported_default === null;
      state = states.includes("changed")
        ? "changed"
        : states.includes("unknown")
          ? "unknown"
          : "unchanged";
      if (unresolvedAttributes) {
        hasUnknownAttributes = true;
        reason = ANDROID_DECLARATION_COMPARISON_REASONS.attribute;
      }
    }
    summary[state]++;
    if (state !== "unchanged")
      changes.push({ ...group, state, fields, reason });
  }
  changes.sort(
    (a, b) =>
      compareUnicodeCodePoints(a.kind, b.kind) ||
      compareUnicodeCodePoints(a.name, b.name),
  );
  const sorted = (values: Iterable<string>) =>
    [...new Set(values)].sort(compareUnicodeCodePoints);
  const a = new Set(left.permissions);
  const b = new Set(right.permissions);
  return {
    sdk: {
      min_sdk: sdkChange(left.min_sdk, right.min_sdk),
      target_sdk: sdkChange(left.target_sdk, right.target_sdk),
    },
    permissions: {
      coverage: "unknown",
      left: left.permissions,
      right: right.permissions,
      observed_only_left: sorted([...a].filter((value) => !b.has(value))),
      observed_only_right: sorted([...b].filter((value) => !a.has(value))),
      observed_both: sorted([...a].filter((value) => b.has(value))),
    },
    components: {
      coverage:
        left.components.status === "unavailable" ||
        right.components.status === "unavailable"
          ? "unknown"
          : complete && summary.unknown === 0 && !hasUnknownAttributes
            ? "complete-within-inputs"
            : "partial",
      changes,
      summary,
    },
    limitations: [...ANDROID_DECLARATION_COMPARISON_LIMITATIONS],
  };
};
