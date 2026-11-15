import type { JsonValue } from "../jsonValue.js";
import { isXmlElement, resolvePointer } from "./viewPointer.js";
import { appendAll } from "../appendAll.js";

/** A file's views at its two ends. */
interface Ends {
  readonly baseline: JsonValue | null;
  readonly final: JsonValue | null;
}

/**
 * Whether a value is a count an app keeps of an element's members, as VYM's
 * root `branchCount`, KMyMoney's `<TRANSACTIONS count="5">` or GnuCash's
 * `<gnc:count-data cd:type="transaction">2</gnc:count-data>` in its book:
 * an attribute whose key ends in `count`, or the text of an element whose
 * tag names a count, an integer that changed, at each end equal to how many
 * elements of one tag the element, or for text the element holding it,
 * holds at any depth there, the counter itself left out; or, for a counter
 * the change added, to how many of one tag, more than one, it holds as
 * children, as FreeCAD's `<ObjectDeps Count="2">` its `Dep`s. A count a
 * user enters, as an item's `<count>`, tallies no tag so.
 */
export const isMemberCount = (
  ends: Ends,
  pointer: string,
  key: string | undefined,
) => {
  const counter = pointer.replace(/\/children\/\d+$/u, "");
  const holder = resolvePointer(ends.final, counter, "xml");
  const scope =
    key === undefined
      ? counter !== pointer &&
        isXmlElement(holder) &&
        /count/iu.test(holder.name.split(":").at(-1) ?? holder.name)
        ? counter.replace(/\/children\/[^/]+$/u, "")
        : undefined
      : /count$/iu.test(key.split(":").at(-1) ?? key)
        ? pointer.split("/").slice(0, -2).join("/")
        : undefined;
  const [before, after] = [ends.baseline, ends.final].map((view) =>
    resolvePointer(view, pointer, "xml"),
  );
  const number = (value: JsonValue | undefined) =>
    typeof value === "string" && /^\d+$/u.test(value)
      ? Number(value)
      : undefined;
  const [seedCount, endCount] = [number(before), number(after)];
  if (
    scope === undefined ||
    endCount === undefined ||
    seedCount === endCount ||
    (seedCount === undefined && before !== undefined)
  )
    return false;
  const tallyAt = (view: JsonValue | null, deep: boolean) => {
    const tally = new Map<string, number>();
    const own =
      key === undefined ? resolvePointer(view, counter, "xml") : undefined;
    const owner = resolvePointer(view, scope, "xml");
    const pending = isXmlElement(owner) ? [...owner.children] : [];
    for (let node = pending.pop(); node !== undefined; node = pending.pop())
      if (isXmlElement(node) && node !== own) {
        tally.set(node.name, (tally.get(node.name) ?? 0) + 1);
        if (deep) appendAll(pending, node.children);
      }
    return tally;
  };
  if (seedCount === undefined)
    return [...tallyAt(ends.final, false).values()].some(
      (count) => count > 1 && count === endCount,
    );
  const seed = tallyAt(ends.baseline, true);
  const end = tallyAt(ends.final, true);
  return [...new Set([...seed.keys(), ...end.keys()])].some(
    (tag) =>
      (seed.get(tag) ?? 0) === seedCount && (end.get(tag) ?? 0) === endCount,
  );
};
