import { isPortableBundleName } from "../portableBundleName.js";
import { z } from "zod";

import { jsonRecordSchema } from "../jsonRecord.js";
import { jsonValueSchema, type JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import { describeValidationFailure } from "../validationFailure.js";
import { selectorOf } from "./viewSelector.js";

/** The prompt a drafted task carries until its author replaces it. */
export const DRAFT_PROMPT =
  "REPLACE: what the user asks to have done in the app, in their own words.";

const line = z
  .string()
  .refine((value) => !value.includes("\n"), "a line cannot hold a line break");
const lines = z.array(line).min(1).max(100);
const count = z.int().min(0);
const where = jsonRecordSchema(jsonValueSchema, z.string().min(1)).refine(
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
  text_attribute: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Read the element's text from this attribute's values on it and its descendants, in document order, instead of from its text nodes.",
    ),
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

/** What a reader's argv or stdin names the file by: the path of a private copy of it. */
export const READER_FILE_PLACEHOLDER = "{file}";

const readerField = {
  reader: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The id of one of the task's readers: the check reads that reader's view of its file instead of the file's own. Give the reader's file as file.",
    ),
};

const checkSchema = z.discriminatedUnion("kind", [
  kind("file_present", {}),
  kind("file_absent", {}),
  kind("lines_present", { lines, ...readerField }),
  kind("lines_absent", { lines, ...readerField }),
  kind("line_count", {
    exact: line.optional(),
    contains: line.optional(),
    ...comparison,
    ...readerField,
  }),
  kind("value_equals", {
    pointer: z.string(),
    value: jsonValueSchema,
    tolerance: z.number().min(0).optional(),
    ...readerField,
  }),
  kind("value_absent", { pointer: z.string(), ...readerField }),
  kind("text_equals", wholeText),
  kind("text_contains", { ...wholeText, value: z.string().min(1) }),
  kind("row_present", { table, where }),
  kind("row_absent", { table, where }),
  kind("row_count", { table, where: where.optional(), ...comparison }),
  kind("member_count", {
    pointer: z.string(),
    matching: z
      .string()
      .optional()
      .describe(
        "A selector of one or more [KEY=VALUE], [@KEY=VALUE] or [>PATH=VALUE] conditions that a member must meet to count, where PATH is up to three /-separated steps inside the member. For XML, [>text()=VALUE] compares the member's whole text with whitespace collapsed. Every member counts without a selector, text nodes of an XML element's children included.",
      ),
    ...comparison,
    ...readerField,
  }),
  z.strictObject({
    id: z.string().min(1).max(64).optional(),
    kind: z.literal("screen_judge"),
    question: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe(
        "A yes-or-no question about the app's screen that the task done makes true and the seed makes false, such as Does the display show 8.568?; a model judges it on a screenshot, for state no file shows.",
      ),
  }),
]);

/** How long a reader may run when it does not say, and the most it may ask for. */
export const READER_TIMEOUT_S = { default: 60, max: 300 } as const;

const readerSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
    .describe(
      "Lowercase letters, digits and hyphens; a check names the reader by it.",
    ),
  file: z
    .string()
    .min(1)
    .describe(
      "The file the reader reads, a path under the home such as Documents/poster.xcf.",
    ),
  argv: z
    .array(z.string().min(1))
    .min(1)
    .max(64)
    .describe(
      `The app's own headless command, run in the computer on a private copy of the file that ${READER_FILE_PLACEHOLDER} names, in a fresh home without the display; each line it prints starting with "REA " is a line of its view.`,
    ),
  stdin: z
    .string()
    .max(64 * 1024)
    .optional()
    .describe(
      `Text sent to the command's stdin, where ${READER_FILE_PLACEHOLDER} also names the copy.`,
    ),
  output: z
    .enum(["json", "lines"])
    .describe(
      "json: the marked lines, joined, are one JSON value that value_equals, value_absent and member_count point into; lines: they are the lines lines_present, lines_absent and line_count read.",
    ),
  timeout_s: z
    .int()
    .min(1)
    .max(READER_TIMEOUT_S.max)
    .optional()
    .describe(
      `Seconds the command may run, ${String(READER_TIMEOUT_S.default)} when omitted.`,
    ),
  display: z
    .boolean()
    .optional()
    .describe(
      "Run the command with the desktop's display, for an app without a headless mode; off when omitted.",
    ),
});

