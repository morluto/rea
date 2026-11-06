import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import type { FileNote } from "./appTaskDraftFileNotes.js";
import { sameJson } from "./appTaskChecks.js";
import { KIND_FIELD } from "./jsonRecordPairing.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { locatePointer, resolvePointer } from "./viewPointer.js";
import { selectorOf, spellCondition } from "./viewSelector.js";

type Suggestion = DesktopTaskCheckInput;

/** Count checks a JSON file's draft suggests, and count guards it offers. */
const MAX_COUNTS = 2;
const MAX_COUNT_GUARDS = 1;
/** Pointers a note lists. */
const MAX_LISTED = 5;

/**
 * Whether a pointer reads a field its record's selector names it by, where
 * that selector reads a path inside the record, as the `data/Title` and
 * `format` of `/nodes/[format=BOOK][>data~1Title=The Silk Roads]`, which
 * the selector already decides.
 */
export const readsOwnName = (pointer: string): boolean => {
  const segments = pointer
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  return segments.some((segment, index) => {
    const conditions = selectorOf(segment) ?? [];
    const rest = segments.slice(index + 1).join("/");
    return (
      conditions.some(({ prefix }) => prefix === ">") &&
      conditions.some(({ prefix, key }) => prefix !== "@" && key === rest)
    );
  });
};

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The array a member pointer sits in, when its parent is one in a view. */
const arrayOf = (view: JsonValue | null, pointer: string) => {
  const list = pointer.replace(/\/[^/]+$/u, "");
  return list !== pointer && Array.isArray(resolvePointer(view, list))
    ? list
    : undefined;
};

/** A counted array, and the kind field and value its counted members share, when they carry one. */
interface Counted {
  readonly list: string;
  readonly kind?: { readonly key: string; readonly value: string };
}

/** The kind a member names, as `format="BOOK"`, when its array's records share the field with more than one value. */
const kindOf = (member: JsonValue | undefined, items: readonly JsonValue[]) => {
  if (!isRecord(member)) return undefined;
  const key = Object.keys(member).find((field) => KIND_FIELD.test(field));
  const value = key === undefined ? undefined : member[key];
  return key === undefined ||
    typeof value !== "string" ||
    value.includes("][") ||
    !items.every((item) => isRecord(item) && typeof item[key] === "string")
    ? undefined
    : { key, value };
};

const membersOf = (view: JsonValue | null, { list, kind }: Counted) => {
  const items = resolvePointer(view, list);
  return (Array.isArray(items) ? items : []).filter(
    (item) =>
      kind === undefined || (isRecord(item) && item[kind.key] === kind.value),
  );
};

const countOf = (
  file: string,
  counted: Counted,
  view: JsonValue | null,
): Suggestion => ({
  kind: "member_count",
  file,
  pointer: counted.list,
  ...(counted.kind === undefined
    ? {}
    : { matching: spellCondition({ prefix: "", ...counted.kind }) }),
  equals: membersOf(view, counted).length,
});

/**
 * `member_count` checks and guards of a JSON file's arrays, as for XML:
 * where members were added or removed, a check that the array holds the
 * end's number, of the members' kind where records share a kind field, as
 * TreeLine's `/nodes` matching `[format=BOOK]`, at most two, the
 * shallowest first; where members were only edited, a guard that the
 * innermost array an edit goes through holds as many as it did, at most one.
 * Never through a step by position.
 */
export const jsonCounts = (
  file: string,
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
  ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  },
): { readonly checks: Suggestion[]; readonly guards: Suggestion[] } => {
  const named = (list: string, view: JsonValue | null) =>
    locatePointer(view, list).byPosition.length === 0;
  const lists = new Map<string, Counted>();
  const note = (pointer: string, view: JsonValue | null) => {
    const list = arrayOf(view, pointer);
    const items = list === undefined ? [] : resolvePointer(view, list);
    if (
      list === undefined ||
      !named(list, ends.baseline) ||
      !named(list, ends.final)
    )
      return;
    const kind = kindOf(
      resolvePointer(view, pointer),
      Array.isArray(items) ? items : [],
    );
    const counted = { list, ...(kind && { kind }) };
    lists.set(JSON.stringify(counted), counted);
  };
  for (const pointer of change.added) note(pointer, ends.final);
  for (const pointer of change.removed) note(pointer, ends.baseline);
  const depth = ({ list }: Counted) => list.split("/").length;
  const checks = [...lists.values()]
    .toSorted((left, right) => depth(left) - depth(right))
    .filter((counted) => {
      const [seed, end] = [ends.baseline, ends.final].map(
        (view) => membersOf(view, counted).length,
      );
      // A lone member makes no list.
      return seed !== end && Math.max(seed ?? 0, end ?? 0) > 1;
    })
    .map((counted) => countOf(file, counted, ends.final))
    .slice(0, MAX_COUNTS);
  // Edits stop at the first guard, and each list is read once, however many records they touch.
  const guards: Suggestion[] = [];
  const tried = new Set<string>();
  for (const pointer of change.changed) {
    const segments = pointer.split("/");
    for (let index = segments.length - 1; index > 1; index -= 1) {
      const list = segments.slice(0, index).join("/");
      const counted = { list };
      if (tried.has(list)) continue;
      tried.add(list);
      if (
        Array.isArray(resolvePointer(ends.final, list)) &&
        !lists.has(JSON.stringify(counted)) &&
        named(list, ends.baseline) &&
        named(list, ends.final) &&
        membersOf(ends.baseline, counted).length > 1 &&
        membersOf(ends.baseline, counted).length ===
          membersOf(ends.final, counted).length
      ) {
        guards.push(countOf(file, counted, ends.baseline));
        break;
      }
    }
    if (guards.length === MAX_COUNT_GUARDS) break;
  }
  return { checks, guards };
};

/** Pointers without a listed ancestor: a record removed whole is checked gone by its own pointer. */
export const outermost = (pointers: readonly string[]): readonly string[] =>
  pointers.filter(
    (pointer) => !pointers.some((other) => pointer.startsWith(`${other}/`)),
  );

/** The checks that tell a file's ends apart: none the seed already passes, nor an absence the end fills, as a place by position another record took. */
export const decisive = (
  suggestions: readonly Suggestion[],
  ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  },
): Suggestion[] =>
  suggestions.filter((check) =>
    check.kind === "value_equals"
      ? !sameJson(resolvePointer(ends.baseline, check.pointer), check.value)
      : check.kind !== "value_absent" ||
        locatePointer(ends.final, check.pointer).kind === "none",
  );

/** A `by_position` note on a JSON file's suggestions that reach their value only by position, as a record nothing names: another save may order the array otherwise. */
export const positionalNotes = (
  file: string,
  suggestions: readonly Suggestion[],
  view: JsonValue | null,
): FileNote[] => {
  const pointers = suggestions.flatMap((check) =>
    "pointer" in check &&
    locatePointer(view, check.pointer).byPosition.length > 0
      ? [check.pointer]
      : [],
  );
  return pointers.length === 0
    ? []
    : [
        {
          code: "by_position",
          file,
          message: `${String(pointers.length)} suggested check(s) of ~/${file} reach their value only by position, as nothing names the record they read: another save may order its array otherwise, so check the record by a value another way, such as a count.`,
          pointers: pointers.slice(0, MAX_LISTED),
        },
      ];
};
