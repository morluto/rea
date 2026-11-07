import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
import {
  draftOf,
  passing,
  pointerOf,
  statePath,
  xml,
  xmlDraft,
} from "./appTaskDraft.fixture.js";

const FILE = "Documents/doc.xml";

describe("draftTaskFiles for a UML model, as Umbrello saves one", () => {
  const STRING = "uMUM2QvoIZjRj";
  const INT = "uC0y4gxFPBxQT";
  const attribute = (id: string, name: string, type: string) =>
    `<ownedAttribute xmi:type="uml:Property" xmi:id="${id}" name="${name}" visibility="private" type="${type}"/>`;
  /** A model: data types, two classes of attributes, the class diagram's boxes, the id counter, and the tree view mirroring the model by id. */
  const model = (added: string, height: string, counter: string) =>
    `<xmi:XMI xmlns:xmi="x" xmlns:uml="u"><uml:Model xmi:id="m1" name="UML Model"><packagedElement xmi:type="uml:Model" xmi:id="Logical_View" name="Logical View"><uml:Package xmi:id="Datatypes" name="Datatypes"><packagedElement xmi:type="uml:DataType" xmi:id="${INT}" name="int"/><packagedElement xmi:type="uml:DataType" xmi:id="${STRING}" name="string"/></uml:Package><packagedElement xmi:type="uml:Class" xmi:id="u3dEaKzAZMUjj" name="Book">${attribute("unJOJYqtTrFmw", "title", STRING)}${attribute("ufuOeMM0RJQRU", "isbn", STRING)}</packagedElement><packagedElement xmi:type="uml:Class" xmi:id="u6wBR4Z5TqyET" name="Member">${attribute("u0xTeAOXDVGS9", "name", STRING)}${attribute("uJiGZsdCWAH42", "memberId", INT)}${added}</packagedElement><xmi:Extension extender="umbrello"><diagrams><diagram xmi.id="uOOLUpU1ZgvZX" name="class diagram"><widgets><classwidget xmi.id="u6wBR4Z5TqyET" localid="uiLi0eQjS7TpP" x="574" y="150" width="116" height="${height}"/><classwidget xmi.id="u3dEaKzAZMUjj" localid="uR6uLy6layctB" x="234" y="150" width="96" height="52"/></widgets></diagram></diagrams></xmi:Extension></packagedElement></uml:Model><xmi:Extension extender="umbrello"><docsettings uniqueid="${counter}"/><codegeneration lastobject="${counter}"/><listview><listitem id="Logical_View" type="801"><listitem id="${STRING}" type="829"/><listitem id="u6wBR4Z5TqyET" type="813"><listitem id="uJiGZsdCWAH42" type="814"/><listitem id="u0xTeAOXDVGS9" type="814"/>${added === "" ? "" : '<listitem id="ubcgF2AWfBmHh" type="814"/>'}</listitem></listitem></listview></xmi:Extension></xmi:XMI>`;
  const SEED = model("", "52", "uAmSta7YLvI1L");
  const email = (type: string) =>
    model(attribute("ubcgF2AWfBmHh", "email", type), "67", "ubcgF2AWfBmHh");
  const MEMBER =
    "/root/children/[name=uml:Model]/children/[name=packagedElement]/children/[name=packagedElement][@name=Member]";

  it("checks the new attribute's type, never its class's visibility values as runs of text, so an attribute of another type fails", () => {
    const file = xmlDraft(SEED, email(STRING));

    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${MEMBER}/children/[name=ownedAttribute][@name=email]/attributes/type`,
        value: STRING,
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: `${MEMBER}/children`,
        matching: "[name=ownedAttribute][@xmi:type=uml:Property]",
        equals: 3,
      },
    ]);
    expect(passing(FILE, xml(SEED), file.suggested)).toEqual([false, false]);
    expect(passing(FILE, xml(email(STRING)), file.suggested)).toEqual([
      true,
      true,
    ]);
    expect(passing(FILE, xml(email(INT)), file.suggested)).toEqual([
      false,
      true,
    ]);
  });

  it("notes the id counter and a value equal to the new attribute's id as volatile, the tree view as view state, and the class box's growth as layout", () => {
    const file = xmlDraft(SEED, email(STRING));

    const notes = Object.fromEntries(
      file.values.map(({ pointer, note }) => [
        pointer.replace(/^.*\/children\//u, ""),
        note ?? null,
      ]),
    );
    expect(notes).toEqual({
      "[name=ownedAttribute][@name=email]": null,
      "[name=docsettings]/attributes/uniqueid": "volatile",
      "[name=codegeneration]/attributes/lastobject": "volatile",
      "[name=listitem][@id=ubcgF2AWfBmHh]": "view_state",
      "[name=classwidget][@x=574]/attributes/height": "layout",
    });
    // No selector names an element by an id of random case.
    expect(file.values.map(({ pointer }) => pointer).join()).not.toMatch(
      /xmi\.id=/u,
    );
  });

  it("names the data type the new attribute's type refers to by its xmi:id, though the tree view mirrors that id", () => {
    const file = xmlDraft(SEED, email(STRING));

    expect(file.values[0]?.refers_to).toEqual([
      {
        attribute: "type",
        value: STRING,
        element: `<packagedElement xmi:type="uml:DataType" xmi:id="${STRING}" name="string"/>`,
      },
    ]);
    expect(file.guards.map(pointerOf)).toEqual([
      `${MEMBER}/children/[name=ownedAttribute][@name=name]/attributes/type`,
      `${MEMBER}/children/[name=ownedAttribute][@name=memberId]/attributes/type`,
    ]);
  });

  it("checks the new attribute's type in a zipped model, whose data types only the archive's entries hold", () => {
    const ZIP = "Documents/library.zip";
    const zipped = (text: string): JsonValue => ({
      entries: [
        {
          name: "library.xmi",
          size: text.length,
          sha256: "a".repeat(64),
          format: "xml",
          view: xml(text),
          view_error: null,
        },
      ],
      entry_count: 1,
      truncated: false,
    });
    const [file] = draftOf({
      [ZIP]: statePath("document", "zip", zipped(SEED), zipped(email(STRING))),
    });
    const passes = (text: string) =>
      evaluateTaskChecks(
        (file?.suggested ?? []).map((check, index) => ({
          ...check,
          id: `c${String(index)}`,
        })),
        new Map([[ZIP, { format: "zip", view: zipped(text) }]]),
      ).map(({ passed }) => passed);

    const member = `/entries/[name=library.xmi]/view${MEMBER}`;
    expect(file?.suggested).toEqual([
      {
        kind: "value_equals",
        file: ZIP,
        pointer: `${member}/children/[name=ownedAttribute][@name=email]/attributes/type`,
        value: STRING,
      },
      {
        kind: "member_count",
        file: ZIP,
        pointer: `${member}/children`,
        matching: "[name=ownedAttribute][@xmi:type=uml:Property]",
        equals: 3,
      },
    ]);
    expect(passes(SEED)).toEqual([false, false]);
    expect(passes(email(STRING))).toEqual([true, true]);
    expect(passes(email(INT))).toEqual([false, true]);
  });
});
