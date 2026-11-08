import { describe, expect, it } from "vitest";

import { passing, xml, xmlDraft } from "./appTaskDraft.fixture.js";

const FILE = ".local/share/notes/list.note";
const CONTENT = "/root/children/[name=text]/children/[name=note-content]";

/** A note whose text is free lines, as Gnote keeps a shopping list. */
const note = (text: string) =>
  `<note><title>Shopping List</title><text><note-content>${text}</note-content></text></note>`;
const draftOf = (before: string, after: string) =>
  xmlDraft(note(before), note(after), {
    role: "application_state",
    file: FILE,
  });
const LIST = "Shopping List\n\neggs\nbread";

describe("draftTaskFiles for lines added to free text", () => {
  it("checks the added line by text_contains, which a correct edit spaced or ordered otherwise passes, and guards each kept line, which one placed mid-list passes too", () => {
    const file = draftOf(LIST, `${LIST}\nolive oil`);

    expect(file.suggested).toEqual([
      {
        kind: "text_contains",
        file: FILE,
        pointer: CONTENT,
        value: "olive oil",
      },
    ]);
    expect(file.guards).toEqual(
      ["Shopping List", "eggs", "bread"].map((value) => ({
        kind: "text_contains",
        file: FILE,
        pointer: CONTENT,
        value,
      })),
    );
    const checks = [...file.suggested, ...file.guards];
    expect(passing(FILE, xml(note(LIST)), checks)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    for (const solved of [
      `${LIST}\nolive oil\n`,
      "Shopping List\n\neggs\nolive oil\nbread",
      "Shopping List\n\nolive oil\neggs\nbread",
    ])
      expect(passing(FILE, xml(note(solved)), checks).every(Boolean)).toBe(
        true,
      );
    // A line lost fails its guard.
    expect(
      passing(FILE, xml(note("Shopping List\n\neggs\nolive oil")), checks),
    ).toEqual([true, true, true, false]);
  });

  it("guards at most four kept lines, those nearest the insertion, in the text's order", () => {
    const long = [
      "Shopping List",
      "",
      "eggs",
      "bread",
      "rice",
      "lemons",
      "milk",
      "tea",
    ].join("\n");
    const file = draftOf(long, long.replace("lemons", "lemons\nolive oil"));

    expect(file.guards.map((guard) => "value" in guard && guard.value)).toEqual(
      ["rice", "lemons", "milk", "tea"],
    );
  });

  it("does not guard a kept line that is only a timestamp", () => {
    const before = "Notes\n2026-11-07T10:12:00Z\nKeep milk";
    const file = draftOf(before, `${before}\nBuy eggs`);

    expect(file.guards.map((guard) => "value" in guard && guard.value)).toEqual(
      ["Notes", "Keep milk"],
    );
    expect(file.suggested).toMatchObject([{ value: "Buy eggs" }]);
  });

  it("keeps text_equals where a line was replaced rather than added", () => {
    const file = draftOf(LIST, "Shopping List\n\neggs\nrye bread");

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: CONTENT,
        value: "Shopping List\n\neggs\nrye bread",
      },
    ]);
    expect(file.guards).toEqual([]);
  });
});

describe("draftTaskFiles for a line added to a note among others, as CherryTree saves them", () => {
  const notebook = (chores: string) =>
    `<cherrytree><node unique_id="1" name="Weekend chores"><rich_text>${chores}</rich_text></node><node unique_id="2" name="Groceries"><rich_text>Oat milk</rich_text></node><node unique_id="3" name="Gift ideas"><rich_text>Puzzle book</rich_text></node></cherrytree>`;
  const CHORES =
    "Water the tomato plants\nSweep the back porch\nReplace the hallway bulb\nReturn the library books";

  it("offers the count guard beside the four kept-line guards, outside their cap", () => {
    const file = xmlDraft(
      notebook(CHORES),
      notebook(`${CHORES}\nClean the gutters`),
    );

    const chores = "/root/children/[name=node][@name=Weekend chores]";
    expect(file.guards).toEqual([
      ...[
        "Water the tomato plants",
        "Sweep the back porch",
        "Replace the hallway bulb",
        "Return the library books",
      ].map((value) => ({
        kind: "text_contains",
        file: "Documents/doc.xml",
        pointer: chores,
        value,
      })),
      {
        kind: "member_count",
        file: "Documents/doc.xml",
        pointer: "/root/children",
        matching: "[name=node]",
        equals: 3,
      },
    ]);
  });
});
