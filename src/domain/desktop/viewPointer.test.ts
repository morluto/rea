import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { locatePointer, pairMembers } from "./viewPointer.js";

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
