import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { draftOf, statePath, xml, xmlDraft } from "./appTaskDraft.fixture.js";

describe("draftTaskFiles notes on thin files", () => {
  it("says which elements only position names when no check can name a change", () => {
    const table = (last: string) =>
      `<doc><row><cell>1</cell><cell>2</cell></row><row><cell>3</cell><cell>${last}</cell></row></doc>`;

    const file = xmlDraft(table("4"), table("5"));

    expect(file.suggested).toEqual([]);
    expect(file.notes).toEqual([
      expect.objectContaining({
        code: "by_position",
        file: "Documents/doc.xml",
        elements: ["row", "cell"],
      }),
    ]);
  });

  it("says which elements' text changed past what a text check compares", () => {
    const essay = (ending: string) =>
      `<doc><section><p>${"Lorem ipsum ".repeat(200)}${ending}</p></section></doc>`;

    const file = xmlDraft(essay("end."), essay("finale."));

    expect(
      file.suggested.filter(({ kind }) => kind.startsWith("text_")),
    ).toEqual([]);
    expect(file.notes).toEqual([
      expect.objectContaining({
        code: "long_text",
        pointers: ["/root/children/[name=section]/children/[name=p]"],
      }),
    ]);
  });

  it("says when a view holds only part of the file, or none of it a check can read", () => {
    const cut = (text: string): JsonValue => ({
      ...(xml(`<doc><p>${text}</p></doc>`) as Record<string, JsonValue>),
      truncated: true,
    });

    const drafted = draftOf({
      "Documents/a.gnumeric": statePath("document", "binary", {}, {}),
      "Documents/b.xml": statePath("document", "xml", cut("x"), cut("y")),
    });

    expect(
      drafted.map(({ file, notes }) => [file, notes.map(({ code }) => code)]),
    ).toEqual([
      ["Documents/a.gnumeric", ["unreadable_view"]],
      ["Documents/b.xml", ["cut_view"]],
    ]);
  });
});
