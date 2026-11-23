import { describe, expect, it } from "vitest";

import { passing, pointerOf, xml, xmlDraft } from "./appTaskDraft.fixture.js";

const FILE = "Documents/doc.xml";

describe("draftTaskFiles for text an app keeps in an attribute", () => {
  const FRAME =
    "/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=Headline]";

  const flyer = (runs: readonly string[], style?: string) =>
    `<SCRIBUSUTF8NEW><DOCUMENT><PAGEOBJECT ANNAME="Headline">${style === undefined ? "" : "<Stories>"}<StoryText>${
      style === undefined ? "<DefaultStyle/>" : `<DefaultStyle id="${style}"/>`
    }${runs
      .map(
        (text, index) =>
          `<ITEXT FONT="${index === 0 ? "Regular" : "Bold"}" CH="${text}"/>`,
      )
      .join("")}</StoryText>${
      style === undefined
        ? ""
        : '<StoryText><DefaultStyle id="Empty continuation"/></StoryText></Stories>'
    }</PAGEOBJECT><PAGEOBJECT ANNAME="Details"><StoryText><ITEXT CH="Saturday at 7 PM"/></StoryText></PAGEOBJECT></DOCUMENT></SCRIBUSUTF8NEW>`;

  it.each([
    {
      edit: "keeps runs",
      before: ["Spring ", "Fair"],
      after: ["Summer ", "Fair"],
    },
    {
      edit: "splits runs",
      before: ["Spring Fair"],
      after: ["Summer ", "Fair"],
    },
    {
      edit: "merges runs",
      before: ["Spring ", "Fair"],
      after: ["Summer Fair"],
    },
    {
      edit: "keeps a style with literal selector text",
      before: ["Spring ", "Fair"],
      after: ["Summer ", "Fair"],
      style: "Headline[@draft=first",
    },
  ])(
    "checks the frame's text when an edit $edit",
    ({ before, after, style }) => {
      const seed = flyer(before, style);
      const saved = flyer(after, style);
      const file = xmlDraft(seed, saved);
      expect(file.suggested).toEqual([
        {
          kind: "text_equals",
          file: FILE,
          pointer: FRAME,
          value: "Summer Fair",
          text_attribute: "CH",
        },
      ]);
      expect(file.guards).not.toContainEqual(
        expect.objectContaining({
          kind: "member_count",
          matching: expect.stringContaining("ITEXT"),
        }),
      );
      const restyled = style === undefined ? undefined : "Updated style";
      const checks = [...file.suggested, ...file.guards];
      for (const followUp of [
        saved,
        flyer(["Summer Fair"], restyled),
        flyer(["Sum", "mer ", "Fair"], restyled),
      ]) {
        expect(passing(FILE, xml(followUp), checks)).not.toContain(false);
      }
      for (const wrong of [seed, flyer(["Summer Fete"], restyled)])
        expect(passing(FILE, xml(wrong), file.suggested)).toEqual([false]);
    },
  );

  it("keeps a check of a run's formatting the text check does not read, beside it", () => {
    const styled = (first: string, font: string) =>
      `<SCRIBUSUTF8NEW><DOCUMENT><PAGEOBJECT ANNAME="Headline"><StoryText><ITEXT FONT="Regular" CH="${first}"/><ITEXT FONT="${font}" CH="Fair"/></StoryText></PAGEOBJECT><PAGEOBJECT ANNAME="Details"/></DOCUMENT></SCRIBUSUTF8NEW>`;

    const file = xmlDraft(
      styled("Spring ", "Bold"),
      styled("Summer ", "Italic"),
    );

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: FRAME,
        value: "Summer Fair",
        text_attribute: "CH",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${FRAME}/children/[name=StoryText]/children/[name=ITEXT][@CH=Fair]/attributes/FONT`,
        value: "Italic",
      },
    ]);
  });

  it("checks a mind map's node by the TEXT it holds itself, not the TEXT of the nodes in it, and names a new node by its text rather than the id the app made, a kept one by that id", () => {
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
      `${TRIP}/children/[name=node][@ID=ID_1965352635]/children/[name=node][@ID=ID_1749680464]/attributes/TEXT`,
    ]);
    const packing = `${TRIP}/children/[name=node][@ID=ID_1965352635]/children`;
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

describe("draftTaskFiles for a run's formatting", () => {
  const flyer = (font: string) =>
    `<SCRIBUSUTF8NEW><DOCUMENT><PAGEOBJECT ANNAME="Headline" XPOS="10.5" ItemID="3"><StoryText><ITEXT FONT="${font}" CH="Spring "/><ITEXT FONT="Bold" CH="Fair"/></StoryText></PAGEOBJECT><PAGEOBJECT ANNAME="Details" XPOS="10.5" ItemID="4"><StoryText><ITEXT CH="Saturday at 7 PM"/></StoryText></PAGEOBJECT></DOCUMENT></SCRIBUSUTF8NEW>`;

  it("keeps a font change on the run that holds it, rather than joining every run's font into the frame's text", () => {
    const file = xmlDraft(flyer("Regular"), flyer("Italic"));

    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer:
          "/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=Headline]/children/[name=StoryText]/children/[name=ITEXT][@CH=Spring ]/attributes/FONT",
        value: "Italic",
      },
    ]);
  });
});
