import { describe, expect, it } from "vitest";

import {
  draftOf,
  passing,
  pointerOf,
  statePath,
  xml,
  xmlDraft,
} from "./appTaskDraft.fixture.js";

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

  it("offers the text a check reads on the nearest like siblings, at its seed value, outside the suggestions, and their count", () => {
    const before = flyer("Riverside Jazz Night");
    const after = flyer("Harbor Lights Jazz Festival");

    const file = xmlDraft(before, after);

    const frameText = (name: string, value: string) => ({
      kind: "text_equals",
      file: FILE,
      pointer: `/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=${name}]`,
      value,
      text_attribute: "CH",
    });
    expect(file.suggested).toEqual([
      frameText("Headline", "Harbor Lights Jazz Festival"),
    ]);
    // The logo has no text, so it guards nothing but the frames' count.
    expect(file.guards).toEqual([
      frameText("Details", "Saturday at 7 PM"),
      frameText("Footer", "Free entry"),
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children/[name=DOCUMENT]/children",
        matching: "[name=PAGEOBJECT]",
        equals: 4,
      },
    ]);
    expect(passing(FILE, xml(before), file.guards)).toEqual([true, true, true]);
    expect(passing(FILE, xml(after), file.guards)).toEqual([true, true, true]);
    expect(frame("Headline")).toContain("[@ANNAME=Headline]");
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
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children/[name=Cells]/children",
        matching: "[name=Cell]",
        equals: 4,
      },
    ]);
  });
});

describe("draftTaskFiles guards of a spreadsheet's cells", () => {
  it("guards the cells sharing the changed cell's row or column and value type, not a label in the next row", () => {
    const sheet = (march: string) =>
      `<Cells><Cell Row="1" Col="0" ValueType="60">Rent</Cell><Cell Row="1" Col="3" ValueType="40">1250</Cell><Cell Row="2" Col="0" ValueType="60">Groceries</Cell><Cell Row="2" Col="2" ValueType="40">402.15</Cell><Cell Row="2" Col="3" ValueType="40">${march}</Cell><Cell Row="3" Col="0" ValueType="60">Utilities</Cell><Cell Row="3" Col="1" ValueType="40">142.3</Cell></Cells>`;

    const file = xmlDraft(sheet("376.9"), sheet("418.65"));

    expect(file.guards.map(pointerOf)).toEqual([
      "/root/children/[name=Cell][@Col=2]/children/0",
      "/root/children/[name=Cell][@Col=3][@Row=1]/children/0",
      "/root/children",
    ]);
  });
});

describe("draftTaskFiles guards beyond a sibling's same field", () => {
  it("guards a field a user sets on the siblings, not a default they all share", () => {
    const plan = (designType: string) =>
      `<project><tasks><task name="Requirements" work="28800" type="normal"/><task name="Design" work="86400" type="${designType}"/><task name="Launch" work="14400" type="normal"/></tasks></project>`;
    const task = (name: string) =>
      `/root/children/[name=tasks]/children/[name=task][@name=${name}]/attributes`;

    const file = xmlDraft(plan("normal"), plan("milestone"));

    expect(file.suggested.map(pointerOf)).toEqual([`${task("Design")}/type`]);
    expect(file.guards).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${task("Requirements")}/work`,
        value: "28800",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${task("Launch")}/work`,
        value: "14400",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children/[name=tasks]/children",
        matching: "[name=task]",
        equals: 3,
      },
    ]);
  });

  it("guards no sibling paired by an id the app renumbers", () => {
    const sheet = (march: string) =>
      `<Cells><Cell Row="2" Col="3">${march}</Cell><Cell Row="5" Col="3" ExprID="1">=sum(C2:C4)</Cell><Cell Row="5" Col="4">=sum(D2:D4)</Cell></Cells>`;

    const file = xmlDraft(sheet("405.1"), sheet("437.8"));

    expect(file.suggested.map(pointerOf)).toEqual([
      "/root/children/[name=Cell][@Row=2]/children/0",
    ]);
    expect(file.guards.map(pointerOf)).toEqual([
      "/root/children/[name=Cell][@Col=4]/children/0",
      "/root/children",
    ]);
  });

  it("guards a text file's list items beside the line an edit added", () => {
    const page = (...items: string[]) => {
      const lines = [
        "====== Meeting Notes ======",
        "Action items",
        ...items,
        "",
        "Next sync: Thursday at 10:00",
      ];
      return { lines, line_count: lines.length, truncated: false };
    };
    const PRIYA = "[ ] Priya to send the revised budget";
    const MARCO = "[ ] Marco to book a room for the offsite";
    const file = "Notebooks/Notes/Meeting_Notes.txt";

    const [drafted] = draftOf({
      [file]: statePath(
        "document",
        "text",
        page(PRIYA, MARCO),
        page(PRIYA, MARCO, "[ ] Dana to update the release checklist"),
      ),
    });

    expect(drafted?.guards).toEqual([
      { kind: "lines_present", file, lines: [PRIYA, MARCO] },
    ]);
  });
});

