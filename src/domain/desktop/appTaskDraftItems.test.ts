import { describe, expect, it } from "vitest";

import { passing, pointerOf, xml, xmlDraft } from "./appTaskDraft.fixture.js";

const FILE = "Documents/doc.xml";

/** A notebook page as Xournal++ saves it: a rendered preview, and notes each placed on the layer by its own position. */
const notebook = (preview: string, ...notes: (readonly [string, string])[]) =>
  `<xournal><preview>${preview}</preview><page><layer>${notes
    .map(
      ([y, text]) =>
        `<text font="Sans" size="12" x="88.28578" y="${y}" color="#000000ff">${text}</text>`,
    )
    .join("")}</layer></page></xournal>`;
const NOTES = [
  ["60.6", "Cell Biology - Week 3"],
  ["84.6", "Mitochondria make ATP"],
  ["108.5", "Ribosomes build proteins"],
] as const;
const PNG = (tail: string) =>
  `iVBORw0KGgoAAAANSUhEUgAAAFsAAACACAIAAADrrYIi${tail}`;
const LAYER = "/root/children/[name=page]/children/[name=layer]";

describe("draftTaskFiles for items placed by their own position", () => {
  it("checks a note added to a layer by its text and the notes' count, guards each kept note, and leaves the rendered preview out", () => {
    const before = notebook(PNG("AAAA"), ...NOTES);
    const after = notebook(PNG("BBBB"), ...NOTES, [
      "156.5",
      "Quiz on Friday: bring a calculator",
    ]);

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "text_contains",
        file: FILE,
        pointer: LAYER,
        value: "Quiz on Friday: bring a calculator",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: `${LAYER}/children`,
        matching: "[name=text]",
        equals: 4,
      },
    ]);
    expect(file.guards).toEqual(
      NOTES.map(([, value]) => ({
        kind: "text_contains",
        file: FILE,
        pointer: LAYER,
        value,
      })),
    );
    expect(
      file.values.find(({ pointer }) => pointer.includes("[name=preview]"))
        ?.note,
    ).toBe("view_state");
    // Another user places the note elsewhere, and the app renders another preview.
    const elsewhere = notebook(
      PNG("CCCC"),
      ["300.2", "Quiz on Friday: bring a calculator"],
      ...NOTES,
    );
    expect(
      passing(FILE, xml(elsewhere), [...file.suggested, ...file.guards]).every(
        Boolean,
      ),
    ).toBe(true);
    expect(passing(FILE, xml(before), file.suggested)).toEqual([false, false]);
    expect(file.suggested.map(pointerOf)).not.toContain(
      "/root/children/[name=preview]",
    );
  });
});
