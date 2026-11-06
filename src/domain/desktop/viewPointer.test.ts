import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { pairMembers } from "./memberPairing.js";
import { locatePointer, memberLookup } from "./viewPointer.js";

const element = (
  name: string,
  attributes: Record<string, string> = {},
  children: JsonValue[] = [],
): JsonValue => ({ name, attributes, children });

const VIEW: JsonValue = {
  root: element("Objects", {}, [
    "text between",
    element("Object", { name: "Plate", type: "Part::Box" }),
    element("Object", { name: "Hole", type: "Part::Cylinder" }),
    element("Object", { name: "Pad", type: "Part::Box" }),
    element("Note", { "odd]key": "x" }),
  ]),
  entries: [
    { name: "a/b.xml", size: 1 },
    { name: "x][y", size: 2 },
    { name: 3, size: 3 },
  ],
};

describe("locatePointer", () => {
  it("selects the one member a selector names, by field, by attribute, or both", () => {
    expect(
      locatePointer(
        VIEW,
        "/root/children/[name=Object][@name=Hole]/attributes/type",
      ),
    ).toMatchObject({ kind: "value", value: "Part::Cylinder" });
    expect(
      locatePointer(VIEW, "/root/children/[@name=Pad]/name"),
    ).toMatchObject({
      kind: "value",
      value: "Object",
    });
    expect(locatePointer(VIEW, "/entries/[name=a~1b.xml]/size")).toMatchObject({
      kind: "value",
      value: 1,
    });
    expect(locatePointer(VIEW, "/root/children/0")).toMatchObject({
      kind: "value",
      value: "text between",
    });
  });

  it("reports the arrays a selector searched, and those it entered by position at an object", () => {
    expect(
      locatePointer(
        VIEW,
        "/root/children/[name=Object][@name=Hole]/attributes/type",
      ),
    ).toMatchObject({ searched: ["/root/children"], byPosition: [] });
    expect(locatePointer(VIEW, "/root/children/1/name")).toMatchObject({
      searched: [],
      byPosition: ["/root/children"],
    });
    expect(locatePointer(VIEW, "/root/children/0")).toMatchObject({
      byPosition: [],
    });
    expect(
      locatePointer(VIEW, "/root/children/[@type=Part::Box]"),
    ).toMatchObject({ kind: "unresolved", searched: ["/root/children"] });
  });

  it("names no value when the last selector matches nothing, and is unresolved otherwise", () => {
    expect(
      locatePointer(VIEW, "/root/children/[name=Object][@name=Gone]"),
    ).toMatchObject({
      kind: "none",
      reason: "[name=Object][@name=Gone] matches no member",
    });
    expect(
      locatePointer(VIEW, "/root/children/[name=Object][@name=Gone]/name"),
    ).toMatchObject({
      kind: "unresolved",
      problem: "[name=Object][@name=Gone] matches no member",
    });
    expect(
      locatePointer(VIEW, "/root/children/[@type=Part::Box]"),
    ).toMatchObject({
      kind: "unresolved",
      problem: "[@type=Part::Box] matches 2 members, not one",
    });
    expect(locatePointer(VIEW, "/root/children/[Object]")).toMatchObject({
      kind: "unresolved",
      problem: "[Object] is not a selector of the form [KEY=VALUE]",
    });
    expect(locatePointer(VIEW, "/root/children/[=x]")).toMatchObject({
      kind: "unresolved",
    });
  });

  it("compares strings only and keeps an ordinary key on an object", () => {
    expect(locatePointer(VIEW, "/entries/[name=3]")).toMatchObject({
      kind: "none",
      reason: "[name=3] matches no member",
    });
    expect(locatePointer({ "[a=b]": 1 }, "/[a=b]")).toMatchObject({
      kind: "value",
      value: 1,
    });
    expect(locatePointer(VIEW, "/root/children/01")).toMatchObject({
      kind: "none",
    });
    expect(locatePointer(null, "/x")).toMatchObject({ kind: "none" });
  });

  it("names a member by a child element's text, its whitespace collapsed, alike in locatePointer and memberLookup", () => {
    const ada = element("contact", {}, [
      element("first", {}, ["Ada"]),
      element("first", {}, ["\n Ann  Lee "]),
    ]);
    const bob = element("contact", {}, [element("first", {}, ["Bob"])]);
    const members: JsonValue[] = [
      "Ada",
      { ">first": "Ada", name: "first" },
      ada,
      bob,
      element("group", {}, [element("first", {}, ["Bob"])]),
    ];
    const named = (token: string) => [
      locatePointer({ members }, `/members/${token}`),
      memberLookup(members, [token])(token),
    ];

    expect(named("[>first=Ann Lee]")).toEqual([
      expect.objectContaining({ kind: "value", value: ada }),
      ada,
    ]);
    expect(named("[>first=Ada][>first=Ann Lee]")[1]).toBe(ada);
    expect(named("[name=contact][>first=Bob]")[1]).toBe(bob);
    expect(named("[>first=Bob]")).toEqual([
      expect.objectContaining({ kind: "unresolved" }),
      undefined,
    ]);
    expect(named("[>first=Zed]")).toEqual([
      expect.objectContaining({ kind: "none" }),
      undefined,
    ]);
    expect(named("[>=Ada]")).toEqual([
      expect.objectContaining({ kind: "unresolved" }),
      undefined,
    ]);
  });
});

