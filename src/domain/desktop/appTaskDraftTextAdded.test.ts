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
  it("checks the added line by text_contains, which a correct edit spaced or ordered otherwise passes, and guards the kept text", () => {
    const file = draftOf(LIST, `${LIST}\nolive oil`);

    expect(file.suggested).toEqual([
      {
        kind: "text_contains",
        file: FILE,
        pointer: CONTENT,
        value: "olive oil",
      },
    ]);
    expect(file.guards.map((guard) => "value" in guard && guard.value)).toEqual(
      ["Shopping List", "eggs", "bread"],
    );
    const checks = [...file.suggested, ...file.guards];
    expect(passing(FILE, xml(note(LIST)), checks)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(passing(FILE, xml(note(`${LIST}\nolive oil\n`)), checks)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      passing(
        FILE,
        xml(note("Shopping List\n\nolive oil\neggs\nbread")),
        checks,
      ),
    ).toEqual([true, true, true, true]);
  });

  it("guards each side of the text a line was inserted into", () => {
    const file = draftOf(LIST, "Shopping List\n\neggs\nolive oil\nbread");

    expect(file.suggested).toEqual([
      {
        kind: "text_contains",
        file: FILE,
        pointer: CONTENT,
        value: "olive oil",
      },
    ]);
    expect(file.guards.map((guard) => "value" in guard && guard.value)).toEqual(
      ["Shopping List", "eggs", "bread"],
    );
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
