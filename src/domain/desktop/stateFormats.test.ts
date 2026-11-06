import { describe, expect, it } from "vitest";

import {
  detectStateFormat,
  jsonView,
  keyfileView,
  textSyntaxFormat,
  textView,
  xmlView,
} from "./stateFormats.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("detectStateFormat", () => {
  it("recognises SQLite and dconf headers before decoding text", () => {
    expect(detectStateFormat("/h/a.db", bytes("SQLite format 3\0rest"))).toBe(
      "sqlite",
    );
    expect(detectStateFormat("/h/user", bytes("GVariant\0\0\0\0"))).toBe(
      "dconf",
    );
    expect(detectStateFormat("/h/blob", Uint8Array.of(1, 0, 2))).toBe("binary");
  });

  it("recognises a zip archive by its local file header, whatever its name", () => {
    const header = Uint8Array.of(0x50, 0x4b, 3, 4, 20, 0, 0, 0);
    expect(detectStateFormat("/h/plate.FCStd", header)).toBe("zip");
    expect(detectStateFormat("/h/plate.20261105.FCBak", header)).toBe("zip");
    expect(
      detectStateFormat("/h/empty.odt", Uint8Array.of(0x50, 0x4b, 5, 6, 0, 0)),
    ).toBe("binary");
  });

  it("tells JSON, XML, key files and plain text apart", () => {
    expect(detectStateFormat("/h/a.json", bytes('{"a":1}'))).toBe("json");
    expect(detectStateFormat("/h/notes", bytes("{not json"))).toBe("text");
    expect(
      detectStateFormat("/h/a.xbel", bytes("<?xml version='1.0'?><x/>")),
    ).toBe("xml");
    expect(
      detectStateFormat("/h/settings", bytes("[General]\nwrap=true\n")),
    ).toBe("keyfile");
    expect(detectStateFormat("/h/todo.txt", bytes("milk\neggs\n"))).toBe(
      "text",
    );
  });

  it("reads text as a key file only when every line is a group, a key or a comment", () => {
    expect(
      detectStateFormat("/h/todo.txt", bytes("Groceries\n[x]\nmilk\n")),
    ).toBe("text");
    expect(
      detectStateFormat("/h/app.conf", bytes("# no groups\nwrap=true\n")),
    ).toBe("text");
    expect(detectStateFormat("/h/app.rc", bytes("[ui]\nset wrap on\n"))).toBe(
      "text",
    );
    expect(
      detectStateFormat(
        "/h/app.desktop",
        bytes("top=1\n; note\n[Desktop Entry]\nName[de]=Notizen\n"),
      ),
    ).toBe("keyfile");
  });
});

describe("jsonView", () => {
  it("refuses values a JavaScript number would round, or that nest too deeply", () => {
    expect(jsonView('{"id":9007199254740993}')).toEqual({
      ok: false,
      error:
        "a number in it cannot be read exactly, such as an integer above 2^53",
    });
    expect(jsonView(`${"[".repeat(502)}${"]".repeat(502)}`)).toEqual({
      ok: false,
      error: "nested deeper than the 500 levels a JSON view keeps",
    });
    expect(jsonView(`${"[".repeat(501)}${"]".repeat(501)}`).ok).toBe(true);
    expect(jsonView('{"id":9007199254740991,"x":0.5}')).toEqual({
      ok: true,
      value: { id: 9007199254740991, x: 0.5 },
    });
  });
});

describe("views", () => {
  it("splits text into lines without a trailing empty line", () => {
    expect(textView("a\nb\n")).toEqual({
      lines: ["a", "b"],
      line_count: 2,
      truncated: false,
    });
  });

  it("reads key file groups, keeping keys before the first group", () => {
    expect(
      keyfileView("top=1\n# note\n[org/app]\nwrap = true\nfont='Mono 10'\n"),
    ).toEqual({
      "": { top: "1" },
      "org/app": { wrap: "true", font: "'Mono 10'" },
    });
  });

  it("reads XML into an element tree and refuses a DOCTYPE with an internal subset", () => {
    expect(xmlView('<a x="1"><b>text</b></a>')).toEqual({
      root: {
        name: "a",
        attributes: { x: "1" },
        children: [{ name: "b", attributes: {}, children: ["text"] }],
      },
      truncated: false,
    });
    expect(xmlView('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>')).toBeUndefined();
    expect(xmlView('<!DOCTYPE a [<!ENTITY e "x">]><a/>')).toBeUndefined();
    expect(xmlView("<!DOCTYPE a []><a/>")).toBeUndefined();
  });

  it("reads a document whose DOCTYPE only names its DTD as the same tree, recording the declaration", () => {
    const tree = '<a x="1"><b>text &amp; more</b></a>';
    const declared = `<?xml version="1.0"?>\n<!DOCTYPE a PUBLIC "-//X//DTD A 1.0//EN" "http://example.test/a.dtd">\n${tree}`;

    expect(xmlView(declared)).toEqual({
      doctype: {
        name: "a",
        public_id: "-//X//DTD A 1.0//EN",
        system_id: "http://example.test/a.dtd",
      },
      ...(xmlView(tree) as object),
    });
    expect(xmlView(`<!DOCTYPE a>${tree}`)).toMatchObject({
      doctype: { name: "a", public_id: null, system_id: null },
    });
  });

  it("refuses a reference to an entity the document cannot declare, even with an external DTD", () => {
    expect(xmlView('<!DOCTYPE a SYSTEM "a.dtd"><a>&e;</a>')).toBeUndefined();
    expect(xmlView('<!DOCTYPE a SYSTEM "a.dtd"><a b="&e;"/>')).toBeUndefined();
  });
});

