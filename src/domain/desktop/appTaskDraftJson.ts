import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import type { FileNote } from "./appTaskDraftFileNotes.js";
import { sameJson } from "./appTaskChecks.js";
import {
  MAX_GUARDS,
  MAX_GUARDS_PER_CHECK,
  MAX_SIBLINGS_READ,
} from "./appTaskDraftGuards.js";
import { isStamp } from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import {
  isRecordIdField,
  KIND_FIELD,
  pairRecordsById,
} from "./jsonRecordPairing.js";
import { pairMembers } from "./memberPairing.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import {
  escapeToken,
  locatePointer as locateView,
  resolvePointer as resolveView,
} from "./viewPointer.js";

const locatePointer = (view: JsonValue | null, pointer: string) =>
  locateView(view, pointer, "json");
const resolvePointer = (view: JsonValue | null, pointer: string) =>
  resolveView(view, pointer, "json");
import { selectorOf, spellCondition } from "./viewSelector.js";

type Suggestion = DesktopTaskCheckInput;

/** Identify only fields the record pairing actually selected as generated ids. */
export const generatedRecordId = (
  ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  },
  format: "json" | "zip",
) => {
  const lists = new Map<
    string,
    | { readonly field: string; readonly generated: ReadonlySet<string> }
    | undefined
  >();
  return (pointer: string): boolean => {
    const segments = pointer.split("/");
    if (segments.length < 3) return false;
    const field = segments.at(-1)?.replaceAll("~1", "/").replaceAll("~0", "~");
    if (field === undefined || !isRecordIdField(field)) return false;
    const member = segments.at(-2)?.replaceAll("~1", "/").replaceAll("~0", "~");
    const list = segments.slice(0, -2).join("/");
    if (!lists.has(list)) {
      const after = resolveView(ends.final, list, format);
      const before = resolveView(ends.baseline, list, format);
      const paired = Array.isArray(after)
        ? pairRecordsById(after, Array.isArray(before) ? before : [])
        : undefined;
      lists.set(
        list,
        paired === undefined
          ? undefined
          : {
              field: paired.idField,
              generated: new Set(
                paired.newer.keys.filter(
                  (_, index) => paired.generated[index] === true,
                ),
              ),
            },
      );
    }
    const paired = lists.get(list);
    if (paired === undefined || field !== paired.field || member === undefined)
      return false;
    return paired.generated.has(member);
  };
};

/** Find the generated record IDs inside added JSON subtrees named by a diff. */
export const generatedIdsInAdditions = (
  ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  },
  format: "json" | "zip",
  pointers: readonly string[],
  isJson: (pointer: string) => boolean,
  generatedId: (pointer: string) => boolean,
): ReadonlySet<string> => {
  const found = new Set<string>();
  const pending: { pointer: string; value: JsonValue }[] = [];
  for (const pointer of pointers) {
    const value = resolveView(ends.final, pointer, format);
    if (value !== undefined && isJson(pointer))
      pending.push({ pointer, value });
  }
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    const { pointer, value } = item;
    if (typeof value === "string" && generatedId(pointer)) found.add(value);
    else if (Array.isArray(value)) {
      const { keys } = pairMembers(value, [], undefined, "json").newer;
      value.forEach((child, index) =>
        pending.push({
          pointer: `${pointer}/${escapeToken(keys[index] ?? String(index))}`,
          value: child,
        }),
      );
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value))
        pending.push({
          pointer: `${pointer}/${escapeToken(key)}`,
          value: child,
        });
    }
  }
  return found;
};

/** Count checks a JSON file's draft suggests, and count guards it offers. */
const MAX_COUNTS = 2;
const MAX_COUNT_GUARDS = 1;
/** Pointers a note lists. */
const MAX_LISTED = 5;

/**
 * The record a pointer reads a field of that the record's selector names it
 * by, where that selector reads a path inside the record, as
 * `/nodes/[format=BOOK][>data~1Title=The Silk Roads]` for its `data/Title`
 * and `format`, which the selector already decides; undefined when it reads none.
 */
const ownNameRecord = (pointer: string): string | undefined => {
  const spelled = pointer.split("/");
  const segments = spelled.map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~"),
  );
  const at = segments.findIndex((segment, index) => {
    const conditions = selectorOf(segment) ?? [];
    const rest = segments.slice(index + 1).join("/");
    return (
      conditions.some(({ prefix }) => prefix === ">") &&
      conditions.some(({ prefix, key }) => prefix !== "@" && key === rest)
    );
  });
  return at === -1 ? undefined : spelled.slice(0, at + 1).join("/");
};

