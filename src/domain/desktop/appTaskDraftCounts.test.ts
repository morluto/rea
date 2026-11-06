import { describe, expect, it } from "vitest";

import { passing, pointerOf, xml, xmlDraft } from "./appTaskDraft.fixture.js";

/** A flowchart as Dia saves it: boxes by id in one layer, each with its geometry and text, and a connector. */
const flowchart = (
  checked: { text: string; corner: string; width: string },
  { reopened = false } = {},
) => {
  const box = (id: string, text: string, corner: string, width: string) =>
    `<dia:object type="Flowchart - Box" version="0" id="${id}"><dia:attribute name="obj_pos"><dia:point val="${corner}"/></dia:attribute><dia:attribute name="obj_bb"><dia:rectangle val="${corner};12.5,8.15"/></dia:attribute><dia:attribute name="elem_width"><dia:real val="${width}"/></dia:attribute><dia:attribute name="text"><dia:composite type="text"><dia:attribute name="string"><dia:string>${text}</dia:string></dia:attribute></dia:composite></dia:attribute></dia:object>`;
  // Dia adds an empty layer of the same name each time it reopens and saves a diagram.
  const empty = reopened
    ? '<dia:layer name="Background" visible="true" connectable="false"/>'
    : "";
  return `<dia:diagram xmlns:dia="http://www.lysator.liu.se/~alla/dia/">${empty}<dia:layer name="Background" visible="true" active="true">${[
    box("O0", "#Receive order#", "6.695,1.7", "5.51"),
    box("O1", checked.text, checked.corner, checked.width),
    box("O2", "#Pack items#", "7.175,10.7", "4.55"),
  ].join(
    "",
  )}<dia:object type="Standard - Line" version="0" id="O3"><dia:attribute name="obj_pos"><dia:point val="9.45,3.6"/></dia:attribute></dia:object></dia:layer></dia:diagram>`;
};
const SEED = { text: "#Check stock#", corner: "6.96625,6.2", width: "4.9675" };
const END = {
  text: "#Verify inventory#",
  corner: "6.3725,6.2",
  width: "6.155",
};

const LAYER = "/root/children/[name=dia:layer][>dia:object=#Receive order#]";
const box = (id: string) =>
  `${LAYER}/children/[name=dia:object][@id=${id}]/children/[name=dia:attribute]`;

describe("draftTaskFiles for a box renamed in a diagram the app resizes", () => {
  it("checks the new text, names the layer by a box's text so a reopened file's empty layer leaves it named, and notes the box's new geometry as layout", () => {
    const file = xmlDraft(flowchart(SEED), flowchart(END));

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: "Documents/doc.xml",
        pointer: `${box("O1")}[@name=text]`,
        value: "#Verify inventory#",
      },
    ]);
    expect(
      file.values.map(({ pointer, note }) => [
        pointer.slice(box("O1").length),
        note,
      ]),
    ).toEqual([
      [
        "[@name=text]/children/[name=dia:composite]/children/[name=dia:attribute]/children/[name=dia:string]/children/0",
        undefined,
      ],
      ["[@name=obj_pos]/children/[name=dia:point]/attributes/val", "layout"],
      ["[@name=obj_bb]/children/[name=dia:rectangle]/attributes/val", "layout"],
      ["[@name=elem_width]/children/[name=dia:real]/attributes/val", "layout"],
    ]);
    const checks = [...file.suggested, ...file.guards];
    expect(
      passing("Documents/doc.xml", xml(flowchart(SEED)), file.suggested),
    ).toEqual([false]);
    for (const end of [flowchart(END), flowchart(END, { reopened: true })])
      expect(
        passing("Documents/doc.xml", xml(end), checks).every(Boolean),
      ).toBe(true);
  });

  it("guards the other boxes' text before any geometry, and that no box of the kind was added or removed", () => {
    const file = xmlDraft(flowchart(SEED), flowchart(END));

    expect(file.guards.map(pointerOf)).toEqual([
      `${box("O0")}[@name=text]`,
      `${box("O2")}[@name=text]`,
      `${LAYER}/children`,
    ]);
    expect(file.guards.at(-1)).toEqual({
      kind: "member_count",
      file: "Documents/doc.xml",
      pointer: `${LAYER}/children`,
      matching: "[name=dia:object][@type=Flowchart - Box]",
      equals: 3,
    });
  });

  it("keeps geometry that changed with no text beside it as the suggestion, since moving a box may be the task", () => {
    const moved = { ...SEED, corner: "8,6.2" };

    const file = xmlDraft(flowchart(SEED), flowchart(moved));

    expect(file.suggested.map(pointerOf)).toEqual([
      `${box("O1")}[@name=obj_pos]/children/[name=dia:point]/attributes/val`,
      `${box("O1")}[@name=obj_bb]/children/[name=dia:rectangle]/attributes/val`,
    ]);
    expect(file.values.every(({ note }) => note === undefined)).toBe(true);
  });
});

describe("draftTaskFiles counts of a list's members", () => {
  const library = (...titles: string[]) =>
    `<library>${titles.map((title) => `<book><title>${title}</title></book>`).join("")}</library>`;

  it("counts the members of a list an edit added to, at the end's number, which fails at the seed", () => {
    const file = xmlDraft(
      library("Salt Roads"),
      library("Salt Roads", "Quiet Rivers"),
    );

    const count = file.suggested.filter(({ kind }) => kind === "member_count");
    expect(count).toEqual([
      {
        kind: "member_count",
        file: "Documents/doc.xml",
        pointer: "/root/children",
        matching: "[name=book]",
        equals: 2,
      },
    ]);
    expect(
      passing("Documents/doc.xml", xml(library("Salt Roads")), count),
    ).toEqual([false]);
  });

  it("counts no lone member an edit added, as a style an app adds for a run", () => {
    const file = xmlDraft(
      "<doc><styles/><body><p>Plan</p></body></doc>",
      '<doc><styles><style name="T1"/></styles><body><p>Plan</p></body></doc>',
    );

    expect(file.suggested.map(({ kind }) => kind)).not.toContain(
      "member_count",
    );
  });
});
