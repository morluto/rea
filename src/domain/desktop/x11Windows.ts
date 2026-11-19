/** Properties `xprop` reports for one top-level client window. */
export interface X11WindowProperties {
  readonly instance: string | null;
  readonly class: string | null;
  readonly title: string | null;
  readonly pid: number | null;
  readonly window_type: string | null;
}

/** Properties requested from `xprop -notype`, in output order. */
export const X11_WINDOW_PROPERTY_NAMES = [
  "WM_CLASS",
  "_NET_WM_NAME",
  "WM_NAME",
  "_NET_WM_PID",
  "_NET_WM_WINDOW_TYPE",
] as const;

const PROPERTY_LINE =
  /^([A-Z_]+)(?:\([A-Z0-9_]+\))?(:| =)([^\r\n\u2028\u2029]*)$/u;
const WINDOW_ID = /0[xX][0-9a-fA-F]+/gu;
const QUOTED_STRING = /"((?:[^"\\]|\\[^\r\n\u2028\u2029])*)"/gu;
const STRING_ESCAPE = /\\([0-7]{3}|[^\r\n\u2028\u2029])/gu;
const OCTAL_BYTE = /^[0-7]{3}$/u;
const MAX_OCTAL_BYTE = 0xff;
// ICCCM WM_CLASS stores the instance first and the class second.
const CLASS_INDEX = 1;

/** What `xprop` prints for a property that is not set, or an atom never interned. */
const UNSET = new Set(["not found.", "no such atom on any window."]);

const propertyValues = (output: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = PROPERTY_LINE.exec(line);
    if (match === null) continue;
    const [, name, rest, value] = match;
    if (name === undefined || value === undefined) continue;
    if (rest === ":" && UNSET.has(value.trim())) continue;
    values.set(name, value.trim());
  }
  return values;
};

const XPROP_STRING_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  "\\": "\\",
  '"': '"',
};

/** xprop emits LF/TAB escapes, quoted delimiters, and three-octal-digit bytes. */
const decodeQuotedString = (source: string): string | null => {
  let valid = true;
  const decoded = source.replace(STRING_ESCAPE, (_match, escape: string) => {
    if (OCTAL_BYTE.test(escape)) {
      const byte = Number.parseInt(escape, 8);
      if (byte <= MAX_OCTAL_BYTE) return String.fromCharCode(byte);
    } else {
      const value = XPROP_STRING_ESCAPES[escape];
      if (value !== undefined) return value;
    }
    valid = false;
    return "";
  });
  return valid ? decoded : null;
};

/** Read `xprop`'s quoted list; an uninterpretable member keeps its position unknown. */
const quotedStrings = (value: string): readonly (string | null)[] => {
  const strings: (string | null)[] = [];
  for (const match of value.matchAll(QUOTED_STRING))
    strings.push(decodeQuotedString(match[1] ?? ""));
  return strings;
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
  const value = values.get("_NET_CLIENT_LIST");
  if (value === undefined)
    return (values.get("_NET_SUPPORTED") ?? "")
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
  const classes = quotedStrings(values.get("WM_CLASS") ?? "");
  const title =
    quotedStrings(values.get("_NET_WM_NAME") ?? "")[0] ??
    quotedStrings(values.get("WM_NAME") ?? "")[0] ??
    null;
  const pid = Number(values.get("_NET_WM_PID"));
  const windowType = values.get("_NET_WM_WINDOW_TYPE")?.split(",")[0]?.trim();
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
        name, delimiter, value = match.groups()
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
