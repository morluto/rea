/** An attribute that identifies its element: `name`, `id`, `xid`, or a prefixed `id` such as `xml:id`. */
export const isIdentifyingAttribute = (key: string): boolean =>
  /^(?:name|id|xid|.+:id)$/iu.test(key);

/**
 * Words in a name for how the app showed, printed or kept the document rather
 * than what it holds: its cursor, selection (VYM's `<select>`), the layer,
 * frame, view or colour it has current, scroll, zoom, windows, view and
 * configuration settings, a list or tree view mirroring the document,
 * printer, a save's history, edit time and count, generator and statistics,
 * and the preview or thumbnail it renders.
 */
export const VIEW_STATE =
  /cursor|^select$|selection|selected|current[-_]?(?:layer|frame|view|colou?r|page|tab|tool|index|item|row|column|cell|sheet|slide|object|scene|track)|scroll|zoom|viewport|window|splitter|toplevel|topleft|uidata|namedview|view-?settings|(?:list|tree)-?view|config(?:uration)?-?settings|printer|history|edit(?:ing)?-?(?:time|duration|cycles?)|last-?saved|generator|document-?statistic|preview|thumbnail/iu;

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

/** Whether a value stands for no value, as Grisbi writes `Id="(null)"` on every transaction: it names nothing. */
export const isPlaceholder = (value: string): boolean =>
  /^\(?(?:null|nil|none|undefined)\)?$/iu.test(value.trim());

/** Umbrello's ids: `u` and twelve letters and digits mixing cases at random, as `ubcgF2AWfBmHh`, with a digit or four or more changes of case. */
const isRandomCaseId = (value: string): boolean =>
  /^u(?=[^]*[A-Z])(?=[^]*[a-z])[A-Za-z\d]{12}$/u.test(value) &&
  (/\d/u.test(value) ||
    (value.match(/\p{Ll}(?=\p{Lu})|\p{Lu}(?=\p{Ll})/gu)?.length ?? 0) >= 4);

/** Whether a value is a GUID, braced or not, as VYM's `uuid="{18eadb5d-04fc-4448-a0f9-1f9a3dedaff7}"` on each branch. */
export const isGuid = (value: string): boolean =>
  /^\{?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\}?$/iu.test(value);

/** Whether a value is a word a program makes, a hex run, GUID, long token or an id of random case, rather than one a user typed. */
export const isGeneratedToken = (value: string): boolean =>
  HEX_TOKEN.test(value) ||
  isGuid(value) ||
  LONG_TOKEN.test(value) ||
  isRandomCaseId(value);

/** Whether an identifier's value is one an app generates for a new element, as Freeplane's `ID_329023692` or a GUID, which another save of the same edit would not repeat. */
export const isGeneratedId = (value: string): boolean =>
  /^[A-Za-z]*[_-]?\d{6,}$/u.test(value) || isGeneratedToken(value);

/** Whether an identifier is one an ODF app numbers anew as it saves, as LibreOffice's `xml:id="id2"` and `draw:id="id2"` on a shape: where the shape came in that save, not which shape it is. */
export const isSaveNumberedId = (key: string, value: string): boolean =>
  /^(?:xml|draw):id$/iu.test(key) && /^id\d+$/u.test(value);

/** Whether a key names what its element is called rather than a style or font it uses. */
export const isNameLikeKey = (key: string): boolean => {
  const local = localName(key);
  return NAME_LIKE.test(local) && !STYLE_NAME.test(local);
};

/** A length with its unit, as ODF's `svg:height="2.629cm"`: a coordinate, however it is spelled. */
const MEASURE = /^-?\d+(?:\.\d+)?(?:cm|mm|in|pt|pc|px|em|%)$/u;

/** Whether an attribute names an automatic style an app numbers as it saves, as LibreOffice's `presentation:style-name="pr1"` or `text:style-name="MT1"`, which it shares and renumbers on reload. */
export const isAutomaticStyle = (key: string, value: string): boolean =>
  /style-name$/iu.test(key) && /^[A-Za-z]{1,4}\d+$/u.test(value);

/**
 * How well an attribute names its element across saves, best first: 0 a
 * name-like key, 1 a worded value that is no generated token, 2 an integer of
 * up to five digits, 3 anything else, such as a coordinate or a length with
 * its unit, a long number, a token or an automatic style name (`pr1`), which
 * a later save may change, as it may view state such as which layer is
 * `selected`.
 */
export const attributeTier = (key: string, value: string): 0 | 1 | 2 | 3 => {
  if (
    isViewStateName(key) ||
    isAutomaticStyle(key, value) ||
    MEASURE.test(value)
  )
    return 3;
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
