import { unescapeJsonPointerToken } from "../jsonPointer.js";
import type { JsonValue } from "../jsonValue.js";
import { isNameLikeKey } from "./attributeRank.js";
import { isXmlElement, resolvePointer } from "./viewPointer.js";
import { selectorOf } from "./viewSelector.js";

/** Where a pointer steps into a list: the list, the member's segment and the rest of the pointer after it. */
export interface ListStep {
  readonly list: string;
  readonly member: string;
  readonly rest: readonly string[];
}

/** Where a pointer steps into a list, innermost first; by selector only, unless `positional` keeps steps by position too. */
export const listSteps = (pointer: string, positional = false): ListStep[] => {
  const segments = pointer.split("/");
  const steps: ListStep[] = [];
  for (let index = segments.length - 1; index >= 2; index -= 1) {
    const member = segments[index] ?? "";
    if (
      segments[index - 1] === "children" &&
      (positional || !/^\d+$/u.test(member))
    )
      steps.push({
        list: segments.slice(0, index).join("/"),
        member,
        rest: segments.slice(index + 1),
      });
  }
  return steps;
};

/** Whether a step's member is named as a field is, by a name-like attribute alone, as QElectroTech's `elementInformation[@name=label]`. */
const namedAsField = ({ member }: ListStep) => {
  const [only, ...more] = (
    selectorOf(unescapeJsonPointerToken(member)) ?? []
  ).filter(({ prefix }) => prefix !== "");
  return (
    only !== undefined &&
    more.length === 0 &&
    only.prefix === "@" &&
    isNameLikeKey(only.key)
  );
};

/** Whether a like sibling of an outer step's member holds the field a step goes through, at the same path, as every component holds its `label`. */
const sharedField = (
  view: JsonValue | null,
  step: ListStep,
  outer: ListStep,
) => {
  const records = resolvePointer(view, outer.list, "xml");
  const record = resolvePointer(view, `${outer.list}/${outer.member}`, "xml");
  const inner = outer.rest.slice(0, outer.rest.length - step.rest.length);
  return (
    Array.isArray(records) &&
    isXmlElement(record) &&
    records.some(
      (item) =>
        item !== record &&
        isXmlElement(item) &&
        item.name === record.name &&
        resolvePointer(item, `/${inner.join("/")}`, "xml") !== undefined,
    )
  );
};

/**
 * The record a step's member is a field of: the nearest step out whose like
 * siblings hold the same field at the same path, for a member named as a
 * field (`namedAsField`), as every QElectroTech component holds its
 * `elementInformation[@name=label]`, or a Glade button its `label` property;
 * undefined for a member that is a record of its own.
 */
export const recordOfField = (
  view: JsonValue | null,
  step: ListStep,
  outer: readonly ListStep[],
): ListStep | undefined =>
  namedAsField(step)
    ? outer.find((candidate) => sharedField(view, step, candidate))
    : undefined;
