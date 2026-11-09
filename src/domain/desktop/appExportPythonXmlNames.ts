import { XML_NAME_START, XML_NAME_MORE } from "../xmlNames.js";

const pythonRange = (source: string): string =>
  source.replaceAll(
    /\\u\{([0-9a-f]+)\}/giu,
    (_match, hex: string) => `\\U${hex.padStart(8, "0")}`,
  );
const start = pythonRange(XML_NAME_START);
const more = pythonRange(XML_NAME_MORE);
const ncStart = start.replace(":", "");

/** A bounded, reversible name-only bridge to expat's older XML name tables. */
export const PYTHON_XML_NAMES = String.raw`
XML_NAME = re.compile(r"[${start}][${start}${more}]*")
XML_NCNAME = re.compile(r"[${ncStart}][${ncStart}${more}]*")
XML_NAME_ESCAPE = re.compile(r"__|_u([0-9a-f]+)_")
XML_INVALID_TOKEN = expat.errors.codes[expat.errors.XML_ERROR_INVALID_TOKEN]


def _xml_original_name(name: str) -> str:
    if "_" not in name:
        return name
    out, at = io.StringIO(), 0
    for escaped in XML_NAME_ESCAPE.finditer(name):
        out.write(name[at:escaped.start()])
        out.write("_" if escaped[0] == "__" else chr(int(escaped[1], 16)))
        at = escaped.end()
    out.write(name[at:])
    return out.getvalue()


def _xml_names_for_expat(text: str) -> str:
    """Encode names only, leaving text, attribute values, comments and identifiers as supplied. Expat still owns
    XML syntax, namespaces and entity refusal. The wire form is bounded before writes by the view byte allowance;
    this compatibility path is only used for documents the original expat pass could not read."""
    out, used = io.StringIO(), 0

    def put(part: str) -> None:
        nonlocal used
        used += len(part.encode("utf-8"))
        if used > MAX_VIEW_BYTES:
            raise ValueError("XML name adaptation exceeds the view byte allowance")
        out.write(part)

    def name(at: int, qname: bool) -> int:
        end = at
        while end < len(text) and text[end] not in XML_WHITESPACE + "/>=?":
            end += 1
        raw = text[at:end]
        if qname:
            valid = raw.count(":") <= 1 and all(XML_NCNAME.fullmatch(part) for part in raw.split(":"))
        else:
            valid = XML_NAME.fullmatch(raw)
        if not valid:
            raise ValueError("XML name is outside the XML 1.0 name grammar")
        for offset in range(0, len(raw), 512):
            put("".join("__" if char == "_" else f"_u{ord(char):x}_" if ord(char) > 127 else char
                        for char in raw[offset:offset + 512]))
        return end

    at = 0
    while at < len(text):
        opening = text.find("<", at)
        if opening < 0:
            put(text[at:])
            break
        put(text[at:opening])
        if text.startswith("<!--", opening) or text.startswith("<![CDATA[", opening):
            closing = "-->" if text.startswith("<!--", opening) else "]]>"
            end = text.find(closing, opening + (4 if closing == "-->" else 9))
            if end < 0:
                raise ValueError("Unclosed XML comment or CDATA")
            at = end + len(closing)
            put(text[opening:at])
            continue
        if text.startswith("<?", opening):
            put("<?")
            at = name(opening + 2, False)
            end = text.find("?>", at)
            if end < 0:
                raise ValueError("Unclosed XML processing instruction")
            put(text[at:end + 2])
            at = end + 2
            continue
        if text.startswith("<!DOCTYPE", opening):
            at = opening + len("<!DOCTYPE")
            while at < len(text) and text[at] in XML_WHITESPACE:
                at += 1
            put(text[opening:at])
            at = name(at, False)
            begin, quote = at, None
            while at < len(text):
                char = text[at]
                if quote is not None:
                    if char == quote:
                        quote = None
                elif char in "\"'":
                    quote = char
                elif char == "[":
                    raise ValueError("the document's DOCTYPE has an internal subset")
                elif char == ">":
                    break
                at += 1
            if at == len(text):
                raise ValueError("Unclosed XML DOCTYPE")
            put(text[begin:at + 1])
            at += 1
            continue
        if text.startswith("<!", opening):
            raise ValueError("Unknown XML declaration")
        closing = text.startswith("</", opening)
        put("</" if closing else "<")
        at = name(opening + (2 if closing else 1), True)
        while True:
            begin = at
            while at < len(text) and text[at] in XML_WHITESPACE:
                at += 1
            put(text[begin:at])
            if text.startswith(">", at) or (not closing and text.startswith("/>", at)):
                end = at + (2 if text.startswith("/>", at) else 1)
                put(text[at:end])
                at = end
                break
            if closing or at == begin:
                raise ValueError("Invalid XML tag boundary")
            at = name(at, True)
            begin = at
            while at < len(text) and text[at] in XML_WHITESPACE:
                at += 1
            if at >= len(text) or text[at] != "=":
                raise ValueError("XML attribute has no equals sign")
            at += 1
            while at < len(text) and text[at] in XML_WHITESPACE:
                at += 1
            if at >= len(text) or text[at] not in "\"'":
                raise ValueError("XML attribute has no quoted value")
            end = text.find(text[at], at + 1)
            if end < 0:
                raise ValueError("Unclosed XML attribute value")
            put(text[begin:end + 1])
            at = end + 1
    return out.getvalue()
`;
