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
      // Free text has no item boundary the current checks can select.
      expect(
        passing(
          FILE,
          xml(note("Shopping List\n\nolive oil\neggs\nbread")),
          checks,
        ).every(Boolean),
      ).toBe(false);
    },
  );

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
