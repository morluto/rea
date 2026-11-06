import { describe, expect, it } from "vitest";

import { passing, pointerOf, xml, xmlDraft } from "./appTaskDraft.fixture.js";

const FILE = "Documents/doc.xml";

describe("draftTaskFiles for text an app keeps in an attribute", () => {
  /** A flyer's frame as Scribus saves it: its text in `ITEXT` runs, one per run of formatting. */
  const flyer = (...runs: string[]) =>
    `<SCRIBUSUTF8NEW><DOCUMENT><PAGEOBJECT ANNAME="Headline" XPOS="10.5" ItemID="3"><StoryText><DefaultStyle/>${runs
      .map(
        (text, index) =>
          `<ITEXT FONT="${index === 0 ? "Regular" : "Bold"}" CH="${text}"/>`,
      )
      .join(
        "",
      )}<para/></StoryText></PAGEOBJECT><PAGEOBJECT ANNAME="Details" XPOS="10.5" ItemID="4"><StoryText><ITEXT CH="Saturday at 7 PM"/></StoryText></PAGEOBJECT></DOCUMENT></SCRIBUSUTF8NEW>`;
  const FRAME =
    "/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=Headline]";

  it("checks the frame's text read from its runs' CH, which holds however a later save splits them", () => {
    const before = flyer("Spring ", "Fair");
    const after = flyer("Summer ", "Fair");

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: FRAME,
        value: "Summer Fair",
        text_attribute: "CH",
      },
    ]);
    expect(
      [
        before,
        after,
        flyer("Summer Fair"),
        flyer("Sum", "mer ", "Fair"),
        flyer("Summer ", "Fete"),
      ].map((text) => passing(FILE, xml(text), file.suggested)),
    ).toEqual([[false], [true], [true], [true], [false]]);
  });

  it("checks a mind map's node by the TEXT it holds itself, not the TEXT of the nodes in it, and names a new node by its text rather than the id the app made", () => {
    const map = (packing: readonly (readonly string[])[]) =>
      `<map version="freeplane 1.7.0"><node TEXT="Weekend Trip" ID="ID_1360674148"><node TEXT="Packing" ID="ID_1965352635">${packing
        .map(
          ([text, id]) =>
            `<node TEXT="${text ?? ""}" ID="${id ?? ""}" CREATED="1793955120032" MODIFIED="1793955121800"/>`,
        )
        .join("")}</node><node TEXT="Food" ID="ID_523079613"/></node></map>`;
    // The trip, the map's one root node, holds its id as a hold against another root node.
    const TRIP = "/root/children/[name=node][@ID=ID_1360674148]";
    const tent = ["Tent", "ID_1749680464"];
    const bags = ["Sleeping bags", "ID_1227863932"];

    const renamed = xmlDraft(
      map([tent, bags]),
      map([["Big tent", "ID_1749680464"], bags]),
    );
    const added = xmlDraft(
      map([tent, bags]),
      map([tent, bags, ["Water filter", "ID_329023692"]]),
    );

    expect(renamed.suggested.map(pointerOf)).toEqual([
      `${TRIP}/children/[name=node][@TEXT=Packing]/children/[name=node][@ID=ID_1749680464]/attributes/TEXT`,
    ]);
    const packing = `${TRIP}/children/[name=node][@TEXT=Packing]/children`;
    expect(added.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${packing}/[name=node][@TEXT=Water filter]/name`,
        value: "node",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: packing,
        matching: "[name=node]",
        equals: 3,
      },
    ]);
    // Another save of the same edit gives the node another id and times.
    const solved = map([tent, bags, ["Water filter", "ID_1048576333"]]);
    expect(passing(FILE, xml(solved), added.suggested)).toEqual([true, true]);
  });
});
