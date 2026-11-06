import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { xmlView } from "../../../src/domain/desktop/stateFormats.js";
import { elementText } from "../../../src/domain/desktop/viewPointer.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  expectSameCheckResults,
  expectSameFileViews,
  odtOf,
  pythonXmlViews,
  savedEnds,
  typescriptFileView,
} from "../../support/desktopExportPython.js";

/** The meeting note as AbiWord saves it, before and after its time was changed. */
const notes = () => savedEnds("abiword", "meeting.abw");

/** Writer's flyer before and after an edit split its body paragraph into runs, zipped with its mimetype. */
const flyers = () =>
  savedEnds("libreoffice-runs", "content.xml", "flyer.odt", odtOf);

const NOTE = "Documents/meeting.abw";
const PARAGRAPH = "/root/children/[name=section]/children/[name=p][@xid=3]";
const MEETING = "The team meeting starts at 3:30 in room 4.";

/** The paragraph's whole text, a time within it, and its first text node, which the edit split. */
const NOTE_CHECKS: DesktopTaskCheck[] = [
  {
    id: "time",
    kind: "text_equals",
    file: NOTE,
    pointer: PARAGRAPH,
    value: MEETING,
  },
  {
    id: "within",
    kind: "text_contains",
    file: NOTE,
    pointer: PARAGRAPH,
    value: "at 3:30 in",
  },
  {
    id: "first-node",
    kind: "value_equals",
    file: NOTE,
    pointer: `${PARAGRAPH}/children/0`,
    value: MEETING,
  },
];

const FLYER = "Documents/flyer.odt";
const BODY =
  "/entries/[name=content.xml]/view/root/children/[name=office:body]/children/[name=office:text]/children/[name=text:p][@text:style-name=Standard]";
const CAKES = "Cakes, biscuits and bread from 9:30 in the village green.";

const FLYER_CHECKS: DesktopTaskCheck[] = [
  { id: "body", kind: "text_equals", file: FLYER, pointer: BODY, value: CAKES },
  {
    id: "time",
    kind: "text_contains",
    file: FLYER,
    pointer: BODY,
    value: " 9:30\n",
    normalize_whitespace: true,
  },
  {
    id: "reflowed",
    kind: "text_equals",
    file: FLYER,
    pointer: BODY,
    value: "  Cakes, biscuits and bread\n  from 9:30 in the village green. ",
    normalize_whitespace: true,
  },
  {
    id: "first-run",
    kind: "value_equals",
    file: FLYER,
    pointer: `${BODY}/children/0`,
    value: CAKES,
  },
];

const passes = (outcomes: readonly { passed: boolean }[] | undefined) =>
  outcomes?.map(({ passed }) => passed);

describe("XML with a DOCTYPE in the exported module", () => {
  it("reads an AbiWord document, which names its DTD, as REA does: the element tree and the declaration", async () => {
    const files = await notes();
    await expectSameFileViews(files);

    const [, after] = files;
    if (after === undefined) throw new Error("fixture");
    const { format, view } = await typescriptFileView(after);
    expect(format).toBe("xml");
    expect(view).toMatchObject({
      doctype: {
        name: "abiword",
        public_id: "-//ABISOURCE//DTD AWML 1.0 Strict//EN",
        system_id: "http://www.abisource.com/awml.dtd",
      },
      root: { name: "abiword", attributes: { "xml:space": "preserve" } },
      truncated: false,
    });
  });

  it("reads a DOCTYPE that only names a DTD alike, and refuses an internal subset or an undeclared entity in both", () => {
    const accepted = [
      "<!DOCTYPE a><a/>",
      '<?xml version="1.0"?><!--c--><!DOCTYPE b SYSTEM "x[1].dtd"><a>t</a>',
      "<!DOCTYPE a PUBLIC '  -//A\r\n  B//EN  ' 's  y'><a/>",
      '<!DOCTYPE a PUBLIC "" ""><a b="&lt;&#65;">&amp;&quot;&apos;&gt;</a>',
      '<!DOCTYPE svg:svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg:svg xmlns:svg="http://www.w3.org/2000/svg"/>',
    ];
    const refused = [
      "<!DOCTYPE a []><a/>",
      '<!DOCTYPE a [<!ENTITY e "boom">]><a/>',
      '<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>',
      '<!DOCTYPE a SYSTEM "a.dtd" [<!ENTITY e SYSTEM "file:///etc/hostname">]><a>&e;</a>',
      '<!DOCTYPE a [<!ENTITY % p SYSTEM "file:///etc/hostname"> %p;]><a/>',
      '<!DOCTYPE a SYSTEM "a.dtd"><a>&e;</a>',
      '<!DOCTYPE a SYSTEM "a.dtd"><a><b c="x &e; y"/></a>',
      '<!DOCTYPE a PUBLIC "-//A//EN"><a/>',
      '<!DOCTYPE a PUBLIC "x{" "y"><a/>',
      "<a/><!DOCTYPE a>",
      "<!DOCTYPE a><!DOCTYPE a><a/>",
    ];
    const texts = [...accepted, ...refused];

    const ours = texts.map((text) => xmlView(text) ?? null);

    expect(pythonXmlViews(texts)).toEqual(ours);
    expect(ours.slice(0, accepted.length)).not.toContain(null);
    expect(ours.slice(accepted.length)).toEqual(refused.map(() => null));
    expect(ours[2]).toMatchObject({
      doctype: { name: "a", public_id: "-//A B//EN", system_id: "s  y" },
    });
  });

  it("never reads the DTD a DOCTYPE names: neither its entities nor its default attributes apply", async () => {
    const folder = await createTestTempDirectory("desktop-xml-dtd-");
    const dtd = join(folder, "a.dtd");
    await writeFile(
      dtd,
      '<!ENTITY e "from the DTD"><!ATTLIST a injected CDATA "from the DTD">',
    );
    const system = pathToFileURL(dtd).href;
    const texts = [
      `<!DOCTYPE a SYSTEM "${system}"><a/>`,
      `<!DOCTYPE a SYSTEM "${system}"><a>&e;</a>`,
      `<!DOCTYPE a SYSTEM "${system}"><a b="&e;"/>`,
    ];

    const ours = texts.map((text) => xmlView(text) ?? null);

    expect(pythonXmlViews(texts)).toEqual(ours);
    expect(ours).toEqual([
      {
        doctype: { name: "a", public_id: null, system_id: system },
        root: { name: "a", attributes: {}, children: [] },
        truncated: false,
      },
      null,
      null,
    ]);
  });
});

