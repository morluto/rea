import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { passing, pointerOf, xml, xmlDraft } from "./appTaskDraft.fixture.js";
import { pairMembers } from "./memberPairing.js";
import { resolvePointer } from "./viewPointer.js";

const FILE = "Documents/doc.xml";

/** The members of the array at a pointer into an XML text's view. */
const membersAt = (text: string, pointer: string): JsonValue[] => {
  const members = resolvePointer(xml(text), pointer);
  if (!Array.isArray(members)) throw new Error(`no array at ${pointer}`);
  return members;
};

describe("draftTaskFiles for a change only position reaches", () => {
  /** A sheet as an ODS spreadsheet keeps it: rows no attribute names, each cell's text in a paragraph, labelled apart or alike, and a save counter. */
  const sheet = (
    february: string,
    total: string,
    cycles: string,
    labelled = false,
  ) => {
    const label = (text: string) =>
      `<cell type="string"><p>${labelled ? text : "Q1"}</p></cell>`;
    return `<spreadsheet><meta><editing-cycles>${cycles}</editing-cycles></meta><table name="Q1 Sales" style="ta1"><row><cell type="string"><p>Month</p></cell><cell type="string"><p>Sales</p></cell></row><row>${label("February")}<cell type="float" value="${february}"><p>${february}</p></cell></row><row>${label("Total")}<cell type="float" formula="sum" value="${total}"><p>${total}</p></cell></row></table></spreadsheet>`;
  };

  it("checks the whole text of the ancestor above the step by position, by its name, and demotes the noise beside it rather than suggesting it", () => {
    const before = sheet("21300", "59625", "1");
    const after = sheet("23100", "61425", "2");

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: "/root/children/[name=table][@name=Q1 Sales]",
        value: "MonthSalesQ123100Q161425",
      },
    ]);
    expect(passing(FILE, xml(before), file.suggested)).toEqual([false]);
    expect(passing(FILE, xml(after), file.suggested)).toEqual([true]);
    expect(file.notes.map(({ code }) => code)).not.toContain("view_state_only");
  });

  it("names a row by its label cell, so the edited cell is checked by name, not the table's whole text", () => {
    const before = sheet("21300", "59625", "1", true);
    const after = sheet("23100", "61425", "2", true);

    const file = xmlDraft(before, after);

    const row = (label: string) =>
      `/root/children/[name=table][>row=MonthSales]/children/[name=row][>cell=${label}]/children/[name=cell][@type=float]`;
    expect(file.suggested.slice(0, 2)).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: row("February"),
        value: "23100",
      },
      {
        kind: "text_equals",
        file: FILE,
        pointer: row("Total"),
        value: "61425",
      },
    ]);
    expect(passing(FILE, xml(before), file.suggested).some(Boolean)).toBe(
      false,
    );
    expect(passing(FILE, xml(after), file.suggested).every(Boolean)).toBe(true);
  });

  it("suggests no noise when position alone reaches the edit and no ancestor's text can take a check", () => {
    // The table's text is past the limit a text check compares.
    const long = "x".repeat(2100);
    const wide = (cell: string, cursor: string) =>
      `<spreadsheet><view><cursor>${cursor}</cursor></view><table><row><cell>${long}</cell></row><row><cell>${cell}</cell></row></table></spreadsheet>`;

    const file = xmlDraft(wide("21300", "1"), wide("23100", "2"));

    expect(file.suggested).toEqual([]);
    expect(file.notes.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["by_position"]),
    );
    expect(file.notes.map(({ code }) => code)).not.toContain("view_state_only");
  });
});

