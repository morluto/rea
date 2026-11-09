import type { JsonValue } from "../jsonValue.js";
import { collapseWhitespace, type DesktopTaskCheckInput } from "./appTask.js";
import { sameJson } from "./appTaskChecks.js";
import { holdsSplitDate, isCoordinates, isStamp } from "./appTaskDraftNoise.js";
import { holdsNoisyText } from "./appTaskDraftText.js";
import { decimalOf, valueEqualsCheck } from "./appTaskDraftScalars.js";
import {
  isIdentifyingAttribute,
  isNameLikeKey,
  isPlaceholder,
  isSaveNumberedId,
  rankAttributes,
} from "./attributeRank.js";
import { holdsTagOnly, pairMembers } from "./memberPairing.js";
import {
  listSteps,
  recordOfField,
  type ListStep,
} from "./appTaskDraftSteps.js";
import { numberedInOrder } from "./positionalKeys.js";
import {
  elementText,
  escapeToken,
  isXmlElement,
  resolvePointer,
} from "./viewPointer.js";
import { selectorOf, spellCondition, type Condition } from "./viewSelector.js";
import { childConditions } from "./selectorCandidates.js";

type Suggestion = DesktopTaskCheckInput;

/** Guards a file's draft offers, and how many one suggested check takes. */
export const MAX_GUARDS = 4;
export const MAX_GUARDS_PER_CHECK = 2;
/** Like siblings a guard is sought on per list, nearest first, so a long list costs no more than a short one. */
export const MAX_SIBLINGS_READ = 16;

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
  const before = resolvePointer(ends.baseline, pointer, "xml");
  const after = resolvePointer(ends.final, pointer, "xml");
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
    const attribute = check.text_attribute;
    // A check comparing collapsed whitespace has guards that do too.
    const collapsed = check.normalize_whitespace === true;
    const read = (element: JsonValue) => {
      const text = elementText(element, attribute);
      return collapsed ? collapseWhitespace(text) : text;
    };
    const value = read(before);
    return value.trim() !== "" &&
      value === read(after) &&
      value.length <= context.chars &&
      (attribute !== undefined ||
        (!holdsNoisyText(before) &&
          !holdsNoisyText(after) &&
          !holdsSplitDate(ends.baseline, pointer) &&
          !holdsSplitDate(ends.final, pointer))) &&
      !isStamp(value)
      ? {
          kind: "text_equals",
          file,
          pointer,
          value,
          ...(attribute === undefined ? {} : { text_attribute: attribute }),
          ...(collapsed ? { normalize_whitespace: true } : {}),
        }
      : undefined;
  }
  return typeof before !== "object" &&
    sameJson(before, after) &&
    !isStamp(before) &&
    (typeof before !== "string" || before.length <= context.chars)
    ? valueEqualsCheck(file, pointer, before)
    : undefined;
};

/** A like sibling of a checked member: its pointer by the selector it pairs by at both ends, and its element at the seed. */
interface Sibling {
  readonly member: string;
  readonly element: Record<string, JsonValue>;
}

/**
 * How many of the attributes placing a member a sibling holds alike: those
 * its selector names it by and those naming its type, among those whose
 * values vary across the like members, as a spreadsheet cell shares its
 * `Row` or `Col` and its `ValueType` with the cells beside it in its row or
 * column, and nothing with a label in another row.
 */
const sharing = (
  member: Record<string, JsonValue>,
  likes: readonly JsonValue[],
  key: string,
) => {
  const own = attributesOf(member);
  const selected = new Set(
    (selectorOf(key.replaceAll("~1", "/").replaceAll("~0", "~")) ?? []).map(
      ({ key: name }) => name,
    ),
  );
  const varying = Object.keys(own).filter(
    (key) =>
      (selected.has(key) || /type$/iu.test(key)) &&
      new Set(
        [member, ...likes].map((item) =>
          isXmlElement(item) ? item.attributes[key] : undefined,
        ),
      ).size > 1,
  );
  return (item: JsonValue) =>
    isXmlElement(item)
      ? varying.filter((key) => item.attributes[key] === own[key]).length
      : 0;
};

