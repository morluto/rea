import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";
import { elementText, isXmlElement } from "./appTaskChecks.js";
import {
  isIdentifyingAttribute,
  isNameLikeKey,
  isViewStateName,
  VIEW_STATE,
} from "./attributeRank.js";
import { isPositionalKey, positionalKeys } from "./positionalKeys.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { resolvePointer } from "./viewPointer.js";

/** Why a change is what an app writes as it saves or shows a document, rather than what its user made. */
export const NOISE_REASONS = [
  "view_state",
  "renumbered",
  "volatile",
  "timestamp",
  "upkeep",
] as const;
export type NoiseReason = (typeof NOISE_REASONS)[number];

/**
 * Whether a name-like attribute's value names view state: one token of two or
 * more words, as LibreOffice's `CursorPositionX` or `ooo:view-settings`, never
 * a phrase a user wrote, such as a task called `Window cleaning`.
 */
const isViewStateValue = (value: string): boolean =>
  /^[\p{L}\d]+(?:[-_:.][\p{L}\d]+)*$/u.test(value) &&
  (/[-_:.]/u.test(value) || /\p{Ll}\p{Lu}/u.test(value)) &&
  VIEW_STATE.test(value);

/** An attribute that says what its element is called, whose value may name view state: name-like, or a `key`. */
const namesElement = (key: string) =>
  isNameLikeKey(key) || /^(?:[^:]*:)?key$/iu.test(key);

/** An attribute an app renumbers as it saves: a generated id such as Gnumeric's `ExprID` or Scribus's `ItemID`, or LibreOffice's `rsid`. */
export const isRenumberedKey = (key: string): boolean => {
  const local = key.split(":").at(-1) ?? key;
  return (
    !isIdentifyingAttribute(key) &&
    /(?:[a-z]I[dD]|(?:^|[-_])[rR][sS][iI][dD])$/u.test(local)
  );
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Seconds since 1970 of 2000-01-01 and 2100-01-01: an epoch time a save stamps falls between. */
const EPOCH_RANGE = [946_684_800, 4_102_444_800] as const;

/**
 * A value a program makes anew, which no user types: a UUID, or, in named save
 * metadata, an epoch time in seconds or milliseconds. A 10-digit number that
 * starts with 2–9 is a phone number, not an epoch: those through 2033 start with 1.
 */
export const isVolatileValue = (
  value: string,
  bookkeeping = false,
): boolean => {
  if (UUID.test(value)) return true;
  if (!bookkeeping) return false;
  if (!/^\d{10}(?:\d{3})?$/u.test(value)) return false;
  const seconds = Number(value.slice(0, 10));
  if (!(seconds > EPOCH_RANGE[0] && seconds < EPOCH_RANGE[1])) return false;
  return value.length === 13 || value.startsWith("1");
};

/**
 * A machine time of day, as LibreOffice stamps a header's `text:time-value`
 * with `05:16:21.675302540`. A clock a person writes, such as `09:30:00`,
 * has no fraction and no zone, so it stays text.
 */
const TIME_OF_DAY =
  /^\d{2}:\d{2}:\d{2}(?:[.,]\d+(?:Z|[+-]\d{2}:?\d{2})?|Z|[+-]\d{2}:?\d{2})$/u;

/** Whether a value is a time an app stamps: a date and time `isTimestamp` reads, or a time of day to the second. */
export const isStamp = (value: JsonValue): boolean =>
  isTimestamp(value) ||
  (typeof value === "string" && TIME_OF_DAY.test(value.trim()));

/** A part of a date or time an app writes as an element of its own. */
const DATE_PART = /^(?:year|month|day|hour|minute|second)$/u;

/**
 * A tag naming when an app made, changed or saved something, as Tellico's
 * `cdate` and `mdate`, or `created`, `modified`, `saved` or `updated`.
 */
const BOOKKEEPING =
  /^[cm]date$|creat(?:ed|ion)|modif(?:ied|ication)|updated|saved|changed|accessed|timestamp/u;

export const isBookkeepingName = (name: string) =>
  BOOKKEEPING.test((name.split(":").at(-1) ?? name).toLowerCase());

export const isBookkeeping = (element: Element) =>
  isBookkeepingName(element.name);

/**
 * Whether a value is a date written in parts, as Tellico writes an entry's
 * `<cdate>` with `<year>`, `<month>` and `<day>`: an element whose children
 * are such parts, year, month and day among them, each holding only digits.
 */
const isDateInParts = (value: JsonValue | undefined): boolean => {
  if (!isXmlElement(value)) return false;
  const parts = new Set<string>();
  for (const child of value.children) {
    if (typeof child === "string" && /^[ \t\r\n]*$/u.test(child)) continue;
    const part = isXmlElement(child)
      ? (child.name.split(":").at(-1) ?? child.name).toLowerCase()
      : "";
    if (!DATE_PART.test(part) || !/^\s*\d+\s*$/u.test(elementText(child)))
      return false;
    parts.add(part);
  }
  return ["year", "month", "day"].every((part) => parts.has(part));
};

/** An ISO 8601 duration, as ODF's `meta:editing-duration` `PT2M2S`. */
const DURATION =
  /^P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:[.,]\d+)?S)?)?$/u;
