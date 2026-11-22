import { isStrictUtf8 } from "../strictUtf8.js";

/** Properties `xprop` reports for one top-level client window. */
export interface X11WindowProperties {
  readonly instance: string | null;
  readonly class: string | null;
  readonly title: string | null;
  readonly pid: number | null;
  readonly window_type: string | null;
}

const TITLE_BYTES_KEY = "WM_NAME bytes";
const TITLE_BYTES_PREFIX = " bytes = ";

/** Request the typed legacy title's bytes beside its locale-dependent rendering. */
export const X11_WINDOW_PROPERTY_ARGUMENTS = [
  "WM_CLASS",
  "_NET_WM_NAME",
  "WM_NAME",
  "8s",
  `:${TITLE_BYTES_PREFIX}$0\\n`,
  "WM_NAME",
  "_NET_WM_PID",
  "_NET_WM_WINDOW_TYPE",
] as const;

const PROPERTY_LINE = /^([A-Z_]+)(?:\(([A-Z0-9_]+)\))?(:| =)([^\r\n]*)$/u;
const WINDOW_ID = /0[xX][0-9a-fA-F]+/gu;
const QUOTED_STRING = /"((?:[^"\\]|\\[^\r\n])*)"/gu;
const SINGLE_QUOTED_STRING = new RegExp(`^${QUOTED_STRING.source}$`, "u");
const OCTAL_BYTE = /[0-7]{3}/u;
const STRING_ESCAPE = new RegExp(
  String.raw`\\(${OCTAL_BYTE.source}|[^\r\n])`,
  "gu",
);
const UTF8_STRING_ESCAPE = new RegExp(
  String.raw`\\(${OCTAL_BYTE.source}(?:\\${OCTAL_BYTE.source})*|[^\r\n])`,
  "gu",
);
const MAX_OCTAL_BYTE = 0xff;
// ICCCM WM_CLASS stores the instance first and the class second.
const CLASS_INDEX = 1;

/** What `xprop` prints for a property that is not set, or an atom never interned. */
const UNSET = new Set(["not found.", "no such atom on any window."]);

type XpropProperty = {
  readonly type: string | undefined;
  readonly text: string;
};

const propertyValues = (output: string): ReadonlyMap<string, XpropProperty> => {
  const values = new Map<string, XpropProperty>();
  for (const line of output.split("\n")) {
    const match = PROPERTY_LINE.exec(line);
    if (match === null) continue;
    const [, name, type, rest, value] = match;
    if (name === undefined || value === undefined) continue;
    const text = value.trim();
    if (rest === ":" && UNSET.has(text)) continue;
    if (
      name === "WM_NAME" &&
      rest === ":" &&
      value.startsWith(TITLE_BYTES_PREFIX)
    )
      values.set(TITLE_BYTES_KEY, {
        type,
        text: value.slice(TITLE_BYTES_PREFIX.length).trim(),
      });
    else values.set(name, { type, text });
  }
  return values;
};

const XPROP_STRING_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  "\\": "\\",
  '"': '"',
};

type PropertyEncoding = "utf8" | "latin1";

/** Consecutive octal escapes can be the bytes of one UTF-8 character. */
const octalText = (run: string, encoding: PropertyEncoding): string | null => {
  const bytes = Buffer.allocUnsafe((run.length + 1) / 4);
  for (let index = 0; index < bytes.length; index += 1) {
    const offset = index * 4;
    const byte = Number.parseInt(run.slice(offset, offset + 3), 8);
    if (byte > MAX_OCTAL_BYTE) return null;
    bytes[index] = byte;
  }
  if (encoding === "utf8" && !isStrictUtf8(bytes)) return null;
  return bytes.toString(encoding);
};

/** xprop emits LF/TAB escapes, quoted delimiters, and three-octal-digit bytes. */
const decodeQuotedString = (
  source: string,
  encoding: PropertyEncoding,
): string | null => {
  let valid = true;
  const decoded = source.replace(
    encoding === "utf8" ? UTF8_STRING_ESCAPE : STRING_ESCAPE,
    (_match, escape: string) => {
      const text =
        escape.length >= 3
          ? octalText(escape, encoding)
          : XPROP_STRING_ESCAPES[escape];
      if (text != null) return text;
      valid = false;
      return "";
    },
  );
  return valid ? decoded : null;
};

/** Read `xprop`'s quoted list; an uninterpretable member keeps its position unknown. */
const quotedStrings = (
  value: string,
  encoding: PropertyEncoding,
): readonly (string | null)[] => {
  const strings: (string | null)[] = [];
  for (const match of value.matchAll(QUOTED_STRING))
    strings.push(decodeQuotedString(match[1] ?? "", encoding));
  return strings;
};

