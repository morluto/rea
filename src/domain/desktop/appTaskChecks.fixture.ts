import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import type { TaskFileView } from "./appTaskChecks.js";

/** Views of every format data/get serves, including the ones a check cannot read. */
export const CHECK_VIEWS: Readonly<Record<string, TaskFileView>> = {
  "Documents/todo.txt": {
    format: "text",
    view: {
      lines: ["buy bread", "buy milk", "buy milk", "CIRCLE", "naïve café"],
      line_count: 5,
      truncated: false,
    },
  },
  "Documents/long.txt": {
    format: "text",
    view: { lines: ["a"], line_count: 6000, truncated: true },
  },
  ".config/notes/settings.json": {
    format: "json",
    view: {
      wrap: true,
      size: 12,
      ratio: 0.5,
      zero: 0,
      tags: ["a", "b"],
      "a/b": { "~k": null },
      scale: "1.2500",
    },
  },
  ".config/notes/app.ini": {
    format: "keyfile",
    view: { groups: { ui: { wrap: "false" } } },
  },
  ".config/notes/layout.xml": {
    format: "xml",
    view: {
      root: { name: "layout", attributes: { width: "80" }, children: [] },
      truncated: true,
    },
  },
  ".local/share/notes/notes.db": {
    format: "sqlite",
    view: {
      tables: {
        notes: {
          columns: ["id", "body", "done"],
          primary_key: ["id"],
          rows: [
            [1, "a", 0],
            [2, "b", 1],
          ],
          truncated: false,
        },
        big: { columns: ["id"], primary_key: [], rows: [[1]], truncated: true },
        broken: { error: "malformed" },
      },
      tables_truncated: false,
    },
  },
  ".local/share/notes/cut.db": {
    format: "sqlite",
    view: { tables: {}, tables_truncated: true },
  },
  "Documents/plate.FCStd": {
    format: "zip",
    view: {
      entries: [
        {
          name: "Document.xml",
          size: 300,
          sha256: "a".repeat(64),
          format: "xml",
          view: {
            root: {
              name: "Document",
              attributes: {},
              children: [
                element("Object", { name: "Plate", type: "Part::Box" }),
                element("Object", { name: "Hole", type: "Part::Cylinder" }, [
                  element("Property", { name: "Radius" }, [
                    element("Float", { value: "5.0000000000000000" }),
                  ]),
                ]),
                element("Object", { name: "Pad", type: "Part::Box" }),
                "saved by hand",
              ],
            },
            truncated: false,
          },
          view_error: null,
        },
        {
          name: "thumbnails/Thumbnail.png",
          size: 3,
          sha256: "b".repeat(64),
          format: "binary",
          view: null,
          view_error: null,
        },
        {
          name: "shape.brp",
          size: 9000,
          sha256: "c".repeat(64),
          format: "text",
          view: { lines: ["a"], line_count: 6000, truncated: true },
          view_error: null,
        },
        {
          name: "huge.brp",
          size: 17_000_000,
          sha256: null,
          format: null,
          view: null,
          view_error: "larger than the 16 MiB an entry's view reads",
        },
        {
          name: "empty.json",
          size: 4,
          sha256: "f".repeat(64),
          format: "json",
          view: null,
          view_error: null,
        },
      ],
      entry_count: 5,
      truncated: false,
    },
  },
  "Documents/many.zip": {
    format: "zip",
    view: { entries: [], entry_count: 1200, truncated: true },
  },
  "Documents/cut.xml": {
    format: "xml",
    view: {
      root: element("doc", {}, [element("p", { id: "1" }), "kept"]),
      truncated: true,
    },
  },
  "Documents/listing.zip": {
    format: "zip",
    view: {
      entries: [
        {
          name: "a.json",
          size: 7,
          sha256: "d".repeat(64),
          format: "json",
          view: { x: 1 },
          view_error: null,
        },
        {
          name: "page.xml",
          size: 9000,
          sha256: "e".repeat(64),
          format: "xml",
          view: {
            root: element("page", {}, [element("p", { id: "1" })]),
            truncated: true,
          },
          view_error: null,
        },
      ],
      entry_count: 1500,
      truncated: true,
    },
  },
  "Documents/meeting.xml": {
    format: "xml",
    view: {
      doctype: { name: "doc", public_id: null, system_id: "meeting.dtd" },
      root: element("doc", { lang: "en" }, [
        element("p", { id: "time" }, [
          "Starts at ",
          element("c", {}, ["3"]),
          ":",
          element("c", {}, ["30"]),
          " today.",
        ]),
        element("p", { id: "spaced" }, [
          "\n  Doors\topen ",
          element("b", {}, ["  early "]),
          "\n",
        ]),
        element("p", { id: "empty" }),
        element("p", { id: "deep" }, [
          element("q", {}, [element("r", {}, ["x"]), "y"]),
          "z",
        ]),
      ]),
      truncated: false,
    },
  },
  "Documents/budget.xml": {
    format: "xml",
    view: {
      root: element("Cells", {}, [
        element("Cell", { Row: "2", Col: "3" }, ["437.80000000000001"]),
        element("Cell", { Row: "2", Col: "2" }, ["398.2"]),
        element("Cell", { Row: "3", Col: "3" }, ["174.9"]),
      ]),
      truncated: false,
    },
  },
  "Documents/flyer.sla": {
    format: "xml",
    view: {
      root: element("SCRIBUSUTF8NEW", { Version: "1.6.1" }, [
        element("DOCUMENT", {}, [
          element("PAGEOBJECT", { ANNAME: "Headline" }, [
            element("StoryText", {}, [
              element("DefaultStyle", {}),
              element("ITEXT", { CH: "Spring " }),
              element("ITEXT", { FONT: "Sans Bold", CH: "Fair" }),
              "typed",
            ]),
          ]),
          element("PAGEOBJECT", { ANNAME: "Body" }, [
            element("StoryText", {}, [
              element("ITEXT", { CH: "Doors \n open" }),
              element("ITEXT", { CH: "  at noon" }),
            ]),
          ]),
        ]),
      ]),
      truncated: false,
    },
  },
  ".local/share/osmo/contacts_records.xml": {
    format: "xml",
    view: {
      root: element("osmo_contacts", {}, [
        contact("Delphine", "Moreau"),
        contact("\n  Bastien\t", "Roy"),
        contact("Delphine", "Abara"),
        element("group", {}, [element("first_name", {}, ["Delphine"])]),
      ]),
      truncated: false,
    },
  },
  "Documents/ledger.json": {
    format: "json",
    view: [
      { payee: "Grocer", amount: 12 },
      { payee: "Rent", amount: 900 },
      { payee: "Grocer", amount: 30 },
    ],
  },
  "Documents/photo.png": { format: "binary", view: null },
  "Documents/huge.txt": {
    format: null,
    view: null,
    error: "larger than 64 MiB, the most the view reads",
  },
  "Documents/Budget.gnumeric": {
    format: "xml",
    compression: "gzip",
    view: {
      root: element("gnm:Workbook", {}, [
        element("gnm:Name", {}, ["Budget"]),
        element("gnm:Cell", { Row: "1", Col: "2" }, ["437.80000000000001"]),
      ]),
      truncated: false,
    },
  },
  "Documents/bomb.gnumeric": {
    format: null,
    compression: "gzip",
    view: null,
    error: "expands more than 100 times, so it is not read",
  },
  "Documents/damaged.gnumeric": {
    format: null,
    compression: "gzip",
    view: null,
    error: "not a readable gzip stream",
  },
};

