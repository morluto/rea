import { describe, expect, it } from "vitest";

import { draftOf, statePath, xml, xmlDraft } from "./appTaskDraft.fixture.js";
import { resolvePointer } from "./viewPointer.js";

/** A household book: accounts, payees and categories by key, and operations naming them. */
const book = (operations: string, note = "Draft", tags = '<tag name="old"/>') =>
  `<book><account key="1" name="Everyday Checking"/><pay key="1" name="Fresh Market"/><pay key="2" name="Landlord"/><cat key="12" name="Rent"/><cat key="44" name="Groceries"/><ope wording="October rent" amount="-1450.00" account="1" payee="2" category="12"/>${operations}<note>${note}</note>${tags}</book>`;
const GROCERIES =
  '<ope wording="Weekly groceries" amount="-64.18" account="1" payee="1" category="44"/>';

describe("draftTaskFiles values", () => {
  it("lists each value the change added, changed and removed at the pointer a check names it by, with what it was and became", () => {
    const before = book("");
    const after = book(GROCERIES, "Final", "");

    const file = xmlDraft(before, after);

    expect(file.values_cut).toBe(false);
    expect(file.values.map(({ pointer, kind }) => [kind, pointer])).toEqual([
      ["added", "/root/children/[name=ope][@wording=Weekly groceries]"],
      ["changed", "/root/children/[name=note]/children/0"],
      ["removed", "/root/children/[name=tag]"],
    ]);
    const [added, changed, removed] = file.values;
    expect(added).toMatchObject({ before: null, after: GROCERIES });
    expect(removed).toMatchObject({ before: '<tag name="old"/>', after: null });
    // A scalar's before and after are what its pointer reads at each end.
    expect(changed).toMatchObject({ before: "Draft", after: "Final" });
    expect(resolvePointer(xml(before), changed?.pointer ?? "")).toBe("Draft");
    expect(resolvePointer(xml(after), changed?.pointer ?? "")).toBe("Final");
  });

  it("resolves a value that is another element's key, by the attribute's stem where several share it", () => {
    const file = xmlDraft(book(""), book(GROCERIES));

    // account="1" and payee="1" both match a key 1; the attribute's stem picks the element.
    expect(file.values[0]?.refers_to).toEqual([
      {
        attribute: "account",
        value: "1",
        element: '<account key="1" name="Everyday Checking"/>',
      },
      {
        attribute: "payee",
        value: "1",
        element: '<pay key="1" name="Fresh Market"/>',
      },
      {
        attribute: "category",
        value: "44",
        element: '<cat key="44" name="Groceries"/>',
      },
    ]);
  });

  it("notes a value only position reaches, and cuts a long one at 600 characters", () => {
    const long = (letter: string) => letter.repeat(700);
    const file = xmlDraft(
      `<list><item><v>a</v></item><item><v>b</v></item><desc>${long("x")}</desc></list>`,
      `<list><item><v>a</v></item><item><v>c</v></item><desc>${long("y")}</desc></list>`,
    );

    expect(
      file.values.map(({ pointer, note }) => [pointer, note ?? null]),
    ).toEqual([
      ["/root/children/[name=desc]/children/0", null],
      ["/root/children/1/children/[name=v]/children/0", "by_position"],
    ]);
    const [cut] = file.values;
    expect(cut?.after).toBe(`${"y".repeat(600)}…`);
    expect(cut?.before).toBe(`${"x".repeat(600)}…`);
  });

  it("lists at most 20 values and 8 KB a file and 24 KB a draft, saying when it left any out", () => {
    const items = (count: number, value: (index: number) => string) =>
      `<doc>${Array.from({ length: count }, (_, index) => `<p id="${String(index)}" v="${value(index)}"/>`).join("")}</doc>`;
    const many = xmlDraft(
      items(25, () => "a"),
      items(25, () => "b"),
    );
    expect([many.values.length, many.values_cut]).toEqual([20, true]);

    // Eight changes of 590 characters each overfill a file's 8 KB...
    const wide = (letter: string) => () => letter.repeat(590);
    const files = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((name) => [
        `Documents/${name}.xml`,
        statePath(
          "document",
          "xml",
          xml(items(8, wide("x"))),
          xml(items(8, wide("y"))),
        ),
      ]),
    );
    const drafted = draftOf(files);
    const bytes = (values: unknown) =>
      new TextEncoder().encode(JSON.stringify(values)).length;
    for (const file of drafted)
      expect(bytes(file.values)).toBeLessThanOrEqual(8 * 1024);
    expect(drafted[0]).toMatchObject({ values_cut: true });
    // ...and the draft's 24 KB runs out before the last file's.
    expect(
      drafted.reduce((sum, file) => sum + bytes(file.values), 0),
    ).toBeLessThanOrEqual(24 * 1024);
    expect(drafted.at(-1)?.values.length).toBeLessThan(
      drafted[0]?.values.length ?? 0,
    );
  });
});

describe("draftTaskFiles change lists", () => {
  it("lists an XML file's change by the selectors naming its members, not their positions", () => {
    const file = xmlDraft(
      '<doc><p id="a">x</p><p id="b">y</p></doc>',
      '<doc><p id="new">z</p><p id="a">x</p><p id="b">w</p></doc>',
    );

    expect(file.change).toMatchObject({
      added: expect.arrayContaining(["/root/children/[name=p][@id=new]"]),
      changed: ["/root/children/[name=p][@id=b]/children/0"],
      removed: [],
    });
  });

  it("lists a change by position where only the members' order changed, and says why no check names it", () => {
    const file = xmlDraft(
      '<doc><p id="a"/><p id="b"/></doc>',
      '<doc><p id="b"/><p id="a"/></doc>',
    );

    expect(file.change).toMatchObject({
      changed: expect.arrayContaining(["/root/children/0/attributes/id"]),
    });
    expect(file.suggested).toEqual([]);
    expect(file.notes.map(({ code }) => code)).toEqual(["by_position"]);
  });
});
