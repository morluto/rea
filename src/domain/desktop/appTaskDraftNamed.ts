import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import {
  attributeChecks,
  fieldChecks,
  recordChecks,
  type AddedContext,
} from "./appTaskDraftAdded.js";
import {
  attributeTextCheck,
  readsText,
  textAttributes,
} from "./appTaskDraftAttributeText.js";
import { draftCounts } from "./appTaskDraftCounts.js";
import { draftGuards } from "./appTaskDraftGuards.js";
import {
  attributeKeyOf,
  changeNoise,
  inSplitDate,
  isStamp,
  type NoiseReason,
} from "./appTaskDraftNoise.js";
import { valueEqualsCheck } from "./appTaskDraftScalars.js";
import { isIdentifyingAttribute } from "./attributeRank.js";
import {
  wholeTextSuggestions,
  type WholeTextSuggestions,
} from "./appTaskDraftText.js";
import { draftValues, type DraftValue } from "./appTaskDraftValues.js";
import {
  diffNamedMembers,
  type DesktopStateDifference,
} from "./stateChanges.js";
import { pairMembers, pairedAtSeed } from "./memberPairing.js";
import {
  escapeToken,
  isXmlElement,
  locatePointer,
  resolvePointer,
} from "./viewPointer.js";
import type { CheckTree } from "./appTaskDraftTree.js";

type Suggestion = DesktopTaskCheckInput;

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Pointers without a listed descendant: a container listed with its members is suggested through them. */
export const innermost = (pointers: readonly string[]): readonly string[] =>
  pointers.filter(
    (pointer) => !pointers.some((other) => other.startsWith(`${pointer}/`)),
  );

/** Whether a check at a pointer is decided by name: no object or array reached by position, no array searched that the view may cut. */
const byName = (view: JsonValue | null, pointer: string, tree: CheckTree) => {
  const located = locatePointer(view, pointer);
  return (
    located.kind !== "unresolved" &&
    located.byPosition.length === 0 &&
    !located.searched.some((array) => tree.arrayLeavesOut(view, array))
  );
};

/** An element of REA's XML view, by its tag name, or undefined for any other value. */
const elementName = (value: JsonValue | undefined): string | undefined =>
  isXmlElement(value) ? value.name : undefined;

/**
 * A text node of an XML view holding only whitespace: what the XML reader
 * keeps of it is text, such as the space between two runs, but a check of it
 * alone would tie the edit to where the runs fall, so it gets none.
 */
const isLayoutText = (
  tree: CheckTree,
  view: JsonValue | null,
  pointer: string,
  value: JsonValue | undefined,
) =>
  typeof value === "string" &&
  /^[ \t\r\n]*$/u.test(value) &&
  /\/children\/[^/]+$/u.test(pointer) &&
  tree.xml(view, pointer);

/** The tags of elements a pointer reaches by position, which no attribute names alone among their siblings. */
const positionalTags = (view: JsonValue | null, pointer: string): string[] => {
  const segments = pointer.split("/");
  return segments.flatMap((segment, index) => {
    if (segments[index - 1] !== "children" || !/^\d+$/u.test(segment))
      return [];
    const element = resolvePointer(
      view,
      segments.slice(0, index + 1).join("/"),
    );
    return isXmlElement(element) ? [element.name] : [];
  });
};

/** Facts a file's notes rest on, gathered as the suggestions are filtered. */
export interface NamedFacts {
  /** Changes no check took because only position reaches them. */
  readonly positional: number;
  /** The tags of the elements position alone reaches on their way. */
  readonly positionalTags: readonly string[];
  /** Elements whose changed text no check took, because it was past the limit. */
  readonly long: readonly string[];
  /** The changes the diff lists, and how many of them are noise. */
  readonly changes: number;
  readonly noise: number;
  /** Suggested checks that are noise, kept because nothing else was. */
  readonly flagged: readonly string[];
}