/** An Osmo contact: fields as child elements, no attributes. */
function contact(first: string, last: string): JsonValue {
  return element("contact", {}, [
    element("first_name", {}, [first]),
    element("last_name", {}, [last]),
  ]);
}

/** An element of REA's XML view. */
function element(
  name: string,
  attributes: Record<string, string>,
  children: JsonValue[] = [],
): JsonValue {
  return { name, attributes, children };
}

const todo = "Documents/todo.txt";
const settings = ".config/notes/settings.json";
const db = ".local/share/notes/notes.db";
const absent = "Documents/absent.txt";
const plate = "Documents/plate.FCStd";
const objects = "/entries/[name=Document.xml]/view/root/children";
const radius = `${objects}/[name=Object][@name=Hole]/children/[name=Property][@name=Radius]/children/[name=Float]/attributes/value`;

/** Selectors over arrays a view may hold only part of stay undecided; positions stay decided on what it holds. */
const PARTIAL_SELECTOR_CASES: readonly (readonly [
  DesktopTaskCheckInput,
  boolean,
])[] = [
  [
    {
      kind: "value_equals",
      file: "Documents/cut.xml",
      pointer: "/root/children/[name=p]/attributes/id",
      value: "1",
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/cut.xml",
      pointer: "/root/children/0/attributes/id",
      value: "1",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/listing.zip",
      pointer: "/entries/[name=a.json]/view/x",
      value: 1,
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/listing.zip",
      pointer: "/entries/0/view/x",
      value: 1,
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/listing.zip",
      pointer: "/entries/1/view/root/children/[name=p]/attributes/id",
      value: "1",
    },
    false,
  ],
];

