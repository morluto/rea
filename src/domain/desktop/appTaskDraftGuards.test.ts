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
import { lineGuards } from "./appTaskDraftLineGuards.js";

const FILE = "Documents/doc.xml";

it("does not guard whole sibling text that contains an unchanged timestamp", () => {
  const document = (title: string) =>
    `<doc><item id="a"><title>${title}</title></item><item id="b"><title>Keep</title><modified>2026-11-01T10:12:00Z</modified></item><item id="c"><title>Stable</title></item></doc>`;
  const baseline = xml(document("Old"));
  const final = xml(document("New"));
  const guards = draftGuards(
    {
      file: FILE,
      ends: { baseline, final },
      named: () => true,
      noisy: () => false,
      chars: 2000,
    },
    [
      {
        kind: "text_equals",
        file: FILE,
        pointer: "/root/children/[name=item][@id=a]",
        value: "New",
      },
    ],
  );
  expect(guards).toEqual([
    expect.objectContaining({
      pointer: "/root/children/[name=item][@id=c]",
      value: "Stable",
    }),
  ]);
});

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
      "/root/children/[name=Cell][@Col=2]",
      "/root/children/[name=Cell][@Col=3][@Row=1]",
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
      "/root/children/[name=Cell][@Row=2]",
    ]);
    expect(file.guards.map(pointerOf)).toEqual([
      "/root/children/[name=Cell][@Col=4]",
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

describe("draftTaskFiles for components of a wiring diagram, as QElectroTech saves them", () => {
  /** A component: its informations by name, and the texts it shows, one showing its label beside the name of that information. */
  const component = (
    uuid: string,
    [label, shown, fn]: readonly [string, string, string],
    user = "",
  ) =>
    `<element uuid="{${uuid}}" prefix="X" x="470"><elementInformations><elementInformation name="function" show="1">${fn}</elementInformation><elementInformation name="label" show="1">${label}</elementInformation></elementInformations><dynamic_texts>${user}<dynamic_elmt_text uuid="{${uuid}-text}" text_from="ElementInfo" x="25"><text>${shown}</text><info_name>label</info_name></dynamic_elmt_text></dynamic_texts></element>`;
  const TERMINALS =
    '<dynamic_elmt_text uuid="{a1}" text_from="UserText" x="2"><text>A1</text></dynamic_elmt_text><dynamic_elmt_text uuid="{a2}" text_from="UserText" x="2"><text>A2</text></dynamic_elmt_text>';
  const diagram = (coil: readonly [string, string, string]) =>
    `<project><diagram><elements>${component("3524", ["H1", "H1", "Pump running"])}${component("1b6b", coil, TERMINALS)}${component("af99", ["S1", "S1", "Start pump"])}</elements></diagram></project>`;
  const ELEMENTS =
    "/root/children/[name=diagram]/children/[name=elements]/children";
  const label = (uuid: string) =>
    `${ELEMENTS}/[name=element][@uuid={${uuid}}]/children/[name=elementInformations]/children/[name=elementInformation][@name=label]`;

  it("checks the coil's label, never the text that shows it, and guards the other components' labels rather than the coil's other fields", () => {
    const file = xmlDraft(
      diagram(["K1", "K1", "Pump contactor"]),
      diagram(["KM1", "KM1", "Pump contactor"]),
    );

    expect(file.suggested).toEqual([
      { kind: "text_equals", file: FILE, pointer: label("1b6b"), value: "KM1" },
    ]);
    expect(file.values.map(({ note }) => note ?? null)).toEqual([
      null,
      "upkeep",
    ]);
    expect(file.guards).toEqual([
      { kind: "text_equals", file: FILE, pointer: label("3524"), value: "H1" },
      { kind: "text_equals", file: FILE, pointer: label("af99"), value: "S1" },
      {
        kind: "member_count",
        file: FILE,
        pointer: ELEMENTS,
        matching: "[name=element]",
        equals: 3,
      },
    ]);
  });

  it("checks a field of a record of fields itself, not the record's text that joins its other fields in", () => {
    const file = xmlDraft(
      diagram(["K1", "K1", "Pump contactor"]),
      diagram(["K1", "KM1", "Pump contactor"]),
    );

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: `${ELEMENTS}/[name=element][@uuid={1b6b}]/children/[name=dynamic_texts]/children/[name=dynamic_elmt_text][@uuid={1b6b-text}]/children/[name=text]`,
        value: "KM1",
      },
    ]);
  });

  it("checks a component's shown text when only another component's label made the same change", () => {
    const page = (
      coil: readonly [string, string, string],
      other: readonly [string, string, string],
    ) =>
      `<project><diagram><elements>${component("3524", other)}${component("1b6b", coil, TERMINALS)}${component("af99", ["S1", "S1", "Start pump"])}</elements></diagram></project>`;
    const file = xmlDraft(
      page(["K1", "K1", "Pump contactor"], ["K1", "H1", "Pump running"]),
      page(["K1", "KM1", "Pump contactor"], ["KM1", "H1", "Pump running"]),
    );

    expect(file.suggested.map(pointerOf)).toContain(
      `${ELEMENTS}/[name=element][@uuid={1b6b}]/children/[name=dynamic_texts]/children/[name=dynamic_elmt_text][@uuid={1b6b-text}]/children/[name=text]`,
    );
    expect(
      file.values.find((value) =>
        value.pointer.endsWith("/children/[name=text]"),
      )?.note,
    ).toBeUndefined();
  });
});

