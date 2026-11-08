import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { listSteps, recordOfField } from "./appTaskDraftSteps.js";
import { isXmlElement, resolvePointer } from "./viewPointer.js";
import { spellCondition } from "./viewSelector.js";

type Suggestion = DesktopTaskCheckInput;

/** Count checks a file's draft suggests, and count guards it offers. */
const MAX_COUNTS = 2;
const MAX_COUNT_GUARDS = 1;

/** A key naming what kind of element a member is, as Dia's `type="Flowchart - Box"`. */
const KIND_KEY = /^(?:[^:]*:)?(?:type|kind|shape)$/iu;

/** What counts read: a file's two ends, whether a list is decided by name and whole there, noise, and the pointers text checks cover. */
export interface CountContext {
  readonly file: string;
  readonly ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  };
  readonly whole: (view: JsonValue | null, list: string) => boolean;
  readonly noisy: (pointer: string) => boolean;
  readonly covered: (pointer: string) => boolean;
  readonly coveredRun: (pointer: string, view: JsonValue | null) => boolean;
}

/** A list of members of one tag a count reads, and of one kind when the members changed are (`kindOf`). */
interface Counted {
  readonly list: string;
  readonly tag: string;
  readonly kind?: { readonly key: string; readonly value: string };
}

/** The list an element's `children` member sits in. */
const listOf = (pointer: string): string | undefined =>
  /^(?<list>.+\/children)\/[^/]+$/u.exec(pointer)?.groups?.list;

/** The members of a tag, and kind, in a list, in a view. */
const membersOf = (view: JsonValue | null, { list, tag, kind }: Counted) => {
  const items = resolvePointer(view, list);
  return Array.isArray(items)
    ? items.filter(
        (item) =>
          isXmlElement(item) &&
          item.name === tag &&
          (kind === undefined || item.attributes[kind.key] === kind.value),
      )
    : [];
};

/** Whether the members of a tag in a list each hold a different value of a key, as Tiled's objects a free-form `type` (`well`, `door`, `gate`): a label of each, not a kind several share. */
const eachOwn = (items: JsonValue, tag: string, key: string) => {
  const values = (Array.isArray(items) ? items : []).flatMap((item) =>
    isXmlElement(item) && item.name === tag ? [item.attributes[key]] : [],
  );
  return values.length > 1 && new Set(values).size === values.length;
};

/** The attribute naming a member's kind, as Dia's `type="Flowchart - Box"`, which a selector can carry; none when `before`, its seed version, holds another, or when every member of its tag in `items`, its list, holds its own (`eachOwn`). */
const kindOf = (member: JsonValue, items: JsonValue, before?: JsonValue) => {
  if (!isXmlElement(member)) return undefined;
  const key = Object.keys(member.attributes).find((name) =>
    KIND_KEY.test(name),
  );
  const value = key === undefined ? undefined : member.attributes[key];
  return key === undefined ||
    typeof value !== "string" ||
    value.includes("][") ||
    eachOwn(items, member.name, key) ||
    (before !== undefined &&
      (!isXmlElement(before) || before.attributes[key] !== value))
    ? undefined
    : { key, value };
};

/** A counted list's key, by its list, tag and kind. */
const keyOf = ({ list, tag, kind }: Counted) =>
  JSON.stringify([list, tag, kind?.key, kind?.value]);

/** Whether a list's element holds text of its own at either end, so its elements are runs of that text. */
const mixed = ({ ends }: CountContext, list: string) =>
  [ends.baseline, ends.final].some((view) => {
    const owner = resolvePointer(view, list.slice(0, -"/children".length));
    return (
      isXmlElement(owner) &&
      owner.children.some(
        (child) => typeof child === "string" && child.trim() !== "",
      )
    );
  });

/** The selector a count matches: the tag, and the kind of the members that changed, as `[name=dia:object][@type=Flowchart - Box]`, so a member of another kind, as a connector, does not count. */
const matchingOf = ({ tag, kind }: Counted) =>
  `[name=${tag}]${kind === undefined ? "" : spellCondition({ prefix: "@", ...kind })}`;

/** A count of a list's members of a tag at one end, as a `member_count` writes it, where both ends hold the list whole by name. */
const countAt = (
  context: CountContext,
  counted: Counted,
  end: "baseline" | "final",
): Suggestion | undefined => {
  const { ends, file } = context;
  if (
    !context.whole(ends.baseline, counted.list) ||
    !context.whole(ends.final, counted.list) ||
    mixed(context, counted.list)
  )
    return undefined;
  return {
    kind: "member_count",
    file,
    pointer: counted.list,
    matching: matchingOf(counted),
    equals: membersOf(ends[end], counted).length,
  };
};