const legacyTitle = (
  properties: ReadonlyMap<string, XpropProperty>,
): string | null => {
  const bytes = properties.get(TITLE_BYTES_KEY);
  if (bytes?.type === "STRING" || bytes?.type === "UTF8_STRING") {
    const value = SINGLE_QUOTED_STRING.exec(bytes.text)?.[1];
    return value === undefined
      ? null
      : decodeQuotedString(value, bytes.type === "STRING" ? "latin1" : "utf8");
  }
  const display = properties.get("WM_NAME");
  if (
    display === undefined ||
    (bytes !== undefined && bytes.type !== display.type) ||
    (display.type !== undefined && display.type !== "COMPOUND_TEXT")
  )
    return null;
  // `8t` leaves printable quotes and backslashes literal after locale conversion,
  // but escapes them on failure. A backslash sequence can have either meaning.
  const value = /^"([^\r\n]*)"$/u.exec(display.text)?.[1];
  return value === undefined || /\\(?:[0-7]{3}|[\\"nt])/u.test(value)
    ? null
    : value;
};

/**
 * Parse the `_NET_CLIENT_LIST` window ids from `xprop -root`. An EWMH window
 * manager leaves the list unset while it manages no windows, so a missing list
 * is empty when `_NET_SUPPORTED` names it and undefined otherwise.
 */
export const parseX11ClientList = (
  output: string,
): readonly string[] | undefined => {
  const values = propertyValues(output);
  const value = values.get("_NET_CLIENT_LIST")?.text;
  if (value === undefined)
    return (values.get("_NET_SUPPORTED")?.text ?? "")
      .split(",")
      .some((atom) => atom.trim() === "_NET_CLIENT_LIST")
      ? []
      : undefined;
  return [...value.matchAll(WINDOW_ID)].map((match) => match[0].toLowerCase());
};

/** Parse one window's class, title, owner pid and type from `xprop -id`. */
export const parseX11WindowProperties = (
  output: string,
): X11WindowProperties => {
  const values = propertyValues(output);
  const classes = quotedStrings(values.get("WM_CLASS")?.text ?? "", "latin1");
  const netName = values.get("_NET_WM_NAME")?.text;
  const title =
    // xprop prefixes an invalid UTF8_STRING with an unquoted diagnostic.
    (netName?.startsWith('"') ? quotedStrings(netName, "utf8")[0] : null) ??
    legacyTitle(values);
  const pid = Number(values.get("_NET_WM_PID")?.text);
  const windowType = values
    .get("_NET_WM_WINDOW_TYPE")
    ?.text.split(",")[0]
    ?.trim();
  return {
    instance: classes[0] ?? null,
    class: classes[CLASS_INDEX] ?? null,
    title,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    window_type:
      windowType === undefined || windowType.length === 0
        ? null
        : windowType.replace(/^_NET_WM_WINDOW_TYPE_/u, "").toLowerCase(),
  };
};

/** The detached export reads the same xprop properties using Python's standard library. */
export const PYTHON_X11_PROPERTIES = String.raw`
XPROP_PROPERTY_LINE = re.compile(${JSON.stringify(PROPERTY_LINE.source)})
XPROP_WINDOW_ID = re.compile(${JSON.stringify(WINDOW_ID.source)})
XPROP_QUOTED_STRING = re.compile(${JSON.stringify(QUOTED_STRING.source)})
XPROP_STRING_ESCAPE = re.compile(${JSON.stringify(STRING_ESCAPE.source)})
XPROP_OCTAL_BYTE = re.compile(${JSON.stringify(OCTAL_BYTE.source)})
XPROP_STRING_ESCAPES = ${JSON.stringify(XPROP_STRING_ESCAPES)}
XPROP_UNSET = ${JSON.stringify([...UNSET])}


def _x11_properties(output: str) -> dict[str, str]:
    properties = {}
    for line in output.split("\n"):
        match = XPROP_PROPERTY_LINE.fullmatch(line)
        if match is None:
            continue
        name, _, delimiter, value = match.groups()
        value = value.strip(ECMASCRIPT_TRIM_CHARACTERS)
        if delimiter != ":" or value not in XPROP_UNSET:
            properties[name] = value
    return properties


def _x11_client_ids(properties: dict[str, str]) -> list[str]:
    return [match.group().lower() for match in XPROP_WINDOW_ID.finditer(properties.get("_NET_CLIENT_LIST", ""))]


def _x11_window_class(properties: dict[str, str]) -> str | None:
    def decode(escape_match):
        escape = escape_match.group(1)
        if XPROP_OCTAL_BYTE.fullmatch(escape):
            byte = int(escape, 8)
            if byte <= ${String(MAX_OCTAL_BYTE)}:
                return chr(byte)
        elif escape in XPROP_STRING_ESCAPES:
            return XPROP_STRING_ESCAPES[escape]
        raise ValueError("unknown xprop string escape")

    for index, match in enumerate(XPROP_QUOTED_STRING.finditer(properties.get("WM_CLASS", ""))):
        if index == ${String(CLASS_INDEX)}:
            try:
                return XPROP_STRING_ESCAPE.sub(decode, match.group(1))
            except ValueError:
                return None
    return None
`;
