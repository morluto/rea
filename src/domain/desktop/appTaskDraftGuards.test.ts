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