/** Selectors: one member matched, none, several, or a malformed one, through a zip view. */
const SELECTOR_CASES: readonly (readonly [DesktopTaskCheckInput, boolean])[] = [
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: `${objects}/[name=Object][@name=Hole]/attributes/type`,
      value: "Part::Cylinder",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: `${objects}/[name=Object][@type=Part::Box]/attributes/name`,
      value: "Plate",
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: `${objects}/[name=Object][@name=Gone]/attributes/name`,
      value: "Gone",
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: `${objects}/[name=Object][@name=Gone]`,
      value: "Gone",
    },
    false,
  ],
  [
    {
      kind: "value_absent",
      file: plate,
      pointer: `${objects}/[name=Object][@name=Gone]`,
    },
    true,
  ],
  [
    {
      kind: "value_absent",
      file: plate,
      pointer: `${objects}/[name=Object][@name=Gone]/attributes/type`,
    },
    false,
  ],
  [
    {
      kind: "value_absent",
      file: plate,
      pointer: `${objects}/[name=Object][@type=Part::Box]`,
    },
    false,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/tags/[x]", value: "a" },
    false,
  ],
  [{ kind: "value_absent", file: settings, pointer: "/tags/[name=a]" }, true],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: "/entries/[name=thumbnails~1Thumbnail.png]/format",
      value: "binary",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: "/entries/0/name",
      value: "Document.xml",
    },
    true,
  ],
  [
    {
      kind: "value_absent",
      file: plate,
      pointer: "/entries/[name=Document.xml]/view/root/attributes/x",
    },
    true,
  ],
  [
    {
      kind: "value_absent",
      file: plate,
      pointer: "/entries/[name=shape.brp]/view/lines/5",
    },
    false,
  ],
  [
    {
      kind: "value_absent",
      file: plate,
      pointer: "/entries/[name=huge.brp]/view/lines/0",
    },
    false,
  ],
  [
    { kind: "value_absent", file: plate, pointer: "/entries/[name=gone.txt]" },
    true,
  ],
  [
    {
      kind: "value_absent",
      file: "Documents/many.zip",
      pointer: "/entries/[name=gone.txt]",
    },
    false,
  ],
  [{ kind: "lines_present", file: plate, lines: ["a"] }, false],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: "/entries/[name=huge.brp]/view",
      value: null,
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: "/entries/[name=empty.json]/view",
      value: null,
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: "/entries/[name=thumbnails~1Thumbnail.png]/view",
      value: null,
    },
    false,
  ],
  [
    {
      kind: "value_absent",
      file: plate,
      pointer: "/entries/[name=thumbnails~1Thumbnail.png]/view/x",
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: plate,
      pointer: "/entries/[name=thumbnails~1Thumbnail.png]/size",
      value: 3,
    },
    true,
  ],
  ...PARTIAL_SELECTOR_CASES,
];

