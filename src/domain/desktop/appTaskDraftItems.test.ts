import { describe, expect, it } from "vitest";

import { passing, xml, xmlDraft } from "./appTaskDraft.fixture.js";
import { DRAFT_VIEW_CHARS } from "./valueCuts.js";

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
  it("checks a moved note and the count, keeping stable sibling text within the draft limit", () => {
    const kept = [...NOTES, ["120.5", "P".repeat(DRAFT_VIEW_CHARS)]] as const;
    const tooLong = ["130.5", "Q".repeat(DRAFT_VIEW_CHARS + 1)] as const;
    const saveTime = ["150.5", "2026-11-07T10:12:00Z"] as const;
    const note = "Quiz on Friday: bring a calculator";
    const before = notebook(PNG("AAAA"), ...kept, tooLong, saveTime);
    const after = notebook(PNG("BBBB"), ...kept, tooLong, saveTime, [
      "156.5",
      note,
    ]);
    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "member_count",
        file: FILE,
        pointer: `${LAYER}/children`,
        matching: `[name=text][>text()=${note}]`,
        at_least: 1,
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: `${LAYER}/children`,
        matching: "[name=text]",
        equals: 7,
      },
    ]);
    expect(file.guards).toEqual(
      kept.map(([, value]) => ({
        kind: "member_count",
        file: FILE,
        pointer: `${LAYER}/children`,
        matching: `[name=text][>text()=${value}]`,
        at_least: 1,
      })),
    );
    expect(
      file.values.find(({ pointer }) => pointer.includes("[name=preview]"))
        ?.note,
    ).toBe("view_state");
    const resaved = (text: string) =>
      notebook(PNG("CCCC"), ["300.2", text], ...kept, tooLong, [
        "150.5",
        "2026-11-07T11:12:00Z",
      ]);
    expect(
      passing(FILE, xml(resaved(note)), [...file.suggested, ...file.guards]),
    ).toEqual([true, true, true, true, true, true]);
    expect(passing(FILE, xml(before), file.suggested)).toEqual([false, false]);
    expect(
      passing(FILE, xml(resaved(`Do not ${note}`)), file.suggested),
    ).toEqual([false, true]);
  });

  it("checks a text whose runs carry x and y by the text, not as notes placed on the page", () => {
    const poster = (headline: string) =>
      `<svg><text id="title" x="10" y="20"><tspan x="10" y="20">${headline}</tspan><tspan x="10" y="40">Saturday</tspan></text></svg>`;
    const file = xmlDraft(poster("Spring Fair"), poster("Summer Fair"));

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer:
          "/root/children/[name=text][@id=title]/children/[name=tspan][@y=20]",
        value: "Summer Fair",
      },
    ]);
    expect(passing(FILE, xml(poster("Spring Fair")), file.suggested)).toEqual([
      false,
    ]);
    expect(passing(FILE, xml(poster("Summer Fair")), file.suggested)).toEqual([
      true,
    ]);
  });
});