/** A file's draft by named pointers: its suggested checks, values, guards and the facts its notes rest on. */
export interface NamedDraft {
  readonly suggested: Suggestion[];
  readonly values: DraftValue[];
  readonly valuesCut: boolean;
  readonly guards: Suggestion[];
  readonly facts: NamedFacts;
}

/** Noise checks a document keeps when its change is nothing else, so an author still sees one. */
const MAX_FLAGGED = 3;
/** Guards a file's draft offers. */
const MAX_GUARDS = 4;

/** The draft's options: its limits, and whether the file is a document, which keeps fewer noise checks than the app's own state. */
export interface NamedOptions {
  readonly limit: { readonly suggestions: number; readonly chars: number };
  readonly document: boolean;
}

/** What one pass over the named diff reads: the file, its ends, where checks go, the limits, the text checks already placed and noise. */
interface CollectContext {
  readonly file: string;
  readonly ends: AddedContext["ends"];
  readonly tree: CheckTree;
  readonly limit: NamedOptions["limit"];
  readonly texts: WholeTextSuggestions;
  readonly noise: (pointer: string) => NoiseReason | undefined;
}

/** Whether a check reads a pointer that is noise. */
const isNoisy = (noise: CollectContext["noise"], check: Suggestion): boolean =>
  "pointer" in check && noise(check.pointer) !== undefined;

/**
 * The checks a pass gathers, elements' apart from values', those that are
 * noise apart from the rest, each list at most the limit; and the changes it
 * left to position, `real` those that are no noise.
 */
interface Collected {
  readonly context: CollectContext;
  readonly elements: Suggestion[];
  readonly values: Suggestion[];
  readonly noise: {
    readonly elements: Suggestion[];
    readonly values: Suggestion[];
  };
  readonly positional: {
    count: number;
    real: number;
    readonly tags: Set<string>;
  };
}

const named = (
  { context }: Collected,
  view: JsonValue | null,
  pointer: string,
) => byName(view, pointer, context.tree);

/** Count a change no check names because position alone reaches it; one a cut view rejects is the view's to explain. */
const unnamed = (
  collected: Collected,
  view: JsonValue | null,
  pointer: string,
) => {
  if (
    collected.context.texts.covers(pointer) ||
    locatePointer(view, pointer).byPosition.length === 0
  )
    return;
  collected.positional.count += 1;
  if (collected.context.noise(pointer) === undefined)
    collected.positional.real += 1;
  for (const tag of positionalTags(view, pointer))
    collected.positional.tags.add(tag);
};

const room = ({ context }: Collected, list: readonly Suggestion[]) =>
  list.length < context.limit.suggestions;

/** Add checks to the elements' or values' list while it has room, those that are noise to their own list, so noise never takes the place of a check that is not. */
const take = (
  collected: Collected,
  kind: "elements" | "values",
  checks: readonly Suggestion[],
) => {
  for (const check of checks) {
    const list = isNoisy(collected.context.noise, check)
      ? collected.noise[kind]
      : collected[kind];
    if (room(collected, list)) list.push(check);
  }
};

/** A check that a scalar, or an empty container, holds its final value. */
const equals = (
  collected: Collected,
  pointer: string,
  value: JsonValue | undefined,
) => {
  const { file, ends, tree, texts, noise } = collected.context;
  const list =
    noise(pointer) === undefined ? collected.values : collected.noise.values;
  if (
    !room(collected, list) ||
    texts.covers(pointer) ||
    value === undefined ||
    (isRecord(value) && Object.keys(value).length > 0) ||
    isStamp(value) ||
    inSplitDate(ends.final, pointer) ||
    isLayoutText(tree, ends.final, pointer, value)
  )
    return;
  if (named(collected, ends.final, pointer))
    take(collected, "values", [
      valueEqualsCheck(
        file,
        pointer,
        value,
        resolvePointer(ends.baseline, pointer),
      ),
    ]);
  else unnamed(collected, ends.final, pointer);
};

