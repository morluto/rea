import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import { sameJson } from "./appTaskChecks.js";
import {
  isCoordinates,
  isRenumberedKey,
  isStamp,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import {
  isIdentifyingAttribute,
  isNameLikeKey,
  isPlaceholder,
  isSaveNumberedId,
  rankAttributes,
} from "./attributeRank.js";
import { holdsTagOnly, pairMembers } from "./memberPairing.js";
import { numberedInOrder } from "./positionalKeys.js";
import {
  elementText,
  escapeToken,
  isXmlElement,
  resolvePointer,
} from "./viewPointer.js";
import { selectorOf, spellCondition } from "./viewSelector.js";

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
    const attribute = check.text_attribute;
    const value = elementText(before, attribute);
    return value.trim() !== "" &&
      value === elementText(after, attribute) &&
      value.length <= context.chars &&
      !isStamp(value)
      ? {
          kind: "text_equals",
          file,
          pointer,
          value,
          ...(attribute === undefined ? {} : { text_attribute: attribute }),
        }
      : undefined;
  }
  return typeof before !== "object" &&
    sameJson(before, after) &&
    !isStamp(before)
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
  const pairing = pairMembers(newer, older, holdsTagOnly(step.list));
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

/** The conditions a sibling's segment selects it by, `@` attributes and `>` children's text. */
const conditionsOf = (member: string) =>
  selectorOf(member.replaceAll("~1", "/").replaceAll("~0", "~")) ?? [];

/** The attribute a path into a member reads, as `name` for `attributes/name`. */
const attributeRead = (rest: readonly string[]) =>
  rest.length === 2 && rest[0] === "attributes"
    ? (rest[1] ?? "").replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined;

/** Whether a guard at a path into a sibling reads what the sibling is selected by: an attribute its segment names, or, for its whole text, a child's text it names. */
const readsSelector = (
  sibling: Sibling,
  rest: readonly string[],
  text: boolean,
) => {
  const read = attributeRead(rest);
  return conditionsOf(sibling.member).some(({ prefix, key }) =>
    text ? prefix === ">" : prefix === "@" && key === read,
  );
};

/** How many members of a tag in a list hold a value of an attribute. */
const holding = (
  list: JsonValue | undefined,
  tag: string,
  key: string,
  value: string,
) =>
  (Array.isArray(list) ? list : []).filter(
    (item) =>
      isXmlElement(item) && item.name === tag && item.attributes[key] === value,
  ).length;

/**
 * The sibling selected by another identifier than the one a guard reads, so
 * the guard says more than that such a member exists, as Tiled's door by
 * `[@id=2]` rather than the `name` the guard checks: an identifier, then a
 * name-like attribute, whose value names the sibling alone among the like
 * members at both ends; undefined when none does.
 */
const rekeyed = (
  context: GuardContext,
  step: ReturnType<typeof listSteps>[number],
  sibling: Sibling,
  avoid: ReadonlySet<string>,
): Sibling | undefined => {
  const { element } = sibling;
  const tag = typeof element.name === "string" ? element.name : "";
  const end = resolvePointer(
    context.ends.final,
    `${step.list}/${sibling.member}`,
  );
  const [newer, older] = [context.ends.final, context.ends.baseline].map(
    (view) => resolvePointer(view, step.list),
  );
  const fields = Object.entries(attributesOf(element)).flatMap(
    ([key, value]) =>
      typeof value === "string" &&
      !avoid.has(key) &&
      !/[=[\]]/u.test(key) &&
      !value.includes("][") &&
      !isStamp(value) &&
      !isPlaceholder(value) &&
      !isRenumberedKey(key) &&
      !isSaveNumberedId(key, value) &&
      isXmlElement(end) &&
      end.attributes[key] === value &&
      holding(newer, tag, key, value) === 1 &&
      holding(older, tag, key, value) === 1
        ? [{ key, value }]
        : [],
  );
  const [best] = [
    ...fields.filter(({ key }) => isIdentifyingAttribute(key)),
    ...fields.filter(
      ({ key }) => !isIdentifyingAttribute(key) && isNameLikeKey(key),
    ),
  ];
  return best === undefined
    ? undefined
    : {
        member: escapeToken(
          `[name=${tag}]${spellCondition({ prefix: "@", ...best })}`,
        ),
        element,
      };
};

