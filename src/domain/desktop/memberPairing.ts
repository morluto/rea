import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";
import {
  isGeneratedId,
  isGuid,
  isIdentifyingAttribute,
  isPlaceholder,
  isSaveNumberedId,
  rankAttributes,
} from "./attributeRank.js";
import {
  isPositionalKey,
  numberedInOrder,
  positionalKeys,
  savePositionKeys,
} from "./positionalKeys.js";
import {
  childConditions,
  condition,
  countUnspelledPairs,
  holdingCondition,
  MAX_PAIRED,
  pairSuffix,
  type Attribute,
  type Candidates,
} from "./selectorCandidates.js";
import { pairRecordsById } from "./jsonRecordPairing.js";
import { resolvePointer } from "./viewPointer.js";
import { selectorOf } from "./viewSelector.js";

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, JsonValue>, key: string) =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** A value a selector can carry and that stays the same between saves. */
const selectable = (value: string) =>
  !value.includes("][") && !isTimestamp(value) && !isPlaceholder(value);

/** An attribute name a selector can carry. */
const attributeName = (key: string) => key !== "" && !/[=[\]]/u.test(key);

/** Two-attribute selectors from the attributes `paired`, the best ranked pairs first. */
const pairsOf = (paired: readonly (Attribute & { tier: number })[]) =>
  paired
    .flatMap((first, index) =>
      paired.slice(index + 1).map((second) => ({
        tier: first.tier + second.tier,
        suffix: pairSuffix(first, second),
      })),
    )
    .toSorted((left, right) => left.tier - right.tier)
    .map(({ suffix }) => suffix);

/**
 * The selectors that could name a member, most general first: `[name=N]`;
 * then its identifiers, a `name` attribute first; then each other attribute
 * by itself, a name-like key, a worded value or a small integer first; then
 * two of the best `MAX_PAIRED` of those together; then a coordinate, a long
 * number or a token by itself, and an id an ODF app numbers anew on each save
 * (`isSaveNumberedId`); then a child element's text, as Osmo's record
 * by `[>first_name=Delphine]` (`childConditions`), for an element no
 * identifier names; last, an id the app generates (`isGeneratedId`), as
 * Freeplane's `ID_329023692`, or a GUID in any attribute, as VYM's `uuid`,
 * after an identifier numbering the members by save position
 * (`savePositionKeys`), as Parley's `<entry id="6">`, where a child's text
 * names the member.
 * All are counted over every sibling, so a selector several siblings match
 * is never taken for one naming a member alone; but an element with
 * identifying attributes is keyed by those alone,
 * so one whose identifiers are new is another element, whatever else it
 * shares. An identifier the app numbers by position (`positional`) names no
 * member. The ids number the name among those seen, so a name is spelled
 * into a selector only once one is chosen, not per attribute.
 */
