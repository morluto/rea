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
  /^(?<name>[A-Z_]+)(?:\([A-Z0-9_]+\))?(?<rest>:| =)(?<value>.*)$/u;

/** What `xprop` prints for a property that is not set, or an atom never interned. */
const UNSET = new Set(["not found.", "no such atom on any window."]);

const propertyValues = (output: string): ReadonlyMap<string, string> => {
  const values = new Map<string, string>();
  for (const line of output.split("\n")) {
    const match = PROPERTY_LINE.exec(line);
    if (match?.groups === undefined) continue;
    const { name, rest, value } = match.groups;
    if (name === undefined || value === undefined) continue;
    if (rest === ":" && UNSET.has(value.trim())) continue;
    values.set(name, value.trim());
  }
  return values;
};

const XPROP_STRING_ESCAPES: ReadonlyMap<string, string> = new Map([
  ["n", "\n"],
  ["t", "\t"],
  ["\\", "\\"],
  ['"', '"'],
]);

/** xprop emits LF/TAB escapes, quoted delimiters, and three-octal-digit bytes. */
const decodeQuotedString = (source: string): string | null => {
  let valid = true;
  const decoded = source.replace(
    /\\([0-7]{3}|.)/gu,
    (_match, escape: string) => {
      if (/^[0-7]{3}$/u.test(escape)) {
        const byte = Number.parseInt(escape, 8);
        if (byte <= 0xff) return String.fromCharCode(byte);
      } else {
        const value = XPROP_STRING_ESCAPES.get(escape);
        if (value !== undefined) return value;
      }
      valid = false;
      return "";
    },
  );
  return valid ? decoded : null;
};

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ENCODER = new TextEncoder();

/**
 * A `UTF8_STRING` value. Outside a UTF-8 locale xprop writes every non-ASCII
 * byte of the value as an octal escape, so escapes are UTF-8 bytes rather
 * than characters; text that is not UTF-8 stays unknown.
 */
const decodeQuotedUtf8 = (source: string): string | null => {
  const bytes: number[] = [];
  for (const [, escape, literal] of source.matchAll(
    /\\([0-7]{3}|.)|([^\\]+)/gu,
  )) {
    if (literal !== undefined) bytes.push(...ENCODER.encode(literal));
    else if (escape !== undefined && /^[0-7]{3}$/u.test(escape)) {
      const byte = Number.parseInt(escape, 8);
      if (byte > 0xff) return null;
      bytes.push(byte);
    } else {
      const value = XPROP_STRING_ESCAPES.get(escape ?? "");
      if (value === undefined) return null;
      bytes.push(value.charCodeAt(0));
    }
  }
  try {
    return UTF8.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
};

/** Read `xprop`'s quoted list; an uninterpretable member keeps its position unknown. */
const quotedStrings = (
  value: string,
  decode: (source: string) => string | null = decodeQuotedString,
): readonly (string | null)[] => {
  const strings: (string | null)[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/gu;
  for (const match of value.matchAll(pattern))
    strings.push(decode(match[1] ?? ""));
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
  return [...value.matchAll(/0x[0-9a-f]+/giu)].map((match) =>
    match[0].toLowerCase(),
  );
};

/** Parse one window's class, title, owner pid and type from `xprop -id`. */
export const parseX11WindowProperties = (
  output: string,
): X11WindowProperties => {
  const values = propertyValues(output);
  const [instance, class_] = quotedStrings(values.get("WM_CLASS") ?? "");
  const title =
    quotedStrings(values.get("_NET_WM_NAME") ?? "", decodeQuotedUtf8)[0] ??
    quotedStrings(values.get("WM_NAME") ?? "")[0] ??
    null;
  const pid = Number(values.get("_NET_WM_PID"));
  const windowType = values.get("_NET_WM_WINDOW_TYPE")?.split(",")[0]?.trim();
  return {
    instance: instance ?? null,
    class: class_ ?? null,
    title,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    window_type:
      windowType === undefined || windowType.length === 0
        ? null
        : windowType.replace(/^_NET_WM_WINDOW_TYPE_/u, "").toLowerCase(),
  };
};
