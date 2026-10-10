/** Parse only WABT producer text; full original detail lines remain authoritative. */
export const parseWabtHeaders = (text: string, artifactBytes: number) => {
  if (
    !/^module\.wasm:\s+file format wasm 0x1$/mu.test(text) ||
    !text.includes("Sections:\n")
  )
    throw new Error("Unsupported WABT section header format.");
  const sections = [];
  for (const line of text.split("\n")) {
    if (
      line.trim() === "" ||
      line.includes("file format") ||
      line === "Sections:"
    )
      continue;
    const match =
      /^\s+(\w+) start=0x([\da-f]+) end=0x([\da-f]+) \(size=0x([\da-f]+)\)(.*)$/u.exec(
        line,
      );
    if (match === null)
      throw new Error(`Unrecognized WABT section row: ${line}`);
    const section = {
      kind: match[1] ?? "",
      start: Number.parseInt(match[2] ?? "", 16),
      end: Number.parseInt(match[3] ?? "", 16),
      bytes: Number.parseInt(match[4] ?? "", 16),
      description: (match[5] ?? "").trim(),
    };
    if (
      section.end > artifactBytes ||
      section.end - section.start !== section.bytes ||
      section.start < 8 ||
      section.start < (sections.at(-1)?.end ?? 8)
    )
      throw new Error("WABT section ranges do not match selected artifact.");
    sections.push(section);
  }
  if ((sections.at(-1)?.end ?? 8) !== artifactBytes)
    throw new Error(
      "WABT section output does not cover the selected artifact.",
    );
  return sections;
};