/** Numbers within a tolerance, numeral strings read as numbers, anything else refused. */
const TOLERANCE_CASES: readonly (readonly [DesktopTaskCheckInput, boolean])[] =
  [
    [
      {
        kind: "value_equals",
        file: plate,
        pointer: radius,
        value: 5,
        tolerance: 0.01,
      },
      true,
    ],
    [
      {
        kind: "value_equals",
        file: plate,
        pointer: radius,
        value: 5.1,
        tolerance: 0.01,
      },
      false,
    ],
    [
      {
        kind: "value_equals",
        file: plate,
        pointer: `${objects}/[name=Object][@name=Hole]/attributes/type`,
        value: 5,
        tolerance: 1,
      },
      false,
    ],
    [
      {
        kind: "value_equals",
        file: settings,
        pointer: "/ratio",
        value: 0.49,
        tolerance: 0.02,
      },
      true,
    ],
    [
      {
        kind: "value_equals",
        file: settings,
        pointer: "/wrap",
        value: 1,
        tolerance: 0,
      },
      false,
    ],
    [
      {
        kind: "value_equals",
        file: settings,
        pointer: "/scale",
        value: 1.25,
        tolerance: 0,
      },
      true,
    ],
    [
      {
        kind: "value_equals",
        file: settings,
        pointer: "/missing",
        value: 1,
        tolerance: 0,
      },
      false,
    ],
    // A cell's text by two attributes together, in either order, as drafts name cells.
    [
      {
        kind: "value_equals",
        file: "Documents/budget.xml",
        pointer: "/root/children/[name=Cell][@Col=3][@Row=2]/children/0",
        value: 437.8,
        tolerance: 0.001,
      },
      true,
    ],
    [
      {
        kind: "value_equals",
        file: "Documents/budget.xml",
        pointer: "/root/children/[name=Cell][@Row=2][@Col=3]/children/0",
        value: 437.9,
        tolerance: 0.001,
      },
      false,
    ],
    [
      {
        kind: "value_equals",
        file: "Documents/budget.xml",
        pointer: "/root/children/[name=Cell][@Col=3]/children/0",
        value: 437.8,
        tolerance: 0.001,
      },
      false,
    ],
  ];

const meeting = "Documents/meeting.xml";
const paragraph = (id: string) => `/root/children/[name=p][@id=${id}]`;

/**
 * Strings of an XML view that are no text of the document: a tag name, the
 * DOCTYPE's fields. Each holds the value checked, and each fails; an
 * attribute's value in an archive entry is text and passes.
 */
const METADATA_CASES: readonly (readonly [DesktopTaskCheckInput, boolean])[] = [
  [
    { kind: "text_equals", file: meeting, pointer: "/root/name", value: "doc" },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: meeting,
      pointer: `${paragraph("time")}/name`,
      value: "p",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: "/doctype/system_id",
      value: "meeting.dtd",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: "/doctype/name",
      value: "doc",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: plate,
      pointer: "/entries/[name=Document.xml]/view/root/name",
      value: "Document",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: plate,
      pointer: `${objects}/[name=Object][@name=Hole]/attributes/type`,
      value: "Part::Cylinder",
    },
    true,
  ],
];

/** An element's whole text, its runs and descendants included, compared or searched, exactly or with whitespace collapsed. */
const TEXT_CASES: readonly (readonly [DesktopTaskCheckInput, boolean])[] = [
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: paragraph("time"),
      value: "Starts at 3:30 today.",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: paragraph("time"),
      value: "Starts at 3:30",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: meeting,
      pointer: paragraph("time"),
      value: "3:30",
    },
    true,
  ],
  [
    {
      kind: "text_contains",
      file: meeting,
      pointer: paragraph("time"),
      value: "3:45",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: paragraph("spaced"),
      value: "Doors open early",
      normalize_whitespace: true,
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: paragraph("spaced"),
      value: "Doors open early",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: meeting,
      pointer: paragraph("spaced"),
      value: "open\n early",
      normalize_whitespace: true,
    },
    true,
  ],
  [
    {
      kind: "text_contains",
      file: meeting,
      pointer: paragraph("spaced"),
      value: "open early",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: paragraph("empty"),
      value: "",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: paragraph("deep"),
      value: "xyz",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: `${paragraph("time")}/children/0`,
      value: "Starts at ",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: "/root/attributes/lang",
      value: "en",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: "/root/attributes",
      value: "en",
    },
    false,
  ],
  ...METADATA_CASES,
  [
    {
      kind: "text_equals",
      file: meeting,
      pointer: paragraph("gone"),
      value: "x",
    },
    false,
  ],
  [{ kind: "text_equals", file: absent, pointer: "/root", value: "" }, false],
  [
    { kind: "text_equals", file: settings, pointer: "/tags/0", value: "a" },
    false,
  ],
  [
    { kind: "text_contains", file: todo, pointer: "/lines/0", value: "b" },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: "Documents/cut.xml",
      pointer: "/root/children/0",
      value: "",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: "Documents/cut.xml",
      pointer: "/root/children/1",
      value: "kept",
    },
    true,
  ],
  [
    {
      kind: "text_contains",
      file: "Documents/cut.xml",
      pointer: "/root/children/[name=p]",
      value: "x",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: plate,
      pointer: "/entries/[name=Document.xml]/view/root",
      value: "saved by hand",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: plate,
      pointer: "/entries/[name=empty.json]/view/x",
      value: "x",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: plate,
      pointer: "/entries/0/name",
      value: "Document.xml",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: plate,
      pointer: "/entries/[name=thumbnails~1Thumbnail.png]/view",
      value: "",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: "Documents/listing.zip",
      pointer: "/entries/1/view/root",
      value: "",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: "Documents/photo.png",
      pointer: "/root",
      value: "",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: "Documents/cut.xml",
      pointer: "/root/children/2",
      value: "later",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: "Documents/listing.zip",
      pointer: "/entries/1/view/root/children/2",
      value: "later",
    },
    false,
  ],
];

