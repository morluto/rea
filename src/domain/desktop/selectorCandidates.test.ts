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
    const huge = element(`a b ${"x".repeat(4 * 1024 * 1024)}`);

    const started = performance.now();
    const conditions = childConditions(huge);
    const elapsed = performance.now() - started;

    expect(conditions).toEqual(["[>title=Budget]"]);
    // Building the whole collapsed text took about half a second.
    expect(elapsed).toBeLessThan(100);
  });
});