describe("detectStateFormat with a DOCTYPE", () => {
  it("reads an AbiWord document, which names its DTD, as XML, and one declaring entities as text", () => {
    const abiword = (subset: string) =>
      bytes(
        `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE abiword PUBLIC "-//ABISOURCE//DTD AWML 1.0 Strict//EN" "http://www.abisource.com/awml.dtd"${subset}>\n<abiword xml:space="preserve"><section><p>Hello</p></section></abiword>\n`,
      );

    expect(detectStateFormat("/h/Documents/note.abw", abiword(""))).toBe("xml");
    expect(
      detectStateFormat(
        "/h/Documents/note.abw",
        abiword(' [<!ENTITY lol "lol">]'),
      ),
    ).toBe("text");
  });

  it("reads a file that opens with a DOCTYPE naming no internal subset and then an element as XML, as KmPlot's plot, whatever it is called", () => {
    const plot = (doctype: string, body = '<function type="cartesian"/>') =>
      bytes(`${doctype}\n<kmpdoc version="4">\n    ${body}\n</kmpdoc>\n`);

    expect(
      detectStateFormat(
        "/h/Documents/lesson_plots.fkt",
        plot("<!DOCTYPE kmpdoc>"),
      ),
    ).toBe("xml");
    expect(
      textSyntaxFormat(
        "/h/Documents/lesson_plots.fkt",
        '<!DOCTYPE kmpdoc>\n<kmpdoc version="4"/>\n',
      ),
    ).toBe("xml");
    // A DOCTYPE that can declare entities, or text that is not well formed, stays text.
    expect(
      detectStateFormat(
        "/h/Documents/lesson_plots.fkt",
        plot('<!DOCTYPE kmpdoc [<!ENTITY e "x">]>', "<f>&e;</f>"),
      ),
    ).toBe("text");
    expect(
      detectStateFormat(
        "/h/Documents/lesson_plots.fkt",
        plot("<!DOCTYPE kmpdoc>", "<function>"),
      ),
    ).toBe("text");
  });

  it.each([
    '<!DOCTYPE abiword PUBLIC "-//ABISOURCE//DTD AWML 1.0 Strict//EN" "http://www.abisource.com/awml.dtd"><abiword/>',
    '<!DOCTYPE abiword [<!ENTITY lol "lol">]><abiword>&lol;</abiword>',
    '<!DOCTYPE abiword SYSTEM "awml.dtd"><abiword>&lol;</abiword>',
    '<!DOCTYPE abiword PUBLIC "{bad}" "awml.dtd"><abiword/>',
  ])(
    "tells XML by syntax alone as it does when it builds the document: %j",
    (body) => {
      const text = `<?xml version="1.0"?>\n${body}\n`;
      expect(textSyntaxFormat("/h/Documents/note.abw", text)).toBe(
        detectStateFormat("/h/Documents/note.abw", bytes(text)),
      );
    },
  );
});

describe("captured data safety and fidelity", () => {
  it("keeps a __proto__ group as plain data without touching Object.prototype", () => {
    const groups = keyfileView("[__proto__]\npolluted=yes\n");
    expect(Object.keys(groups)).toEqual(["__proto__"]);
    expect(groups["__proto__"]?.polluted).toBe("yes");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("keeps XML text and leaf whitespace exactly, dropping only formatting between elements", () => {
    expect(
      xmlView(
        '<a>\n  <b> x </b><c xml:space="preserve">  </c><d>\n  </d>\n</a>',
      ),
    ).toEqual({
      root: {
        name: "a",
        attributes: {},
        children: [
          { name: "b", attributes: {}, children: [" x "] },
          {
            name: "c",
            attributes: { "xml:space": "preserve" },
            children: ["  "],
          },
          { name: "d", attributes: {}, children: ["\n  "] },
        ],
      },
      truncated: false,
    });
  });

  it("keeps whitespace between the runs of mixed content, which holds text of its own", () => {
    expect(
      xmlView("<p>Meet on <s>Sunday</s> <s>evening</s>.<q>\n  <s/>\n</q></p>"),
    ).toEqual({
      root: {
        name: "p",
        attributes: {},
        children: [
          "Meet on ",
          { name: "s", attributes: {}, children: ["Sunday"] },
          " ",
          { name: "s", attributes: {}, children: ["evening"] },
          ".",
          {
            name: "q",
            attributes: {},
            children: [{ name: "s", attributes: {}, children: [] }],
          },
        ],
      },
      truncated: false,
    });
  });

  it("drops only XML whitespace as formatting: a no-break space between elements is text", () => {
    const b = { name: "b", attributes: {}, children: [] };
    const between = (text: string) => `<a><b/>${text}<b/></a>`;

    expect(
      xmlView(`<r>${[" ", "\u0085", "﻿", "\t\r\n "].map(between).join("")}</r>`),
    ).toEqual({
      root: {
        name: "r",
        attributes: {},
        children: [
          ...[" ", "\u0085", "﻿"].map((text) => ({
            name: "a",
            attributes: {},
            children: [b, text, b],
          })),
          { name: "a", attributes: {}, children: [b, b] },
        ],
      },
      truncated: false,
    });
  });

  it("keeps whitespace runs a leaf's comments separate", () => {
    expect(xmlView("<a> <!--x--> <!--y--> </a>")).toEqual({
      root: { name: "a", attributes: {}, children: [" ", " ", " "] },
      truncated: false,
    });
  });

  it("marks a tree cut at the depth limit as truncated", () => {
    const deep = `${"<n>".repeat(70)}${"</n>".repeat(70)}`;
    expect(xmlView(deep)).toMatchObject({ truncated: true });
  });
});