const candidatesOf = (
  member: JsonValue,
  names: Map<string, number>,
  positional: ReadonlySet<string>,
  saved: ReadonlySet<string>,
): Candidates | undefined => {
  if (!isRecord(member)) return undefined;
  const name = own(member, "name");
  if (typeof name !== "string" || !selectable(name)) return undefined;
  const attributes = own(member, "attributes");
  const usable = (
    isRecord(attributes) ? Object.entries(attributes) : []
  ).flatMap(([key, value]) =>
    typeof value === "string" &&
    attributeName(key) &&
    selectable(value) &&
    !isPositionalKey(positional, name, key)
      ? [{ key, value }]
      : [],
  );
  // An id the app generates names a kept member, but no new one another save would key alike, so it ranks last.
  const children = childConditions(member);
  // An id numbering the members by save position names one after a child's text does.
  const placed =
    children.length === 0
      ? []
      : usable.filter(
          ({ key }) =>
            isIdentifyingAttribute(key) && isPositionalKey(saved, name, key),
        );
  const generated = usable.filter(
    (field) =>
      !placed.includes(field) &&
      ((isIdentifyingAttribute(field.key) && isGeneratedId(field.value)) ||
        isGuid(field.value)),
  );
  // An id the app numbers anew on each save names no member past it: it ranks with the tokens.
  const numbered = usable.filter(({ key, value }) =>
    isSaveNumberedId(key, value),
  );
  const identities = usable.filter(
    (field) =>
      isIdentifyingAttribute(field.key) &&
      !generated.includes(field) &&
      !numbered.includes(field) &&
      !placed.includes(field),
  );
  const named = (key: string) => key.toLowerCase() === "name";
  const ranked = [
    ...rankAttributes(
      usable.filter(
        (field) =>
          !isIdentifyingAttribute(field.key) && !generated.includes(field),
      ),
    ),
    ...numbered.map((field) => ({ ...field, tier: 3 as const })),
  ];
  const pairable = ranked.filter(({ tier }) => tier < 3);
  const suffixes = [
    "",
    ...[
      ...identities.filter(({ key }) => named(key)),
      ...identities.filter(({ key }) => !named(key)),
      ...pairable,
    ].map(condition),
    ...pairsOf(pairable.slice(0, MAX_PAIRED)),
    ...ranked.filter(({ tier }) => tier === 3).map(condition),
  ];
  // Counted on every member, one its identifiers key included, since the evaluator matches any member holding the child.
  suffixes.push(
    ...children,
    ...placed.map(condition),
    ...generated.map(condition),
  );
  const number = names.get(name) ?? names.size;
  names.set(name, number);
  // A suffix is empty or opens with `[`, so the number before it cannot run into it.
  const ids = suffixes.map((suffix) => `${String(number)}${suffix}`);
  const choosable =
    identities.length > 0 ? identities.length + 1 : suffixes.length;
  return {
    name,
    number,
    ids,
    choosable,
    byChild:
      suffixes.length - children.length - placed.length - generated.length,
    identified: identities.length + 1,
    generated: generated.length,
    pairable: pairable.map(({ key }) => key),
  };
};

/**
 * The candidates a member present in both versions pairs by, in order: its
 * tag and stable identifiers, then an id the app generated, which a kept
 * member keeps, as a record's UUID however its title changes, then the rest
 * it may be keyed by. A new member is keyed with that id last (`unmatched`).
 */
const pairingOrder = ({
  ids,
  choosable,
  identified,
  generated,
}: Candidates): number[] => {
  const last = ids.length - generated;
  const ranks = Array.from({ length: ids.length }, (_, at) => at);
  return [
    ...ranks.slice(0, Math.min(identified, choosable)),
    ...ranks.slice(last),
    ...ranks.slice(Math.min(identified, choosable), Math.min(choosable, last)),
  ];
};

/** The selector a member's candidate at `index` spells: its name, then its id past the name's number. */
const selectorAt = ({ name, number, ids }: Candidates, index: number) =>
  `[name=${name}]${(ids[index] ?? "").slice(String(number).length)}`;

const countIds = (members: readonly (Candidates | undefined)[]) => {
  const counts = new Map<string, number>();
  for (const candidates of members)
    for (const id of candidates?.ids ?? [])
      counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
};

/** Each member's place among the members of its tag, as the tag and how many come before it; none for a member with no tag. */
const placesOf = (members: readonly JsonValue[]) => {
  const seen = new Map<string, number>();
  return members.map((member) => {
    const name = isRecord(member) ? own(member, "name") : undefined;
    if (typeof name !== "string") return undefined;
    const before = seen.get(name) ?? 0;
    seen.set(name, before + 1);
    return `${String(before)}\u0000${name}`;
  });
};

/**
 * Whether two members are one element renamed: the same tag and attribute
 * keys, one identifier's value changed and every other attribute and the
 * children alike, as MyPaint renames a layer.
 */
const renamed = (newer: JsonValue, older: JsonValue) => {
  if (!isRecord(newer) || !isRecord(older)) return false;
  const [after, before] = [own(newer, "attributes"), own(older, "attributes")];
  if (
    own(newer, "name") !== own(older, "name") ||
    !isRecord(after) ||
    !isRecord(before)
  )
    return false;
  const keys = Object.keys(after);
  const changed = keys.filter((key) => own(before, key) !== after[key]);
  const [key] = changed;
  return (
    keys.length === Object.keys(before).length &&
    changed.length === 1 &&
    key !== undefined &&
    Object.hasOwn(before, key) &&
    isIdentifyingAttribute(key) &&
    JSON.stringify(own(newer, "children")) ===
      JSON.stringify(own(older, "children"))
  );
};