describe("draftTaskFiles guards of siblings named by the field they check", () => {
  /** A Tiled map's objects, each with an id, a name and a free-form type of its own. */
  const map = (well: string) =>
    `<map><objectgroup id="2" name="Landmarks"><object id="1" name="${well}" type="well" x="95.9"/><object id="2" name="Blacksmith Door" type="door" x="320.1"/><object id="3" name="Harbor Gate" type="gate" x="191.8"/><object id="4" name="Player Spawn" type="spawn" x="48.6"/></objectgroup></map>`;
  const OBJECTS = "/root/children/[name=objectgroup][@id=2]/children";

  it("selects each sibling by its id, not the name the guard reads, and counts the objects though each holds a type of its own", () => {
    const file = xmlDraft(map("Old Well"), map("Wishing Well"));

    expect(file.suggested.map(pointerOf)).toEqual([
      `${OBJECTS}/[name=object][@id=1]/attributes/name`,
      `${OBJECTS}/[name=object][@name=Old Well]`,
    ]);
    expect(file.guards).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${OBJECTS}/[name=object][@id=2]/attributes/name`,
        value: "Blacksmith Door",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${OBJECTS}/[name=object][@id=3]/attributes/name`,
        value: "Harbor Gate",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: OBJECTS,
        matching: "[name=object]",
        equals: 4,
      },
    ]);
    // Renaming the door fails its guard, which a guard selecting it by that name could not.
    const renamed = map("Wishing Well").replace("Blacksmith Door", "Bakery");
    expect(passing(FILE, xml(renamed), file.guards)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("guards no attribute numbering the siblings in order, as MyPaint's `src`, which a layer added or moved renumbers", () => {
    const stack = (top: string) =>
      `<stack><layer name="${top}" src="data/layer-00.png" opacity="1.0"/><layer name="Sky" src="data/layer-01.png" opacity="0.8"/><layer name="Background" src="data/layer-02.png" opacity="0.5"/></stack>`;

    const file = xmlDraft(stack("Layer"), stack("Sun"));

    expect(file.guards.map(pointerOf)).toEqual([
      "/root/children/[name=layer][@name=Sky]/attributes/opacity",
      "/root/children/[name=layer][@name=Background]/attributes/opacity",
      "/root/children",
    ]);
  });

  it("guards another field of a sibling no other attribute names alone", () => {
    const list = (first: string) =>
      `<list><item name="${first}" qty="3"/><item name="Lantern" qty="1"/><item name="Rope" qty="2"/></list>`;

    const file = xmlDraft(list("Tent"), list("Tarp"));

    expect(file.guards.map(pointerOf)).toEqual([
      "/root/children/[name=item][@name=Lantern]/attributes/qty",
      "/root/children/[name=item][@name=Rope]/attributes/qty",
      "/root/children",
    ]);
  });
});
