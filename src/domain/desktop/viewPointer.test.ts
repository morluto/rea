import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { locatePointer, memberKeys, selectorIndex } from "./viewPointer.js";

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
    ).toEqual({ kind: "value", value: "Part::Cylinder" });
    expect(locatePointer(VIEW, "/root/children/[@name=Pad]/name")).toEqual({
      kind: "value",
      value: "Object",
    });
    expect(locatePointer(VIEW, "/entries/[name=a~1b.xml]/size")).toEqual({
      kind: "value",
      value: 1,
    });
    expect(locatePointer(VIEW, "/root/children/0")).toEqual({
      kind: "value",
      value: "text between",
    });
  });

  it("names no value when the last selector matches nothing, and is unresolved otherwise", () => {
    expect(
      locatePointer(VIEW, "/root/children/[name=Object][@name=Gone]"),
    ).toEqual({
      kind: "none",
      reason: "[name=Object][@name=Gone] matches no member",
    });
    expect(
      locatePointer(VIEW, "/root/children/[name=Object][@name=Gone]/name"),
    ).toEqual({
      kind: "unresolved",
      problem: "[name=Object][@name=Gone] matches no member",
    });
    expect(locatePointer(VIEW, "/root/children/[@type=Part::Box]")).toEqual({
      kind: "unresolved",
      problem: "[@type=Part::Box] matches 2 members, not one",
    });
    expect(locatePointer(VIEW, "/root/children/[Object]")).toEqual({
      kind: "unresolved",
      problem: "[Object] is not a selector of the form [KEY=VALUE]",
    });
    expect(locatePointer(VIEW, "/root/children/[=x]")).toMatchObject({
      kind: "unresolved",
    });
  });

  it("compares strings only and keeps an ordinary key on an object", () => {
    expect(locatePointer(VIEW, "/entries/[name=3]")).toEqual({
      kind: "none",
      reason: "[name=3] matches no member",
    });
    expect(locatePointer({ "[a=b]": 1 }, "/[a=b]")).toEqual({
      kind: "value",
      value: 1,
    });
    expect(locatePointer(VIEW, "/root/children/01")).toEqual({ kind: "none" });
    expect(locatePointer(null, "/x")).toEqual({ kind: "none" });
  });
});

describe("memberKeys", () => {
  it("names each member by the most general selector unique among its siblings, else by index", () => {
    const children = (VIEW as { root: { children: JsonValue[] } }).root
      .children;
    const entries = (VIEW as { entries: JsonValue[] }).entries;

    expect(memberKeys(children)).toEqual([
      "0",
      "[name=Object][@name=Plate]",
      "[name=Object][@name=Hole]",
      "[name=Object][@name=Pad]",
      "[name=Note]",
    ]);
    expect(memberKeys(entries)).toEqual(["[name=a/b.xml]", "1", "2"]);
  });

  it("passes over a selector that names several members of the other version", () => {
    const before = [element("Object", { name: "Plate" })];
    const after = [
      element("Object", { name: "Plate" }),
      element("Object", { name: "Hole" }),
    ];

    expect(memberKeys(before)).toEqual(["[name=Object]"]);
    expect(memberKeys(before, selectorIndex(after))).toEqual([
      "[name=Object][@name=Plate]",
    ]);
  });

  it("leaves out values a selector cannot carry and times an app stamps", () => {
    expect(
      memberKeys([
        element("Save", { at: "2026-11-04T10:12:00Z", id: "1" }),
        element("Save", { at: "2026-11-04T10:13:00Z", id: "2" }),
      ]),
    ).toEqual(["[name=Save][@id=1]", "[name=Save][@id=2]"]);
  });
});
