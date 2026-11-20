/** Desktop text records use LF or CRLF. Other characters stay in the record. */
export const DESKTOP_LINE_BREAK = String.raw`\r?\n`;
export const desktopLineBreak = new RegExp(DESKTOP_LINE_BREAK, "gu");

/** Python spelling of the ECMAScript String.trim() character set, without Python-only whitespace. */
export const PYTHON_ECMASCRIPT_TRIM_CHARACTERS = String.raw`"\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"`;

/** On a trimmed keyfile line, match a blank/comment or capture a group name. */
export const KEYFILE_CONTROL_LINE = String.raw`^(?:[#;][\s\S]*)?$|^\[([^\]]+)\]$`;

/** On a raw keyfile line, capture the key and value. Only ASCII space and tab after '=' are padding. */
export const KEYFILE_ENTRY_LINE = String.raw`^([^=]*)=[ \t]*([\s\S]*)$`;

type KeyfileLine =
  | { readonly kind: "skip" }
  | { readonly kind: "group"; readonly name: string }
  | { readonly kind: "entry"; readonly key: string; readonly value: string }
  | { readonly kind: "other" };

const keyfileControlLine = new RegExp(KEYFILE_CONTROL_LINE, "u");
const keyfileEntryLine = new RegExp(KEYFILE_ENTRY_LINE, "u");

const keyfileLine = (raw: string): KeyfileLine => {
  const control = keyfileControlLine.exec(raw.trim());
  if (control !== null) {
    const name = control[1];
    return name === undefined ? { kind: "skip" } : { kind: "group", name };
  }
  const entry = keyfileEntryLine.exec(raw);
  const key = entry?.[1]?.trim();
  const value = entry?.[2];
  return key === undefined || key === "" || value === undefined
    ? { kind: "other" }
    : { kind: "entry", key, value };
};

/** Read keyfile lines lazily so a plain text file can be rejected immediately. */
export function* keyfileLines(text: string): Generator<KeyfileLine> {
  let start = 0;
  for (const delimiter of text.matchAll(desktopLineBreak)) {
    yield keyfileLine(text.slice(start, delimiter.index));
    start = delimiter.index + delimiter[0].length;
  }
  yield keyfileLine(text.slice(start));
}

/** A keyfile has at least one group and nothing a keyfile view would drop. */
export const isKeyfile = (text: string): boolean => {
  let group = false;
  for (const { kind } of keyfileLines(text)) {
    if (kind === "other") return false;
    if (kind === "group") group = true;
  }
  return group;
};