describe("locatePointer and memberLookup by a path inside a member", () => {
  it("names a member by a path of up to three steps inside it: a JSON record's string, an element's descendant text or a child's attribute, alike in locatePointer and memberLookup", () => {
    const book = (title: JsonValue, year: JsonValue = "2015") => ({
      data: { Title: title, Year: year },
      format: "BOOK",
    });
    const silk = book("The Silk Roads");
    const spqr = book("SPQR", 2015);
    const button = (id: string, label: string) =>
      element("child", {}, [
        element("object", { id }, [element("property", {}, [label])]),
      ]);
    const [submit, cancel] = [
      button("submit_button", "\n Send "),
      button("cancel_button", "Cancel"),
    ];
    const members: JsonValue[] = [
      "The Silk Roads",
      silk,
      spqr,
      book({ text: "SPQR" }, "1999"),
      submit,
      cancel,
    ];
    const named = (selector: string) => {
      const located = locatePointer(
        { members },
        `/members/${selector.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      );
      const looked = memberLookup(members, [selector])(selector);
      return located.kind === "value" && located.value === looked
        ? looked
        : [located.kind, looked];
    };

    expect(named("[format=BOOK][>data/Title=The Silk Roads]")).toBe(silk);
    expect(named("[>data/Year=2015]")).toBe(silk);
    expect(named("[>data/Title/text=SPQR]")).toBe(members[3]);
    expect(named("[>format=BOOK][>data/Title=SPQR]")).toBe(spqr);
    expect(named("[>object@id=submit_button]")).toBe(submit);
    expect(named("[>object/property=Send]")).toBe(submit);
    expect(named("[name=child][>object/property=Cancel]")).toBe(cancel);
    expect(named("[>data/Title=Missing]")).toEqual(["none", undefined]);
    expect(named("[>object@id/property=Cancel]")).toEqual(["none", undefined]);
    expect(named("[>object/property@id=x]")).toEqual(["none", undefined]);
    expect(named("[>data/Title/text/x=SPQR]")).toEqual([
      "unresolved",
      undefined,
    ]);
    expect(named("[>data//Title=SPQR]")).toEqual(["unresolved", undefined]);
  });
});

describe("pairMembers", () => {
  it("keys each member by the most general selector naming it alone, else by position", () => {
    const children = (VIEW as { root: { children: JsonValue[] } }).root
      .children;
    const entries = (VIEW as { entries: JsonValue[] }).entries;

    expect(pairMembers(children, []).newer.keys).toEqual([
      "0",
      "[name=Object][@name=Plate]",
      "[name=Object][@name=Hole]",
      "[name=Object][@name=Pad]",
      "[name=Note]",
    ]);
    expect(pairMembers(entries, []).newer.keys).toEqual([
      "[name=a/b.xml]",
      "1",
      "2",
    ]);
  });

  it("pairs one to one, so a member another selector also names is not paired twice", () => {
    const item = (attributes: Record<string, string>) =>
      element("item", attributes);

    expect(
      pairMembers(
        [item({ b: "y" }), item({ a: "x" })],
        [item({ a: "x", b: "y" })],
      ),
    ).toEqual({
      newer: { keys: ["[name=item][@b=y]", "1"], partners: [0, undefined] },
      older: { keys: ["[name=item][@b=y]"], partners: [0] },
    });
  });

  it("passes over a selector that names several members of the other version", () => {
    const pairing = pairMembers(
      [
        element("Object", { name: "Plate" }),
        element("Object", { name: "Hole" }),
      ],
      [element("Object", { name: "Plate" })],
    );

    expect(pairing).toEqual({
      newer: {
        keys: ["[name=Object][@name=Plate]", "[name=Object][@name=Hole]"],
        partners: [0, undefined],
      },
      older: { keys: ["[name=Object][@name=Plate]"], partners: [0] },
    });
  });

  it("pairs an element by its identifier, so another attribute that changed is an edit", () => {
    const pairing = pairMembers(
      [
        element("item", { color: "green", id: "1" }),
        element("item", { id: "2" }),
      ],
      [
        element("item", { color: "red", id: "1" }),
        element("item", { id: "2" }),
      ],
    );

    const keys = ["[name=item][@id=1]", "[name=item][@id=2]"];
    expect(pairing).toEqual({
      newer: { keys, partners: [0, 1] },
      older: { keys, partners: [0, 1] },
    });
  });

  it("counts an identified sibling's other attributes, keying a group by its label rather than a fill both share", () => {
    const note = (transform: string) =>
      element("g", { fill: "red", "inkscape:label": "note", transform });
    const layer = element("g", { fill: "red", id: "layer" });

    const keys = ["[name=g][@inkscape:label=note]", "[name=g][@id=layer]"];
    expect(
      pairMembers([note("scale(2)"), layer], [note("scale(1)"), layer]),
    ).toEqual({
      newer: { keys, partners: [0, 1] },
      older: { keys, partners: [0, 1] },
    });
  });

  it("pairs an element with identifiers by those alone, so one replaced by another of its type is removed and added", () => {
    const object = (name: string, id: string) =>
      element("Object", { type: "Part::Cylinder", name, id });
    const plate = element("Object", { type: "Part::Box", name: "Plate" });

    expect(
      pairMembers(
        [plate, object("Hole001", "3")],
        [plate, object("Hole", "2")],
      ),
    ).toEqual({
      newer: {
        keys: ["[name=Object][@name=Plate]", "[name=Object][@name=Hole001]"],
        partners: [0, undefined],
      },
      older: {
        keys: ["[name=Object][@name=Plate]", "[name=Object][@name=Hole]"],
        partners: [0, undefined],
      },
    });
  });

  it("pairs members no selector names by position", () => {
    expect(pairMembers(["a", "b", "c"], ["a", "x"])).toEqual({
      newer: { keys: ["0", "1", "2"], partners: [0, 1, undefined] },
      older: { keys: ["0", "1"], partners: [0, 1] },
    });
  });

  it("leaves out values a selector cannot carry and times an app stamps", () => {
    expect(
      pairMembers(
        [
          element("Save", { at: "2026-11-04T10:12:00Z", id: "1" }),
          element("Save", { at: "2026-11-04T10:13:00Z", id: "2" }),
        ],
        [],
      ).newer.keys,
    ).toEqual(["[name=Save][@id=1]", "[name=Save][@id=2]"]);
  });
});

describe("pairMembers by ranked attributes", () => {
  it("keys a member by two attributes together where no single one names it, spelled in canonical order whatever order the app wrote them in", () => {
    const cell = (row: string, col: string) =>
      element("Cell", { Row: row, Col: col, ValueType: "40" });
    // The app writes Col before Row in the later save.
    const later = (row: string, col: string) =>
      element("Cell", { Col: col, Row: row, ValueType: "40" });

    const pairing = pairMembers(
      [later("2", "3"), later("2", "4"), later("3", "3"), later("3", "4")],
      [cell("3", "4"), cell("2", "4"), cell("2", "3"), cell("3", "3")],
    );

    expect(pairing.newer).toEqual({
      keys: [
        "[name=Cell][@Col=3][@Row=2]",
        "[name=Cell][@Col=4][@Row=2]",
        "[name=Cell][@Col=3][@Row=3]",
        "[name=Cell][@Col=4][@Row=3]",
      ],
      partners: [2, 1, 3, 0],
    });
  });

  it("counts a pair over identified siblings too, while an identified member keeps its identity and a pair whose values changed pairs nothing", () => {
    const cell = (row: string, col: string, id?: string) =>
      element("Cell", {
        ...(id === undefined ? {} : { id }),
        Row: row,
        Col: col,
      });
    const cells = [
      cell("1", "1", "x"),
      cell("1", "1"),
      cell("1", "2"),
      cell("2", "1"),
      cell("2", "2"),
    ];

    expect(pairMembers(cells, cells).newer.keys).toEqual([
      "[name=Cell][@id=x]",
      // Its pair is the identified cell's too, so position keys it.
      "1",
      "[name=Cell][@Col=2][@Row=1]",
      "[name=Cell][@Col=1][@Row=2]",
      "[name=Cell][@Col=2][@Row=2]",
    ]);
    // The cell at row 2, column 2 moved to column 3: no longer the same pair.
    const moved = pairMembers([...cells.slice(0, 4), cell("2", "3")], cells);
    expect(moved.newer.partners[4]).toBeUndefined();
    expect(moved.newer.keys[4]).toBe("[name=Cell][@Col=3]");
  });

  it("counts a pair over every sibling holding both values, though one ranks six other attributes before them", () => {
    // Six worded attributes rank before Row and Col, so this cell never takes their pair itself.
    const styled = element("Cell", {
      Row: "1",
      Col: "1",
      Font: "Sans",
      Style: "bold",
      Align: "left",
      Wrap: "word",
      Color: "red",
      Border: "thin",
    });
    const plain = element("Cell", { Row: "1", Col: "1", X: "12.75" });
    const cells = [plain, styled];

    const { newer } = pairMembers(cells, cells);
    expect(newer).toEqual({
      keys: ["[name=Cell][@X=12.75]", "[name=Cell][@Font=Sans]"],
      partners: [0, 1],
    });
    for (const [index, key] of newer.keys.entries())
      expect(locatePointer(cells, `/${key}`)).toMatchObject({
        kind: "value",
        value: cells[index],
      });
    // Nor does the pair key a member as new when a member of the other version holds both values.
    const others = [
      element("Cell", { Row: "1", Col: "2" }),
      element("Cell", { Row: "2", Col: "1" }),
    ];
    expect(
      pairMembers([plain, ...others], [styled, ...others]).newer.keys[0],
    ).toBe("[name=Cell][@X=12.75]");
  });

  it("keys a member by a name-like attribute before a coordinate the app writes first", () => {
    const frame = (x: string, name: string) =>
      element("PAGEOBJECT", { XPOS: x, YPOS: "12.5", ANNAME: name });

    expect(
      pairMembers([frame("146.83", "Headline"), frame("20.5", "Details")], [])
        .newer.keys,
    ).toEqual([
      "[name=PAGEOBJECT][@ANNAME=Headline]",
      "[name=PAGEOBJECT][@ANNAME=Details]",
    ]);
  });
});