/** The like siblings of the member a step goes through, those sharing most of its attributes (`sharing`) and then the nearest first, each paired by a selector, not by position or a renumbered id, and every like member at the seed. */
const siblingsOf = (
  context: GuardContext,
  step: ReturnType<typeof listSteps>[number],
): { readonly siblings: Sibling[]; readonly all: JsonValue[] } => {
  const newer = resolvePointer(context.ends.final, step.list, "xml");
  const older = resolvePointer(context.ends.baseline, step.list, "xml");
  const member = resolvePointer(
    context.ends.final,
    `${step.list}/${step.member}`,
    "xml",
  );
  if (!Array.isArray(newer) || !Array.isArray(older) || !isXmlElement(member))
    return { siblings: [], all: [] };
  const at = newer.indexOf(member);
  const likes = newer
    .map((item, index) => ({ item, index }))
    .filter(
      ({ item, index }) =>
        index !== at && isXmlElement(item) && item.name === member.name,
    );
  const shares = sharing(
    member,
    likes.map(({ item }) => item),
    step.member,
  );
  likes.sort(
    (left, right) =>
      shares(right.item) - shares(left.item) ||
      Math.abs(left.index - at) - Math.abs(right.index - at) ||
      left.index - right.index,
  );
  const all = older.filter(
    (item) => isXmlElement(item) && item.name === member.name,
  );
  if (likes.length === 0) return { siblings: [], all };
  const pairing = pairMembers(newer, older, holdsTagOnly(step.list), "xml");
  return {
    siblings: likes.flatMap(({ index }) => {
      const key = pairing.newer.keys[index];
      const partner = pairing.newer.partners[index];
      const element = partner === undefined ? undefined : older[partner];
      return key === undefined ||
        /^\d+$/u.test(key) ||
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

/** The conditions a sibling's segment selects it by, `@` attributes and `>` children's text. */
const conditionsOf = (member: string) =>
  selectorOf(member.replaceAll("~1", "/").replaceAll("~0", "~")) ?? [];

/** The attribute a path into a member reads, as `name` for `attributes/name`. */
const attributeRead = (rest: readonly string[]) =>
  rest.length === 2 && rest[0] === "attributes"
    ? (rest[1] ?? "").replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined;

/** What a guard at a path into a sibling reads at the seed: an attribute's value, or an element's whole text, trimmed. */
const readAt = (sibling: Sibling, rest: readonly string[]) => {
  const value =
    rest.length === 0
      ? sibling.element
      : resolvePointer(sibling.element, `/${rest.join("/")}`, "xml");
  return (
    isXmlElement(value)
      ? elementText(value)
      : typeof value === "string"
        ? value
        : ""
  ).trim();
};

/**
 * Whether a condition selects a sibling by what a guard reads, so the guard
 * proves only that such a member exists: the attribute it reads, as Tiled's
 * `[@name=Blacksmith Door]` for its `name`, or a value that is or holds the
 * text it reads, as Glade's `[>object=CancelTrueTrueTrue]` for a button's
 * `Cancel` label.
 */
const selectsByRead = (
  condition: Condition,
  read: string | undefined,
  text: string,
) =>
  condition.prefix !== "" &&
  ((condition.prefix === "@" && condition.key === read) ||
    condition.value === text ||
    (text.length >= 3 &&
      /\p{L}/u.test(text) &&
      condition.value.includes(text)));

/** Whether a guard at a path into a sibling reads what the sibling is selected by (`selectsByRead`). */
const readsSelector = (sibling: Sibling, rest: readonly string[]) => {
  const [read, text] = [attributeRead(rest), readAt(sibling, rest)];
  return conditionsOf(sibling.member).some((condition) =>
    selectsByRead(condition, read, text),
  );
};

/**
 * The sibling selected by another condition than what a guard reads
 * (`selectsByRead`), as Tiled's door by `[@id=2]` rather than the `name` the
 * guard checks, or Glade's Cancel button by `[>packing=TrueTrue0]` rather
 * than the child holding its label: an identifier, a name-like attribute,
 * then a child's text, naming the sibling alone at both ends; undefined
 * when none does.
 */
const rekeyed = (
  context: GuardContext,
  step: ListStep,
  sibling: Sibling,
): Sibling | undefined => {
  const { element } = sibling;
  const tag = typeof element.name === "string" ? element.name : "";
  const [read, text] = [attributeRead(step.rest), readAt(sibling, step.rest)];
  const attributes = Object.entries(attributesOf(element)).flatMap(
    ([key, value]) =>
      typeof value === "string" &&
      (isIdentifyingAttribute(key) || isNameLikeKey(key)) &&
      !/[=[\]]/u.test(key) &&
      !value.includes("][") &&
      !isStamp(value) &&
      !isPlaceholder(value) &&
      !isSaveNumberedId(key, value)
        ? [{ prefix: "@" as const, key, value }]
        : [],
  );
  const candidates = [
    ...attributes.filter(({ key }) => isIdentifyingAttribute(key)),
    ...attributes.filter(({ key }) => !isIdentifyingAttribute(key)),
    ...childConditions(element).flatMap((spelled) => selectorOf(spelled) ?? []),
  ].filter((condition) => !selectsByRead(condition, read, text));
  const at = (member: string, view: JsonValue | null) =>
    resolvePointer(view, `${step.list}/${member}`, "xml");
  const end = at(sibling.member, context.ends.final);
  for (const condition of candidates) {
    const member = escapeToken(`[name=${tag}]${spellCondition(condition)}`);
    if (
      at(member, context.ends.baseline) === element &&
      at(member, context.ends.final) === end
    )
      return { member, element };
  }
  return undefined;
};

/** Whether like members at the seed hold more than one value at a path into them, as Planner's `work` does and its shared `type="normal"` does not; each path read once. */
const variesAmong = (all: readonly JsonValue[]) => {
  const known = new Map<string, boolean>();
  return (rest: readonly string[]): boolean => {
    const pointer = `/${rest.join("/")}`;
    const varied =
      known.get(pointer) ??
      new Set(
        all.map((item) =>
          JSON.stringify(resolvePointer(item, pointer, "xml") ?? null),
        ),
      ).size > 1;
    known.set(pointer, varied);
    return varied;
  };
};

/**
 * The path into a sibling a guard reads: the check's own field where like
 * members hold different values in it and the sibling's selector does not
 * name it; otherwise, as for a tag or a default every sibling shares, the
 * sibling's best ranked attribute that varies, one a user sets, as Planner's
 * `work`, and not one numbering the members in order, as MyPaint's `src`;
 * the check's own field when none does, unless the selector names it,
 * as a guard of the `name` it selects the sibling by proves only that such a
 * member exists.
 */
const guardField = (
  sibling: Sibling,
  {
    all,
    varies,
  }: {
    readonly all: readonly JsonValue[];
    readonly varies: (rest: readonly string[]) => boolean;
  },
  rest: readonly string[],
) => {
  const own = !readsSelector(sibling, rest);
  if (rest.length > 0 && varies(rest) && own) return rest;
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
      !isStamp(value) &&
      !numberedInOrder(all, String(sibling.element.name), key) &&
      varies(["attributes", escapeToken(key)])
        ? [{ key, value }]
        : [],
    ),
  );
  if (best !== undefined) return ["attributes", escapeToken(best.key)];
  return own ? rest : undefined;
};

/** The guard a check gives on one like sibling: its field (`guardField`), with the sibling selected by another identifier where its selector names what the guard reads (`rekeyed`). */
const siblingGuard = (
  context: GuardContext,
  check: Suggestion,
  place: {
    readonly step: ReturnType<typeof listSteps>[number];
    readonly all: readonly JsonValue[];
    readonly varies: (rest: readonly string[]) => boolean;
  },
  selected: Sibling,
): Suggestion | undefined => {
  const { step, all, varies } = place;
  const sibling = readsSelector(selected, step.rest)
    ? (rekeyed(context, step, selected) ?? selected)
    : selected;
  const field =
    check.kind === "value_equals" &&
    "tolerance" in check &&
    step.rest.length === 0
      ? []
      : check.kind === "text_equals"
        ? step.rest
        : guardField(sibling, { all, varies }, step.rest);
  // A guard reading what its sibling is selected by says no more than that the member exists.
  return field === undefined || readsSelector(sibling, field)
    ? undefined
    : guardAt(context, check, [step.list, sibling.member, ...field].join("/"));
};

type Step = ListStep;

/**
 * A check's list steps in the order guards try them: innermost first, but
 * for a field, first the record it is a field of (`recordOfField`), so the
 * other components' labels guard a component's label rather than its other
 * fields.
 */
const guardSteps = (context: GuardContext, pointer: string): Step[] => {
  const steps = listSteps(pointer);
  return steps.flatMap((step, index) => {
    const outer = recordOfField(
      context.ends.final,
      step,
      steps.slice(index + 1),
    );
    return outer === undefined ? [step] : [outer, step];
  });
};

/** Up to two guards for one check: a field on the `MAX_SIBLINGS_READ` nearest like siblings of the innermost list it goes through that has any, a record's before its other fields (`guardSteps`), preferring one that varies among them, stopping once it has two. */
const guardsFor = (context: GuardContext, check: Suggestion): Suggestion[] => {
  if (check.kind !== "value_equals" && check.kind !== "text_equals") return [];
  for (const step of guardSteps(context, check.pointer)) {
    const { siblings, all } = siblingsOf(context, step);
    const varies = variesAmong(all);
    const guards: Suggestion[] = [];
    for (const sibling of siblings.slice(0, MAX_SIBLINGS_READ)) {
      if (guards.length === MAX_GUARDS_PER_CHECK) break;
      const guard = siblingGuard(
        context,
        check,
        { step, all, varies },
        sibling,
      );
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
 * `MAX_GUARDS` a file, none at a suggested pointer, coordinates last.
 */
export const draftGuards = (
  context: GuardContext,
  suggested: readonly Suggestion[],
): Suggestion[] => {
  const taken = new Set(
    suggested.flatMap((check) => ("pointer" in check ? [check.pointer] : [])),
  );
  // A coordinate an app may derive says less that the rest stayed than text does.
  const placed = (guard: Suggestion) =>
    "value" in guard && isCoordinates(guard.value) ? 1 : 0;
  const guards: Suggestion[] = [];
  for (const check of suggested) {
    // Later checks' guards sort after these, so four that are no coordinate settle the file's.
    if (guards.filter((guard) => placed(guard) === 0).length >= MAX_GUARDS)
      break;
    for (const guard of guardsFor(context, check))
      if ("pointer" in guard && !taken.has(guard.pointer)) {
        taken.add(guard.pointer);
        guards.push(guard);
      }
  }
  return guards
    .toSorted((left, right) => placed(left) - placed(right))
    .slice(0, MAX_GUARDS);
};