/** An element's attributes; none for any other value. */
const attributesOf = (member: JsonValue) => {
  const attributes = isRecord(member) ? own(member, "attributes") : undefined;
  return isRecord(attributes) ? attributes : {};
};

/** One version's members as a pairing reads and fills them. */
interface Pairing {
  readonly members: readonly JsonValue[];
  readonly candidates: readonly (Candidates | undefined)[];
  readonly counts: ReadonlyMap<string, number>;
  readonly keys: (string | undefined)[];
  readonly partners: (number | undefined)[];
}

/**
 * The keys of a member `renamed` where the attribute it pairs by numbers the
 * members in order, as MyPaint's `src`, which a move renumbers: each
 * version's own value of the renamed identifier, as `[@name=Crescent Moon]`
 * and `[@name=Sketch]`, where each names its member alone; undefined
 * otherwise, and the pairing keeps the attribute.
 */
const renameKeys = (
  sides: { readonly newer: Pairing; readonly older: Pairing },
  at: { readonly index: number; readonly match: number; readonly id: string },
) => {
  const { newer, older } = sides;
  const candidates = newer.candidates[at.index];
  const [after, before] = [
    attributesOf(newer.members[at.index] ?? null),
    attributesOf(older.members[at.match] ?? null),
  ];
  const paired =
    candidates === undefined
      ? undefined
      : selectorOf(at.id.slice(String(candidates.number).length))?.[0]?.key;
  const key = Object.keys(after).find((name) => after[name] !== before[name]);
  if (
    candidates === undefined ||
    paired === undefined ||
    key === undefined ||
    !numberedInOrder(newer.members, candidates.name, paired) ||
    !numberedInOrder(older.members, candidates.name, paired)
  )
    return undefined;
  const spelled = (side: Pairing, value: JsonValue | undefined) => {
    const suffix = typeof value === "string" ? condition({ key, value }) : "";
    return suffix !== "" &&
      side.counts.get(`${String(candidates.number)}${suffix}`) === 1
      ? `[name=${candidates.name}]${suffix}`
      : undefined;
  };
  const [mine, theirs] = [
    spelled(newer, after[key]),
    spelled(older, before[key]),
  ];
  return mine === undefined || theirs === undefined
    ? undefined
    : { newer: mine, older: theirs };
};

/**
 * Pair, as one element `renamed`, a member of each version left unpaired at
 * the same place among the members of its tag, by its first selector past
 * its identifiers that names it alone in both versions with the same value,
 * as a layer by its `src`; left unpaired when none does. Where that selector
 * numbers the members in order, each version keys it by its own name
 * (`renameKeys`).
 */
const pairRenamed = (newer: Pairing, older: Pairing) => {
  const unpaired = new Map<string, number>();
  placesOf(older.members).forEach((place, index) => {
    if (place !== undefined && older.partners[index] === undefined)
      unpaired.set(place, index);
  });
  placesOf(newer.members).forEach((place, index) => {
    const match = place === undefined ? undefined : unpaired.get(place);
    const candidates = newer.candidates[index];
    const theirs = match === undefined ? undefined : older.candidates[match];
    if (
      match === undefined ||
      candidates === undefined ||
      theirs === undefined ||
      newer.partners[index] !== undefined ||
      !renamed(newer.members[index] ?? null, older.members[match] ?? null)
    )
      return;
    const at = candidates.ids.findIndex(
      (id, position) =>
        position >= candidates.choosable &&
        newer.counts.get(id) === 1 &&
        older.counts.get(id) === 1 &&
        theirs.ids.includes(id),
    );
    if (at < 0) return;
    const keys = renameKeys(
      { newer, older },
      { index, match, id: candidates.ids[at] ?? "" },
    );
    newer.keys[index] = keys?.newer ?? selectorAt(candidates, at);
    older.keys[match] = keys?.older ?? selectorAt(candidates, at);
    newer.partners[index] = match;
    older.partners[match] = index;
  });
};