describe("identifiers an app numbers by position", () => {
  /** A project plan as Planner saves it: tasks numbered 1..N in document order on every save. */
  const task = (id: number, name: string, work: string) =>
    `<task id="${String(id)}" name="${name}" work="${work}" type="normal" scheduling="fixed-work"/>`;
  const plan = (...tasks: [string, string][]) =>
    `<project><tasks>${tasks.map(([name, work], index) => task(index + 1, name, work)).join("")}</tasks></project>`;
  const SEED: [string, string][] = [
    ["Requirements", "28800"],
    ["Design", "86400"],
    ["Launch", "28800"],
  ];
  const INSERTED: [string, string][] = [
    ["Requirements", "28800"],
    ["Design", "86400"],
    ["User testing", "28800"],
    ["Launch", "28800"],
  ];
  const tasksOf = (text: string) =>
    membersAt(text, "/root/children/0/children");

  it("pairs tasks by name once an insertion shifts the ids, so the new task is added rather than its neighbour renamed", () => {
    const pairing = pairMembers(
      tasksOf(plan(...INSERTED)),
      tasksOf(plan(...SEED)),
    );

    expect(pairing.newer.keys).toEqual([
      "[name=task][@name=Requirements]",
      "[name=task][@name=Design]",
      "[name=task][@name=User testing]",
      "[name=task][@name=Launch]",
    ]);
    expect(pairing.newer.partners).toEqual([0, 1, undefined, 2]);
  });

  it("checks that the inserted task is there, by name, and notes its neighbour's shifted id as renumbered", () => {
    const file = xmlDraft(plan(...SEED), plan(...INSERTED));

    const tasks = "/root/children/[name=tasks]/children/[name=task]";
    // The new task holds its neighbour's defaults, so only its presence says what the user did.
    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${tasks}[@name=User testing]/name`,
        value: "task",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children/[name=tasks]/children",
        matching: "[name=task][@type=normal]",
        equals: 4,
      },
    ]);
    expect(file.values.map(({ pointer, note }) => [pointer, note])).toEqual([
      [`${tasks}[@name=User testing]`, undefined],
      [`${tasks}[@name=Launch]/attributes/id`, "renumbered"],
    ]);
  });

  it("checks a deleted task is gone by its name, and never that the id its neighbour was renumbered from is", () => {
    const file = xmlDraft(
      plan(...SEED),
      plan(...SEED.filter(([name]) => name !== "Design")),
    );

    const tasks = "/root/children/[name=tasks]/children/[name=task]";
    expect(file.suggested).toEqual([
      { kind: "value_absent", file: FILE, pointer: `${tasks}[@name=Design]` },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children/[name=tasks]/children",
        matching: "[name=task][@type=normal]",
        equals: 2,
      },
    ]);
  });

  it("keeps ids as identity when two items only swap a colour, so the swap reads as two colour edits", () => {
    const list = (first: string, second: string) =>
      `<list><item id="1" color="${first}"/><item id="2" color="${second}"/></list>`;
    const [before, after] = [list("red", "blue"), list("blue", "red")];

    expect(
      pairMembers(
        membersAt(after, "/root/children"),
        membersAt(before, "/root/children"),
      ),
    ).toEqual({
      newer: {
        keys: ["[name=item][@id=1]", "[name=item][@id=2]"],
        partners: [0, 1],
      },
      older: {
        keys: ["[name=item][@id=1]", "[name=item][@id=2]"],
        partners: [0, 1],
      },
    });
    const file = xmlDraft(before, after);
    const items = "/root/children/[name=item]";
    expect(
      file.values.map(({ pointer, note }) => [pointer, note ?? null]),
    ).toEqual([
      [`${items}[@id=1]/attributes/color`, null],
      [`${items}[@id=2]/attributes/color`, null],
    ]);
    expect(file.suggested.map(({ kind }) => kind)).toEqual([
      "value_equals",
      "value_equals",
    ]);
    expect(file.notes).toEqual([]);
  });

  it("keeps ids that did not shift as identity, so a deletion leaves the rest paired by id", () => {
    const stable = (...ids: number[]) =>
      `<list>${ids.map((id) => `<item id="${String(id)}" color="red"/>`).join("")}</list>`;
    const items = (text: string) => membersAt(text, "/root/children");

    expect(
      pairMembers(items(stable(1, 3)), items(stable(1, 2, 3))).newer.keys,
    ).toEqual(["[name=item][@id=1]", "[name=item][@id=3]"]);
  });
});

describe("an element renamed", () => {
  /**
   * A painting's layer stack as MyPaint saves it: each layer by name, its
   * pixels in `src`, numbered along the stack as MyPaint 2 writes it or named
   * by the layer, the one selected flagged; the top layer first, or second.
   */
  const stack = (
    top: string,
    {
      numbered = true,
      moved = false,
    }: { numbered?: boolean; moved?: boolean } = {},
  ) => {
    const layers = [
      [top, "sun", "576", "true"],
      ["Sky", "sky", "0", "false"],
      ["Background", "ground", "0", "false"],
    ];
    const order = moved ? [1, 0, 2].map((at) => layers[at] ?? []) : layers;
    return `<image w="800" h="600"><stack>${order
      .map(
        ([name, own, x, selected], index) =>
          `<layer composite-op="svg:src-over" name="${name ?? ""}" opacity="1.0" selected="${selected ?? ""}" src="data/${numbered ? `layer-0${String(index)}` : (own ?? "")}.png" visibility="visible" x="${x ?? ""}" y="0"/>`,
      )
      .join("")}</stack></image>`;
  };
  const LAYER = "/root/children/[name=stack]/children/[name=layer]";

  it("pairs a layer whose name alone changed, at its place among the layers, by another attribute naming it alone rather than the one selected", () => {
    const layers = (top: string) =>
      membersAt(stack(top, { numbered: false }), "/root/children/0/children");

    const pairing = pairMembers(layers("Sun"), layers("Untitled"));

    const keys = [
      "[name=layer][@src=data/sun.png]",
      "[name=layer][@name=Sky]",
      "[name=layer][@name=Background]",
    ];
    expect(pairing).toEqual({
      newer: { keys, partners: [0, 1, 2] },
      older: { keys, partners: [0, 1, 2] },
    });
  });

  it("keys a renamed layer by each version's own name where the attribute pairing it numbers the layers in order, as MyPaint's src", () => {
    const layers = (top: string) =>
      membersAt(stack(top), "/root/children/0/children");

    const pairing = pairMembers(layers("Sun"), layers("Untitled"));

    expect(pairing.newer.keys[0]).toBe("[name=layer][@name=Sun]");
    expect(pairing.older.keys[0]).toBe("[name=layer][@name=Untitled]");
    expect(pairing.newer.partners).toEqual([0, 1, 2]);
  });

  it("checks the renamed layer's new name by the attribute that names it, and that the old name names nothing, though a later save moves it", () => {
    const file = xmlDraft(stack("Untitled"), stack("Sun"));

    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${LAYER}[@name=Sun]/attributes/name`,
        value: "Sun",
      },
      {
        kind: "value_absent",
        file: FILE,
        pointer: `${LAYER}[@name=Untitled]`,
      },
    ]);
    expect(file.values).toMatchObject([
      { kind: "changed", before: "Untitled", after: "Sun" },
    ]);
    // The move renumbers every src, which a check by src would have failed.
    expect(
      [
        stack("Untitled"),
        stack("Sun"),
        stack("Moon"),
        stack("Sun", { moved: true }),
      ].map((text) => passing(FILE, xml(text), file.suggested)),
    ).toEqual([
      [false, false],
      [true, true],
      [false, true],
      [true, true],
    ]);
    // No layer added or removed is a guard at the unchanged count.
    expect(file.guards.at(-1)).toEqual({
      kind: "member_count",
      file: FILE,
      pointer: "/root/children/[name=stack]/children",
      matching: "[name=layer]",
      equals: 3,
    });
  });
});

