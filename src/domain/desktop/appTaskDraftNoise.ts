import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";
import { isXmlElement } from "./appTaskChecks.js";
import { isIdentifyingAttribute } from "./attributeRank.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { resolvePointer } from "./viewPointer.js";

/** Why a change is what an app writes as it saves or shows a document, rather than what its user made. */
export const NOISE_REASONS = [
  "view_state",
  "renumbered",
  "volatile",
  "timestamp",
] as const;
export type NoiseReason = (typeof NOISE_REASONS)[number];

/** Words in a tag or attribute name for how the app was showing the document: its cursor, selection, scroll, zoom, windows, or a save's history. */
const VIEW_STATE =
  /cursor|selection|selected|scroll|zoom|viewport|window|splitter|toplevel|topleft|uidata|namedview|history|edit-?time|last-?saved/iu;

/** Whether a tag or attribute name is about how the app showed the document rather than what it holds. */
export const isViewStateName = (name: string): boolean => VIEW_STATE.test(name);

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

/** A value a program makes anew, a UUID or an epoch time in seconds or milliseconds, which no user types. */
export const isVolatileValue = (value: string): boolean => {
  if (UUID.test(value)) return true;
  if (!/^\d{10}(?:\d{3})?$/u.test(value)) return false;
  const seconds = Number(value.slice(0, 10));
  return seconds > EPOCH_RANGE[0] && seconds < EPOCH_RANGE[1];
};

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

/** The tag names of the elements a pointer steps into through `children`, read from the view. */
const tagsAlong = (view: JsonValue | null, pointer: string): string[] => {
  const segments = pointer.split("/");
  const tags: string[] = [];
  for (let index = 2; index < segments.length; index += 1) {
    if (segments[index - 1] !== "children") continue;
    const element = resolvePointer(
      view,
      segments.slice(0, index + 1).join("/"),
    );
    if (isXmlElement(element)) tags.push(element.name);
  }
  return tags;
};

/** A file's views at its two ends. */
interface Ends {
  readonly baseline: JsonValue | null;
  readonly final: JsonValue | null;
}

/**
 * Why each pointer into a document is noise, or undefined when it is not: a
 * tag or attribute on its way named for view state; an attribute an app
 * renumbers, or anything inside an element both ends hold whose renumbered
 * attribute changed, as Gnumeric empties a formula cell whose shared
 * expression it renumbers; a UUID or epoch time; a timestamp.
 */
export const changeNoise = (
  change: Pick<DesktopStateDifference, "changed">,
  ends: Ends,
): ((pointer: string) => NoiseReason | undefined) => {
  const renumbered = change.changed.flatMap((pointer) => {
    const key = attributeKeyOf(pointer);
    return key !== undefined && isRenumberedKey(key)
      ? [ownerOfAttribute(pointer)]
      : [];
  });
  return (pointer) => {
    const view =
      resolvePointer(ends.final, pointer) === undefined
        ? ends.baseline
        : ends.final;
    const key = attributeKeyOf(pointer);
    if (
      tagsAlong(view, pointer).some(isViewStateName) ||
      (key !== undefined && isViewStateName(key))
    )
      return "view_state";
    if (
      (key !== undefined && isRenumberedKey(key)) ||
      renumbered.some(
        (element) => pointer === element || pointer.startsWith(`${element}/`),
      )
    )
      return "renumbered";
    const value = resolvePointer(view, pointer);
    if (typeof value === "string" && isVolatileValue(value)) return "volatile";
    return isTimestamp(value ?? null) ? "timestamp" : undefined;
  };
};
