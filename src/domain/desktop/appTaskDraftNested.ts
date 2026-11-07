import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import {
  isRenumberedKey,
  isStamp,
  isVolatileValue,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import {
  isGeneratedId,
  isIdentifyingAttribute,
  isPlaceholder,
  isViewStateName,
  rankAttributes,
} from "./attributeRank.js";
import { escapeToken, isXmlElement, resolvePointer } from "./viewPointer.js";
import { spellCondition } from "./viewSelector.js";

type Element = Record<string, JsonValue> & {
  name: string;
  attributes: Record<string, JsonValue>;
  children: JsonValue[];
};

/** Checks of the records nested in one element added whole, and of one record's attributes. */
const MAX_NESTED_CHECKS = 6;
const MAX_PER_RECORD = 3;

/** Whether an element is a record of attributes alone, as KMyMoney's `<SPLIT value="-1749/20" account="A000001" …/>`: no element or text of its own. */
const attributesOnly = (item: JsonValue): item is Element =>
  isXmlElement(item) &&
  Object.keys(item.attributes).length > 0 &&
  item.children.every(
    (child) => typeof child === "string" && child.trim() === "",
  );

/** The records of attributes alone among an element's children, when they are all one tag; empty otherwise. */
const recordsIn = (element: JsonValue | undefined): Element[] => {
  const items = isXmlElement(element)
    ? element.children.filter(isXmlElement)
    : [];
  const records = items.filter(attributesOnly);
  return records.length === items.length &&
    records.every((record) => record.name === records[0]?.name)
    ? records
    : [];
};

/** A list of records of attributes alone in an element: the steps from it to the element holding them, none for its own or a child's tag for a child's, as a transaction's `<SPLITS>`, and the records. */
interface RecordList {
  readonly steps: readonly string[];
  readonly records: readonly Element[];
}

/**
 * The lists of records of attributes alone an element holds: its own
 * children, or those of a child holding nothing else that its tag names
 * alone, as a KMyMoney `<TRANSACTION>` its `<SPLITS>` of `<SPLIT>`.
 */
export const recordListsOf = (element: JsonValue): RecordList[] => {
  const own = recordsIn(element);
  if (own.length > 0) return [{ steps: [], records: own }];
  const children = isXmlElement(element)
    ? element.children.filter(isXmlElement)
    : [];
  const tags = new Map<string, number>();
  for (const { name } of children) tags.set(name, (tags.get(name) ?? 0) + 1);
  return children.flatMap((child) => {
    const records = recordsIn(child);
    return records.length > 0 &&
      tags.get(child.name) === 1 &&
      !/[=[\]]/u.test(child.name)
      ? [{ steps: ["children", escapeToken(`[name=${child.name}]`)], records }]
      : [];
  });
};

/** The records at a list's steps in each like sibling of an element, as the splits of the transactions already in the book. */
const cousinsOf = (
  likes: readonly JsonValue[],
  steps: readonly string[],
  tag: string,
): Element[] =>
  likes.flatMap((like) =>
    recordsIn(
      steps.length === 0 ? like : resolvePointer(like, `/${steps.join("/")}`),
    ).filter((record) => record.name === tag),
  );

/** Whether a value a selector can carry and that names something across saves. */
const selectable = (key: string, value: JsonValue | undefined) =>
  typeof value === "string" &&
  value !== "" &&
  !/[=[\]]/u.test(key) &&
  !value.includes("][") &&
  !isStamp(value) &&
  !isPlaceholder(value) &&
  !isVolatileValue(value);

/**
 * The selector naming a nested record alone among its list's: an
 * identifier first, unless it is one the app generates or numbers anew in
 * each record holding such a list, as KMyMoney's `S0001` in every
 * transaction; then the best ranked attribute short of a coordinate or an
 * amount, as a split's `[@account=A000001]`.
 */
const recordKey = (
  record: Element,
  records: readonly Element[],
  cousins: readonly Element[],
) => {
  const values = Object.entries(record.attributes).flatMap(([key, value]) =>
    selectable(key, value) ? [{ key, value: String(value) }] : [],
  );
  const repeated = (key: string, value: string) =>
    cousins.some((cousin) => cousin.attributes[key] === value);
  const [best] = [
    ...values.filter(
      ({ key, value }) =>
        isIdentifyingAttribute(key) &&
        !isGeneratedId(value) &&
        !repeated(key, value),
    ),
    ...rankAttributes(
      values.filter(({ key }) => !isIdentifyingAttribute(key)),
    ).filter(({ tier }) => tier < 3),
  ].filter(
    ({ key, value }) =>
      records.filter((other) => other.attributes[key] === value).length === 1,
  );
  return best === undefined
    ? undefined
    : {
        key: best.key,
        segment: escapeToken(
          `[name=${record.name}]${spellCondition({ prefix: "@", ...best })}`,
        ),
      };
};

/**
 * The keys of a record checked one by one: those whose values vary among
 * the like records, its list's and those under the element's like siblings,
 * as a split's `value` and `payee`, but not its `memo` or `price` that every
 * split holds alike, nor one each like record holds equal to an earlier one,
 * as `shares` repeats `value`; never its selector's, an identifier, a time,
 * a volatile value, view state or an id the app renumbers.
 */
const checkedKeys = (
  record: Element,
  likes: readonly Element[],
  skip: string,
) => {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(record.attributes)) {
    const all = likes.map((like) => like.attributes[key]);
    if (
      key === skip ||
      typeof value !== "string" ||
      isIdentifyingAttribute(key) ||
      isPlaceholder(value) ||
      isStamp(value) ||
      isVolatileValue(value) ||
      isViewStateName(key) ||
      isRenumberedKey(key) ||
      new Set(all).size < 2 ||
      keys.some((earlier) =>
        likes.every(
          (like) => like.attributes[earlier] === like.attributes[key],
        ),
      )
    )
      continue;
    keys.push(key);
  }
  return keys.slice(0, MAX_PER_RECORD);
};