/** Whether like members at the seed hold more than one value at a path into them, as Planner's `work` does and its shared `type="normal"` does not. */
const varies = (all: readonly JsonValue[], rest: readonly string[]) =>
  new Set(
    all.map((item) =>
      JSON.stringify(resolvePointer(item, `/${rest.join("/")}`) ?? null),
    ),
  ).size > 1;

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
  all: readonly JsonValue[],
  rest: readonly string[],
) => {
  const own = !readsSelector(sibling, rest, false);
  if (rest.length > 0 && varies(all, rest) && own) return rest;
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
      !numberedInOrder(all, String(sibling.element.name), key) &&
      varies(all, ["attributes", escapeToken(key)])
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
  },
  selected: Sibling,
): Suggestion | undefined => {
  const { step, all } = place;
  const text = check.kind === "text_equals";
  const sibling = readsSelector(selected, step.rest, text)
    ? (rekeyed(
        context,
        step,
        selected,
        new Set(text ? [] : [attributeRead(step.rest) ?? ""]),
      ) ?? selected)
    : selected;
  const field = text ? step.rest : guardField(sibling, all, step.rest);
  const guard =
    field === undefined
      ? undefined
      : guardAt(
          context,
          check,
          [step.list, sibling.member, ...field].join("/"),
        );
  // Its whole text, when that is the child's text it is selected by, says no more than its selector.
  return guard !== undefined &&
    text &&
    "value" in guard &&
    conditionsOf(sibling.member).some(
      ({ prefix, value }) => prefix === ">" && value === guard.value,
    )
    ? undefined
    : guard;
};

type Step = ReturnType<typeof listSteps>[number];

/** Whether a step's member is named as a field is, by a name-like attribute alone, as QElectroTech's `elementInformation[@name=label]`. */
const namedAsField = (step: Step) => {
  const [only, ...more] = conditionsOf(step.member).filter(
    ({ prefix }) => prefix !== "",
  );
  return (
    only !== undefined &&
    more.length === 0 &&
    only.prefix === "@" &&
    isNameLikeKey(only.key)
  );
};

/** Whether a like sibling of an outer step's member holds the field a step goes through, at the same path, as every component holds its `label`. */
const sharedField = (context: GuardContext, step: Step, outer: Step) => {
  const records = resolvePointer(context.ends.final, outer.list);
  const record = resolvePointer(
    context.ends.final,
    `${outer.list}/${outer.member}`,
  );
  const inner = outer.rest.slice(0, outer.rest.length - step.rest.length);
  return (
    Array.isArray(records) &&
    isXmlElement(record) &&
    records.some(
      (item) =>
        item !== record &&
        isXmlElement(item) &&
        item.name === record.name &&
        resolvePointer(item, `/${inner.join("/")}`) !== undefined,
    )
  );
};

/**
 * A check's list steps in the order guards try them: innermost first, but
 * for a member named as a field (`namedAsField`), first the nearest record
 * out whose like siblings hold that field too (`sharedField`), so the other
 * components' labels guard a component's label rather than its other fields.
 */
const guardSteps = (context: GuardContext, pointer: string): Step[] => {
  const steps = listSteps(pointer);
  return steps.flatMap((step, index) => {
    const outer = namedAsField(step)
      ? steps
          .slice(index + 1)
          .find((candidate) => sharedField(context, step, candidate))
      : undefined;
    return outer === undefined ? [step] : [outer, step];
  });
};

/** Up to two guards for one check: a field on like siblings of the innermost list it goes through that has any, a record's before its other fields (`guardSteps`), preferring one that varies among them. */
const guardsFor = (context: GuardContext, check: Suggestion): Suggestion[] => {
  if (check.kind !== "value_equals" && check.kind !== "text_equals") return [];
  for (const step of guardSteps(context, check.pointer)) {
    const { siblings, all } = siblingsOf(context, step);
    const guards: Suggestion[] = [];
    for (const sibling of siblings) {
      const guard = siblingGuard(context, check, { step, all }, sibling);
      if (guard !== undefined) guards.push(guard);
      if (guards.length === MAX_GUARDS_PER_CHECK) break;
    }
    if (guards.length > 0) return guards;
  }
  return [];
};

/**
 * Checks that the rest stays as it was, for an author to add by choice: a
 * field on up to two like siblings of the innermost list each suggested check
 * goes through, nearest first, at its seed value, which the end holds too: the
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
  const guards: Suggestion[] = [];
  for (const check of suggested)
    for (const guard of guardsFor(context, check))
      if ("pointer" in guard && !taken.has(guard.pointer)) {
        taken.add(guard.pointer);
        guards.push(guard);
      }
  // A coordinate an app may derive says less that the rest stayed than text does.
  const placed = (guard: Suggestion) =>
    "value" in guard && isCoordinates(guard.value) ? 1 : 0;
  return guards
    .toSorted((left, right) => placed(left) - placed(right))
    .slice(0, MAX_GUARDS);
};