/** A task file as an agent writes it: a portable name, a prompt, declarative checks and the readers some read through. */
export const desktopTaskSchema = z.strictObject({
  name: z.string().min(1),
  prompt: z.string().trim().min(1),
  checks: z.array(checkSchema).min(1).max(32),
  readers: z
    .array(readerSchema)
    .min(1)
    .max(8)
    .optional()
    .describe(
      "Commands that read a file REA cannot read itself, such as a binary document, with the app's own headless mode; a check reads one's view by naming it in reader.",
    ),
});

/** One check as written, its id optional. */
export type DesktopTaskCheckInput = z.infer<typeof checkSchema>;
/** One check with its id settled. */
export type DesktopTaskCheck = DesktopTaskCheckInput & { readonly id: string };
/** A command that reads one file with the app's own headless mode, for checks to read its view. */
export type DesktopTaskReader = z.infer<typeof readerSchema>;

/** A task whose checks are well formed and have unique ids, with the readers its checks read through, if any. */
export interface DesktopTask {
  readonly name: string;
  readonly prompt: string;
  readonly checks: readonly DesktopTaskCheck[];
  readonly readers?: readonly DesktopTaskReader[];
}

/** The check kinds each reader output serves. */
const READER_KINDS = {
  json: ["value_equals", "value_absent", "member_count"],
  lines: ["lines_present", "lines_absent", "line_count"],
} as const satisfies Record<
  DesktopTaskReader["output"],
  readonly DesktopTaskCheck["kind"][]
>;

/** Checks that count lines, rows or the members of an array. */
export type CountCheck = Extract<
  DesktopTaskCheck,
  { kind: "line_count" | "row_count" | "member_count" }
>;

/** A count comparison: exactly one of equals, at_least and at_most. */
export const countComparison = (
  check: CountCheck,
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
  {
    kind:
      | "value_equals"
      | "value_absent"
      | "text_equals"
      | "text_contains"
      | "member_count";
  }
>;

export const isPointerCheck = (
  check: DesktopTaskCheck,
): check is PointerCheck =>
  check.kind === "value_equals" ||
  check.kind === "value_absent" ||
  check.kind === "text_equals" ||
  check.kind === "text_contains" ||
  check.kind === "member_count";

/** A home-relative path in its one spelling: no leading slash, empty, `.` or `..` segment. */
const isHomePath = (path: string): boolean =>
  path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** An ISO 8601 date and time. */
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/u;
/** C's `asctime` and `ctime` form, `Www Mmm dd hh:mm:ss yyyy`, the day padded with a space, as AbiWord stamps a save. */
const ASCTIME_TIMESTAMP =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3]?\d \d{2}:\d{2}:\d{2} \d{4}$/u;

/** Whether a value looks like a date and time the app stamps rather than the user writes: ISO 8601, or `asctime`'s form. */
export const isTimestamp = (value: JsonValue): boolean => {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return ISO_TIMESTAMP.test(trimmed) || ASCTIME_TIMESTAMP.test(trimmed);
};

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
  // A count may take a whole file, as a JSON file whose top level is an array.
  if (check.pointer === "")
    return check.kind === "member_count"
      ? undefined
      : "the empty pointer names the whole file; point at the value that changed";
  if (!check.pointer.startsWith("/"))
    return `pointer ${JSON.stringify(check.pointer)} must start with /`;
  return check.kind === "text_contains" &&
    check.normalize_whitespace === true &&
    collapseWhitespace(check.value) === ""
    ? "text_contains needs a value with more than whitespace in it"
    : undefined;
};

