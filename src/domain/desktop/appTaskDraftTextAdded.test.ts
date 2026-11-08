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
  it.each(["no olive oil", "olive oil soap"])(
    "does not accept %s in place of the added line",
    (wrong) => {
      const file = draftOf(LIST, `${LIST}\nolive oil`);
      const checks = [...file.suggested, ...file.guards];
      expect(
        passing(FILE, xml(note(`${LIST}\n${wrong}`)), checks).every(Boolean),
      ).toBe(false);
      expect(
        passing(FILE, xml(note(`${LIST}\nolive oil`)), checks).every(Boolean),
      ).toBe(true);
      // Whole free text has no item boundary the current checks can select.
      expect(
        passing(
          FILE,
          xml(note("Shopping List\n\nolive oil\neggs\nbread")),
          checks,
        ).every(Boolean),
      ).toBe(false);
    },
  );

  it("checks the whole note when a kept line contains a timestamp", () => {
    const before = "Notes\n2026-11-07T10:12:00Z\nKeep milk";
    const after = `${before}\nBuy eggs`;
    const file = draftOf(before, after);

    expect(file.guards).toEqual([]);
    expect(file.suggested).toMatchObject([
      { kind: "text_equals", value: after },
    ]);
    expect(passing(FILE, xml(note(after)), file.suggested)).toEqual([true]);
    expect(
      passing(FILE, xml(note(`${before}\nDo not buy eggs`)), file.suggested),
    ).toEqual([false]);
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

  it("keeps the sibling count guard beside a whole-text check", () => {
    const file = xmlDraft(
      notebook(CHORES),
      notebook(`${CHORES}\nClean the gutters`),
    );
    expect(file.guards).toContainEqual({
      kind: "member_count",
      file: "Documents/doc.xml",
      pointer: "/root/children",
      matching: "[name=node]",
      equals: 3,
    });
  });
});