/**
 * Checks of an element added whole: a record only position names by its new
 * fields, beside any whole text; a list member by its own attributes; any
 * other by its presence.
 */
const elementChecks = (
  collected: Collected,
  pointer: string,
  value: JsonValue,
): void => {
  const { file, ends, texts } = collected.context;
  // A date the app stamps in parts is never a check.
  if (!isXmlElement(value) || inSplitDate(ends.final, pointer)) return;
  const added = {
    file,
    ends,
    named: (view: JsonValue | null, at: string) => named(collected, view, at),
    chars: collected.context.limit.chars,
    noisy: (at: string) => collected.context.noise(at) !== undefined,
  };
  if (!named(collected, ends.final, `${pointer}/name`)) {
    const fields = fieldChecks(added, pointer, value);
    take(collected, "values", fields);
    // Its new fields, checked at an ancestor, name it as well as text does.
    if (fields.length === 0 && !texts.covers(pointer))
      unnamed(collected, ends.final, pointer);
    return;
  }
  if (texts.covers(pointer) || !room(collected, collected.elements)) return;
  const own = [
    ...attributeChecks(added, pointer, value),
    ...recordChecks(added, pointer, value),
  ];
  take(
    collected,
    "elements",
    own.length > 0
      ? own
      : [
          {
            kind: "value_equals",
            file,
            pointer: `${pointer}/name`,
            value: value.name,
          },
        ],
  );
};

/** Checks of a value added whole: an element as `elementChecks` says, a container through its members, a scalar as it is. */
const addedChecks = (
  collected: Collected,
  pointer: string,
  value: JsonValue | undefined,
): void => {
  if (
    !room(collected, collected.elements) &&
    !room(collected, collected.values)
  )
    return;
  if (isXmlElement(value)) elementChecks(collected, pointer, value);
  else if (collected.context.texts.covers(pointer)) return;
  else if (Array.isArray(value) && value.length > 0) {
    const { keys } = pairMembers(value, []).newer;
    value.forEach((item, index) =>
      addedChecks(
        collected,
        `${pointer}/${escapeToken(keys[index] ?? String(index))}`,
        item,
      ),
    );
  } else if (isRecord(value) && Object.keys(value).length > 0)
    for (const [key, item] of Object.entries(value))
      addedChecks(collected, `${pointer}/${escapeToken(key)}`, item);
  // A scalar, or an empty array or object, is checked as it is.
  else equals(collected, pointer, value);
};

/** A check that a value is gone, only where the entry still has a view to lack it in. */
const removedCheck = (collected: Collected, pointer: string) => {
  const { file, ends, tree, texts } = collected.context;
  const before = resolvePointer(ends.baseline, pointer);
  if (
    texts.covers(pointer) ||
    isLayoutText(tree, ends.baseline, pointer, before) ||
    tree.root(ends.baseline, pointer) !== pointer ||
    tree.root(ends.final, pointer) !== pointer
  )
    return;
  if (
    named(collected, ends.baseline, pointer) &&
    named(collected, ends.final, pointer)
  )
    take(collected, elementName(before) === undefined ? "values" : "elements", [
      { kind: "value_absent", file, pointer },
    ]);
  else unnamed(collected, ends.baseline, pointer);
};

/** The element a member pointer names at the seed: there, or, for one keyed by its new name as `renameKeys` keys it, the member it pairs with. */
const atSeed = (ends: AddedContext["ends"], owner: string) =>
  resolvePointer(ends.baseline, owner) ?? pairedAtSeed(ends, owner);

/**
 * A check that the identifier an element was renamed from names nothing at
 * the end, as a layer renamed from `Layer` that its `src` names: its tag
 * and old value, where that named the element alone at the seed. An element
 * its tag alone names gets none; the check of its identifier says as much.
 */
