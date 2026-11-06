import { describe, expect, it } from "vitest";

import { draftOf, statePath } from "./appTaskDraft.fixture.js";
import { textView } from "./stateFormats.js";

const FILE = "Documents/trip.txt";

/** A text file's lines, as a mind map exported to text keeps topics with the ids and times the app assigns. */
const lines = (...added: string[]) =>
  [
    "# Weekend Trip",
    'topic TEXT="Packing" ID="ID_1965352635"',
    'topic TEXT="Sleeping bags" ID="ID_1227863932" CREATED="1793955122470"',
    ...added,
    "</topic>",
    "</map>",
  ].join("\n");

const drafted = (before: string, after: string) => {
  const [file] = draftOf({
    [FILE]: statePath("document", "text", textView(before), textView(after)),
  });
  if (file === undefined) throw new Error("the file did not change");
  return file;
};

describe("draftTaskFiles for lines holding values the app generates", () => {
  it("counts the lines holding a new line's text up to its first generated value, rather than the line whole, which another save would not repeat", () => {
    const file = drafted(
      lines(),
      lines(
        'topic TEXT="Water filter" ID="ID_329023692" CREATED="1793955250671" MODIFIED="1793955252979"',
      ),
    );

    expect(file.suggested).toEqual([
      {
        kind: "line_count",
        file: FILE,
        contains: 'topic TEXT="Water filter" ID="',
        equals: 1,
      },
    ]);
    expect(file.notes).toEqual([]);
  });

  it("notes a new line whose generated value comes first, as no text tells it apart", () => {
    const file = drafted(lines(), lines("ID_329023692 1793955250671"));

    expect(file.suggested).toEqual([]);
    expect(file.notes.map(({ code }) => code)).toEqual(["volatile_lines"]);
  });

  it("guards a kept line beside a new one, never a lone closing tag any such file holds", () => {
    const file = drafted(lines(), lines("Water filter"));

    expect(file.guards).toEqual([
      {
        kind: "lines_present",
        file: FILE,
        lines: [
          'topic TEXT="Packing" ID="ID_1965352635"',
          'topic TEXT="Sleeping bags" ID="ID_1227863932" CREATED="1793955122470"',
        ],
      },
    ]);
  });
});

describe("draftTaskFiles for lines added to a text file longer than its view", () => {
  it("counts no lines a view cut short, since a count there is undecided", () => {
    // Both views keep the first 5,000 lines of 5,001 or more, the new line among them.
    const long = (...added: string[]) =>
      [
        ...added,
        ...Array.from({ length: 5001 }, (_, index) => `line ${String(index)}`),
      ].join("\n");

    const file = drafted(
      long(),
      long(
        'topic TEXT="Water filter" ID="ID_329023692" CREATED="1793955250671"',
      ),
    );

    expect(file.change).toMatchObject({ complete: false });
    expect(file.suggested.map(({ kind }) => kind)).not.toContain("line_count");
  });
});

describe("draftTaskFiles guards of a document of commands and text, as LyX saves one", () => {
  /** A LyX body: each heading and paragraph opened by a command and closed by `\end_layout`. */
  const report = (heading: string) =>
    [
      "\\begin_body",
      "",
      "\\begin_layout Section",
      "Introduction",
      "\\end_layout",
      "",
      "\\begin_layout Standard",
      "This report summarises the spring season.",
      "\\end_layout",
      "",
      "\\begin_layout Section",
      heading,
      "\\end_layout",
      "",
      "\\begin_layout Standard",
      "Volunteers spread compost in early March.",
      "\\end_layout",
      "",
      "\\begin_layout Section",
      "Harvest Results",
      "\\end_layout",
      "",
      "\\end_body",
    ].join("\n");
  const doc = (heading: string) => {
    const view = textView(report(heading));
    return { view, file: "Documents/garden-report.lyx" };
  };

  it("guards the other headings the same command opens, never a command line or one every section repeats", () => {
    const [seed, end] = [doc("Soil Preperation"), doc("Soil Preparation")];
    const [file] = draftOf({
      [seed.file]: statePath("document", "text", seed.view, end.view),
    });

    expect(file?.suggested).toEqual([
      { kind: "lines_present", file: seed.file, lines: ["Soil Preparation"] },
      { kind: "lines_absent", file: seed.file, lines: ["Soil Preperation"] },
    ]);
    expect(file?.guards).toEqual([
      {
        kind: "lines_present",
        file: seed.file,
        lines: ["Introduction", "Harvest Results"],
      },
    ]);
  });
});
