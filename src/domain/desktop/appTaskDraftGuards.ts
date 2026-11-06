import type { JsonValue } from "../jsonValue.js";
import { isTimestamp, type DesktopTaskCheckInput } from "./appTask.js";
import { elementText, isXmlElement, sameJson } from "./appTaskChecks.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import { escapeToken, pairMembers, resolvePointer } from "./viewPointer.js";

type Suggestion = DesktopTaskCheckInput;

/** Guards a file's draft offers, and how many one suggested check takes. */
const MAX_GUARDS = 4;
const MAX_GUARDS_PER_CHECK = 2;

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
  if (check.kind === "text_equals") {
    if (!isXmlElement(before) || !isXmlElement(after)) return undefined;
    const value = elementText(before);
    return value.trim() !== "" &&
      value === elementText(after) &&
      value.length <= context.chars &&
      !isTimestamp(value)
      ? { kind: "text_equals", file, pointer, value }
      : undefined;
  }
  return typeof before !== "object" &&
    sameJson(before, after) &&
    !isTimestamp(before)
    ? valueEqualsCheck(file, pointer, before)
    : undefined;
};

/** Pointers of like siblings, nearest first, each by the selector it pairs by at both ends. */
const siblingPointers = (
  context: GuardContext,
  step: ReturnType<typeof listSteps>[number],
): string[] => {
  const newer = resolvePointer(context.ends.final, step.list);
  const older = resolvePointer(context.ends.baseline, step.list);
  const member = resolvePointer(
    context.ends.final,
    `${step.list}/${step.member}`,
  );
  if (!Array.isArray(newer) || !Array.isArray(older) || !isXmlElement(member))
    return [];
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
  if (likes.length === 0) return [];
  const pairing = pairMembers(newer, older);
  return likes.flatMap(({ index }) => {
    const key = pairing.newer.keys[index];
    const partner = pairing.newer.partners[index];
    return key === undefined ||
      /^\d+$/u.test(key) ||
      partner === undefined ||
      pairing.older.keys[partner] !== key
      ? []
      : [[step.list, escapeToken(key), ...step.rest].join("/")];
  });
};

/** Up to two guards for one check: the same field on like siblings of the innermost list it goes through that has any. */
const guardsFor = (context: GuardContext, check: Suggestion): Suggestion[] => {
  if (check.kind !== "value_equals" && check.kind !== "text_equals") return [];
  for (const step of listSteps(check.pointer)) {
    const siblings = siblingPointers(context, step);
    if (siblings.length === 0) continue;
    const guards = siblings
      .flatMap((pointer) => guardAt(context, check, pointer) ?? [])
      .slice(0, MAX_GUARDS_PER_CHECK);
    if (guards.length > 0) return guards;
  }
  return [];
};

/**
 * Checks that the rest stays as it was, for an author to add by choice: the
 * field each suggested check reads, on up to two like siblings of the
 * innermost list it goes through, nearest first, at its seed value, which the
 * end holds too; at most `MAX_GUARDS` a file, none at a suggested pointer.
 */
export const draftGuards = (
  context: GuardContext,
  suggested: readonly Suggestion[],
): Suggestion[] => {
  const taken = new Set(
    suggested.flatMap((check) => ("pointer" in check ? [check.pointer] : [])),
  );
  const guards: Suggestion[] = [];
  for (const check of suggested)
    for (const guard of guardsFor(context, check))
      if (
        guards.length < MAX_GUARDS &&
        "pointer" in guard &&
        !taken.has(guard.pointer)
      ) {
        taken.add(guard.pointer);
        guards.push(guard);
      }
  return guards;
};