describe("members named by a child's text or a generated id", () => {
  it("counts a child's text on every sibling, one an identifier names included, so a selector both match names neither", () => {
    const records = (note: string) =>
      `<records><record id="fixed"><title>Shared</title><note>kept</note></record><record><title>Shared</title><note>${note}</note></record></records>`;

    const file = xmlDraft(records("before"), records("after"));

    const pointers = [
      ...file.suggested.flatMap((check) =>
        "pointer" in check ? [check.pointer] : [],
      ),
      ...file.values.map(({ pointer }) => pointer),
    ];
    expect(
      pointers.some((pointer) => pointer.includes("[>title=Shared]")),
    ).toBe(false);
    expect(file.values.map(({ after }) => after)).toEqual(["after"]);
    expect(
      passing(FILE, xml(records("after")), file.suggested).every(Boolean),
    ).toBe(true);
  });

  it("names a new node by its text rather than the id the app generated, wherever the id sits among its attributes, and pairs a kept one by that id", () => {
    const map = (...nodes: string[]) =>
      `<map><node TEXT="Packing" ID="ID_1965352635">${nodes.join("")}</node></map>`;
    const node = (id: string, text: string) =>
      `<node ID="${id}" TEXT="${text}" CREATED="1793955120032"/>`;

    const pairing = pairMembers(
      membersAt(
        map(
          node("ID_1749680464", "Tent"),
          node("ID_329023692", "Water filter"),
        ),
        "/root/children/0/children",
      ),
      membersAt(
        map(node("ID_1749680464", "Tent")),
        "/root/children/0/children",
      ),
    );

    expect(pairing.newer.keys).toEqual([
      "[name=node][@ID=ID_1749680464]",
      "[name=node][@TEXT=Water filter]",
    ]);
  });
});