/** Failures a cut view may have caused, which both evaluators fail alike and REA marks undecided. */
const CUT_VIEW_CASES: readonly (readonly [DesktopTaskCheckInput, boolean])[] = [
  [{ kind: "lines_present", file: "Documents/long.txt", lines: ["z"] }, false],
  [{ kind: "row_present", file: db, table: "big", where: { id: 9 } }, false],
  [
    {
      kind: "value_equals",
      file: "Documents/long.txt",
      pointer: "/lines/5500",
      value: "z",
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/many.zip",
      pointer: "/entries/1100/name",
      value: "a.txt",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: "Documents/cut.xml",
      pointer: "/root",
      value: "gone",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: "Documents/cut.xml",
      pointer: "/root",
      value: "kept",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: "Documents/cut.xml",
      pointer: "/root/children/5",
      value: "x",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: "Documents/many.zip",
      pointer: "/entries/1100/view/root",
      value: "x",
    },
    false,
  ],
];

const budget = "Documents/Budget.gnumeric";

/** A gzip file's document checked as the document, and one past the limits or damaged read by no check. */
const GZIP_CASES: readonly (readonly [DesktopTaskCheckInput, boolean])[] = [
  [
    {
      kind: "value_equals",
      file: budget,
      pointer: "/root/children/[name=gnm:Cell][@Row=1][@Col=2]/children/0",
      value: 437.8,
      tolerance: 0.001,
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: budget,
      pointer: "/root/children/[name=gnm:Name]",
      value: "Budget",
    },
    true,
  ],
  [{ kind: "lines_present", file: budget, lines: ["Budget"] }, false],
  [
    {
      kind: "value_absent",
      file: "Documents/bomb.gnumeric",
      pointer: "/root/attributes/x",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: "Documents/damaged.gnumeric",
      pointer: "/root",
      value: "x",
    },
    false,
  ],
  [{ kind: "file_present", file: "Documents/damaged.gnumeric" }, true],
];

const flyer = "Documents/flyer.sla";
const headline =
  "/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=Headline]";
const body =
  "/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=Body]";

/** Text joined from one attribute's values on an element and its descendants, its text nodes left out. */
const ATTRIBUTE_TEXT_CASES: readonly (readonly [
  DesktopTaskCheckInput,
  boolean,
])[] = [
  [
    {
      kind: "text_equals",
      file: flyer,
      pointer: headline,
      value: "Spring Fair",
      text_attribute: "CH",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: flyer,
      pointer: headline,
      value: "Spring Fete",
      text_attribute: "CH",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: flyer,
      pointer: headline,
      value: "typed",
      text_attribute: "CH",
    },
    false,
  ],
  [
    { kind: "text_equals", file: flyer, pointer: headline, value: "typed" },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: flyer,
      pointer: body,
      value: "Doors open at noon",
      text_attribute: "CH",
      normalize_whitespace: true,
    },
    true,
  ],
  [
    {
      kind: "text_contains",
      file: flyer,
      pointer: body,
      value: "open  at",
      text_attribute: "CH",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: plate,
      pointer: `${objects}/[name=Object][@name=Hole]`,
      value: "HoleRadius",
      text_attribute: "name",
    },
    true,
  ],
  [
    {
      kind: "text_equals",
      file: flyer,
      pointer: `${headline}/attributes/ANNAME`,
      value: "Headline",
      text_attribute: "CH",
    },
    false,
  ],
  [
    {
      kind: "text_equals",
      file: settings,
      pointer: "/tags",
      value: "ab",
      text_attribute: "CH",
    },
    false,
  ],
  [
    {
      kind: "text_contains",
      file: "Documents/cut.xml",
      pointer: "/root",
      value: "1",
      text_attribute: "id",
    },
    false,
  ],
];

