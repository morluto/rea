import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import { elementText, isXmlElement, sameJson } from "./appTaskChecks.js";
import {
  holdsSplitDate,
  isRenumberedKey,
  isStamp,
} from "./appTaskDraftNoise.js";
import { holdsNoisyText } from "./appTaskDraftText.js";
import { decimalOf, valueEqualsCheck } from "./appTaskDraftScalars.js";
import { isIdentifyingAttribute, rankAttributes } from "./attributeRank.js";
import { escapeToken, pairMembers, resolvePointer } from "./viewPointer.js";

type Suggestion = DesktopTaskCheckInput;

/** Guards a file's draft offers, and how many one suggested check takes. */
const MAX_GUARDS = 4;
const MAX_GUARDS_PER_CHECK = 2;
/** Like siblings a guard is sought on per list, nearest first, so a long list costs no more than a short one. */
const MAX_SIBLINGS_READ = 16;

/** What guards read: a file's two ends, whether a check there is decided by name, and noise. */
export interface GuardContext {
  readonly file: string;
  readonly ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  };
  readonly named: (view: JsonValue | null, pointer: string) => boolean;
  readonly noisy: (pointer: string) => boolean;
  readonly chars: number;
}

/** Where a pointer steps into a list by selector, innermost first: the list, the member's segment and the rest of the pointer after it. */
const listSteps = (pointer: string) => {
  const segments = pointer.split("/");
  const steps: { list: string; member: string; rest: string[] }[] = [];
  for (let index = segments.length - 1; index >= 2; index -= 1) {
    const member = segments[index] ?? "";
    if (segments[index - 1] === "children" && !/^\d+$/u.test(member))
      steps.push({
        list: segments.slice(0, index).join("/"),
        member,
        rest: segments.slice(index + 1),
      });
  }
  return steps;
};

/** The guard at a sibling's pointer, when it holds the same value at both ends, by name, and is no noise. */
const guardAt = (
  context: GuardContext,
  check: Suggestion,
  pointer: string,
): Suggestion | undefined => {
  const { ends, file } = context;
  if (
    context.noisy(pointer) ||
    !context.named(ends.baseline, pointer) ||
    !context.named(ends.final, pointer)
  )
    return undefined;
  const before = resolvePointer(ends.baseline, pointer);
  const after = resolvePointer(ends.final, pointer);
  if (before === undefined || after === undefined) return undefined;
  if (
    check.kind === "value_equals" &&
    "tolerance" in check &&
    isXmlElement(before) &&
    isXmlElement(after)
  ) {
    const value = elementText(before);
    if (
      value.trim() === "" ||
      value !== elementText(after) ||
      value.length > context.chars ||
      holdsNoisyText(before) ||
      holdsNoisyText(after) ||
      holdsSplitDate(ends.baseline, pointer) ||
      holdsSplitDate(ends.final, pointer) ||
      isStamp(value)
    )
      return undefined;
    return decimalOf(value) === undefined
      ? { kind: "text_equals", file, pointer, value }
      : valueEqualsCheck(file, pointer, value);
  }
  if (check.kind === "text_equals") {
    if (!isXmlElement(before) || !isXmlElement(after)) return undefined;
    const value = elementText(before);
    return value.trim() !== "" &&
      value === elementText(after) &&
      value.length <= context.chars &&
      !holdsNoisyText(before) &&
      !holdsNoisyText(after) &&
      !holdsSplitDate(ends.baseline, pointer) &&
      !holdsSplitDate(ends.final, pointer) &&
      !isStamp(value)
      ? { kind: "text_equals", file, pointer, value }
      : undefined;
  }
  return typeof before !== "object" &&
    sameJson(before, after) &&
    !isStamp(before) &&
    (typeof before !== "string" || before.length <= context.chars)
    ? valueEqualsCheck(file, pointer, before)
    : undefined;
};

/** Whether a selector key keys a member by a value the app renumbers, as Gnumeric's `[@ExprID=2]`. */
const renumberedKey = (key: string) =>
  [...key.matchAll(/\[@(?<attribute>[^=\]]+)=/gu)].some(({ groups }) =>
    isRenumberedKey(groups?.attribute ?? ""),
  );

/** A like sibling of a checked member: its pointer by the selector it pairs by at both ends, and its element at the seed. */
interface Sibling {
  readonly member: string;
  readonly element: Record<string, JsonValue>;
}

