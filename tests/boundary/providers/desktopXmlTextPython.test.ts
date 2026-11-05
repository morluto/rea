import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { xmlView } from "../../../src/domain/desktop/stateFormats.js";
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
    expect(before?.[0]?.description).toBe(
      `${NOTE} at ${PARAGRAPH} has the text "The team meeting starts at 2:00 in room 4.", not "${MEETING}"`,
    );
    expect(passes(after)).toEqual([true, true, false]);
    expect(after?.[2]?.description).toContain(
      'is "The team meeting starts at ", not',
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
    expect(after?.[1]?.description).toBe(
      `${FLYER} at ${BODY} has text containing "9:30" with whitespace collapsed`,
    );
  });
});