const contacts = ".local/share/osmo/contacts_records.xml";
const ledger = "Documents/ledger.json";

/** Members named by a child element's text, its whitespace collapsed, alone or with other conditions. */
const CHILD_TEXT_CASES: readonly (readonly [DesktopTaskCheckInput, boolean])[] =
  [
    [
      {
        kind: "text_equals",
        file: contacts,
        pointer:
          "/root/children/[name=contact][>first_name=Bastien]/children/[name=last_name]",
        value: "Roy",
      },
      true,
    ],
    [
      {
        kind: "value_equals",
        file: contacts,
        pointer:
          "/root/children/[name=contact][>first_name=Delphine][>last_name=Abara]/children/1/children/0",
        value: "Abara",
      },
      true,
    ],
    [
      {
        kind: "value_absent",
        file: contacts,
        pointer: "/root/children/[name=contact][>first_name=Delphine]",
      },
      false,
    ],
    [
      {
        kind: "value_absent",
        file: contacts,
        pointer: "/root/children/[name=contact][>first_name=Zoe]",
      },
      true,
    ],
    [
      {
        kind: "value_absent",
        file: contacts,
        pointer: "/root/children/[name=contact][>first_name=Zoe]/children",
      },
      false,
    ],
    [
      {
        kind: "value_equals",
        file: contacts,
        pointer: "/root/children/[name=group][>first_name=Delphine]/name",
        value: "group",
      },
      true,
    ],
    [
      {
        kind: "value_absent",
        file: contacts,
        pointer: "/root/children/[>first_name]/name",
      },
      false,
    ],
    [
      {
        kind: "value_absent",
        file: settings,
        pointer: "/tags/[>a=a]",
      },
      true,
    ],
    [
      {
        kind: "value_absent",
        file: "Documents/cut.xml",
        pointer: "/root/children/[name=p][>q=x]",
      },
      false,
    ],
  ];

/** Counts of an array's members, every one or those a selector matches, decided only on an array the view holds whole. */
const MEMBER_COUNT_CASES: readonly (readonly [
  DesktopTaskCheckInput,
  boolean,
])[] = [
  [
    {
      kind: "member_count",
      file: contacts,
      pointer: "/root/children",
      matching: "[name=contact]",
      equals: 3,
    },
    true,
  ],
  [
    {
      kind: "member_count",
      file: contacts,
      pointer: "/root/children",
      matching: "[name=contact][>first_name=Delphine]",
      equals: 2,
    },
    true,
  ],
  [
    {
      kind: "member_count",
      file: contacts,
      pointer: "/root/children",
      matching: "[>first_name=Delphine]",
      at_most: 2,
    },
    false,
  ],
  [
    {
      kind: "member_count",
      file: meeting,
      pointer: `${paragraph("time")}/children`,
      equals: 5,
    },
    true,
  ],
  [
    {
      kind: "member_count",
      file: meeting,
      pointer: `${paragraph("time")}/children`,
      matching: "[name=c]",
      equals: 2,
    },
    true,
  ],
  [
    {
      kind: "member_count",
      file: settings,
      pointer: "/tags",
      at_least: 3,
    },
    false,
  ],
  [
    {
      kind: "member_count",
      file: plate,
      pointer: objects,
      matching: "[name=Object][@type=Part::Box]",
      equals: 2,
    },
    true,
  ],
  [
    { kind: "member_count", file: settings, pointer: "/size", equals: 0 },
    false,
  ],
  [
    { kind: "member_count", file: settings, pointer: "/missing", equals: 0 },
    false,
  ],
  [
    {
      kind: "member_count",
      file: contacts,
      pointer: "/root/children/[name=contact][>first_name=Zoe]/children",
      equals: 0,
    },
    false,
  ],
  [{ kind: "member_count", file: absent, pointer: "/x", equals: 0 }, false],
  [{ kind: "member_count", file: ledger, pointer: "", equals: 3 }, true],
  [
    {
      kind: "member_count",
      file: ledger,
      pointer: "",
      matching: "[payee=Grocer]",
      equals: 2,
    },
    true,
  ],
  [
    {
      kind: "member_count",
      file: ledger,
      pointer: "",
      matching: "[payee=Rent]",
      at_least: 2,
    },
    false,
  ],
  [{ kind: "member_count", file: settings, pointer: "", equals: 0 }, false],
  [
    {
      kind: "member_count",
      file: "Documents/cut.xml",
      pointer: "/root/children",
      at_least: 1,
    },
    false,
  ],
  [
    {
      kind: "member_count",
      file: "Documents/many.zip",
      pointer: "/entries",
      at_least: 1,
    },
    false,
  ],
  [
    {
      kind: "member_count",
      file: "Documents/listing.zip",
      pointer: "/entries/1/view/root/children",
      equals: 1,
    },
    false,
  ],
  [
    {
      kind: "member_count",
      file: "Documents/listing.zip",
      pointer: "/entries/0/view",
      equals: 1,
    },
    false,
  ],
];

