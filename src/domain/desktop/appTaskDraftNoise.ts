import type { JsonValue } from "../jsonValue.js";
import { isTimestamp } from "./appTask.js";
import {
  isAutomaticStyle,
  isIdentifyingAttribute,
  isNameLikeKey,
  isViewStateName,
  VIEW_STATE,
} from "./attributeRank.js";
import { isMemberCount } from "./appTaskDraftMemberCount.js";
import { idReferencesOf, mirrorsOf } from "./appTaskDraftMirrors.js";
import { isPositionalKey, positionalKeys } from "./positionalKeys.js";
import type { DesktopStateDifference } from "./stateChanges.js";
import { elementText, isXmlElement, resolvePointer } from "./viewPointer.js";

/** Why a change is what an app writes as it saves or shows a document, rather than what its user made. */
export const NOISE_REASONS = [
  "view_state",
  "renumbered",
  "volatile",
  "timestamp",
  "upkeep",
  "layout",
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

/** Base64 of binary data an app encodes as it saves, as Xournal++'s page preview, a PNG (`iVBORw0KGgo`), or any run of 256 or more base64 characters mixing cases and digits, line breaks aside: no prose runs that long without a space. */
const ENCODED =
  /^(?:iVBORw0KGgo[A-Za-z0-9+/=\r\n]*|(?=[^]*[a-z])(?=[^]*[A-Z])(?=[^]*\d)[A-Za-z0-9+/\r\n]{256,}={0,2})$/u;

/**
 * A value a program makes anew, a UUID, an epoch time, or binary it encodes.
 * A 10-digit number that starts with 2–9 is a phone number, not an epoch:
 * those through 2033 start with 1.
 */
export const isVolatileValue = (value: string): boolean => {
  if (UUID.test(value) || ENCODED.test(value.trim())) return true;
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
  /^[cm]date$|creat(?:ed|ion)|modif(?:ied|ication)|updated|saved|changed|accessed|entered|timestamp/u;

const isBookkeeping = (element: Element) =>
  BOOKKEEPING.test(
    (element.name.split(":").at(-1) ?? element.name).toLowerCase(),
  );

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

/** A date written whole, as GnuCash's `2026-11-06 08:50:12 +0000`, which `isTimestamp` reads only in ISO 8601's own spelling. */
const DATE_TEXT = /^\s*\d{4}-\d{2}-\d{2}\b/u;

/** Whether a value is a date under an element bookkeeping names, as GnuCash's `<trn:date-entered><ts:date>…`, or such an element holding one. */
const stampedWhole = (
  elements: readonly Element[],
  value: JsonValue | undefined,
) =>
  elements.some(isBookkeeping) &&
  DATE_TEXT.test(
    typeof value === "string"
      ? value
      : isXmlElement(value)
        ? elementText(value)
        : "",
  );

/** Whether an element holds an id the app assigns, as GnuCash's `<trn:id type="guid">`. */
const assignedId = (element: Element) =>
  /^(?:[^:]*:)?id$/iu.test(element.name) &&
  isRecord(element.attributes) &&
  element.attributes.type === "guid";

/** Whether text holds a control character other than a tab or line break, or the replacement character, which no user types, as GnuCash's options hold before it fills them. */
const isGarbled = (value: string) =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f ||
      code === 0xfffd
    );
  });

/** An attribute counting the ids an app hands out, as Umbrello's `uniqueid` or Tiled's `nextobjectid`. */
const ID_COUNTER = /^(?:next|unique|last)[-_]?(?:[\p{L}_-]*)id$/iu;

/** A key keeping the last or next id an app hands out, as Umbrello's `lastobject`, which holds the id its new element took. */
const COUNTER_KEY = /^(?:next|unique|last)[-_]?[\p{L}_-]*$/iu;

/** Whether a value is one a program makes: a UUID, an epoch time or garbled text, a count under the metadata, an id counter, an id the change gave a new element where a counter or that element holds it (`fresh`), or in or at an id the app assigns. */
const volatileAt = (
  elements: readonly Element[],
  key: string | undefined,
  value: JsonValue | undefined,
  fresh: boolean,
) =>
  (typeof value === "string" &&
    (isVolatileValue(value) || isGarbled(value) || fresh)) ||
  (key !== undefined && ID_COUNTER.test(key.split(":").at(-1) ?? key)) ||
  metadataCount(elements, key, value) ||
  elements.some(assignedId) ||
  (isXmlElement(value) && assignedId(value));

/**
 * The ids of the elements a change added (`id`, `xid`, `uuid`, `guid`, as
 * Umbrello's new attribute's `xmi:id="ubcgF2AWfBmHh"`), which another save
 * of the same edit would not repeat, so a value equal to one in an id
 * counter or in that element is the app's: those of four or more
 * characters, not a plain number.
 */
