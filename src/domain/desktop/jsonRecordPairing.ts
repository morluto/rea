import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";
import {
  isGeneratedId,
  isNameLikeKey,
  isPlaceholder,
} from "./attributeRank.js";
import { isXmlElement } from "./viewPointer.js";
import { MAX_INSIDE_STEPS, spellCondition } from "./viewSelector.js";

/** A field naming a JSON record, as TreeLine's `uid`: `id`, `uid`, `uuid`, `guid`, `key`, or a name ending in `_id`, `-id` or `Id`. */
const ID_FIELD = /^(?:_?id|uid|uuid|guid|key)$|[_-]id$|[a-z]Id$/u;

/** A field naming what kind of record a member is, as TreeLine's `format="BOOK"`. */
export const KIND_FIELD = /^(?:type|kind|format|category)$/iu;

/** The most name-like fields a record is tried by, and the longest value one names it by. */
const MAX_NAMES = 3;
const MAX_NAME = 64;

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  isRecord(value) && !isXmlElement(value);

/** Whether every member holds a string at a key a selector can carry, each its own. */
const namesEach = (members: readonly JsonValue[], key: string) => {
  const values = members.map((member) =>
    isJsonRecord(member) ? member[key] : undefined,
  );
  return (
    values.every(
      (value) =>
        typeof value === "string" && value !== "" && !value.includes("]["),
    ) && new Set(values).size === values.length
  );
};

/** The string at a path of keys inside a record, as a `>` condition reads a JSON record. */
const stringAt = (record: JsonValue, path: readonly string[]) => {
  let found: JsonValue | undefined = record;
  for (const key of path)
    found =
      isRecord(found) && Object.hasOwn(found, key) ? found[key] : undefined;
  return typeof found === "string" ? found : undefined;
};

/** A value a user gave a record, which another save of the same edit repeats: short, worded, no time or token an app makes. */
const isName = (value: string) =>
  value.length <= MAX_NAME &&
  /[\p{L}\d]/u.test(value) &&
  !value.includes("][") &&
  !isTimestamp(value) &&
  !isGeneratedId(value) &&
  !isPlaceholder(value);

/** The paths of a record's name-like string fields, nearest first, up to `MAX_INSIDE_STEPS` keys deep, as TreeLine's `data/Title`. */
const namePaths = (record: Record<string, JsonValue>) => {
  const found: string[][] = [];
  let level = [{ path: [] as string[], fields: record }];
  for (let depth = 0; depth < MAX_INSIDE_STEPS; depth += 1) {
    const next: typeof level = [];
    for (const { path, fields } of level)
      for (const [key, value] of Object.entries(fields))
        if (key === "" || /[=[\]/]/u.test(key)) continue;
        else if (isRecord(value))
          next.push({ path: [...path, key], fields: value });
        else if (
          typeof value === "string" &&
          isNameLikeKey(key) &&
          isName(value)
        )
          found.push([...path, key]);
    if (found.length >= MAX_NAMES) break;
    level = next;
  }
  return found.slice(0, MAX_NAMES);
};

/** The field a record's kind is kept in, as `format`, when it holds a string a selector can carry. */
const kindOf = (record: Record<string, JsonValue>) =>
  Object.keys(record).find((key) => {
    const value = record[key];
    return (
      KIND_FIELD.test(key) && typeof value === "string" && !value.includes("][")
    );
  });

/** How many of a version's records hold a record's kind and its string at a path, each kind field and path read over the version once. */
const tally = (members: readonly JsonValue[]) => {
  const counted = new Map<string, Map<string, number>>();
  return (kind: string | undefined, path: readonly string[], of: JsonValue) => {
    const held = (member: JsonValue) => {
      const name = stringAt(member, path);
      const sort = kind === undefined ? "" : stringAt(member, [kind]);
      return name === undefined || sort === undefined
        ? undefined
        : `${sort}\u0000${name}`;
    };
    const id = JSON.stringify([kind ?? null, path]);
    let counts = counted.get(id);
    if (counts === undefined) {
      counts = new Map();
      for (const member of members) {
        const at = held(member);
        if (at !== undefined) counts.set(at, (counts.get(at) ?? 0) + 1);
      }
      counted.set(id, counts);
    }
    const at = held(of);
    return at === undefined ? 0 : (counts.get(at) ?? 0);
  };
};

/**
 * The selector naming a record only one version holds by its kind and its
 * first name-like field that names it alone there and nothing in the other
 * version, as TreeLine's new book by `[format=BOOK][>data/Title=The Silk Roads]`;
 * undefined when none does.
 */
const nameOf = (
  record: JsonValue,
  here: ReturnType<typeof tally>,
  there: ReturnType<typeof tally>,
) => {
  if (!isRecord(record)) return undefined;
  const kind = kindOf(record);
  const path = namePaths(record).find(
    (at) => here(kind, at, record) === 1 && there(kind, at, record) === 0,
  );
  const value = path === undefined ? undefined : stringAt(record, path);
  if (path === undefined || value === undefined) return undefined;
  const key = path.join("/");
  // A field of the record's own is its plain condition, unless its key reads as a prefix.
  const prefix = path.length === 1 && !/^[@>]/u.test(key) ? "" : ">";
  const sort =
    kind === undefined
      ? ""
      : spellCondition({
          prefix: "",
          key: kind,
          value: stringAt(record, [kind]) ?? "",
        });
  return `${sort}${spellCondition({ prefix, key, value })}`;
};

/** One version's side of a pairing: each member's key, and the other version's member it pairs with. */
interface Side {
  readonly keys: readonly string[];
  readonly partners: readonly (number | undefined)[];
}

/**
 * Pair the JSON records of two versions of an array by an id field each
 * holds alone at both ends (`ID_FIELD`), as TreeLine's nodes by
 * `[uid=7584d494d9f511f1a873edd4f1920549]`, whatever order the app saves
 * them in; a member only one version holds is named by its id too, unless
 * the app generated it (`isGeneratedId`), when another save would not
 * repeat it: then by a name-like field inside it (`nameOf`), else only by
 * position. Undefined when the members are not all JSON records or no such
 * field names each.
 */
export const pairRecordsById = (
  newer: readonly JsonValue[],
  older: readonly JsonValue[],
): { readonly newer: Side; readonly older: Side } | undefined => {
  const [first] = [...newer, ...older];
  if (!isJsonRecord(first ?? null) || ![...newer, ...older].every(isJsonRecord))
    return undefined;
  const key = Object.keys(first ?? {}).find(
    (field) =>
      ID_FIELD.test(field) &&
      !/[=[\]]/u.test(field) &&
      namesEach(newer, field) &&
      namesEach(older, field),
  );
  if (key === undefined) return undefined;
  const idOf = (member: JsonValue) =>
    isJsonRecord(member) ? String(member[key]) : "";
  const counts = { newer: tally(newer), older: tally(older) };
  const side = (
    members: readonly JsonValue[],
    others: readonly JsonValue[],
    newest: boolean,
  ): Side => {
    const where = new Map(others.map((other, index) => [idOf(other), index]));
    const partners = members.map((member) => where.get(idOf(member)));
    const [here, there] = newest
      ? [counts.newer, counts.older]
      : [counts.older, counts.newer];
    return {
      keys: members.map((member, index) =>
        partners[index] === undefined && isGeneratedId(idOf(member))
          ? (nameOf(member, here, there) ?? String(index))
          : `[${key}=${idOf(member)}]`,
      ),
      partners,
    };
  };
  return {
    newer: side(newer, older, true),
    older: side(older, newer, false),
  };
};
