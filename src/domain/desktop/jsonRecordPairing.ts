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
/** The record's own id, ahead of a relationship such as `parent_id`, which also matches `ID_FIELD`. */
const OWN_ID = ["uid", "uuid", "guid", "id", "key"];

/** A field naming what kind of record a member is, as TreeLine's `format="BOOK"`. */
export const KIND_FIELD = /^(?:type|kind|format|category)$/iu;

/** The longest value a field names a record by. */
const MAX_NAME = 64;
/** The most kind fields and paths a version's records are counted by, each a pass over them, so odd records cost no more. */
const MAX_TALLIES = 64;

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

/** The first path, nearest first and up to `MAX_INSIDE_STEPS` keys deep, of a record's name-like string fields that `names` accepts, as TreeLine's `data/Title`. */
const namePath = (
  record: Record<string, JsonValue>,
  names: (path: readonly string[]) => boolean,
): readonly string[] | undefined => {
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
          isName(value) &&
          names([...path, key])
        )
          return [...path, key];
    level = next;
  }
  return undefined;
};

/** The field a record's kind is kept in, as `format`, when it holds a string a selector can carry. */
const kindOf = (record: Record<string, JsonValue>) =>
  Object.keys(record).find((key) => {
    const value = record[key];
    return (
      KIND_FIELD.test(key) && typeof value === "string" && !value.includes("][")
    );
  });

/** How many of a version's records hold a record's kind and its string at a path, each kind field and path read over the version once; undefined past `MAX_TALLIES` of them. */
const tally = (members: readonly JsonValue[]) => {
  const counted = new Map<string, Map<string, number>>();
  return (
    kind: string | undefined,
    path: readonly string[],
    of: JsonValue,
  ): number | undefined => {
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
      if (counted.size >= MAX_TALLIES) return undefined;
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

/** The selector naming a record by its kind and its string at a path. */
const spellName = (
  record: Record<string, JsonValue>,
  kind: string | undefined,
  path: readonly string[],
) => {
  const value = stringAt(record, path);
  if (value === undefined) return undefined;
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

type Tally = ReturnType<typeof tally>;

/**
 * The selector naming a record only one version holds by its kind and its
 * first name-like field that names it alone there and nothing in the other
 * version, as TreeLine's new book by `[format=BOOK][>data/Title=The Silk Roads]`;
 * undefined when none does.
 */
const nameOf = (record: JsonValue, here: Tally, there: Tally) => {
  if (!isRecord(record)) return undefined;
  const kind = kindOf(record);
  const path = namePath(
    record,
    (at) => here(kind, at, record) === 1 && there(kind, at, record) === 0,
  );
  return path === undefined ? undefined : spellName(record, kind, path);
};

/**
 * The selector naming a record both versions hold by its kind and its first
 * name-like field that holds the same string in both and names it alone in
 * each, as TreeLine's kept category by `[format=CATEGORY][>data/NAME=Science]`;
 * undefined when none does.
 */
const keptNameOf = (
  newer: JsonValue,
  older: JsonValue,
  counts: { readonly newer: Tally; readonly older: Tally },
) => {
  if (!isRecord(newer) || !isRecord(older)) return undefined;
  const kind = kindOf(newer);
  const same = (path: readonly string[]) =>
    stringAt(newer, path) === stringAt(older, path);
  const path = namePath(
    newer,
    (at) =>
      (kind === undefined || same([kind])) &&
      same(at) &&
      counts.newer(kind, at, newer) === 1 &&
      counts.older(kind, at, older) === 1,
  );
  return path === undefined ? undefined : spellName(newer, kind, path);
};

/** One version's side of a pairing: each member's key, and the other version's member it pairs with. */
interface Side {
  readonly keys: readonly string[];
  readonly partners: readonly (number | undefined)[];
}

/**
 * Pair the JSON records of two versions of an array by an id field each
 * holds alone at both ends (`ID_FIELD`), as TreeLine's nodes by their `uid`,
 * whatever order the app saves them in, and name each by that id, as
 * `[id=chores]`, unless the app generated it (`isGeneratedId`): then a
 * member both versions hold by a name-like field inside it (`keptNameOf`),
 * else by its id, as `[uid=7584d494d9f511f1a873edd4f1920549]`; and a member
 * only one version holds, which another save would give another id, by a
 * name-like field inside it (`nameOf`), else only by position. Undefined
 * when the members are not all JSON records or no such field names each.
 */
export const pairRecordsById = (
  newer: readonly JsonValue[],
  older: readonly JsonValue[],
): { readonly newer: Side; readonly older: Side } | undefined => {
  const [first] = [...newer, ...older];
  if (!isJsonRecord(first ?? null) || ![...newer, ...older].every(isJsonRecord))
    return undefined;
  const key = Object.keys(first ?? {})
    .filter(
      (field) =>
        ID_FIELD.test(field) &&
        // `[@attr]` and `[>child]` are selector marks, not a JSON field's name.
        !/^[@>]|[=[\]]/u.test(field) &&
        namesEach(newer, field) &&
        namesEach(older, field),
    )
    .toSorted((left, right) => {
      const rank = (field: string) => {
        const own = OWN_ID.indexOf(field.toLowerCase());
        return own < 0 ? OWN_ID.length : own;
      };
      return rank(left) - rank(right);
    })[0];
  if (key === undefined) return undefined;
  const idOf = (member: JsonValue) =>
    isJsonRecord(member) ? String(member[key]) : "";
  const counts = { newer: tally(newer), older: tally(older) };
  const partnersOf = (
    members: readonly JsonValue[],
    others: readonly JsonValue[],
  ) => {
    const where = new Map(others.map((other, index) => [idOf(other), index]));
    return members.map((member) => where.get(idOf(member)));
  };
  const partners = {
    newer: partnersOf(newer, older),
    older: partnersOf(older, newer),
  };
  const idKey = (member: JsonValue) => `[${key}=${idOf(member)}]`;
  // A kept member is named from its newer version, so both versions key it alike.
  const newerKeys = newer.map((member, index) => {
    const partner = partners.newer[index];
    if (!isGeneratedId(idOf(member))) return idKey(member);
    return partner === undefined
      ? (nameOf(member, counts.newer, counts.older) ?? String(index))
      : (keptNameOf(member, older[partner] ?? null, counts) ?? idKey(member));
  });
  const olderKeys = older.map((member, index) => {
    const partner = partners.older[index];
    if (partner !== undefined) return newerKeys[partner] ?? idKey(member);
    return isGeneratedId(idOf(member))
      ? (nameOf(member, counts.older, counts.newer) ?? String(index))
      : idKey(member);
  });
  return {
    newer: { keys: newerKeys, partners: partners.newer },
    older: { keys: olderKeys, partners: partners.older },
  };
};
