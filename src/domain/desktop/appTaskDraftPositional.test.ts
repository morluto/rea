import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { passing, xml, xmlDraft } from "./appTaskDraft.fixture.js";
import { pairMembers, resolvePointer } from "./viewPointer.js";

const FILE = "Documents/doc.xml";

/** The members of the array at a pointer into an XML text's view. */
const membersAt = (text: string, pointer: string): JsonValue[] => {
  const members = resolvePointer(xml(text), pointer);
  if (!Array.isArray(members)) throw new Error(`no array at ${pointer}`);
  return members;
};

describe("draftTaskFiles for a change only position reaches", () => {
  /** A sheet as an ODS spreadsheet keeps it: rows no attribute names, each cell's text in a paragraph, and a save counter. */
  const sheet = (february: string, total: string, cycles: string) =>
    `<spreadsheet><meta><editing-cycles>${cycles}</editing-cycles></meta><table name="Q1 Sales" style="ta1"><row><cell type="string"><p>Month</p></cell><cell type="string"><p>Sales</p></cell></row><row><cell type="string"><p>February</p></cell><cell type="float" value="${february}"><p>${february}</p></cell></row><row><cell type="string"><p>Total</p></cell><cell type="float" formula="sum" value="${total}"><p>${total}</p></cell></row></table></spreadsheet>`;

  it("checks the whole text of the ancestor above the step by position, by its name, and demotes the noise beside it rather than suggesting it", () => {
    const before = sheet("21300", "59625", "1");
    const after = sheet("23100", "61425", "2");

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: "/root/children/[name=table][@name=Q1 Sales]",
        value: "MonthSalesFebruary23100Total61425",
      },
    ]);
    expect(passing(FILE, xml(before), file.suggested)).toEqual([false]);
    expect(passing(FILE, xml(after), file.suggested)).toEqual([true]);
    expect(file.notes.map(({ code }) => code)).not.toContain("view_state_only");
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
    ]);
    expect(file.values.map(({ pointer, note }) => [pointer, note])).toEqual([
      [`${tasks}[@name=User testing]`, undefined],
      [`${tasks}[@name=Launch]/attributes/id`, "renumbered"],
    ]);
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