const depth = ({ list }: Counted) => list.split("/").length;

/**
 * The innermost list holding the edited element that a pointer goes through
 * by a member with like siblings at both ends, a record rather than a field
 * of one (`recordOfField`), as Dia's boxes in their layer, not the
 * attributes of the box, or Glade's buttons in their button box, not the
 * dialog's children above them: what "nothing was added or removed" counts
 * for an edit inside one.
 */
const editedList = (
  { ends }: CountContext,
  pointer: string,
): Counted | undefined => {
  const steps = listSteps(pointer, true);
  for (const [index, step] of steps.entries()) {
    const { list } = step;
    const at = `${list}/${step.member}`;
    const member = resolvePointer(ends.final, at);
    const local = isXmlElement(member)
      ? (member.name.split(":").at(-1) ?? member.name)
      : "";
    // A formatting run, as Scribus's ITEXT or SVG's tspan, is not the frame the count guards.
    if (/^(?:itext|tspan|span)$/iu.test(local)) continue;
    if (
      !isXmlElement(member) ||
      recordOfField(ends.final, step, steps.slice(index + 1)) !== undefined
    )
      continue;
    const kind = kindOf(
      member,
      resolvePointer(ends.final, list) ?? null,
      resolvePointer(ends.baseline, at) ?? null,
    );
    const counted = { list, tag: member.name, ...(kind && { kind }) };
    if (
      [ends.baseline, ends.final].every(
        (view) => membersOf(view, counted).length > 1,
      )
    )
      return counted;
  }
  return undefined;
};

/**
 * `member_count` checks and guards for a file's change. Where members were
 * added or removed, a check that the list holds the end's number of members
 * of their tag (`matchingOf`), which fails at the seed since that number
 * changed, at most two, the shallowest first. Where members were only
 * edited, a guard that the list holding the edited record (`editedList`)
 * holds as many as it did, which the end holds too. Never
 * for noise, runs of a text check, an element in mixed content, or a list a
 * selector cannot name whole at both ends.
 */
export const draftCounts = (
  context: CountContext,
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
): { readonly checks: Suggestion[]; readonly guards: Suggestion[] } => {
  const { ends } = context;
  const changed = new Map<string, Counted>();
  const note = (pointer: string, view: JsonValue | null) => {
    const list = listOf(pointer);
    const value = resolvePointer(view, pointer);
    // A member of an element a text check reads is a run of that text.
    if (
      list === undefined ||
      !isXmlElement(value) ||
      context.noisy(pointer) ||
      context.coveredRun(pointer, view) ||
      context.covered(list.slice(0, -"/children".length))
    )
      return;
    const kind = kindOf(value, resolvePointer(view, list) ?? null);
    const counted = { list, tag: value.name, ...(kind && { kind }) };
    changed.set(keyOf(counted), counted);
  };
  for (const pointer of change.added) note(pointer, ends.final);
  for (const pointer of change.removed) note(pointer, ends.baseline);
  const checks = [...changed.values()]
    .toSorted((left, right) => depth(left) - depth(right))
    .filter((counted) => {
      const [seed, end] = [ends.baseline, ends.final].map(
        (view) => membersOf(view, counted).length,
      );
      // A lone member, as a style an app adds for a run, makes no list.
      return seed !== end && Math.max(seed ?? 0, end ?? 0) > 1;
    })
    .flatMap((counted) => countAt(context, counted, "final") ?? [])
    .slice(0, MAX_COUNTS);
  const edited = new Map<string, Counted>();
  for (const pointer of change.changed) {
    const counted = context.noisy(pointer)
      ? undefined
      : editedList(context, pointer);
    if (
      counted !== undefined &&
      !context.covered(counted.list.slice(0, -"/children".length)) &&
      ![...changed.values()].some(
        ({ list, tag }) => list === counted.list && tag === counted.tag,
      )
    )
      edited.set(keyOf(counted), counted);
  }
  // A guard holds at both ends: an edit that also added or removed such a member makes none.
  const guards = [...edited.values()]
    .toSorted((left, right) => depth(left) - depth(right))
    .filter(
      (counted) =>
        membersOf(ends.baseline, counted).length ===
        membersOf(ends.final, counted).length,
    )
    .flatMap((counted) => countAt(context, counted, "baseline") ?? [])
    .slice(0, MAX_COUNT_GUARDS);
  return { checks, guards };
};
