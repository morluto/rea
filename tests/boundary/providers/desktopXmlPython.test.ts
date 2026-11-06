import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { DesktopTaskCheck } from "../../../src/domain/desktop/appTask.js";
import { xmlView } from "../../../src/domain/desktop/stateFormats.js";
import { zipArchive } from "../../../src/domain/desktop/zipArchive.fixture.js";
import {
  expectSameCheckResults,
  expectSameFileViews,
  pythonXmlViews,
  typescriptFileView,
} from "../../support/desktopExportPython.js";

const FIXTURES = join(import.meta.dirname, "../../fixtures");
const ENDS = ["before", "after"] as const;

/** Inkscape's saves of the poster, before and after the headline was changed. */
const posters = () =>
  Promise.all(
    ENDS.map(async (end) => ({
      name: "poster.svg",
      bytes: await readFile(join(FIXTURES, "inkscape", end, "poster.svg")),
    })),
  );

/** LibreOffice Writer's saves of the flyer, before and after the date was changed, zipped with their mimetype. */
const flyers = () =>
  Promise.all(
    ENDS.map(async (end) => ({
      name: "flyer.odt",
      bytes: zipArchive([
        {
          name: "mimetype",
          data: "application/vnd.oasis.opendocument.text",
          method: 0,
        },
        {
          name: "content.xml",
          data: await readFile(
            join(FIXTURES, "libreoffice", end, "content.xml"),
          ),
        },
      ]),
    })),
  );

const POSTER = "Pictures/poster.svg";
const FLYER = "Documents/flyer.odt";

/** The poster's checks: its headline's text, then a setting Inkscape keeps in a namespaced attribute. */
const POSTER_CHECKS: DesktopTaskCheck[] = [
  {
    id: "headline",
    kind: "value_equals",
    file: POSTER,
    pointer:
      "/root/children/[name=g][@inkscape:label=Layer 1]/children/[name=text][@id=headline]/children/[name=tspan]/children/0",
    value: "Summer Bake Sale",
  },
  {
    id: "units",
    kind: "value_equals",
    file: POSTER,
    pointer:
      "/root/children/[name=sodipodi:namedview]/attributes/inkscape:document-units",
    value: "mm",
  },
];

const DATE: DesktopTaskCheck = {
  id: "date",
  kind: "value_equals",
  file: FLYER,
  pointer:
    "/entries/[name=content.xml]/view/root/children/[name=office:body]/children/[name=office:text]/children/[name=text:p][@text:style-name=Subtitle]/children/0",
  value: "Monday 24 November",
};

const passes = (outcomes: readonly { passed: boolean }[] | undefined) =>
  outcomes?.map(({ passed }) => passed);

describe("namespaced XML in the exported module", () => {
  it("reads an Inkscape SVG as REA does: prefixed names, the default namespace and its declarations", async () => {
    const files = await posters();
    await expectSameFileViews(files);

    const [, after] = files;
    if (after === undefined) throw new Error("fixture");
    const { view } = await typescriptFileView(after);
    expect(view).toMatchObject({
      root: {
        name: "svg",
        attributes: {
          xmlns: "http://www.w3.org/2000/svg",
          "xmlns:svg": "http://www.w3.org/2000/svg",
          "xmlns:sodipodi":
            "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
          "sodipodi:docname": "poster.svg",
        },
        children: [{ name: "defs" }, { name: "sodipodi:namedview" }, {}],
      },
      truncated: false,
    });
  });

  it("checks the poster's headline by name: failing before the edit and passing after, in both evaluators", async () => {
    const [before, after] = await expectSameCheckResults(
      POSTER,
      POSTER_CHECKS,
      await posters(),
    );

    expect(passes(before)).toEqual([false, true]);
    expect(before?.[0]?.description).toContain(
      'is "Spring Bake Sale", not "Summer Bake Sale"',
    );
    expect(passes(after)).toEqual([true, true]);
  });

  it("reads a Writer document's content.xml as REA does, in its archive", async () => {
    const files = await flyers();
    await expectSameFileViews(files);

    const [, after] = files;
    if (after === undefined) throw new Error("fixture");
    const { view } = await typescriptFileView(after);
    expect(view).toMatchObject({
      entries: [
        { name: "mimetype", format: "text" },
        {
          name: "content.xml",
          format: "xml",
          view: {
            root: {
              name: "office:document-content",
              attributes: {
                "xmlns:text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
                "office:version": "1.3",
              },
            },
          },
        },
      ],
    });
  });

  it("checks the flyer's date by name: failing before the edit and passing after, in both evaluators", async () => {
    const [before, after] = await expectSameCheckResults(
      FLYER,
      [DATE],
      await flyers(),
    );

    expect(passes(before)).toEqual([false]);
    expect(before?.[0]?.description).toContain(
      'is "Monday 17 November", not "Monday 24 November"',
    );
    expect(passes(after)).toEqual([true]);
  });

  it("splits text, CDATA and comments, spells xml: and xmlns names, and refuses documents, as REA does", () => {
    const texts = [
      '<a b="1" xmlns="urn:u" c="2" xmlns:p="urn:v" p:d="3"><e xmlns=""/><p:f xml:lang="en"/></a>',
      "<a>x<![CDATA[y]]>z<![CDATA[]]>w<!--c-->v<?pi d?><![CDATA[q]]><![CDATA[r]]></a>",
      '<a xml:space="preserve"><b/> <c xml:space=""><d/> </c></a>',
      "<a><b/><![CDATA[  ]]><c/></a>",
      "<p:a/>",
      '<a xmlns:p="urn:u" xmlns:q="urn:u" p:x="1" q:x="2"/>',
      '<a xmlns:p=""/>',
      '<a:b:c xmlns:a="urn:u"/>',
      "<a><?p:x y?></a>",
      "<!DOCTYPE a><a/>",
    ];

    const ours = texts.map((text) => xmlView(text) ?? null);

    expect(pythonXmlViews(texts)).toEqual(ours);
    expect(ours.slice(4)).toEqual([null, null, null, null, null, null]);
    expect(ours[1]).toMatchObject({
      root: { children: ["x", "y", "zw", "v", "q", "r"] },
    });
  });

  it("keeps REA's node and depth limits on prefixed names", () => {
    const declared = 'xmlns:p="urn:u"';
    const texts = [
      `<p:a ${declared}>${"<p:b/>".repeat(5000)}</p:a>`,
      `<p:a ${declared}>${"<p:d>".repeat(70)}${"</p:d>".repeat(70)}<p:e/></p:a>`,
    ];

    const ours = texts.map((text) => xmlView(text) ?? null);

    expect(pythonXmlViews(texts)).toEqual(ours);
    expect(ours).toMatchObject([{ truncated: true }, { truncated: true }]);
  });
});
