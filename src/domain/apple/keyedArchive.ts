import { z } from "zod";
import { AnalysisInputError } from "../analysisErrorCore.js";
import { jsonValueSchema, type JsonValue } from "../jsonValue.js";

/** Select one archive within the active bundle and optionally one named root. */
export const keyedArchiveInputSchema = z.strictObject({
  path: z.string().min(1).default("."),
  root: z.string().optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(20_000).default(20_000),
});
const linkSchema = z.strictObject({
  source: z.number().int().nonnegative().nullable(),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  target: z.number().int().nonnegative().nullable(),
  status: z.enum(["resolved", "nil", "unresolved", "malformed"]),
  raw: jsonValueSchema,
});
/** Archive object identity is its original $objects index, never a recursive copy. */
export const keyedArchiveResultSchema = z.strictObject({
  target_sha256: z.string(),
  archive_path: z.string(),
  archive_sha256: z.string(),
  archive_format: z.enum(["binary-plist", "xml-plist"]),
  roots: z.record(z.string(), jsonValueSchema),
  objects: z.array(
    z.strictObject({
      id: z.number().int().nonnegative(),
      kind: z.enum([
        "nil",
        "scalar",
        "array",
        "dictionary",
        "class-descriptor",
        "archived-object",
      ]),
      class_id: z.number().int().nonnegative().nullable(),
      class_name: z.string().nullable(),
      status: z.enum(["observed", "unknown-class", "unresolved-class", "nil"]),
      value: jsonValueSchema,
    }),
  ),
  references: z.array(linkSchema),
  total_objects: z.number().int().nonnegative(),
  total_references: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});

const record = (
  value: JsonValue | undefined,
): Record<string, JsonValue> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
/**
 * A UID decodes as a one-key `UID` (binary) or `CF$UID` (XML) dictionary with
 * a numeric value. Any other value means an ordinary dictionary, such as a
 * `$top` that holds a root encoded under the key `UID`.
 */
const uid = (value: JsonValue | undefined): number | undefined => {
  const object = record(value);
  if (object === undefined || Object.keys(object).length !== 1)
    return undefined;
  const marker = Object.hasOwn(object, "UID") ? object.UID : object["CF$UID"];
  return typeof marker === "number" ? marker : undefined;
};

/** Interpret serialized Foundation references without instantiating archive classes. */
export const projectKeyedArchive = (
  value: unknown,
  selection: { root?: string | undefined; offset: number; limit: number },
) => {
  const archive = record(jsonValueSchema.parse(value));
  if (
    archive?.$archiver !== "NSKeyedArchiver" ||
    !Array.isArray(archive.$objects)
  )
    throw new TypeError("Expected NSKeyedArchiver with an $objects array");
  const table = archive.$objects;
  if (table.length > 200_000)
    throw new RangeError("Archive exceeds 200000 object-table entries");
  const top = record(archive.$top);
  if (top === undefined || Object.keys(top).length === 0)
    throw new TypeError("Keyed archive has no $top roots");
  if (selection.root !== undefined && !Object.hasOwn(top, selection.root))
    throw new AnalysisInputError("inspect_keyed_archive", undefined, [
      {
        path: ["root"],
        reason: "invalid_value",
        message: `Archive root does not exist: ${selection.root}. Select one of the archive's $top roots or omit root.`,
        expected: Object.keys(top),
      },
    ]);
  const roots =
    selection.root === undefined
      ? top
      : { [selection.root]: top[selection.root] ?? null };
  const references: z.infer<typeof linkSchema>[] = [];
  const scan = (source: number | null, initial: JsonValue) => {
    const pending: { value: JsonValue; path: (string | number)[] }[] = [
      { value: initial, path: [] },
    ];
    let visited = 0;
    while (pending.length > 0) {
      const item = pending.pop();
      if (item === undefined) break;
      if (++visited > 200_000 || item.path.length > 128)
        throw new RangeError(
          "Archive exceeds 200000 values per object or 128 nesting levels",
        );
      const target = uid(item.value);
      if (target !== undefined) {
        const index =
          Number.isSafeInteger(target) && target >= 0 ? target : null;
        references.push({
          source,
          path: item.path,
          target: index,
          raw: item.value,
          status:
            index === null
              ? "malformed"
              : index >= table.length
                ? "unresolved"
                : index === 0 && table[0] === "$null"
                  ? "nil"
                  : "resolved",
        });
      } else if (Array.isArray(item.value)) {
        for (let index = item.value.length - 1; index >= 0; index--) {
          const child = item.value[index];
          if (child !== undefined)
            pending.push({ value: child, path: [...item.path, index] });
        }
      } else {
        const fields = record(item.value);
        if (fields !== undefined)
          for (const key of Object.keys(fields).sort().reverse()) {
            const child = fields[key];
            if (child !== undefined)
              pending.push({ value: child, path: [...item.path, key] });
          }
      }
      if (references.length > 200_000)
        throw new RangeError("Archive exceeds 200000 reference edges");
    }
  };
  scan(null, roots);
  const objects = table.map((value, id) => {
    scan(id, value);
    const fields = record(value);
    const classUid = uid(fields?.$class);
    const classId =
      classUid !== undefined && Number.isSafeInteger(classUid) && classUid >= 0
        ? classUid
        : null;
    const descriptor = classId === null ? undefined : record(table[classId]);
    const className =
      typeof descriptor?.$classname === "string" ? descriptor.$classname : null;
    const isNil = id === 0 && value === "$null";
    return {
      id,
      kind: isNil
        ? ("nil" as const)
        : Array.isArray(value)
          ? ("array" as const)
          : fields === undefined
            ? ("scalar" as const)
            : typeof fields.$classname === "string"
              ? ("class-descriptor" as const)
              : Object.hasOwn(fields, "$class")
                ? ("archived-object" as const)
                : ("dictionary" as const),
      class_id: classId,
      class_name: className,
      status: isNil
        ? ("nil" as const)
        : fields !== undefined && Object.hasOwn(fields, "$class")
          ? className === null
            ? ("unresolved-class" as const)
            : ("unknown-class" as const)
          : ("observed" as const),
      value,
    };
  });
  const end = Math.min(objects.length, selection.offset + selection.limit);
  const page = objects.slice(selection.offset, end);
  const ids = new Set(page.map(({ id }) => id));
  return {
    roots,
    objects: page,
    references: references.filter(
      ({ source }) => source === null || ids.has(source),
    ),
    total_objects: objects.length,
    total_references: references.length,
    offset: selection.offset,
    next_offset: end < objects.length ? end : null,
    truncated: page.length !== objects.length,
    limitations: [
      "Archive classes are never instantiated. Class names and serialized fields are observed; class-specific semantics are unknown.",
      "Conditional references serialized as UID 0 cannot be distinguished from ordinary nil references. Missing fields remain absent in the raw serialized value.",
      "Root selection selects the named $top entry; object pagination retains original indices and does not recursively expand references.",
    ],
  };
};