/** What checks of nested records read: the file, the end, and whether a pointer names its value without a step by position. */
export interface NestedContext {
  readonly file: string;
  readonly final: JsonValue | null;
  readonly named: (pointer: string) => boolean;
}

/**
 * A `value_equals` per attribute of each record of attributes alone nested
 * in an element added whole to a list, as each split of a KMyMoney
 * transaction holds its amount, account and payee, which the element's own
 * attributes and text leave out: the record named by `recordKey`, its
 * attributes by `checkedKeys`, at most six in all. Each fails at the seed,
 * which lacks the element. Empty for an element with no like sibling, as no
 * record then tells what varies.
 */
export const nestedRecordChecks = (
  context: NestedContext,
  pointer: string,
  element: JsonValue,
): DesktopTaskCheckInput[] => {
  if (!isXmlElement(element)) return [];
  const list = resolvePointer(context.final, pointer.replace(/\/[^/]+$/u, ""));
  const likes = (Array.isArray(list) ? list : []).filter(
    (item) =>
      item !== element && isXmlElement(item) && item.name === element.name,
  );
  if (likes.length === 0) return [];
  return recordListsOf(element)
    .flatMap(({ steps, records }) => {
      const cousins = cousinsOf(likes, steps, records[0]?.name ?? "");
      return records.flatMap((record) => {
        const key = recordKey(record, records, cousins);
        if (key === undefined) return [];
        const at = [pointer, ...steps, "children", key.segment].join("/");
        return checkedKeys(record, [...records, ...cousins], key.key).flatMap(
          (name) => {
            const field = `${at}/attributes/${escapeToken(name)}`;
            const value = record.attributes[name];
            return context.named(field) && typeof value === "string"
              ? [valueEqualsCheck(context.file, field, value)]
              : [];
          },
        );
      });
    })
    .slice(0, MAX_NESTED_CHECKS);
};
