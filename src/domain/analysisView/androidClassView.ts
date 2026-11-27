import { z } from "zod";

import { androidResultSchemas } from "../android/androidAnalysis.js";
import { androidClassViewRequestSchema } from "../android/androidClassQuery.js";
import { evidenceSubjectTarget } from "../evidence.js";
import { boundedList } from "../boundedList.js";
import { err, ok, type Result } from "../result.js";
import { filterSet } from "./selectViewRows.js";
import {
  analysisViewInputError,
  invalidAnalysisViewSubject,
} from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewLimitations,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  assertOwnedView,
  type AdmittedView,
  type SummaryAnalysisView,
} from "./analysisViewShape.js";
import type { JsonValue } from "../jsonValue.js";
import {
  PLACEHOLDER_COVERAGE,
  selectByteBoundedViewRows,
  type ByteBoundedPageOwner,
  type ByteBoundedRows,
} from "./byteBoundedViewRows.js";

export const INSPECT_ANDROID_CLASS_OPERATION = "inspect_android_class" as const;

const classSchema = androidResultSchemas.inspect_android_class;
type AndroidClass = z.output<typeof classSchema>;
type ClassView = z.output<typeof androidClassViewRequestSchema>;
const shape = classSchema.shape;
const mappingSchema = shape.mapping.unwrap();

/** Overloaded method names listed in a summary, most overloads first. */
const SUMMARY_OVERLOADED_NAMES = 64;

const count = z.int().nonnegative();

/** The class's identity and counts, with its member lists paged separately. */
export const androidClassSummarySchema = z.strictObject({
  engine: shape.engine,
  class_name: shape.class_name,
  counts: z.strictObject({
    methods: count,
    constructors: count,
    overloaded_method_names: count,
    fields: count,
    static_values: count,
    inner_classes: count,
  }),
  overloaded_methods: z
    .strictObject({
      items: z.array(z.strictObject({ name: z.string(), overloads: count })),
      omitted: count,
    })
    .describe(
      `Method names declared more than once, most overloads first, at most ${String(SUMMARY_OVERLOADED_NAMES)}; omitted counts the rest`,
    ),
  mapping: mappingSchema
    .omit({ symbols: true })
    .extend({ symbols: count })
    .exactOptional()
    .describe(
      "The caller-selected mapping's identity and record counts; page its symbols with facet mapping-symbols",
    ),
});

/** One declared method with its position among the class's methods. */
export const androidClassMethodRowSchema = shape.methods.element.extend({
  index: count,
});
/** One declared field with its position among the class's fields. */
export const androidClassFieldRowSchema = shape.fields.element.extend({
  index: count,
});
export const androidClassMappingSymbolRowSchema =
  mappingSchema.shape.symbols.element;

const readClass = createAnalysisViewResultReader(classSchema);

const compare = ([a, x]: [string, number], [b, y]: [string, number]) =>
  y - x || (a < b ? -1 : a > b ? 1 : 0);

const summarize = (
  value: AndroidClass,
): z.output<typeof androidClassSummarySchema> => {
  const overloads = new Map<string, number>();
  let constructors = 0;
  let staticValues = 0;
  for (const field of value.fields)
    if (field.dex_static_value !== null) staticValues++;
  for (const method of value.methods) {
    overloads.set(method.name, (overloads.get(method.name) ?? 0) + 1);
    if (method.is_constructor) constructors++;
  }
  const overloaded = [...overloads].filter(([, n]) => n > 1).sort(compare);
  const { mapping } = value;
  const listed = boundedList(
    overloaded.map(([name, n]) => ({ name, overloads: n })),
    SUMMARY_OVERLOADED_NAMES,
  );
  return {
    engine: value.engine,
    class_name: value.class_name,
    counts: {
      methods: value.methods.length,
      constructors,
      overloaded_method_names: overloaded.length,
      fields: value.fields.length,
      static_values: staticValues,
      inner_classes: value.inner_classes.length,
    },
    overloaded_methods: { items: [...listed.items], omitted: listed.omitted },
    ...(mapping === undefined
      ? {}
      : {
          mapping: (({ symbols, ...facts }) => ({
            ...facts,
            symbols: symbols.length,
          }))(mapping),
        }),
  };
};

/** A name filter over exact names and prefixes; undefined when unfiltered. */
const nameFilter = (
  names: readonly string[] | undefined,
  prefixes: readonly string[] | undefined,
) => {
  if (names === undefined && prefixes === undefined) return undefined;
  const exact = filterSet(names);
  return (name: string) =>
    (exact === undefined || exact.has(name)) &&
    (prefixes === undefined ||
      prefixes.some((prefix) => name.startsWith(prefix)));
};