describe("whole-text checks in both evaluators", () => {
  it("checks the meeting time across AbiWord's runs: the whole text fails before and passes after, its first node does not", async () => {
    const [before, after] = await expectSameCheckResults(
      NOTE,
      NOTE_CHECKS,
      await notes(),
    );

    expect(passes(before)).toEqual([false, false, false]);
    for (const fact of [
      PARAGRAPH,
      JSON.stringify("The team meeting starts at 2:00 in room 4."),
    ])
      expect(before?.[0]?.description).toContain(fact);
    expect(passes(after)).toEqual([true, true, false]);
    // The first text node holds only the text before the first run.
    expect(after?.[2]?.description).toContain(
      JSON.stringify("The team meeting starts at "),
    );
  });

  it("reads Writer's runs in its archive alike, the space between two runs included", async () => {
    const files = await flyers();
    await expectSameFileViews(files);

    const [before, after] = await expectSameCheckResults(
      FLYER,
      FLYER_CHECKS,
      files,
    );

    expect(passes(before)).toEqual([false, false, false, false]);
    expect(passes(after)).toEqual([true, true, true, false]);
    // The value searched for is the collapsed one, " 9:30\n" read as "9:30".
    expect(after?.[1]?.description).toContain(JSON.stringify("9:30"));
  });

  it("leaves an element's text undecided where the readers dropped text from between its runs, and its attribute decided", async () => {
    const deep = "Documents/deep.xml";
    /** A paragraph of `before`, then `dropped` nested past the 64 levels both readers keep, then `after`. */
    const paragraph = (before: string, dropped: string, after: string) => ({
      name: "deep.xml",
      bytes: new TextEncoder().encode(
        `<p id="t">${before}${"<b>".repeat(65)}${dropped}${"</b>".repeat(65)}${after}</p>`,
      ),
    });
    const files = [
      paragraph("at 3", "WRONG", ":30 PM"),
      paragraph("alpha", "zzz", "beta"),
    ];
    await expectSameFileViews(files);
    // The kept runs join into text neither file has.
    const kept = await Promise.all(
      files.map(async (file) => {
        const { view } = await typescriptFileView(file);
        return elementText((view as { root: JsonValue }).root);
      }),
    );
    expect(kept).toEqual(["at 3:30 PM", "alphabeta"]);

    const results = await expectSameCheckResults(
      deep,
      [
        {
          id: "time",
          kind: "text_contains",
          file: deep,
          pointer: "/root",
          value: "at 3:30 PM",
        },
        {
          id: "word",
          kind: "text_contains",
          file: deep,
          pointer: "/root",
          value: "alphabeta",
        },
        {
          id: "id",
          kind: "text_equals",
          file: deep,
          pointer: "/root/attributes/id",
          value: "t",
        },
      ],
      files,
    );

    expect(results).toHaveLength(files.length);
    for (const outcomes of results) {
      expect(
        outcomes.map(({ id, passed, undecided }) => [id, passed, undecided]),
      ).toEqual([
        ["time", false, true],
        ["word", false, true],
        ["id", true, undefined],
      ]);
      for (const { description } of outcomes)
        expect(description).toContain(deep);
    }
  });
});