/**
 * The checks without those of a field its record's selector names it by
 * (`ownNameRecord`), but for the first of a record no other check reads, as
 * a new record holding only a generated uid and its title, so its addition
 * is still checked.
 */
export const ownNamesUnreadOtherwise = (
  checks: readonly Suggestion[],
): Suggestion[] => {
  const records = checks.map((check) =>
    "pointer" in check ? ownNameRecord(check.pointer) : undefined,
  );
  const read = new Set<string>();
  const reads = (pointer: string) => {
    const parts = pointer.split("/");
    for (let end = 1; end < parts.length; end += 1)
      read.add(parts.slice(0, end).join("/"));
  };
  const kept = checks.filter((check, index) => {
    if (records[index] !== undefined) return false;
    if ("pointer" in check) reads(check.pointer);
    return true;
  });
  checks.forEach((check, index) => {
    const record = records[index];
    if (record === undefined || read.has(record) || !("pointer" in check))
      return;
    reads(check.pointer);
    kept.push(check);
  });
  return kept;
};

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The array a member pointer sits in, when its parent is one in a view. The empty pointer is the view itself, as a file whose top level is an array. */
const arrayOf = (view: JsonValue | null, pointer: string) => {
  const list = pointer.replace(/\/[^/]+$/u, "");
  if (list === pointer) return undefined;
  const items = list === "" ? view : resolvePointer(view, list);
  return Array.isArray(items) ? list : undefined;
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
  const items = list === "" ? view : resolvePointer(view, list);
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
    const atEnd =
      list === undefined
        ? undefined
        : list === ""
          ? ends.final
          : resolvePointer(ends.final, list);
    if (
      list === undefined ||
      !Array.isArray(atEnd) ||
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
    for (let index = segments.length - 1; index > 0; index -= 1) {
      const list = segments.slice(0, index).join("/");
      const counted = { list };
      if (tried.has(list)) continue;
      tried.add(list);
      const items = list === "" ? ends.final : resolvePointer(ends.final, list);
      if (
        Array.isArray(items) &&
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

type Ends = {
  readonly baseline: JsonValue | null;
  readonly final: JsonValue | null;
};

/** A record added whole that a pointer goes through: the innermost array holding a record on its way, the record's segment and place there, the path into it, and its like records, those of its kind (`kindOf`), at each end. */
interface AddedRecord {
  readonly list: string;
  readonly member: string;
  readonly place: number;
  readonly field: string;
  readonly likes: {
    readonly baseline: readonly JsonValue[];
    readonly final: readonly {
      readonly item: JsonValue;
      readonly place: number;
    }[];
  };
}

/** The record added whole a pointer goes through (`AddedRecord`), when the change lists it among `added`; undefined when the nearest record on the way is kept. */
const addedRecordOf = (
  ends: Ends,
  added: ReadonlySet<string>,
  pointer: string,
): AddedRecord | undefined => {
  const segments = pointer.split("/");
  for (let index = segments.length - 1; index >= 1; index -= 1) {
    const list = segments.slice(0, index).join("/");
    const items = resolvePointer(ends.final, list);
    const member = segments[index] ?? "";
    const record = resolvePointer(ends.final, `${list}/${member}`);
    if (!Array.isArray(items) || !isRecord(record)) continue;
    if (!added.has(`${list}/${member}`)) return undefined;
    const kind = kindOf(record, items);
    const like = (item: JsonValue) =>
      item !== record &&
      isRecord(item) &&
      (kind === undefined || item[kind.key] === kind.value);
    const older = resolvePointer(ends.baseline, list);
    return {
      list,
      member,
      place: items.indexOf(record),
      field: `/${segments.slice(index + 1).join("/")}`,
      likes: {
        baseline: (Array.isArray(older) ? older : []).filter(like),
        final: items.flatMap((item, place) =>
          like(item) ? [{ item, place }] : [],
        ),
      },
    };
  }
  return undefined;
};

/** Whether a field of a record added whole holds what every like record at the end holds there, as the empty `children` of every TreeLine book: a default, not what the user entered. */
export const isLikeDefault = (
  ends: Ends,
  added: ReadonlySet<string>,
  pointer: string,
  value: JsonValue,
): boolean => {
  const record = addedRecordOf(ends, added, pointer);
  return (
    record !== undefined &&
    record.field !== "/" &&
    record.likes.final.length > 0 &&
    record.likes.final.every(({ item }) =>
      sameJson(resolvePointer(item, record.field), value),
    )
  );
};

/** Whether a member's selector reads a field, as `[format=BOOK][>data~1Title=SPQR]` reads `/data/Title`: a guard of it proves only that such a member exists. */
const selectsBy = (member: string, field: string) => {
  const path = field
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .join("/");
  return (selectorOf(member) ?? []).some(
    ({ prefix, key }) => prefix !== "@" && key === path,
  );
};

/** The guard at a field of a like record a pairing names alike at both ends, not by position: its seed value, which the end holds too, and no stamp. */
const recordGuard = (
  file: string,
  ends: Ends,
  member: string,
  field: string,
): Suggestion | undefined => {
  const pointer = `${member}${field}`;
  const [before, after] = [ends.baseline, ends.final].map((view) =>
    locatePointer(view, pointer).byPosition.length === 0
      ? resolvePointer(view, pointer)
      : undefined,
  );
  return before !== undefined &&
    after !== undefined &&
    typeof before !== "object" &&
    sameJson(after, before) &&
    !isStamp(before)
    ? valueEqualsCheck(file, pointer, before)
    : undefined;
};

/**
 * Guards of a record added whole, as XML's: for each `value_equals` through
 * it, its field on up to two like records, nearest first among the
 * `MAX_SIBLINGS_READ` nearest that both ends name alike by selector, at the
 * seed value the end holds too, where like records at the seed hold
 * different values in it and the record's selector does not read it, as
 * TreeLine's `[format=BOOK][>data~1Title=Small Engines of Life]/data/Author`
 * beside a new book's author; at most `MAX_GUARDS` a file, none at a
 * suggested pointer.
 */
export const recordGuards = (
  file: string,
  suggested: readonly Suggestion[],
  ends: Ends,
  added: ReadonlySet<string>,
): Suggestion[] => {
  const taken = new Set(
    suggested.flatMap((check) => ("pointer" in check ? [check.pointer] : [])),
  );
  const pairings = new Map<string, ReturnType<typeof pairMembers>>();
  const pairingOf = (list: string) => {
    const known = pairings.get(list);
    if (known !== undefined) return known;
    const [newer = [], older = []] = [ends.final, ends.baseline].map((view) => {
      const items = resolvePointer(view, list);
      return Array.isArray(items) ? items : [];
    });
    const pairing = pairMembers(newer, older, undefined, "json");
    pairings.set(list, pairing);
    return pairing;
  };
  const guards: Suggestion[] = [];
  for (const check of suggested) {
    if (guards.length >= MAX_GUARDS) break;
    const record =
      check.kind === "value_equals"
        ? addedRecordOf(ends, added, check.pointer)
        : undefined;
    if (
      record === undefined ||
      /^\d+$/u.test(record.member) ||
      record.field === "/" ||
      new Set(
        record.likes.baseline.map((item) =>
          JSON.stringify(resolvePointer(item, record.field) ?? null),
        ),
      ).size < 2
    )
      continue;
    const pairing = pairingOf(record.list);
    const siblings = record.likes.final
      .toSorted(
        (left, right) =>
          Math.abs(left.place - record.place) -
            Math.abs(right.place - record.place) || left.place - right.place,
      )
      .flatMap(({ place }) => {
        const key = pairing.newer.keys[place];
        const partner = pairing.newer.partners[place];
        return key === undefined ||
          /^\d+$/u.test(key) ||
          partner === undefined ||
          pairing.older.keys[partner] !== key ||
          selectsBy(key, record.field)
          ? []
          : [`${record.list}/${escapeToken(key)}`];
      })
      .slice(0, MAX_SIBLINGS_READ);
    let found = 0;
    for (const member of siblings) {
      if (found === MAX_GUARDS_PER_CHECK) break;
      const guard = recordGuard(file, ends, member, record.field);
      if (
        guard === undefined ||
        !("pointer" in guard) ||
        taken.has(guard.pointer)
      )
        continue;
      taken.add(guard.pointer);
      guards.push(guard);
      found += 1;
    }
  }
  return guards.slice(0, MAX_GUARDS);
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
