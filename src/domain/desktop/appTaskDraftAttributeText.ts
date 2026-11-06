import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import {
  attributeKeyOf,
  isStamp,
  type NoiseReason,
} from "./appTaskDraftNoise.js";
import { isIdentifyingAttribute } from "./attributeRank.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import {
  elementText,
  escapeToken,
  isXmlElement,
  resolvePointer,
} from "./viewPointer.js";

/** How far a text check climbs from a run to the element an attribute names. */
const MAX_CLIMB = 3;

/** The element a member of `children` sits in; none for the root. */
const parentOf = (pointer: string): string | undefined =>
  /^(?<parent>.+)\/children\/[^/]+$/u.exec(pointer)?.groups?.parent;

/** Whether a pointer's last step names its element by an attribute, as `[name=PAGEOBJECT][@ANNAME=Headline]`. */
const namedByAttribute = (pointer: string) =>
  (pointer.split("/").at(-1) ?? "").includes("[@");

/** An element's text from its text nodes, or from an attribute's values, at a pointer in a view. */
const textAt = (
  view: JsonValue | null,
  pointer: string,
  attribute?: string,
) => {
  const element = resolvePointer(view, pointer);
  return isXmlElement(element) ? elementText(element, attribute) : undefined;
};

/**
 * The elements below the element at a pointer that hold an attribute, as
 * runs do: none holding another, and the element itself holding none; a
 * Freeplane node and the nodes in it, each holding `TEXT`, are no runs.
 */
const runsOf = (view: JsonValue | null, pointer: string, key: string) => {
  const element = resolvePointer(view, pointer);
  const holds = (node: JsonValue) =>
    isXmlElement(node) && typeof node.attributes[key] === "string";
  let runs = 0;
  const pending: { node: JsonValue; inside: boolean }[] = [
    { node: element ?? null, inside: false },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, inside } = next;
    if (!isXmlElement(node)) continue;
    if (holds(node) && (inside || node === element)) return undefined;
    runs += holds(node) ? 1 : 0;
    for (const child of node.children)
      pending.push({ node: child, inside: inside || holds(node) });
  }
  return runs;
};

/** Whether an element keeps its text in runs of an attribute at both ends: no text nodes, and its holders runs (`runsOf`), two or more or one holding words with a space. */
const holdsRuns = (
  { ends }: AttributeTextContext,
  pointer: string,
  key: string,
) => {
  const views = [ends.baseline, ends.final];
  const runs = views.map((view) => runsOf(view, pointer, key));
  return (
    runs.every((count) => count !== undefined) &&
    (runs.some((count) => (count ?? 0) > 1) ||
      /\s/u.test(textAt(ends.final, pointer, key) ?? "")) &&
    views.every((view) => textAt(view, pointer)?.trim() === "")
  );
};

/** What an attribute-text check reads: a file's two ends, whether the final view decides a check at a pointer, and the longest text it compares. */
export interface AttributeTextContext {
  readonly file: string;
  readonly ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  };
  readonly named: (pointer: string) => boolean;
  readonly chars: number;
}

/**
 * The check of text an app keeps in an attribute across runs, as Scribus a
 * frame's in `<StoryText><ITEXT CH="Spring "/><ITEXT CH="Fair"/>`, for an
 * element whose attribute `key` holds words that changed, or that was added
 * or removed: a `text_equals` with `text_attribute` on the nearest ancestor
 * an attribute names, within three levels and below the root, that holds no
 * text nodes at either end and whose holders of the attribute are runs
 * (`runsOf`), two or more, or one holding words with a space; with the
 * ancestor, whose runs it covers. Undefined otherwise, as for a Freeplane
 * node's own `TEXT`, which a check reads where it is.
 */
export const attributeTextCheck = (
  context: AttributeTextContext,
  owner: string,
  key: string,
):
  | { readonly element: string; readonly check: DesktopTaskCheckInput }
  | undefined => {
  const { ends } = context;
  const element = [ends.final, ends.baseline]
    .map((view) => resolvePointer(view, owner))
    .find(isXmlElement);
  const value = element?.attributes[key];
  if (
    isIdentifyingAttribute(key) ||
    typeof value !== "string" ||
    !/\p{L}/u.test(value) ||
    isStamp(value)
  )
    return undefined;
  let at = parentOf(owner);
  for (
    let climbed = 1;
    at !== undefined && !namedByAttribute(at) && climbed < MAX_CLIMB;
    climbed += 1
  )
    at = parentOf(at);
  if (at === undefined || parentOf(at) === undefined || !namedByAttribute(at))
    return undefined;
  const ancestor = at;
  const after = textAt(ends.final, ancestor, key);
  return holdsRuns(context, ancestor, key) &&
    context.named(ancestor) &&
    after !== undefined &&
    after !== textAt(ends.baseline, ancestor, key) &&
    after.length <= context.chars
    ? {
        element: ancestor,
        check: {
          kind: "text_equals",
          file: context.file,
          pointer: ancestor,
          value: after,
          text_attribute: key,
        },
      }
    : undefined;
};

/** The attributes an attribute-text check may read, by the element holding them: each that changed, and each of an element added or removed; none that is noise. */
export const textAttributes = (
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
  ends: AttributeTextContext["ends"],
  noise: (pointer: string) => NoiseReason | undefined,
) => {
  const own = (view: JsonValue | null, pointer: string) => {
    const element = resolvePointer(view, pointer);
    return isXmlElement(element)
      ? Object.keys(element.attributes).map((key) => ({ owner: pointer, key }))
      : [];
  };
  return [
    ...change.changed.flatMap((pointer) => {
      const key = attributeKeyOf(pointer);
      return key === undefined
        ? []
        : [{ owner: pointer.split("/").slice(0, -2).join("/"), key }];
    }),
    ...change.added.flatMap((pointer) => own(ends.final, pointer)),
    ...change.removed.flatMap((pointer) => own(ends.baseline, pointer)),
  ].filter(
    ({ owner, key }) =>
      noise(`${owner}/attributes/${escapeToken(key)}`) === undefined,
  );
};

/** Whether a change at a pointer, read in a view, is one an attribute-text check reads: its attribute in the checked element, or a run holding it there; another attribute or element is no part of it. */
export const readsText =
  (checked: readonly { readonly element: string; readonly key: string }[]) =>
  (pointer: string, view: JsonValue | null): boolean =>
    checked.some(({ element, key }) => {
      const run = resolvePointer(view, pointer);
      return (
        pointer.startsWith(`${element}/`) &&
        (attributeKeyOf(pointer) === key ||
          (isXmlElement(run) && typeof run.attributes[key] === "string"))
      );
    });