const freshIds = (
  change: Pick<DesktopStateDifference, "added">,
  ends: Ends,
): ReadonlySet<string> =>
  new Set(
    change.added.flatMap((pointer) => {
      const element = resolvePointer(ends.final, pointer);
      return isXmlElement(element)
        ? Object.entries(element.attributes).flatMap(([key, value]) =>
            /^(?:[^:]*:)?(?:x|uu|g)?id$/iu.test(key) &&
            typeof value === "string" &&
            value.length >= 4 &&
            !/^\d+$/u.test(value)
              ? [value]
              : [],
          )
        : [];
    }),
  );

/** A container of an app's own bookkeeping slots, as GnuCash's `book:slots`, which it adds to and fills on reopening a book. */
const isSlots = (element: Element) => /^(?:[^:]*:)?slots$/u.test(element.name);

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
      typeof value === "string" &&
      namesElement(key) &&
      (isViewStateValue(value) || VIEW_SETTING.test(value)),
  );

/** A settings path whose last part says how a panel shows, as VYM's `<setting key="/treeeditor/visible">`. */
const VIEW_SETTING =
  /^\/(?:[\w-]+\/)+(?:visible|hidden|shown?|expanded|collapsed|geometry|state|size|zoom)$/iu;

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

/** A pointer to an archive entry's own size or digest, which change with any edit to it. */
const ENTRY_META = /^\/entries\/[^/]+\/(?!view(?:\/|$))/u;

/** A pointer into an archive entry's view: the entry's part of it, as `/entries/[name=styles.xml]/view/`. */
const ENTRY_VIEW = /^\/entries\/[^/]+\/view\//u;

/**
 * What an app keeps up as it saves, while the edit is elsewhere: attributes an
 * archive entry's elements only gained, as LibreOffice fills in
 * `loext:tab-stop-distance` across `styles.xml`, while another entry holds
 * the edit; and, while a change outside them is the edit, any change to a
 * document's styles, `styles.xml` or its style containers and master,
 * handout and notes pages, or to an attribute naming an automatic style
 * at both ends (`isAutomaticStyle`), as Impress wraps its master pages'
 * fields in a new `MT1` style after a reload.
 */
const upkeepOf = (
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
  ends: Ends,
  noise: (pointer: string) => NoiseReason | undefined,
) => {
  const added = new Set(change.added);
  const gained = (pointer: string) =>
    added.has(pointer) &&
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
  // A style a user names, as "Quotations" given to a paragraph, is an edit; one the app numbers, as `P1`, its upkeep.
  const automatic = (pointer: string, key: string) =>
    [ends.baseline, ends.final].every((view) => {
      const value = resolvePointer(view, pointer);
      return (
        value === undefined ||
        (typeof value === "string" && isAutomaticStyle(key, value))
      );
    });
  const styled = (pointer: string) => {
    const key = attributeKeyOf(pointer);
    const view =
      resolvePointer(ends.final, pointer) === undefined
        ? ends.baseline
        : ends.final;
    return (
      ENTRY_VIEW.exec(pointer)?.[0] === "/entries/[name=styles.xml]/view/" ||
      (key !== undefined &&
        /style-name$/iu.test(key) &&
        automatic(pointer, key)) ||
      elementsAlong(view, pointer).some(({ name }) => STYLE_AREA.test(name))
    );
  };
  // The user's edit is elsewhere when a change no other rule calls noise lies outside the styles.
  const elsewhere = [
    ...change.added,
    ...change.changed,
    ...change.removed,
  ].some(
    (pointer) =>
      noise(pointer) === undefined &&
      !styled(pointer) &&
      !ENTRY_META.test(pointer),
  );
  return (pointer: string) => {
    const [entry] = ENTRY_VIEW.exec(pointer) ?? [];
    const key = attributeKeyOf(pointer);
    const count =
      entry === undefined || key === undefined
        ? 0
        : (filled.get(entry)?.get(key) ?? 0);
    const view =
      resolvePointer(ends.final, pointer) === undefined
        ? ends.baseline
        : ends.final;
    const inStyleArea = elementsAlong(view, pointer).some(({ name }) =>
      STYLE_AREA.test(name),
    );
    const automaticName =
      key !== undefined && /style-name$/iu.test(key) && automatic(pointer, key);
    // One attribute gained in styles.xml is the edit. A repeated fill-in, an automatic style name, or a style area the app rewrites is upkeep.
    return (
      (elsewhere &&
        (automaticName || inStyleArea || (styled(pointer) && count >= 2))) ||
      (edited.size > 0 &&
        entry !== undefined &&
        !edited.has(entry) &&
        gained(pointer) &&
        count >= 2)
    );
  };
};

/** An element holding an ODF document's styles, or its master, handout and notes pages, which an app rewrites as it saves after a reload. */
const STYLE_AREA =
  /^(?:office:(?:styles|automatic-styles|master-styles|font-face-decls)|style:(?:master-page|handout-master))$/u;

