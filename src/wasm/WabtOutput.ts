/** WABT prints names with %.*s, so an embedded NUL ends their display. */
const wabtDisplayedName = (name: string | undefined): string | undefined =>
  name?.split("\0", 1)[0];

/** Frame WABT's raw custom names using the ordered names from its escaped WAT output. */
export const parseWabtOutput = (
  text: string,
  artifactBytes: number,
  customSectionNames: readonly string[],
  debugModuleNames: readonly string[] = [],
) => {
  const preamble =
    "\nmodule.wasm:\tfile format wasm 0x1\n" +
    debugModuleNames
      .map((name) => `module name: <${wabtDisplayedName(name)}>\n`)
      .join("");
  const prefix = `${preamble}\nSections:\n\n`;
  if (!text.startsWith(prefix))
    throw new Error("Unsupported WABT section header format.");
  let offset = prefix.length;
  let customIndex = 0;
  const sections = [];
  while (!text.startsWith("\nSection Details:\n", offset)) {
    const match =
      /^[ \t]*(\w+) start=0x([\da-f]+) end=0x([\da-f]+) \(size=0x([\da-f]+)\) /u.exec(
        text.slice(offset),
      );
    if (match === null) throw new Error("Unrecognized WABT section row.");
    offset += match[0].length;
    let description: string;
    if (match[1] === "Custom") {
      const name = wabtDisplayedName(customSectionNames[customIndex++]);
      if (name === undefined || !text.startsWith(`"${name}"\n`, offset))
        throw new Error(
          "WABT custom-section header does not match decoded WAT.",
        );
      description = `"${name}"`;
      offset += description.length + 1;
    } else {
      const end = text.indexOf("\n", offset);
      if (end < 0) throw new Error("Incomplete WABT section row.");
      description = text.slice(offset, end).trim();
      offset = end + 1;
    }
    const section = {
      kind: match[1] ?? "",
      start: Number.parseInt(match[2] ?? "", 16),
      end: Number.parseInt(match[3] ?? "", 16),
      bytes: Number.parseInt(match[4] ?? "", 16),
      description,
    };
    const sectionHeaderBytes = section.start - (sections.at(-1)?.end ?? 8);
    if (
      section.end > artifactBytes ||
      section.end - section.start !== section.bytes ||
      sectionHeaderBytes < 2 ||
      sectionHeaderBytes > 6
    )
      throw new Error("WABT section ranges do not match selected artifact.");
    sections.push(section);
  }
  if (customIndex !== customSectionNames.length)
    throw new Error(
      "WABT custom-section inventory does not match decoded WAT.",
    );
  if ((sections.at(-1)?.end ?? 8) !== artifactBytes)
    throw new Error(
      "WABT section output does not cover the selected artifact.",
    );
  const separator = offset + 1;
  return {
    sections,
    headers: text.slice(0, separator),
    details: `${preamble.slice(1)}\n${text.slice(separator)}`,
  };
};