/** Whether pairing a list holds its members' tag-only keys: the children of a document's root element, where an app may add a container of the tag, as Dia a layer. */
/** Where a list sits, for its members' `holdingCondition`: whether it is the document root's children, and the tag the step to its element names, when one does. */
export interface ListPlace {
  readonly root: boolean;
  readonly owner?: string;
}

/** A list's place, read from its pointer, as `/root/children/[name=gnm:Sheets]/children` sits in `gnm:Sheets`. */
export const holdsTagOnly = (list: string): ListPlace => {
  const owner = selectorOf(
    (list.split("/").at(-2) ?? "").replaceAll("~1", "/").replaceAll("~0", "~"),
  )?.find(({ prefix, key }) => prefix === "" && key === "name")?.value;
  return {
    root: /(?:^|\/)root\/children$/u.test(list),
    ...(owner === undefined ? {} : { owner }),
  };
};

/** Whether a tag is the singular of a list's, as `gnm:Sheet` of `gnm:Sheets`, so the list holds or could hold several. */
const pluralOf = (owner: string | undefined, tag: string) => {
  const [list, one] = [owner?.toLowerCase() ?? "", tag.toLowerCase()];
  return (
    list === `${one}s` ||
    list === `${one}es` ||
    (one.endsWith("y") && list === `${one.slice(0, -1)}ies`)
  );
};

/**
 * Give each member of a pair its tag alone names a `holdingCondition`, so it
 * stays named if a sibling of its tag appears: in the root's children, and
 * in a list named for its tag, as `gnm:Sheets` holds a `gnm:Sheet`.
 */
const holdTagOnly = (newer: Pairing, older: Pairing, place: ListPlace) => {
  newer.partners.forEach((match, index) => {
    const candidates = newer.candidates[index];
    const deep =
      candidates !== undefined && pluralOf(place.owner, candidates.name);
    if (
      match === undefined ||
      candidates === undefined ||
      newer.keys[index] !== `[name=${candidates.name}]` ||
      (!place.root && !deep)
    )
      return;
    const held = holdingCondition(
      newer.members[index] ?? null,
      older.members[match] ?? null,
      !place.root,
    );
    if (held !== undefined)
      newer.keys[index] = older.keys[match] =
        `[name=${candidates.name}]${held}`;
  });
};

/** One version's side of a pairing: each member's key, and the other version's member it pairs with. */
interface PairedSide {
  readonly keys: readonly string[];
  readonly partners: readonly (number | undefined)[];
}

/**
 * Pair the members of two versions of an array one to one. A member pairs by
 * its first candidate selector naming it alone in its version and one unpaired
 * member of the other, whichever before it name nothing there; then one
 * element renamed by another selector (`pairRenamed`). One with no partner
 * keeps its first selector naming it alone and nothing in the other version.
 * Members left without a selector are keyed and paired by position; so is an
 * identifier the app numbers by position, as `positionalKeys` finds. Given
 * the list's `place`, a pair its tag alone names also gets a
 * `holdingCondition` (`holdTagOnly`).
 */