/** A number, or a list of numbers split by commas or semicolons, as Dia's `6.3225,6.15;12.5775,8.15`. */
const COORDINATES =
  /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[,;] ?-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)*$/u;

/** Whether a value is a coordinate or a list of them, which an app may derive rather than its user enter. */
export const isCoordinates = (value: JsonValue | undefined): boolean =>
  typeof value === "string" && COORDINATES.test(value.trim());

/** How far above an attribute's element the element whose text changed may sit for the attribute to be its layout. */
const MAX_LAYOUT_CLIMB = 3;

/**
 * Attributes holding coordinates that changed inside an element whose text
 * changed while their own element's did not, as Dia moves and resizes a box
 * (`obj_pos`, `obj_bb`, `elem_width`) around its new text: layout the app
 * derives from the edit. A list of numbers is layout; a lone number only
 * where a name on its way says it is (`namesLayout`). The element whose text changed is at most three
 * levels up and below the root's own children; an attribute of an element
 * whose own text changed, as a spreadsheet cell's `office:value` beside its
 * text, is none.
 */
const derivedLayout = (
  change: Pick<DesktopStateDifference, "changed">,
  ends: Ends,
) => {
  const textAt = (view: JsonValue | null, pointer: string) => {
    const element = resolvePointer(view, pointer);
    return isXmlElement(element) ? elementText(element) : undefined;
  };
  const known = new Map<string, boolean>();
  const retexted = (pointer: string) => {
    const before = textAt(ends.baseline, pointer);
    const found =
      known.get(pointer) ??
      (before !== undefined && before !== textAt(ends.final, pointer));
    known.set(pointer, found);
    return found;
  };
  const layout = new Set(
    change.changed.filter((pointer) => {
      const value = resolvePointer(ends.final, pointer);
      const owner = ownerOfAttribute(pointer);
      if (
        attributeKeyOf(pointer) === undefined ||
        !isCoordinates(value) ||
        retexted(owner)
      )
        return false;
      const segments = owner.split("/");
      const above = Array.from({ length: MAX_LAYOUT_CLIMB }, (_, index) =>
        segments.slice(0, -2 * (index + 1)).join("/"),
      );
      const at = above.findIndex(
        (element) =>
          /\/children\/[^/]+$/u.test(element) &&
          element.split("/").at(-3) !== "root" &&
          retexted(element),
      );
      // A lone number is layout only where a name on its way says so; a list of them always is.
      return (
        at >= 0 &&
        (/[,;]/u.test(String(value)) ||
          namesLayout(ends.final, pointer, [owner, ...above.slice(0, at)]))
      );
    }),
  );
  return (pointer: string) => layout.has(pointer);
};

/** A tag naming a drawing of a model rather than the model, as Umbrello's `diagrams`, `diagram`, `widgets` and `classwidget`. */
const DRAWING = /(?:diagram|widget|canvas|scene)s?$/iu;

/**
 * Coordinates in a drawing of the model, while the model change is
 * elsewhere, as Umbrello grows a class's box (`classwidget` `height` 52 to
 * 67) in its diagram when an attribute is added to the class: an attribute
 * holding a list of numbers, or a number a name on its way calls layout,
 * below an element whose tag names a diagram, widget, canvas or scene, while
 * a change no other rule calls noise lies outside every such element.
 */
const drawingLayout = (
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
  ends: Ends,
  noise: (pointer: string) => NoiseReason | undefined,
) => {
  const viewOf = (pointer: string) =>
    resolvePointer(ends.final, pointer) === undefined
      ? ends.baseline
      : ends.final;
  const drawn = (pointer: string) =>
    elementsAlong(viewOf(pointer), pointer).some(({ name }) =>
      DRAWING.test(name.split(":").at(-1) ?? name),
    );
  // A model element added or removed can resize the drawing. A rename or
  // other edit outside it does not make a deliberate resize into layout.
  const elsewhere = [...change.added, ...change.removed].some(
    (pointer) =>
      noise(pointer) === undefined &&
      !ENTRY_META.test(pointer) &&
      !drawn(pointer),
  );
  return (pointer: string) => {
    const value = resolvePointer(viewOf(pointer), pointer);
    return (
      elsewhere &&
      attributeKeyOf(pointer) !== undefined &&
      isCoordinates(value) &&
      drawn(pointer) &&
      (/[,;]/u.test(String(value)) ||
        namesLayout(viewOf(pointer), pointer, [ownerOfAttribute(pointer)]))
    );
  };
};

/** A word in a name for where or how large something is drawn: a position, a point, a box, a corner, a width or height, an offset or a side. */
const LAYOUT_WORD =
  /^(?:pos|position|x|y|z|point|bb|bbox|bounds|rect|rectangle|corner|width|height|w|h|left|top|right|bottom|offset|origin|coords?)$/u;

