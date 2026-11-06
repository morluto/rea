import type { JsonValue } from "../jsonValue.js";
import { isStamp } from "./appTaskDraftNoise.js";
import {
  attributeTier,
  isIdentifyingAttribute,
  isPlaceholder,
  isSaveNumberedId,
} from "./attributeRank.js";
import { escapeToken, isXmlElement, resolvePointer } from "./viewPointer.js";
import { selectorOf, spellCondition } from "./viewSelector.js";

/** Other pointers a value's entry lists. */
const MAX_ALTERNATIVES = 3;

const unescape = (token: string) =>
  token.replaceAll("~1", "/").replaceAll("~0", "~");

/**
 * The value's pointer naming its element another way, for an author to pick
 * a key without another export: the innermost member a pointer selects by a
 * condition, by each other identifier or name-like attribute it holds, as a
 * shape by `draw:name` beside its `xml:id`, that names it alone among its
 * list's members of its tag, at most three. Never the attribute the pointer
 * reads, an id an ODF app numbers anew on each save, a time or a placeholder.
 */
export const alternativePointers = (
  view: JsonValue | null,
  pointer: string,
): string[] => {
  const segments = pointer.split("/");
  for (let index = segments.length - 1; index >= 2; index -= 1) {
    const conditions =
      segments[index - 1] === "children"
        ? selectorOf(unescape(segments[index] ?? ""))
        : undefined;
    if (!conditions?.some(({ prefix }) => prefix !== "")) continue;
    const list = resolvePointer(view, segments.slice(0, index).join("/"));
    const element = resolvePointer(
      view,
      segments.slice(0, index + 1).join("/"),
    );
    if (!Array.isArray(list) || !isXmlElement(element)) return [];
    const used = new Set(conditions.map(({ key }) => key));
    const reads =
      segments[index + 1] === "attributes" && index + 3 === segments.length
        ? unescape(segments[index + 2] ?? "")
        : undefined;
    const alone = (key: string, value: string) =>
      list.filter(
        (item) =>
          isXmlElement(item) &&
          item.name === element.name &&
          item.attributes[key] === value,
      ).length === 1;
    return Object.entries(element.attributes)
      .flatMap(([key, value]) =>
        typeof value === "string" &&
        (isIdentifyingAttribute(key) || attributeTier(key, value) === 0) &&
        !used.has(key) &&
        key !== reads &&
        !/[=[\]]/u.test(key) &&
        !value.includes("][") &&
        value.trim() !== "" &&
        !isStamp(value) &&
        !isPlaceholder(value) &&
        !isSaveNumberedId(key, value) &&
        alone(key, value)
          ? [
              [
                ...segments.slice(0, index),
                escapeToken(
                  `[name=${element.name}]${spellCondition({ prefix: "@", key, value })}`,
                ),
                ...segments.slice(index + 1),
              ].join("/"),
            ]
          : [],
      )
      .slice(0, MAX_ALTERNATIVES);
  }
  return [];
};