describe("draftTaskFiles for a dialog's buttons, as Glade saves them", () => {
  /** A button in a GtkBuilder child: its label and flags, then where it is packed. */
  const button = (id: string, label: string, position: string) =>
    `<child><object class="GtkButton" id="${id}"><property name="label">${label}</property><property name="visible">True</property><property name="can-focus">True</property></object><packing><property name="expand">True</property><property name="position">${position}</property></packing></child>`;
  const dialog = (submit: string) =>
    `<interface><object class="GtkDialog" id="feedback_dialog"><child internal-child="vbox"><object class="GtkBox"><child internal-child="action_area"><object class="GtkButtonBox">${button("cancel_button", "Cancel", "0")}${button("submit_button", submit, "1")}</object><packing><property name="position">0</property></packing></child><child><object class="GtkLabel" id="intro_label"><property name="label">Tell us what you think.</property></object><packing><property name="position">1</property></packing></child></object></child></object></interface>`;
  const BUTTONS =
    "/root/children/[name=object]/children/[name=child]/children/[name=object]/children/[name=child][@internal-child=action_area]/children/[name=object]/children";

  it("selects the other button by where it is packed, not by the child text holding the label the guard reads, and counts the buttons, not the dialog's other children", () => {
    const file = xmlDraft(dialog("Submit"), dialog("Send Feedback"));

    expect(file.suggested.map(pointerOf)).toEqual([
      `${BUTTONS}/[name=child][>packing=True1]/children/[name=object]/children/[name=property][@name=label]`,
    ]);
    expect(file.guards).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: `${BUTTONS}/[name=child][>packing=True0]/children/[name=object]/children/[name=property][@name=label]`,
        value: "Cancel",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: BUTTONS,
        matching: "[name=child]",
        equals: 2,
      },
    ]);
  });
});

describe("draftTaskFiles for a plot's functions, as KmPlot saves them", () => {
  /** A function: its colours, then its formula with a differential after it, laid out on lines of their own. */
  const fn = (color: string, formula: string, flipped = false) => {
    const attributes = [
      `f0-color="${color}"`,
      'type="cartesian"',
      'f0-visible="1"',
    ];
    return `<function ${(flipped ? attributes.toReversed() : attributes).join(" ")}>\n        <equation-0 step="0.05">${formula}<differential x="0" y="1"/>\n        </equation-0>\n        <arg-min use="0">0</arg-min>\n        <arg-max use="0">2π</arg-max>\n    </function>`;
  };
  const plot = (h: string, flipped = false) =>
    `<kmpdoc version="4">\n    ${fn("#191970", "f(x) = x^2 − 4", flipped)}\n    ${fn("#006400", "g(x) = 2sin(x)", flipped)}\n    ${fn("#ff4500", h, flipped)}\n</kmpdoc>`;
  const equation = (color: string) =>
    `/root/children/[name=function][@f0-color=${color}]/children/[name=equation-0]`;

  it("checks the formula by its element with the whitespace the app lays out collapsed, and guards the others, which a save writing attributes in another order passes", () => {
    const file = xmlDraft(plot("h(x) = 0.5x + 1"), plot("h(x) = 2x + 1"));

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: equation("#ff4500"),
        value: "h(x) = 2x + 1",
        normalize_whitespace: true,
      },
    ]);
    expect(file.guards.map(pointerOf)).toEqual([
      equation("#006400"),
      equation("#191970"),
      "/root/children",
    ]);
    const fresh = xml(plot("h(x) = 2x + 1", true));
    expect(passing(FILE, fresh, file.suggested)).toEqual([true]);
    expect(passing(FILE, fresh, file.guards)).toEqual([true, true, true]);
  });

  it("checks no formula the app only moved to an indented line of its own, whose collapsed text the seed holds, beside one the user changed", () => {
    const seed = plot("h(x) = 2x + 1");
    const end = plot("h(x) = 2x + 1")
      .replace("g(x) = 2sin(x)", "g(x) = 3sin(x)")
      .replace(
        '<equation-0 step="0.05">h(x)',
        '<equation-0 step="0.05">\n            h(x)',
      );
    const file = xmlDraft(seed, end);

    expect(file.suggested.map(pointerOf)).toEqual([equation("#006400")]);
    expect(passing(FILE, xml(seed), file.suggested)).toEqual([false]);
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

describe("lineGuards text bound", () => {
  it("leaves a huge unchanged line out of the guard", () => {
    const huge = "word ".repeat(500);
    expect(
      lineGuards("Documents/note.txt", [huge, "milk"], ["eggs", huge, "milk"]),
    ).toEqual([
      { kind: "lines_present", file: "Documents/note.txt", lines: ["milk"] },
    ]);
  });
});
