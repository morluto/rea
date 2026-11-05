import { z } from "zod";

import { jsonValueSchema, type JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import { describeValidationFailure } from "../validationFailure.js";

/** The prompt a drafted task carries until its author replaces it. */
export const DRAFT_PROMPT =
  "REPLACE: what the user asks to have done in the app, in their own words.";

const line = z
  .string()
  .refine((value) => !value.includes("\n"), "a line cannot hold a line break");
const lines = z.array(line).min(1).max(100);
const count = z.int().min(0);
const where = z
  .record(z.string().min(1), jsonValueSchema)
  .refine(
    (columns) => Object.keys(columns).length > 0,
    "name at least one column",
  );
const comparison = {
  equals: count.optional(),
  at_least: count.optional(),
  at_most: count.optional(),
};
const table = z.string().min(1);
const wholeText = {
  pointer: z.string(),
  value: z.string(),
  normalize_whitespace: z.boolean().optional(),
};

/** Text with each run of XML whitespace (space, tab, CR, LF) made one space and none at either end, as XPath's normalize-space(). */
export const collapseWhitespace = (text: string): string =>
  text.replace(/[ \t\r\n]+/gu, " ").replace(/^ | $/gu, "");

/** One kind of check: its id, kind and file, then its own fields. */
const kind = <Kind extends string, Shape extends z.ZodRawShape>(
  name: Kind,
  shape: Shape,
) =>
  z.strictObject({
    id: z.string().min(1).max(64).optional(),
    kind: z.literal(name),
    file: z.string().min(1),
    ...shape,
  });

const checkSchema = z.discriminatedUnion("kind", [
  kind("file_present", {}),
  kind("file_absent", {}),
  kind("lines_present", { lines }),
  kind("lines_absent", { lines }),
  kind("line_count", {
    exact: line.optional(),
    contains: line.optional(),
    ...comparison,
  }),
  kind("value_equals", {
    pointer: z.string(),
    value: jsonValueSchema,
    tolerance: z.number().min(0).optional(),
  }),
  kind("value_absent", { pointer: z.string() }),
  kind("text_equals", wholeText),
  kind("text_contains", { ...wholeText, value: z.string().min(1) }),
  kind("row_present", { table, where }),
  kind("row_absent", { table, where }),
  kind("row_count", { table, where: where.optional(), ...comparison }),
]);

/** A task file as an agent writes it: a portable name, a prompt and declarative checks. */
export const desktopTaskSchema = z.strictObject({
  name: z.string().min(1),
  prompt: z.string().trim().min(1),
  checks: z.array(checkSchema).min(1).max(32),
});

/** One check as written, its id optional. */
export type DesktopTaskCheckInput = z.infer<typeof checkSchema>;
/** One check with its id settled. */
export type DesktopTaskCheck = DesktopTaskCheckInput & { readonly id: string };

/** A task whose checks are well formed and have unique ids. */
export interface DesktopTask {
  readonly name: string;
  readonly prompt: string;
  readonly checks: readonly DesktopTaskCheck[];
}

/** A count comparison: exactly one of equals, at_least and at_most. */
export const countComparison = (
  check: Extract<DesktopTaskCheck, { kind: "line_count" | "row_count" }>,
):
  | { readonly operator: "equals" | "at_least" | "at_most"; readonly n: number }
  | undefined => {
  const given = (["equals", "at_least", "at_most"] as const).flatMap(
    (operator) =>
      check[operator] === undefined ? [] : [{ operator, n: check[operator] }],
  );
  return given.length === 1 ? given[0] : undefined;
};

/** Checks that read a view at a JSON pointer. */
export type PointerCheck = Extract<
  DesktopTaskCheck,
  { kind: "value_equals" | "value_absent" | "text_equals" | "text_contains" }
>;

export const isPointerCheck = (
  check: DesktopTaskCheck,
): check is PointerCheck =>
  check.kind === "value_equals" ||
  check.kind === "value_absent" ||
  check.kind === "text_equals" ||
  check.kind === "text_contains";

/** A home-relative path in its one spelling: no leading slash, empty, `.` or `..` segment. */
const isHomePath = (path: string): boolean =>
  path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** Whether a value looks like an ISO 8601 date and time, which the app stamps rather than the user writes. */
export const isTimestamp = (value: JsonValue): boolean =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u.test(
    value.trim(),
  );

/** Expected values a check compares, for the timestamp guard. */
const expectedValues = (check: DesktopTaskCheck): readonly JsonValue[] => {
  switch (check.kind) {
    case "value_equals":
    case "text_equals":
    case "text_contains":
      return [check.value];
    case "row_present":
    case "row_absent":
    case "row_count":
      return Object.values(check.where ?? {});
    default:
      return [];
  }
};

/** What is wrong with a pointer check's pointer, or with what a text check searches for, or undefined. */
const pointerProblem = (check: PointerCheck): string | undefined => {
  if (check.pointer === "")
    return "the empty pointer names the whole file; point at the value that changed";
  if (!check.pointer.startsWith("/"))
    return `pointer ${JSON.stringify(check.pointer)} must start with /`;
  return check.kind === "text_contains" &&
    check.normalize_whitespace === true &&
    collapseWhitespace(check.value) === ""
    ? "text_contains needs a value with more than whitespace in it"
    : undefined;
};

/** What is wrong with one check beyond its shape, or undefined. */
const checkProblem = (check: DesktopTaskCheck): string | undefined => {
  if (!isHomePath(check.file))
    return `file ${JSON.stringify(check.file)} must be a path under the home, such as Documents/todo.txt, without a leading slash, . or .. segments`;
  if (
    check.kind === "line_count" &&
    (check.exact === undefined) === (check.contains === undefined)
  )
    return "line_count takes exactly one of exact and contains";
  if (
    (check.kind === "line_count" || check.kind === "row_count") &&
    countComparison(check) === undefined
  )
    return `${check.kind} takes exactly one of equals, at_least and at_most`;
  const pointed = isPointerCheck(check) ? pointerProblem(check) : undefined;
  if (pointed !== undefined) return pointed;
  if (
    (check.kind === "lines_present" || check.kind === "lines_absent") &&
    new Set(check.lines).size !== check.lines.length
  )
    return "it lists a line twice";
  if (
    check.kind === "value_equals" &&
    check.tolerance !== undefined &&
    typeof check.value !== "number"
  )
    return "tolerance compares numbers, so value must be a number";
  const stamped = expectedValues(check).find(isTimestamp);
  return stamped === undefined
    ? undefined
    : `${JSON.stringify(stamped)} looks like a time the app stamps; leave volatile values out of checks`;
};

/** Parse a task file and settle its check ids, or say what is wrong with it. */
export const parseDesktopTask = (
  value: unknown,
  isPortableName: (name: string) => boolean,
): Result<DesktopTask, string> => {
  const parsed = desktopTaskSchema.safeParse(value);
  if (!parsed.success) return err(describeValidationFailure(parsed.error));
  const { name, prompt, checks } = parsed.data;
  if (!isPortableName(name) || name === "smoke")
    return err(
      `name ${JSON.stringify(name)} must be a portable bundle name other than smoke: lowercase letters, digits and hyphens.`,
    );
  if (prompt.trim() === DRAFT_PROMPT)
    return err(
      "prompt is still the draft's placeholder; write the user's request.",
    );
  const settled = checks.map((check, index) => ({
    ...check,
    id: check.id ?? `check-${String(index + 1)}`,
  }));
  const ids = settled.map((check) => check.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined)
    return err(`two checks have the id ${JSON.stringify(repeated)}.`);
  for (const check of settled) {
    const problem = checkProblem(check);
    if (problem !== undefined)
      return err(`check ${JSON.stringify(check.id)}: ${problem}.`);
  }
  return ok({ name, prompt: prompt.trim(), checks: settled });
};
