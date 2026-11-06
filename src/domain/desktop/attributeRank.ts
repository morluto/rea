/** An attribute that identifies its element: `name`, `id`, `xid`, or a prefixed `id` such as `xml:id`. */
export const isIdentifyingAttribute = (key: string): boolean =>
  /^(?:name|id|xid|.+:id)$/iu.test(key);

/**
 * Words in a name for how the app showed, printed or kept the document rather
 * than what it holds: its cursor, selection, scroll, zoom, windows, view and
 * configuration settings, printer, and a save's history, edit time and count,
 * generator and statistics.
 */
export const VIEW_STATE =
  /cursor|selection|selected|scroll|zoom|viewport|window|splitter|toplevel|topleft|uidata|namedview|view-?settings|config(?:uration)?-?settings|printer|history|edit(?:ing)?-?(?:time|duration|cycles?)|last-?saved|generator|document-?statistic/iu;

/** Whether a tag or attribute name is about how the app showed the document rather than what it holds. */
export const isViewStateName = (name: string): boolean => VIEW_STATE.test(name);

/** An attribute's name without its namespace prefix, in lower case. */
const localName = (key: string) => (key.split(":").at(-1) ?? key).toLowerCase();

/** A key that names what its element is called, such as Scribus's `ANNAME` or `inkscape:label`, but not a style or font it uses. */
const NAME_LIKE = /(?:name|title|label|caption)$/u;
const STYLE_NAME = /(?:style|font|family|class|type)-?name$/u;
/** A hex run or UUID, or a long base64-like token with a digit in it: words a program makes. */
const HEX_TOKEN = /^[0-9a-f-]{8,}$/iu;
const LONG_TOKEN = /^(?=.*\d)[A-Za-z0-9+/=_-]{16,}$/u;

/** Whether a value is a word a program makes, a hex run, UUID or long token, rather than one a user typed. */
export const isGeneratedToken = (value: string): boolean =>
  HEX_TOKEN.test(value) || LONG_TOKEN.test(value);

/** Whether an identifier's value is one an app generates for a new element, as Freeplane's `ID_329023692` or a GUID, which another save of the same edit would not repeat. */
export const isGeneratedId = (value: string): boolean =>
  /^[A-Za-z]*[_-]?\d{6,}$/u.test(value) || isGeneratedToken(value);

/** Whether a key names what its element is called rather than a style or font it uses. */
export const isNameLikeKey = (key: string): boolean => {
  const local = localName(key);
  return NAME_LIKE.test(local) && !STYLE_NAME.test(local);
};

/**
 * How well an attribute names its element across saves, best first: 0 a
 * name-like key, 1 a worded value that is no generated token, 2 an integer of
 * up to five digits, 3 anything else, such as a coordinate, a long number or a
 * token, which a later save may change, as it may view state such as which
 * layer is `selected`.
 */
export const attributeTier = (key: string, value: string): 0 | 1 | 2 | 3 => {
  if (isViewStateName(key)) return 3;
  if (isNameLikeKey(key)) return 0;
  if (/\p{L}/u.test(value) && !isGeneratedToken(value)) return 1;
  return /^-?\d{1,5}$/u.test(value) ? 2 : 3;
};

/** Attributes best first by `attributeTier`, those of one tier in the order given. */
export const rankAttributes = <Entry extends { key: string; value: string }>(
  entries: readonly Entry[],
): (Entry & { readonly tier: 0 | 1 | 2 | 3 })[] =>
  entries
    .map((entry) => ({ ...entry, tier: attributeTier(entry.key, entry.value) }))
    .toSorted((left, right) => left.tier - right.tier);
