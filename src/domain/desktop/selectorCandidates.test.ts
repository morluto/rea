import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { childCandidates, childConditions } from "./selectorCandidates.js";

const element = (
  name: string,
  attributes: Record<string, string>,
  children: JsonValue[] = [],
): JsonValue => ({ name, attributes, children });

describe("childCandidates", () => {
  it("ranks a child's own text, then an identifier a child carries, then text a child joins from its own elements, and no id an app generates", () => {
    const child = element("child", {}, [
      element("object", { class: "GtkButton", id: "submit_button" }, [
        element("property", { name: "label" }, ["Send"]),
      ]),
      element("packing", {}, [element("property", {}, ["1"])]),
      element("note", {}, ["Primary"]),
      element("layer", { id: "{18eadb5d-04fc-4448-a0f9-1f9a3dedaff7}" }),
      element("node", { ID: "ID_329023692" }),
      element("shape", { "draw:id": "id2" }),
      element("cell", { name: "B2" }),
    ]);

    expect(childCandidates(child)).toEqual([
      "[>note=Primary]",
      "[>object@id=submit_button]",
      "[>cell@name=B2]",
      "[>object=Send]",
      "[>packing=1]",
    ]);
  });
});

describe("childConditions", () => {
  it("stops reading a child's text once it is past what a selector names a member by, however long the text", () => {
    const element = (text: string) => ({
      name: "record",
      attributes: {},
      children: [
        { name: "title", attributes: {}, children: ["Budget"] },
        { name: "body", attributes: {}, children: [text] },
      ],
    });
    const length = 4 * 1024 * 1024;
    const huge = element(`a b ${"x".repeat(length)}`);

    // A selector names a member by at most 64 characters. Count the characters
    // read one at a time, and refuse any whole-string rewrite of the long
    // text, as collapsing all of it before measuring would do.
    const allowed = 1024;
    let read = 0;
    const string = String.prototype;
    const { [Symbol.iterator]: iterate } = string;
    const rewrites = ["replace", "replaceAll", "split"] as const;
    const originals = rewrites.map((name) => [name, string[name]] as const);
    Object.defineProperty(string, Symbol.iterator, {
      configurable: true,
      writable: true,
      *value(this: string) {
        for (const character of iterate.call(this)) {
          if (++read > allowed) throw new Error("read the whole child text");
          yield character;
        }
      },
    });
    for (const [name, original] of originals)
      Object.defineProperty(string, name, {
        configurable: true,
        writable: true,
        value(this: string, ...args: never[]) {
          if (this.length >= length)
            throw new Error(`${name} on the long text`);
          return (original as (...values: never[]) => unknown).apply(
            this,
            args,
          );
        },
      });
    let conditions: string[];
    try {
      conditions = childConditions(huge);
    } finally {
      string[Symbol.iterator] = iterate;
      for (const [name, original] of originals)
        Object.defineProperty(string, name, {
          configurable: true,
          writable: true,
          value: original,
        });
    }

    expect(conditions).toEqual(["[>title=Budget]"]);
    expect(read).toBeLessThanOrEqual(allowed);
  });
});