/** A document's metadata element, as ODF's `office:meta` or AbiWord's `metadata`. */
const META = /^(?:[^:]*:)?meta(?:data)?$/iu;
/** A name for a count the app keeps, as `meta:editing-cycles` or `meta:cell-count`. */
const COUNTER = /count|cycles?|revision/iu;

/** The key a pointer names an attribute by, unescaped; undefined when it names no attribute. */
export const attributeKeyOf = (pointer: string): string | undefined => {
  const segments = pointer.split("/");
  return segments.at(-2) === "attributes"
    ? segments.at(-1)?.replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined;
};

/** The element a pointer to one of its attributes names. */
const ownerOfAttribute = (pointer: string) =>
  pointer.split("/").slice(0, -2).join("/");

type Element = Record<string, JsonValue> & {
  name: string;
  children: JsonValue[];
};

const isRecord = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The elements a pointer steps into through `children`, read from the view, outermost first. */
const elementsAlong = (view: JsonValue | null, pointer: string): Element[] => {
  const segments = pointer.split("/");
  const elements: Element[] = [];
  for (let index = 2; index < segments.length; index += 1) {
    if (segments[index - 1] !== "children") continue;
    const element = resolvePointer(
      view,
      segments.slice(0, index + 1).join("/"),
    );
    if (isXmlElement(element)) elements.push(element);
  }
  return elements;
};

/**
 * Whether elements along a pointer, outermost first, reach a date the app
 * stamps in parts: one written in parts that it, or an element it sits in,
 * names bookkeeping. A date a user enters in parts, as a birthday, is none.
 */
const stampedAlong = (elements: readonly Element[]) => {
  let named = false;
  return elements.some((element) => {
    named ||= isBookkeeping(element);
    return named && isDateInParts(element);
  });
};

/** Whether a pointer is a date the app stamps in parts, or inside one. */
export const inSplitDate = (view: JsonValue | null, pointer: string): boolean =>
  stampedAlong(elementsAlong(view, pointer));

/** Whether an element holds a date the app stamps in parts, `named` when a tag it sits in names bookkeeping. */
const holdsStamped = (value: JsonValue, named: boolean): boolean =>
  isXmlElement(value) &&
  value.children.some((child) => {
    if (!isXmlElement(child)) return false;
    const inside = named || isBookkeeping(child);
    return (inside && isDateInParts(child)) || holdsStamped(child, inside);
  });

/** Whether the element at a pointer is, sits in or holds a date the app stamps in parts, whose text no check compares. */
export const holdsSplitDate = (
  view: JsonValue | null,
  pointer: string,
): boolean => {
  const along = elementsAlong(view, pointer);
  const value = resolvePointer(view, pointer);
  return (
    stampedAlong(along) ||
    (value !== undefined && holdsStamped(value, along.some(isBookkeeping)))
  );
};

/** Whether an element is view state by its tag, or by a name-like attribute naming view state, as `[@config:name=CursorPositionX]`. */
const showsView = (element: Element) =>
  isViewStateName(element.name) ||
  Object.entries(isRecord(element.attributes) ? element.attributes : {}).some(
    ([key, value]) =>
      typeof value === "string" && namesElement(key) && isViewStateValue(value),
  );

/** A file's views at its two ends. */
interface Ends {
  readonly baseline: JsonValue | null;
  readonly final: JsonValue | null;
}

/** Whether a duration or a count under a document's metadata, which the app keeps as it saves. */
const metadataCount = (
  elements: readonly Element[],
  key: string | undefined,
  value: JsonValue | undefined,
) => {
  if (
    typeof value !== "string" ||
    !elements.some(({ name }) => META.test(name))
  )
    return false;
  if (DURATION.test(value.trim())) return true;
  const own = key ?? elements.at(-1)?.name ?? "";
  return /^\d+$/u.test(value.trim()) && COUNTER.test(own);
};

/** Whether an identifier change is one the app made by numbering a list by position, as Planner's task ids shift after an insertion. */
const positionalRenumbering = (ends: Ends) => {
  const lists = new Map<string, ReadonlySet<string>>();
  return (pointer: string, key: string) => {
    const owner = ownerOfAttribute(pointer);
    const list = owner.split("/").slice(0, -1).join("/");
    const element =
      resolvePointer(ends.final, owner) ?? resolvePointer(ends.baseline, owner);
    if (!list.endsWith("/children") || !isXmlElement(element)) return false;
    let keys = lists.get(list);
    if (keys === undefined) {
      const newer = resolvePointer(ends.final, list);
      const older = resolvePointer(ends.baseline, list);
      keys =
        Array.isArray(newer) && Array.isArray(older)
          ? positionalKeys(newer, older)
          : new Set();
      lists.set(list, keys);
    }
    return isPositionalKey(keys, element.name, key);
  };
};

