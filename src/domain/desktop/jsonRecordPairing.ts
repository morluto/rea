import type { JsonValue } from "../jsonValue.js";
import { isGeneratedId } from "./attributeRank.js";
import { isXmlElement } from "./viewPointer.js";

/** A field naming a JSON record, as TreeLine's `uid`: `id`, `uid`, `uuid`, `guid`, `key`, or a name ending in `_id`, `-id` or `Id`. */
const ID_FIELD = /^(?:_?id|uid|uuid|guid|key)$|[_-]id$|[a-z]Id$/u;
/** The record's own id, ahead of a relationship such as `parent_id`, which also matches `ID_FIELD`. */
const OWN_ID = ["uid", "uuid", "guid", "id", "key"];

const isJsonRecord = (value: JsonValue): value is Record<string, JsonValue> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !isXmlElement(value);

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
 * repeat it and only position names the member. Undefined when the members
 * are not all JSON records or no such field names each.
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
  const side = (
    members: readonly JsonValue[],
    others: readonly JsonValue[],
  ): Side => {
    const where = new Map(others.map((other, index) => [idOf(other), index]));
    const partners = members.map((member) => where.get(idOf(member)));
    return {
      keys: members.map((member, index) =>
        partners[index] === undefined && isGeneratedId(idOf(member))
          ? String(index)
          : `[${key}=${idOf(member)}]`,
      ),
      partners,
    };
  };
  return { newer: side(newer, older), older: side(older, newer) };
};