const renamedFrom = (collected: Collected, pointer: string) => {
  const { file, ends, tree } = collected.context;
  const key = attributeKeyOf(pointer) ?? "";
  const owner = pointer.split("/").slice(0, -2).join("/");
  const list = /^(?<list>.+\/children)\/[^/]+$/u.exec(owner)?.groups?.list;
  const before = atSeed(ends, owner);
  const old = isXmlElement(before) ? before.attributes[key] : undefined;
  if (
    list === undefined ||
    !(owner.split("/").at(-1) ?? "").includes("][@") ||
    !isIdentifyingAttribute(key) ||
    /[=[\]]/u.test(key) ||
    !isXmlElement(before) ||
    typeof old !== "string" ||
    old.includes("][")
  )
    return;
  const at = `${list}/${escapeToken(`[name=${before.name}][@${key}=${old}]`)}`;
  const seed = locatePointer(ends.baseline, at);
  if (
    seed.kind === "value" &&
    seed.value === before &&
    locatePointer(ends.final, at).kind === "none" &&
    tree.root(ends.final, at) === at &&
    named(collected, ends.baseline, at) &&
    named(collected, ends.final, at)
  )
    take(collected, "values", [{ kind: "value_absent", file, pointer: at }]);
};

/** The checks one pass over the named diff suggests, with what it left out by position. */
const collectChecks = (
  context: CollectContext,
  change: DesktopStateDifference,
): Collected => {
  const collected: Collected = {
    context,
    elements: [],
    values: [],
    noise: { elements: [], values: [] },
    positional: { count: 0, real: 0, tags: new Set() },
  };
  const { ends, tree } = context;
  const runs = attributeTexts(collected, change);
  for (const pointer of change.added.filter((at) => !runs(at, ends.final))) {
    const root = tree.root(ends.final, pointer);
    if (root !== undefined)
      addedChecks(collected, root, resolvePointer(ends.final, root));
  }
  for (const pointer of innermost(change.changed))
    if (
      tree.root(ends.final, pointer) === pointer &&
      !runs(pointer, ends.final)
    ) {
      equals(collected, pointer, resolvePointer(ends.final, pointer));
      // An id the app renumbered, or other noise, renamed nothing.
      if (context.noise(pointer) === undefined) renamedFrom(collected, pointer);
    }
  for (const pointer of change.removed.filter((at) => !runs(at, ends.baseline)))
    removedCheck(collected, pointer);
  return collected;
};

/**
 * Take the `attributeTextCheck` of each attribute that may hold runs of
 * text; whether a change at a pointer is one a check took reads: the text
 * attribute of an element in it, or a run holding that attribute added or
 * removed in it, not another of its attributes or elements.
 */
const attributeTexts = (
  collected: Collected,
  change: DesktopStateDifference,
) => {
  const { file, ends, tree, limit } = collected.context;
  const covered: { element: string; key: string }[] = [];
  for (const { owner, key } of textAttributes(
    change,
    ends,
    collected.context.noise,
  )) {
    const found =
      tree.root(ends.final, owner) === owner ||
      tree.root(ends.baseline, owner) === owner
        ? attributeTextCheck(
            {
              file,
              ends,
              named: (at) => named(collected, ends.final, at),
              chars: limit.chars,
            },
            owner,
            key,
          )
        : undefined;
    if (
      found !== undefined &&
      !covered.some(({ element }) => element === found.element)
    ) {
      covered.push({ element: found.element, key });
      take(collected, "elements", [found.check]);
    }
  }
  return readsText(covered);
};