const pairElements = (
  newer: readonly JsonValue[],
  older: readonly JsonValue[],
  place?: ListPlace,
): { readonly newer: PairedSide; readonly older: PairedSide } => {
  const names = new Map<string, number>();
  const positional = positionalKeys(newer, older);
  const saved = savePositionKeys(newer, older);
  const newCandidates = newer.map((member) =>
    candidatesOf(member, names, positional, saved),
  );
  const oldCandidates = older.map((member) =>
    candidatesOf(member, names, positional, saved),
  );
  const newCounts = countIds(newCandidates);
  const oldCounts = countIds(oldCandidates);
  countUnspelledPairs([
    { members: newer, candidates: newCandidates, counts: newCounts },
    { members: older, candidates: oldCandidates, counts: oldCounts },
  ]);
  const count = (counts: ReadonlyMap<string, number>, id: string) =>
    counts.get(id) ?? 0;
  const oldById = new Map<string, number>();
  oldCandidates.forEach((candidates, index) => {
    for (const at of candidates === undefined ? [] : pairingOrder(candidates)) {
      const id = candidates?.ids[at] ?? "";
      if (count(oldCounts, id) === 1) oldById.set(id, index);
    }
  });
  const newKeys: (string | undefined)[] = newer.map(() => undefined);
  const oldKeys: (string | undefined)[] = older.map(() => undefined);
  const newPartners: (number | undefined)[] = newer.map(() => undefined);
  const oldPartners: (number | undefined)[] = older.map(() => undefined);
  newCandidates.forEach((candidates, index) => {
    if (candidates === undefined) return;
    for (const at of pairingOrder(candidates)) {
      const id: string = candidates.ids[at] ?? "";
      const match = count(newCounts, id) === 1 ? oldById.get(id) : undefined;
      if (match === undefined || oldPartners[match] !== undefined) continue;
      newKeys[index] = oldKeys[match] = selectorAt(candidates, at);
      newPartners[index] = match;
      oldPartners[match] = index;
      return;
    }
  });
  const sides = [
    {
      members: newer,
      candidates: newCandidates,
      counts: newCounts,
      keys: newKeys,
      partners: newPartners,
    },
    {
      members: older,
      candidates: oldCandidates,
      counts: oldCounts,
      keys: oldKeys,
      partners: oldPartners,
    },
  ] as const;
  pairRenamed(...sides);
  if (place !== undefined) holdTagOnly(...sides, place);
  /**
   * The first selector naming a member alone in its version and nothing in
   * the other; by a child's text only where the list's length changed, since
   * otherwise a member whose naming child an edit changed is that member.
   */
  const unmatched = (
    candidates: Candidates | undefined,
    here: ReadonlyMap<string, number>,
    there: ReadonlyMap<string, number>,
  ) => {
    if (candidates === undefined) return undefined;
    const last =
      newer.length === older.length ? candidates.byChild : candidates.choosable;
    const at = candidates.ids
      .slice(0, Math.min(candidates.choosable, last))
      .findIndex((id) => count(here, id) === 1 && count(there, id) === 0);
    return at < 0 ? undefined : selectorAt(candidates, at);
  };
  newCandidates.forEach((candidates, index) => {
    newKeys[index] ??= unmatched(candidates, newCounts, oldCounts);
  });
  oldCandidates.forEach((candidates, index) => {
    oldKeys[index] ??= unmatched(candidates, oldCounts, newCounts);
  });
  for (let index = 0; index < Math.min(newer.length, older.length); index += 1)
    if (newKeys[index] === undefined && oldKeys[index] === undefined) {
      newPartners[index] = index;
      oldPartners[index] = index;
    }
  const side = (
    keys: readonly (string | undefined)[],
    partners: readonly (number | undefined)[],
  ): PairedSide => ({
    keys: keys.map((key, index) => key ?? String(index)),
    partners,
  });
  return {
    newer: side(newKeys, newPartners),
    older: side(oldKeys, oldPartners),
  };
};

/** Pair the members of two versions of an array one to one: JSON records by an id field each holds (`pairRecordsById`), others by selector (`pairElements`). */
export const pairMembers = (
  newer: readonly JsonValue[],
  older: readonly JsonValue[],
  place?: ListPlace,
): { readonly newer: PairedSide; readonly older: PairedSide } =>
  pairRecordsById(newer, older) ?? pairElements(newer, older, place);

/**
 * The member a pointer names at the end, as its seed version: the other
 * version's member it pairs with in the same list, as a layer `renameKeys`
 * keys by its new name pairs with the layer of its old one; undefined when
 * the pointer names no member of a list.
 */
export const pairedAtSeed = (
  ends: {
    readonly baseline: JsonValue | null;
    readonly final: JsonValue | null;
  },
  member: string,
): JsonValue | undefined => {
  const list = /^(?<list>.*\/children)\/[^/]+$/u.exec(member)?.groups?.list;
  const newer =
    list === undefined ? undefined : resolvePointer(ends.final, list);
  const older =
    list === undefined ? undefined : resolvePointer(ends.baseline, list);
  const element = resolvePointer(ends.final, member);
  if (list === undefined || !Array.isArray(newer) || !Array.isArray(older))
    return undefined;
  const index = newer.indexOf(element ?? null);
  const partner =
    index < 0
      ? undefined
      : pairMembers(newer, older, holdsTagOnly(list)).newer.partners[index];
  return partner === undefined ? undefined : older[partner];
};