/** A pointer into an archive entry's view: the entry's part of it, as `/entries/[name=styles.xml]/view/`. */
const ENTRY_VIEW = /^\/entries\/[^/]+\/view\//u;

/**
 * Attributes an archive entry's elements only gained, as LibreOffice fills in
 * `loext:tab-stop-distance` across `styles.xml` on save, while another entry
 * holds the edit: whether each pointer is one.
 */
const upkeepOf = (
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
  ends: Ends,
  noise: (pointer: string) => NoiseReason | undefined,
  xml: (view: JsonValue | null, pointer: string) => boolean,
) => {
  const added = new Set(change.added);
  const gained = (pointer: string) =>
    added.has(pointer) &&
    xml(ends.final, pointer) &&
    attributeKeyOf(pointer) !== undefined &&
    [ends.baseline, ends.final].every((view) =>
      isXmlElement(resolvePointer(view, ownerOfAttribute(pointer))),
    );
  const edited = new Set<string>();
  /** How many elements of an entry gained one attribute key. One gain is an edit; a repeated gain is the app filling a default in. */
  const filled = new Map<string, Map<string, number>>();
  for (const pointer of [
    ...change.added,
    ...change.changed,
    ...change.removed,
  ]) {
    const [entry] = ENTRY_VIEW.exec(pointer) ?? [];
    if (entry === undefined || noise(pointer) !== undefined) continue;
    const key = attributeKeyOf(pointer);
    if (!gained(pointer) || key === undefined) {
      edited.add(entry);
      continue;
    }
    const counts = filled.get(entry) ?? new Map<string, number>();
    filled.set(entry, counts);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (pointer: string) => {
    const [entry] = ENTRY_VIEW.exec(pointer) ?? [];
    const key = attributeKeyOf(pointer);
    const count =
      entry === undefined || key === undefined
        ? 0
        : (filled.get(entry)?.get(key) ?? 0);
    return (
      edited.size > 0 &&
      entry !== undefined &&
      !edited.has(entry) &&
      gained(pointer) &&
      count >= 2
    );
  };
};

/**
 * Why each pointer into a file is noise, or undefined when it is not: a tag,
 * attribute or name-like attribute value on its way naming view state, as
 * `[@config:name=CursorPositionX]`; an attribute an app renumbers, an
 * identifier it numbers by position, or anything inside an element both ends
 * hold whose renumbered attribute changed, as Gnumeric empties a formula cell
 * whose shared expression it renumbers; a UUID or epoch time, or a duration or
 * count under the document's metadata; a time the app stamps, whole or in
 * parts (`inSplitDate`); an attribute an archive entry only gained while
 * another entry holds the edit.
 */
export const changeNoise = (
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
  ends: Ends,
  xml: (view: JsonValue | null, pointer: string) => boolean,
): ((pointer: string) => NoiseReason | undefined) => {
  const renumbered = change.changed.flatMap((pointer) => {
    const key = attributeKeyOf(pointer);
    return xml(ends.final, pointer) && key !== undefined && isRenumberedKey(key)
      ? [ownerOfAttribute(pointer)]
      : [];
  });
  const byPosition = positionalRenumbering(ends);
  const known = new Map<string, NoiseReason | undefined>();
  const base = (pointer: string): NoiseReason | undefined => {
    if (known.has(pointer)) return known.get(pointer);
    const view =
      resolvePointer(ends.final, pointer) === undefined
        ? ends.baseline
        : ends.final;
    const isXml = xml(view, pointer);
    const key = isXml ? attributeKeyOf(pointer) : undefined;
    const elements = isXml ? elementsAlong(view, pointer) : [];
    const value = resolvePointer(view, pointer);
    const reason: NoiseReason | undefined =
      elements.some(showsView) || (key !== undefined && isViewStateName(key))
        ? "view_state"
        : (key !== undefined &&
              (isRenumberedKey(key) ||
                (isIdentifyingAttribute(key) && byPosition(pointer, key)))) ||
            renumbered.some((element) => {
              if (pointer !== element && !pointer.startsWith(`${element}/`))
                return false;
              if (pointer === element) return false;
              const next = resolvePointer(ends.final, pointer);
              const text =
                typeof next === "string"
                  ? next.trim()
                  : isXmlElement(next)
                    ? elementText(next).trim()
                    : undefined;
              // Gnumeric clears a shared formula when it renumbers the cell. A formula that still has text was edited.
              return text === undefined || text === "";
            })
          ? "renumbered"
          : (typeof value === "string" &&
                isVolatileValue(
                  value,
                  elements.some(isBookkeeping) ||
                    (key !== undefined && isBookkeepingName(key)),
                )) ||
              metadataCount(elements, key, value)
            ? "volatile"
            : isStamp(value ?? null) || stampedAlong(elements)
              ? "timestamp"
              : undefined;
    known.set(pointer, reason);
    return reason;
  };
  const upkeep = upkeepOf(change, ends, base, xml);
  return (pointer) => base(pointer) ?? (upkeep(pointer) ? "upkeep" : undefined);
};