describe("a container in a list named for its tag", () => {
  /** A workbook as Gnumeric saves one: sheets in `Sheets`, each named by its `Name` child. */
  const book = (march: string, more = "") =>
    `<Workbook><Sheets><Sheet><Name>Budget</Name><Cells><Cell Row="2" Col="2">402.15</Cell><Cell Row="2" Col="3">${march}</Cell></Cells></Sheet>${more}</Sheets></Workbook>`;

  it("names a sheet its tag alone names by its name child, so a sheet added later leaves the check its own", () => {
    const file = xmlDraft(book("376.9"), book("418.65"));

    expect(file.suggested.map(pointerOf)).toEqual([
      "/root/children/[name=Sheets]/children/[name=Sheet][>Name=Budget]/children/[name=Cells]/children/[name=Cell][@Col=3]/children/0",
    ]);
    const another = book("418.65", "<Sheet><Name>Notes</Name><Cells/></Sheet>");
    expect(passing(FILE, xml(another), file.suggested)).toEqual([true]);
  });

  it("holds no step of a list not named for its member's tag, nor a member with no name", () => {
    const plain = (text: string) =>
      `<doc><body><section><title>Plan</title><p>${text}</p></section></body></doc>`;

    const file = xmlDraft(plain("Monday"), plain("Tuesday"));

    expect(file.suggested.map(pointerOf)).toEqual([
      "/root/children/[name=body]/children/[name=section]/children/[name=p]",
    ]);
  });
});

describe("records an app gave generated ids", () => {
  const records = (first: string, second: string) =>
    `<records><record id="0b5c1f0e-3c1d-4f7a-9a3e-2d7f5b8c9e10"><title>${first}</title></record><record id="7d1e2a90-5b4c-4e8f-8a21-6c3b9f0d4e57"><title>${second}</title></record></records>`;

  it("pairs kept records by their ids, so titles they swapped read as two title edits, not two id changes", () => {
    const file = xmlDraft(records("Alpha", "Beta"), records("Beta", "Alpha"));

    expect(
      file.values.map(({ pointer, kind, note }) => [
        pointer,
        kind,
        note ?? null,
      ]),
    ).toEqual(
      [
        "0b5c1f0e-3c1d-4f7a-9a3e-2d7f5b8c9e10",
        "7d1e2a90-5b4c-4e8f-8a21-6c3b9f0d4e57",
      ].map((id) => [
        `/root/children/[name=record][@id=${id}]/children/[name=title]/children/0`,
        "changed",
        null,
      ]),
    );
    expect(
      passing(FILE, xml(records("Alpha", "Beta")), file.suggested),
    ).not.toContain(true);
    expect(
      passing(FILE, xml(records("Beta", "Alpha")), file.suggested).every(
        Boolean,
      ),
    ).toBe(true);
  });
});

describe("shapes an ODF app numbers on every save", () => {
  /** A Draw page's boxes, each named by the user, and numbered `id1`… by LibreOffice from `first` as it saves. */
  const page = (second: string, first = 1) =>
    `<draw:page xmlns:draw="d" xmlns:text="t" draw:name="page1">${[
      "Order Received",
      second,
      "Pack Items",
      "Ship Order",
    ]
      .map(
        (text, index) =>
          `<draw:custom-shape draw:name="Step ${String(index + 1)}" draw:style-name="gr1" xml:id="id${String(index + first)}" draw:id="id${String(index + first)}"><text:p>${text}</text:p></draw:custom-shape>`,
      )
      .join("")}</draw:page>`;
  const shape = (step: number) =>
    `/root/children/[name=draw:custom-shape][@draw:name=Step ${String(step)}]`;

  it("names each box by the name the user gave it, not the id the save numbered, so a save numbering them anew keeps the checks and guards", () => {
    const file = xmlDraft(page("Pick Items"), page("Pick and Scan"));

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: shape(2),
        value: "Pick and Scan",
      },
    ]);
    expect(file.guards.map(pointerOf)).toEqual([
      shape(1),
      shape(3),
      "/root/children",
    ]);
    // Another save numbers the shapes from 5.
    const renumbered = xml(page("Pick and Scan", 5));
    expect(passing(FILE, renumbered, file.suggested)).toEqual([true]);
    expect(passing(FILE, renumbered, file.guards)).toEqual([true, true, true]);
    // The value lists no other pointer by an id the save numbered.
    expect(file.values[0]).toMatchObject({
      pointer: `${shape(2)}/children/[name=text:p]/children/0`,
    });
    expect(file.values[0]?.alternatives).toBeUndefined();
  });
});
