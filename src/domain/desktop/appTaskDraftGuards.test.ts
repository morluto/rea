import { describe, expect, it } from "vitest";

import { passing, pointerOf, xml, xmlDraft } from "./appTaskDraft.fixture.js";

const FILE = "Documents/doc.xml";

describe("draftTaskFiles guards", () => {
  /** A flyer's frames, each named, its text in an attribute, as Scribus saves them. */
  const flyer = (headline: string) =>
    `<SCRIBUS><DOCUMENT>${[
      ["10.5", "Headline", headline],
      ["10.5", "Details", "Saturday at 7 PM"],
      ["20", "Footer", "Free entry"],
    ]
      .map(
        ([x, name, text]) =>
          `<PAGEOBJECT XPOS="${x ?? ""}" ANNAME="${name ?? ""}"><StoryText><ITEXT CH="${text ?? ""}"/></StoryText></PAGEOBJECT>`,
      )
      .join("")}<PAGEOBJECT XPOS="30" ANNAME="Logo"/></DOCUMENT></SCRIBUS>`;
  const frame = (name: string) =>
    `/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=${name}]/children/[name=StoryText]/children/[name=ITEXT]/attributes/CH`;

  it("offers the field a check reads on the nearest like siblings, at its seed value, outside the suggestions", () => {
    const before = flyer("Riverside Jazz Night");
    const after = flyer("Harbor Lights Jazz Festival");

    const file = xmlDraft(before, after);

    expect(file.suggested.map(pointerOf)).toEqual([frame("Headline")]);
    // The logo has no text, so it guards nothing.
    expect(file.guards).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: frame("Details"),
        value: "Saturday at 7 PM",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: frame("Footer"),
        value: "Free entry",
      },
    ]);
    expect(passing(FILE, xml(before), file.guards)).toEqual([true, true]);
    expect(passing(FILE, xml(after), file.guards)).toEqual([true, true]);
  });

  it("guards no sibling whose field changed too, and a number by its value within the tolerance", () => {
    const sheet = (march: string, april: string) =>
      `<Sheet><Cells><Cell Row="2" Col="2">398.2</Cell><Cell Row="2" Col="3">${march}</Cell><Cell Row="2" Col="4">${april}</Cell><Cell Row="3" Col="3">174.9</Cell></Cells></Sheet>`;
    // Each cell by the fewest attributes naming it alone.
    const cell = (selector: string) =>
      `/root/children/[name=Cells]/children/[name=Cell]${selector}/children/0`;

    const file = xmlDraft(sheet("405.1", "421.75"), sheet("437.8", "430.1"));

    expect(file.suggested.map(pointerOf)).toEqual([
      cell("[@Col=3][@Row=2]"),
      cell("[@Col=4]"),
    ]);
    expect(file.guards).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: cell("[@Col=2]"),
        value: 398.2,
        tolerance: 0.001,
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: cell("[@Row=3]"),
        value: 174.9,
        tolerance: 0.001,
      },
    ]);
  });
});