/** Every kind of check against those views, each with the outcome both evaluators must give. */
export const CHECK_CASES: readonly (readonly [
  DesktopTaskCheckInput,
  boolean,
])[] = [
  [{ kind: "file_present", file: todo }, true],
  [{ kind: "file_present", file: absent }, false],
  [{ kind: "file_absent", file: absent }, true],
  [{ kind: "file_absent", file: "Documents/huge.txt" }, false],
  [
    { kind: "lines_present", file: todo, lines: ["buy milk", "naïve café"] },
    true,
  ],
  [{ kind: "lines_present", file: todo, lines: ["buy eggs"] }, false],
  [{ kind: "lines_present", file: absent, lines: ["x"] }, false],
  [{ kind: "lines_present", file: settings, lines: ["x"] }, false],
  [{ kind: "lines_present", file: "Documents/long.txt", lines: ["a"] }, true],
  [{ kind: "lines_absent", file: todo, lines: ["buy eggs"] }, true],
  [
    { kind: "lines_absent", file: todo, lines: ["buy eggs", "buy bread"] },
    false,
  ],
  [{ kind: "lines_absent", file: "Documents/long.txt", lines: ["z"] }, false],
  [{ kind: "lines_absent", file: absent, lines: ["x"] }, true],
  [{ kind: "lines_absent", file: "Documents/huge.txt", lines: ["x"] }, false],
  [{ kind: "line_count", file: todo, exact: "buy milk", equals: 2 }, true],
  [{ kind: "line_count", file: todo, exact: "buy milk", at_least: 3 }, false],
  [{ kind: "line_count", file: todo, exact: "buy milk", at_most: 2 }, true],
  [{ kind: "line_count", file: todo, contains: "buy", equals: 3 }, true],
  [{ kind: "line_count", file: todo, contains: "MILK", equals: 0 }, true],
  [{ kind: "line_count", file: todo, contains: "IRCL", equals: 1 }, true],
  [{ kind: "line_count", file: todo, contains: "ïve caf", equals: 1 }, true],
  [{ kind: "line_count", file: todo, contains: "milk", at_least: 3 }, false],
  [{ kind: "line_count", file: todo, contains: "(a+)+$", equals: 0 }, true],
  [
    { kind: "line_count", file: "Documents/long.txt", exact: "a", at_least: 1 },
    false,
  ],
  [{ kind: "line_count", file: absent, exact: "x", equals: 0 }, true],
  [
    {
      kind: "value_equals",
      file: ".config/notes/layout.xml",
      pointer: "/root/attributes/width",
      value: "80",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: ".config/notes/layout.xml",
      pointer: "/root/attributes",
      value: { width: "80" },
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: ".local/share/notes/notes.db",
      pointer: "/tables/big/rows",
      value: [[1]],
    },
    false,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/wrap", value: true },
    true,
  ],
  [{ kind: "value_equals", file: settings, pointer: "/wrap", value: 1 }, false],
  [
    { kind: "value_equals", file: settings, pointer: "/zero", value: false },
    false,
  ],
  [{ kind: "value_equals", file: settings, pointer: "/size", value: 12 }, true],
  [
    { kind: "value_equals", file: settings, pointer: "/ratio", value: 0.5 },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: settings,
      pointer: "/tags",
      value: ["a", "b"],
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: settings,
      pointer: "/tags",
      value: ["b", "a"],
    },
    false,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/tags/1", value: "b" },
    true,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/tags/01", value: "b" },
    false,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/a~1b/~0k", value: null },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: settings,
      pointer: "/a~1b",
      value: { "~k": null },
    },
    true,
  ],
  [
    { kind: "value_equals", file: settings, pointer: "/a~1b", value: {} },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: ".config/notes/app.ini",
      pointer: "/groups/ui/wrap",
      value: "false",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: db,
      pointer: "/tables/notes/rows/1/1",
      value: "b",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: ".config/notes/layout.xml",
      pointer: "/root/attributes/width",
      value: "80",
    },
    true,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/photo.png",
      pointer: "/x",
      value: 1,
    },
    false,
  ],
  [
    {
      kind: "value_equals",
      file: "Documents/huge.txt",
      pointer: "/x",
      value: 1,
    },
    false,
  ],
  [{ kind: "value_absent", file: settings, pointer: "/missing" }, true],
  [{ kind: "value_absent", file: settings, pointer: "/tags/2" }, true],
  [{ kind: "value_absent", file: settings, pointer: "/wrap" }, false],
  [{ kind: "value_absent", file: absent, pointer: "/x" }, true],
  [
    {
      kind: "value_absent",
      file: ".config/notes/layout.xml",
      pointer: "/root/attributes/height",
    },
    false,
  ],
  [
    {
      kind: "row_present",
      file: db,
      table: "notes",
      where: { body: "b", done: 1 },
    },
    true,
  ],
  [
    {
      kind: "row_present",
      file: db,
      table: "notes",
      where: { body: "b", done: true },
    },
    false,
  ],
  [
    { kind: "row_present", file: db, table: "notes", where: { body: "c" } },
    false,
  ],
  [
    { kind: "row_present", file: db, table: "notes", where: { colour: "red" } },
    false,
  ],
  [{ kind: "row_present", file: db, table: "broken", where: { id: 1 } }, false],
  [{ kind: "row_present", file: db, table: "big", where: { id: 1 } }, true],
  [
    {
      kind: "row_present",
      file: ".local/share/notes/cut.db",
      table: "notes",
      where: { id: 1 },
    },
    false,
  ],
  [
    { kind: "row_present", file: todo, table: "notes", where: { id: 1 } },
    false,
  ],
  [
    { kind: "row_absent", file: db, table: "notes", where: { body: "c" } },
    true,
  ],
  [{ kind: "row_absent", file: db, table: "notes", where: { id: 1 } }, false],
  [{ kind: "row_absent", file: db, table: "big", where: { id: 9 } }, false],
  [{ kind: "row_absent", file: db, table: "gone", where: { id: 1 } }, true],
  [
    { kind: "row_absent", file: absent, table: "notes", where: { id: 1 } },
    true,
  ],
  [{ kind: "row_count", file: db, table: "notes", equals: 2 }, true],
  [
    {
      kind: "row_count",
      file: db,
      table: "notes",
      where: { done: 1 },
      equals: 1,
    },
    true,
  ],
  [{ kind: "row_count", file: db, table: "notes", at_least: 3 }, false],
  [{ kind: "row_count", file: db, table: "big", at_least: 1 }, false],
  [{ kind: "row_count", file: absent, table: "notes", equals: 0 }, true],
  ...SELECTOR_CASES,
  ...TOLERANCE_CASES,
  ...TEXT_CASES,
  ...CUT_VIEW_CASES,
  ...GZIP_CASES,
  ...ATTRIBUTE_TEXT_CASES,
  ...CHILD_TEXT_CASES,
  ...MEMBER_COUNT_CASES,
];