/** What is wrong with one check beyond its shape, or undefined. */
const checkProblem = (
  check: Exclude<DesktopTaskCheck, { kind: "screen_judge" }>,
): string | undefined => {
  if (!isHomePath(check.file))
    return `file ${JSON.stringify(check.file)} must be a path under the home, such as Documents/todo.txt, without a leading slash, . or .. segments`;
  if (
    check.kind === "line_count" &&
    (check.exact === undefined) === (check.contains === undefined)
  )
    return "line_count takes exactly one of exact and contains";
  if (
    (check.kind === "line_count" ||
      check.kind === "row_count" ||
      check.kind === "member_count") &&
    countComparison(check) === undefined
  )
    return `${check.kind} takes exactly one of equals, at_least and at_most`;
  const pointed = isPointerCheck(check) ? pointerProblem(check) : undefined;
  if (pointed !== undefined) return pointed;
  if (
    check.kind === "member_count" &&
    check.matching !== undefined &&
    selectorOf(check.matching) === undefined
  )
    return `matching ${JSON.stringify(check.matching)} is not a selector of one or more [KEY=VALUE], [@KEY=VALUE] or [>PATH=VALUE], a PATH of one to three steps`;
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

/** What is wrong with one reader on its own, or undefined. */
const readerProblem = (reader: DesktopTaskReader): string | undefined => {
  if (!isHomePath(reader.file))
    return `file ${JSON.stringify(reader.file)} must be a path under the home, such as Documents/poster.xcf, without a leading slash, . or .. segments`;
  return [...reader.argv, reader.stdin ?? ""].some((part) =>
    part.includes(READER_FILE_PLACEHOLDER),
  )
    ? undefined
    : `its argv and stdin name no ${READER_FILE_PLACEHOLDER}, the copy of ${reader.file} it reads`;
};

/** What is wrong with the readers and the checks that read through them, or undefined. */
const readersProblem = (
  readers: readonly DesktopTaskReader[],
  checks: readonly DesktopTaskCheck[],
): string | undefined => {
  const ids = readers.map((reader) => reader.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined)
    return `two readers have the id ${JSON.stringify(repeated)}.`;
  for (const reader of readers) {
    const problem = readerProblem(reader);
    if (problem !== undefined)
      return `reader ${JSON.stringify(reader.id)}: ${problem}.`;
  }
  for (const check of checks) {
    if (!("reader" in check) || check.reader === undefined) continue;
    const reader = readers.find(({ id }) => id === check.reader);
    if (reader === undefined)
      return `check ${JSON.stringify(check.id)} names reader ${JSON.stringify(check.reader)}, which the task does not define in readers.`;
    if (check.file !== reader.file)
      return `check ${JSON.stringify(check.id)} reads ${reader.id}, so its file is ${reader.file}, not ${check.file}.`;
    const kinds: readonly string[] = READER_KINDS[reader.output];
    if (!kinds.includes(check.kind))
      return `check ${JSON.stringify(check.id)} is ${check.kind}, but reader ${reader.id} reads ${reader.output}, which ${kinds.join(", ").replace(/, (?=[^,]*$)/u, " and ")} check.`;
  }
  const unread = readers.find(
    (reader) =>
      !checks.some((check) => "reader" in check && check.reader === reader.id),
  );
  return unread === undefined
    ? undefined
    : `reader ${JSON.stringify(unread.id)} is read by no check; remove it or name it in a check's reader.`;
};

/** What is wrong with a task's screen judges beside its other checks and readers, or undefined. */
const screenProblem = (
  checks: readonly DesktopTaskCheck[],
  readers: readonly DesktopTaskReader[] | undefined,
): string | undefined => {
  if (!checks.some(({ kind }) => kind === "screen_judge")) return undefined;
  if (checks.some(({ kind }) => kind !== "screen_judge"))
    return "a task with screen_judge checks holds only screen_judge checks: they judge state no file shows, so a change a file shows is checked in that file instead.";
  return readers === undefined
    ? undefined
    : "a task with screen_judge checks takes no readers.";
};

/** Parse a task file and settle its check ids, or say what is wrong with it. */
export const parseDesktopTask = (
  value: unknown,
): Result<DesktopTask, string> => {
  const parsed = desktopTaskSchema.safeParse(value);
  if (!parsed.success) return err(describeValidationFailure(parsed.error));
  const { name, prompt, checks, readers } = parsed.data;
  if (!isPortableBundleName(name) || name === "smoke")
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
    const problem =
      check.kind === "screen_judge" ? undefined : checkProblem(check);
    if (problem !== undefined)
      return err(`check ${JSON.stringify(check.id)}: ${problem}.`);
  }
  const problem =
    screenProblem(settled, readers) ?? readersProblem(readers ?? [], settled);
  if (problem !== undefined) return err(problem);
  return ok({
    name,
    prompt: prompt.trim(),
    checks: settled,
    ...(readers === undefined ? {} : { readers }),
  });
};