/**
 * Checks by the selectors a keyed diff names members with, in an archive's
 * entries or an XML file: the whole text of each element whose text changed
 * first, then text kept in an attribute's runs (`attributeTextCheck`), then
 * elements added or removed whole, then values changed, added and removed,
 * then counts of lists whose members were added or removed (`draftCounts`).
 * An element added to a list is checked by its own attributes, a record only
 * position names by its new fields, a decimal by its number. A JSON value or
 * an entry added whole is checked through its members. Nothing goes through
 * an object or array by position. Noise (view state, renumbered ids,
 * volatile values, times, upkeep, layout) leaves the suggestions when anything
 * else changed, a change only position reaches included; when noise is all
 * there is, it stays, flagged: up to three in a document, as many as fit in
 * the app's own state, where a view setting may be the task. Beside them: the
 * values the change added, changed and removed, and guards that the rest
 * stays as it was, a count of the list an edit went through among them.
 */
export const namedDraft = (
  file: string,
  ends: AddedContext["ends"],
  tree: CheckTree,
  options: NamedOptions,
): NamedDraft => {
  const change = diffNamedMembers(ends.baseline, ends.final);
  const noise = changeNoise(change, ends);
  const named = (view: JsonValue | null, pointer: string) =>
    byName(view, pointer, tree) && !tree.leavesOut(view, pointer);
  const texts = wholeTextSuggestions(file, change, ends, {
    limit: options.limit,
    inTree: (pointer) =>
      tree.xml(ends.final, pointer) &&
      tree.root(ends.final, pointer) === pointer,
    name: (pointer) => (named(ends.final, pointer) ? pointer : undefined),
    noise: (pointer) => noise(pointer) !== undefined,
  });
  const checks = collectChecks(
    { file, ends, tree, limit: options.limit, texts, noise },
    change,
  );
  const noisy = (check: Suggestion) => isNoisy(noise, check);
  const counts = draftCounts(
    {
      file,
      ends,
      whole: (view, list) =>
        named(view, list) && !tree.arrayLeavesOut(view, list),
      noisy: (pointer) => noise(pointer) !== undefined,
      covered: texts.covers,
    },
    change,
  );
  const clean = [
    ...texts.suggestions.filter((check) => !noisy(check)),
    ...checks.elements,
    ...checks.values,
    ...counts.checks,
  ];
  const flaggable = [
    ...texts.suggestions.filter(noisy),
    ...checks.noise.elements,
    ...checks.noise.values,
  ];
  const edited = clean.length > 0 || checks.positional.real > 0;
  const suggested = (
    edited
      ? clean
      : options.document
        ? flaggable.slice(0, MAX_FLAGGED)
        : flaggable
  ).slice(0, options.limit.suggestions);
  const listed = [...change.added, ...change.changed, ...change.removed];
  const { values, cut } = draftValues(change, {
    ends,
    listed: tree.listed,
    noise,
  });
  const guards = edited
    ? [
        ...texts.guards,
        ...draftGuards(
          {
            file,
            ends,
            named,
            noisy: (pointer) => noise(pointer) !== undefined,
            chars: options.limit.chars,
          },
          suggested,
        ),
        ...counts.guards,
      ].slice(0, MAX_GUARDS)
    : [];
  return {
    suggested,
    values,
    valuesCut: cut,
    guards,
    facts: factsOf(checks, texts, {
      listed,
      noise,
      flagged: edited ? [] : suggested,
    }),
  };
};

/** The facts a file's notes rest on: what position alone reached, text past the limit, how many changes are noise, and the noise checks kept. */
const factsOf = (
  checks: Collected,
  texts: WholeTextSuggestions,
  change: {
    readonly listed: readonly string[];
    readonly noise: (pointer: string) => NoiseReason | undefined;
    readonly flagged: readonly Suggestion[];
  },
): NamedFacts => ({
  positional: checks.positional.count,
  positionalTags: [...checks.positional.tags],
  long: texts.long,
  changes: change.listed.length,
  noise: change.listed.filter((pointer) => change.noise(pointer) !== undefined)
    .length,
  flagged: change.flagged.flatMap((check) =>
    "pointer" in check ? [check.pointer] : [],
  ),
});