/** The like siblings of the member a step goes through, nearest first, each paired by a selector, not by position or a renumbered id, and every like member at the seed. */
const siblingsOf = (
  context: GuardContext,
  step: ReturnType<typeof listSteps>[number],
): { readonly siblings: Sibling[]; readonly all: JsonValue[] } => {
  const newer = resolvePointer(context.ends.final, step.list);
  const older = resolvePointer(context.ends.baseline, step.list);
  const member = resolvePointer(
    context.ends.final,
    `${step.list}/${step.member}`,
  );
  if (!Array.isArray(newer) || !Array.isArray(older) || !isXmlElement(member))
    return { siblings: [], all: [] };
  const at = newer.indexOf(member);
  const likes = newer
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        index !== at && isXmlElement(item) && item.name === member.name,
    )
    .toSorted(
      (left, right) =>
        Math.abs(left.index - at) - Math.abs(right.index - at) ||
        left.index - right.index,
    );
  const all = older.filter(
    (item) => isXmlElement(item) && item.name === member.name,
  );
  if (likes.length === 0) return { siblings: [], all };
  const pairing = pairMembers(newer, older);
  return {
    siblings: likes.flatMap(({ index }) => {
      const key = pairing.newer.keys[index];
      const partner = pairing.newer.partners[index];
      const element = partner === undefined ? undefined : older[partner];
      return key === undefined ||
        /^\d+$/u.test(key) ||
        renumberedKey(key) ||
        partner === undefined ||
        pairing.older.keys[partner] !== key ||
        !isXmlElement(element)
        ? []
        : [{ member: escapeToken(key), element }];
    }),
    all,
  };
};

const attributesOf = ({ attributes }: Record<string, JsonValue>) =>
  typeof attributes === "object" &&
  attributes !== null &&
  !Array.isArray(attributes)
    ? attributes
    : {};

/** Whether like members at the seed hold more than one value at a path into them, as Planner's `work` does and its shared `type="normal"` does not; each path read once. */
const variesAmong = (all: readonly JsonValue[]) => {
  const known = new Map<string, boolean>();
  return (rest: readonly string[]): boolean => {
    const pointer = `/${rest.join("/")}`;
    const varied =
      known.get(pointer) ??
      new Set(
        all.map((item) =>
          JSON.stringify(resolvePointer(item, pointer) ?? null),
        ),
      ).size > 1;
    known.set(pointer, varied);
    return varied;
  };
};

/**
 * The path into a sibling a guard reads: the check's own field where like
 * members hold different values in it; otherwise, as for a tag or a default
 * every sibling shares, the sibling's best ranked attribute that varies, one
 * a user sets, as Planner's `work`; the check's own field when none does.
 */
const guardField = (
  sibling: Sibling,
  varies: (rest: readonly string[]) => boolean,
  rest: readonly string[],
) => {
  if (rest.length > 0 && varies(rest)) return rest;
  const selected = new Set(
    [...sibling.member.matchAll(/\[@(?<key>[^=\]]+)=/gu)].map(
      ({ groups }) => groups?.key ?? "",
    ),
  );
  const [best] = rankAttributes(
    Object.entries(attributesOf(sibling.element)).flatMap(([key, value]) =>
      typeof value === "string" &&
      !selected.has(key) &&
      !isIdentifyingAttribute(key) &&
      !isRenumberedKey(key) &&
      !isStamp(value) &&
      varies(["attributes", escapeToken(key)])
        ? [{ key, value }]
        : [],
    ),
  );
  return best === undefined ? rest : ["attributes", escapeToken(best.key)];
};

/** Up to two guards for one check: a field on the 16 nearest like siblings of the innermost list it goes through that has any, preferring one that varies among them. */
const guardsFor = (context: GuardContext, check: Suggestion): Suggestion[] => {
  if (check.kind !== "value_equals" && check.kind !== "text_equals") return [];
  for (const step of listSteps(check.pointer)) {
    const { siblings, all } = siblingsOf(context, step);
    const varies = variesAmong(all);
    const guards: Suggestion[] = [];
    for (const sibling of siblings.slice(0, MAX_SIBLINGS_READ)) {
      if (guards.length === MAX_GUARDS_PER_CHECK) break;
      const field =
        check.kind === "value_equals" &&
        "tolerance" in check &&
        step.rest.length === 0
          ? []
          : check.kind === "value_equals"
            ? guardField(sibling, varies, step.rest)
            : step.rest;
      const pointer = [step.list, sibling.member, ...field].join("/");
      const guard = guardAt(context, check, pointer);
      if (guard !== undefined) guards.push(guard);
    }
    if (guards.length > 0) return guards;
  }
  return [];
};

/**
 * Checks that the rest stays as it was, for an author to add by choice: a
 * field on up to two like siblings of the innermost list each suggested check
 * goes through, nearest first among the `MAX_SIBLINGS_READ` nearest, at its
 * seed value, which the end holds too: the
 * field the check reads where it varies among them, otherwise one that does;
 * never through a sibling paired by position or a renumbered id; at most
 * `MAX_GUARDS` a file, none at a suggested pointer.
 */
export const draftGuards = (
  context: GuardContext,
  suggested: readonly Suggestion[],
): Suggestion[] => {
  const taken = new Set(
    suggested.flatMap((check) => ("pointer" in check ? [check.pointer] : [])),
  );
  const guards: Suggestion[] = [];
  for (const check of suggested) {
    if (guards.length === MAX_GUARDS) break;
    for (const guard of guardsFor(context, check))
      if (
        guards.length < MAX_GUARDS &&
        "pointer" in guard &&
        !taken.has(guard.pointer)
      ) {
        taken.add(guard.pointer);
        guards.push(guard);
      }
  }
  return guards;
};
