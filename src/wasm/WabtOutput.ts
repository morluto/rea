import { WabtAdmissionError } from "./WabtAdmissionError.js";
import { readLeb128, ULEB32 } from "../domain/leb128.js";
import { isStrictUtf8 } from "../domain/strictUtf8.js";

const SECTION_ROW_RE =
  /[ \t]*(\w+) start=0x([\da-f]+) end=0x([\da-f]+) \(size=0x([\da-f]+)\) /uy;

/** WABT prints names with %.*s, so an embedded NUL ends their display. */
const wabtDisplayedName = (name: string | undefined): string | undefined => {
  if (name === undefined) return undefined;
  const nul = name.indexOf("\0");
  return nul < 0 ? name : name.slice(0, nul);
};

const parseCustomSectionField = (
  text: string,
  offset: number,
  customSectionNames: readonly string[],
  customIndex: { value: number },
  bounds: { start: number; end: number; artifact: Uint8Array | undefined },
): {
  readonly description: string;
  readonly nextOffset: number;
  readonly invalidNameEnd?: number;
} => {
  if (text.charCodeAt(offset) !== 0x22) {
    // WABT leaves this field blank when the binary custom name is invalid
    // UTF-8. Confirm the bytes rather than inventing a name from its output.
    const invalidEnd = invalidCustomNameEnd(
      bounds.artifact,
      bounds.start,
      bounds.end,
    );
    if (invalidEnd === undefined)
      throw new WabtAdmissionError("blank_custom_name");
    const nextOffset =
      text.charCodeAt(offset) === 0x0a &&
      !text.startsWith("\nSection Details:\n", offset)
        ? offset + 1
        : offset;
    return { description: "", nextOffset, invalidNameEnd: invalidEnd };
  }
  const name = wabtDisplayedName(customSectionNames[customIndex.value++]);
  if (
    name === undefined ||
    text.charCodeAt(offset) !== 0x22 ||
    !text.startsWith(name, offset + 1) ||
    text.charCodeAt(offset + 1 + name.length) !== 0x22 ||
    text.charCodeAt(offset + 2 + name.length) !== 0x0a
  )
    throw new WabtAdmissionError("custom_header_mismatch");
  const description = `"${name}"`;
  return { description, nextOffset: offset + description.length + 1 };
};

/** Frame WABT's raw custom names using the ordered names from its escaped WAT output. */
export const parseWabtOutput = (
  text: string,
  artifactBytes: number,
  customSectionNames: readonly string[],
  debugModuleNames: readonly string[] = [],
  artifact?: Uint8Array,
) => {
  let moduleLines = "";
  for (let i = 0; i < debugModuleNames.length; i++)
    moduleLines += `module name: <${wabtDisplayedName(debugModuleNames[i])}>\n`;
  const preamble = `\nmodule.wasm:\tfile format wasm 0x1\n${moduleLines}`;
  const prefix = `${preamble}\nSections:\n\n`;
  if (!text.startsWith(prefix))
    throw new WabtAdmissionError("unsupported_section_header");
  let offset = prefix.length;
  const customIndex = { value: 0 };
  let previousEnd = 8;
  const sections = [];
  const invalidNameEnds = new Set<number>();
  while (!text.startsWith("\nSection Details:\n", offset)) {
    SECTION_ROW_RE.lastIndex = offset;
    const match = SECTION_ROW_RE.exec(text);
    if (match === null)
      throw new WabtAdmissionError("unrecognized_section_row");
    offset += match[0].length;
    const kind = match[1] ?? "";
    const start = Number.parseInt(match[2] ?? "", 16);
    const end = Number.parseInt(match[3] ?? "", 16);
    const bytes = Number.parseInt(match[4] ?? "", 16);
    let description: string;
    if (kind === "Custom") {
      const parsed = parseCustomSectionField(
        text,
        offset,
        customSectionNames,
        customIndex,
        { start, end, artifact },
      );
      description = parsed.description;
      offset = parsed.nextOffset;
      if (parsed.invalidNameEnd !== undefined)
        invalidNameEnds.add(parsed.invalidNameEnd);
    } else {
      const rowEnd = text.indexOf("\n", offset);
      if (rowEnd < 0) throw new WabtAdmissionError("incomplete_section_row");
      description = text.slice(offset, rowEnd).trim();
      offset = rowEnd + 1;
    }
    const sectionHeaderBytes = start - previousEnd;
    if (
      end > artifactBytes ||
      end - start !== bytes ||
      sectionHeaderBytes < 2 ||
      sectionHeaderBytes > 6
    )
      throw new WabtAdmissionError("section_ranges");
    previousEnd = end;
    sections.push({ kind, start, end, bytes, description });
  }
  if (customIndex.value !== customSectionNames.length)
    throw new WabtAdmissionError("custom_inventory_mismatch");
  if (previousEnd !== artifactBytes)
    throw new WabtAdmissionError("section_coverage");
  const separator = offset + 1;
  return {
    sections,
    headers: text.slice(0, separator),
    details: `${preamble.slice(1)}\n${text.slice(separator)}`,
    invalidNameEnds,
  };
};

/** Return the end of a bounded invalid UTF-8 name, or undefined if unproved. */
const invalidCustomNameEnd = (
  bytes: Uint8Array | undefined,
  start: number,
  end: number,
): number | undefined => {
  if (bytes === undefined || end > bytes.length || start >= end)
    return undefined;
  const read = readLeb128(bytes, start, end, ULEB32);
  if ("failure" in read) return undefined;
  const nameEnd = read.next + Number(read.value);
  if (nameEnd > end) return undefined;
  return isStrictUtf8(bytes.subarray(read.next, nameEnd)) ? undefined : nameEnd;
};