const both = <Row>(
  first: ((row: Row) => boolean) | undefined,
  second: ((row: Row) => boolean) | undefined,
) =>
  first === undefined
    ? second
    : second === undefined
      ? first
      : (row: Row) => first(row) && second(row);

const memberPage = <View extends ClassView, Row, E>(
  view: View,
  selected: Result<ByteBoundedRows<Row>, E>,
) => {
  if (!selected.ok) return selected;
  const { rows, total, byte_limited } = selected.value;
  return ok({
    view,
    items: rows,
    byte_limited,
    coverage: pageViewCoverage(view.offset, rows.length, total),
  });
};

/** One page of the selected member facet, with the total that match. */
const selectMembers = (
  value: AndroidClass,
  view: ClassView,
  owner: ByteBoundedPageOwner,
) => {
  switch (view.facet) {
    case "methods": {
      const name = nameFilter(view.names, view.name_prefixes);
      const constructors = view.constructors;
      const rows = selectByteBoundedViewRows<
        AndroidClass["methods"][number],
        z.output<typeof androidClassMethodRowSchema>
      >(
        value.methods,
        view,
        {
          matches: both<AndroidClass["methods"][number]>(
            name === undefined ? undefined : (row) => name(row.name),
            constructors === undefined
              ? undefined
              : (row) => row.is_constructor === constructors,
          ),
          project: (row, index) => ({ ...row, index }),
        },
        owner,
      );
      return memberPage(view, rows);
    }
    case "fields": {
      const name = nameFilter(view.names, view.name_prefixes);
      const statics = view.static_values;
      const rows = selectByteBoundedViewRows<
        AndroidClass["fields"][number],
        z.output<typeof androidClassFieldRowSchema>
      >(
        value.fields,
        view,
        {
          matches: both<AndroidClass["fields"][number]>(
            name === undefined ? undefined : (row) => name(row.name),
            statics === undefined
              ? undefined
              : (row) => (row.dex_static_value !== null) === statics,
          ),
          project: (row, index) => ({ ...row, index }),
        },
        owner,
      );
      return memberPage(view, rows);
    }
    case "inner-classes": {
      const rows = selectByteBoundedViewRows(
        value.inner_classes,
        view,
        { matches: undefined, project: (row) => row },
        owner,
      );
      return memberPage(view, rows);
    }
    case "mapping-symbols": {
      if (value.mapping === undefined)
        return err(
          analysisViewInputError([
            {
              path: ["view", "facet"],
              reason: "invalid_value",
              message:
                "This inspection selected no mapping; pass mapping_path to inspect_android_class first.",
            },
          ]),
        );
      const rows = selectByteBoundedViewRows(
        value.mapping.symbols,
        view,
        { matches: undefined, project: (row) => row },
        owner,
      );
      return memberPage(view, rows);
    }
  }
};

/** Project a retained class inspection's summary or one member page. */
export const projectAndroidClassView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  if (admitted.kind !== "android-class" && admitted.kind !== "summary")
    return err(
      analysisViewInputError([
        {
          path: ["view", "kind"],
          reason: "invalid_value",
          message: "Select an android-class or summary view.",
        },
      ]),
    );
  assertOwnedView<SummaryAnalysisView | ClassView>(
    admitted,
    "summary",
    "android-class",
  );
  const parsed = readClass(parent);
  if (!parsed.ok) return parsed;
  // The engine artifact digest is the JAR; it cannot identify the APK.
  const subject = evidenceSubjectTarget(parent.subject);
  if (subject === undefined)
    return invalidAnalysisViewSubject(
      "Android class views require the recorded APK subject identity.",
    );
  const value = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: INSPECT_ANDROID_CLASS_OPERATION,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: subject.path, sha256: subject.sha256 },
    limitations: boundedViewLimitations(parent),
    unknowns: [
      "Static class and method analysis does not establish runtime behavior or APK authenticity.",
    ],
  };
  if (admitted.kind === "summary")
    return ok({
      ...shared,
      kind: "summary" as const,
      view: admitted,
      summary: summarize(value),
      coverage: completeWithinViewCoverage(1),
    });
  const view = admitted;
  const context = {
    ...shared,
    kind: "android-class" as const,
    view,
    class_name: value.class_name,
  };
  const page = selectMembers(value, view, {
    parentEvidenceId: parent.evidenceId,
    envelope: {
      ...context,
      items: [],
      byte_limited: false,
      coverage: PLACEHOLDER_COVERAGE,
    } as unknown as JsonValue,
    facet: view.facet,
  });
  return page.ok ? ok({ ...context, ...page.value }) : page;
};