/** Whether a name holds a layout word, its parts split at punctuation and case, as Dia's `obj_pos`, `elem_width` or `dia:point`. */
const isLayoutName = (name: string) =>
  name
    .replaceAll(/(?<lower>\p{Ll})(?<upper>\p{Lu})/gu, "$<lower> $<upper>")
    .toLowerCase()
    .split(/[^\p{L}\d]+/u)
    .some((word) => LAYOUT_WORD.test(word));

/**
 * Whether the attribute at a pointer, its element's tag, or the tag or a
 * name-like attribute's value of an element between it and the element
 * whose text changed, names layout, as Dia keeps `elem_width` in
 * `<dia:attribute name="elem_width"><dia:real val="6.155"/>`; an order's
 * `<amount value="12"/>` is no layout.
 */
const namesLayout = (
  view: JsonValue | null,
  pointer: string,
  elements: readonly string[],
) =>
  [
    attributeKeyOf(pointer) ?? "",
    ...elements.flatMap((at) => {
      const element = resolvePointer(view, at);
      return isXmlElement(element)
        ? [
            element.name,
            ...Object.entries(element.attributes).flatMap(([key, value]) =>
              isNameLikeKey(key) && typeof value === "string" ? [value] : [],
            ),
          ]
        : [];
    }),
  ].some(isLayoutName);

/**
 * Why each pointer into a file is noise, or undefined when it is not: a tag,
 * attribute or name-like attribute value on its way naming view state, as
 * `[@config:name=CursorPositionX]`; an attribute an app renumbers, an
 * identifier it numbers by position, or anything inside an element both ends
 * hold whose renumbered attribute changed, as Gnumeric empties a formula cell
 * whose shared expression it renumbers; a UUID or epoch time, an id
 * counter, an id the change gave a new element (`freshIds`), or a duration or
 * count under the document's metadata; a time the app stamps, whole or in
 * parts (`inSplitDate`), or a date under a tag naming bookkeeping; an id
 * the app assigns (`type="guid"`), or text of control characters; upkeep, a
 * change inside an app's `slots`, an attribute an archive entry only
 * gained while another entry holds the edit, a text showing another field
 * that changed alike (`mirrorsOf`), or an element holding nothing but the id
 * of a record the change added (`idReferencesOf`); layout an edit's text
 * derived (`derivedLayout`), or a drawing of the model holds while the
 * model change is elsewhere (`drawingLayout`).
 */
export const changeNoise = (
  change: Pick<DesktopStateDifference, "added" | "changed" | "removed">,
  ends: Ends,
): ((pointer: string) => NoiseReason | undefined) => {
  const renumbered = change.changed.flatMap((pointer) => {
    const key = attributeKeyOf(pointer);
    return key !== undefined && isRenumberedKey(key)
      ? [ownerOfAttribute(pointer)]
      : [];
  });
  const byPosition = positionalRenumbering(ends);
  const fresh = freshIds(change, ends);
  const added = new Set(change.added);
  // A reference on an element both ends hold, as a split moved to the new account, is the user's.
  const freshAt = (
    pointer: string,
    key: string | undefined,
    value: JsonValue | undefined,
  ) =>
    typeof value === "string" &&
    fresh.has(value) &&
    ((key !== undefined && COUNTER_KEY.test(key.split(":").at(-1) ?? key)) ||
      pointer
        .split("/")
        .some((_, index, segments) =>
          added.has(segments.slice(0, index + 1).join("/")),
        ));
  const known = new Map<string, NoiseReason | undefined>();
  const base = (pointer: string): NoiseReason | undefined => {
    if (known.has(pointer)) return known.get(pointer);
    const view =
      resolvePointer(ends.final, pointer) === undefined
        ? ends.baseline
        : ends.final;
    const key = attributeKeyOf(pointer);
    const elements = elementsAlong(view, pointer);
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
          : volatileAt(elements, key, value, freshAt(pointer, key, value))
            ? "volatile"
            : isStamp(value ?? null) ||
                stampedAlong(elements) ||
                stampedWhole(elements, value)
              ? "timestamp"
              : elements.some(isSlots) || isMemberCount(ends, pointer, key)
                ? "upkeep"
                : undefined;
    known.set(pointer, reason);
    return reason;
  };
  const upkeep = upkeepOf(change, ends, base);
  const layout = derivedLayout(change, ends);
  const drawing = drawingLayout(change, ends, base);
  const mirror = mirrorsOf(change, ends);
  const reference = idReferencesOf(change, ends);
  return (pointer) =>
    base(pointer) ??
    (upkeep(pointer) || mirror(pointer) || reference(pointer)
      ? "upkeep"
      : layout(pointer) || drawing(pointer)
        ? "layout"
        : undefined);
};
