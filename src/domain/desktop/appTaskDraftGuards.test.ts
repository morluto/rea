import { describe, expect, it, vi } from "vitest";

import {
  draftOf,
  passing,
  pointerOf,
  statePath,
  xml,
  xmlDraft,
} from "./appTaskDraft.fixture.js";
import { draftGuards } from "./appTaskDraftGuards.js";

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

  it("guards no sibling whose field changed too, and a number by the cell's whole text", () => {
    const sheet = (march: string, april: string) =>
      `<Sheet><Cells><Cell Row="2" Col="2">398.2</Cell><Cell Row="2" Col="3">${march}</Cell><Cell Row="2" Col="4">${april}</Cell><Cell Row="3" Col="3">174.9</Cell></Cells></Sheet>`;
    // Each cell by the fewest attributes naming it alone.
    const cell = (selector: string) =>
      `/root/children/[name=Cells]/children/[name=Cell]${selector}`;

    const file = xmlDraft(sheet("405.1", "421.75"), sheet("437.8", "430.1"));

    expect(file.suggested.map(pointerOf)).toEqual([
      cell("[@Col=3][@Row=2]"),
      cell("[@Col=4]"),
    ]);
    expect(file.guards).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: cell("[@Col=2]"),
        value: "398.2",
      },
      {
        kind: "text_equals",
        file: FILE,
        pointer: cell("[@Row=3]"),
        value: "174.9",
      },
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
    ]);
  });

  it("guards no sibling paired by an id the app renumbers", () => {
    const sheet = (march: string) =>
      `<Cells><Cell Row="2" Col="3">${march}</Cell><Cell Row="5" Col="3" ExprID="1">=sum(C2:C4)</Cell><Cell Row="5" Col="4">=sum(D2:D4)</Cell></Cells>`;

    const file = xmlDraft(sheet("405.1"), sheet("437.8"));

    expect(file.suggested.map(pointerOf)).toEqual([
      "/root/children/[name=Cell][@Row=2]",
    ]);
    expect(file.guards.map(pointerOf)).toEqual([
      "/root/children/[name=Cell][@Col=4]",
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

describe("draftGuards on a long list", () => {
  /** A ledger of 4,000 operations, each worded as `wording` says. */
  const ledger = (wording: (index: number) => string) =>
    xml(
      `<homebank>${Array.from(
        { length: 4000 },
        (_, index) =>
          `<ope name="op${String(index)}" amount="-${String(index)}.50" wording="${wording(index)}"/>`,
      ).join("")}</homebank>`,
    );
  const payment = (index: number) => `Payment ${String(index)}`;
  /** The guards of a check of op2000's wording, and a spy called once per sibling a guard is sought on. */
  const guardsOf = (
    baseline: ReturnType<typeof xml>,
    final: ReturnType<typeof xml>,
  ) => {
    const noisy = vi.fn(() => false);
    const guards = draftGuards(
      {
        file: FILE,
        ends: { baseline, final },
        named: () => true,
        noisy,
        chars: 2000,
      },
      [
        {
          kind: "value_equals",
          file: FILE,
          pointer: "/root/children/[name=ope][@name=op2000]/attributes/wording",
          value: "October rent",
        },
      ],
    );
    return { guards, noisy };
  };

  it("reads siblings only until a check has its two guards", () => {
    const { guards, noisy } = guardsOf(
      ledger((index) => (index === 2000 ? "Rent" : payment(index))),
      ledger((index) => (index === 2000 ? "October rent" : payment(index))),
    );

    expect(guards.map(pointerOf)).toEqual([
      "/root/children/[name=ope][@name=op1999]/attributes/wording",
      "/root/children/[name=ope][@name=op2001]/attributes/wording",
    ]);
    expect(noisy).toHaveBeenCalledTimes(2);
  });

  it("reads at most the 16 nearest siblings when none qualifies, as when every one changed", () => {
    const { guards, noisy } = guardsOf(
      ledger(payment),
      ledger((index) => `${payment(index)} (paid)`),
    );

    expect(guards).toEqual([]);
    expect(noisy.mock.calls.length).toBeLessThanOrEqual(16);
  });
});
