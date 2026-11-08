import { describe, expect, it } from "vitest";

import { parseDesktopTask } from "./appTask.js";
import {
  evaluateTaskChecks,
  type TaskCheckOutcome,
  type TaskFileView,
} from "./appTaskChecks.js";
import { CHECK_CASES, CHECK_VIEWS } from "./appTaskChecks.fixture.js";
import { textView } from "./stateFormats.js";

const portable = (name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name);

/** A value as a description shows it: caller data and what the view holds, as JSON. */
const quoted = (value: unknown) => JSON.stringify(value);

/** An outcome's id, result and undecided mark exactly, and the facts its description reports in any wording. */
const expectOutcome = (
  found: TaskCheckOutcome | undefined,
  decision: Omit<TaskCheckOutcome, "description">,
  facts: readonly string[],
) => {
  const { description, ...decided } = found ?? { description: undefined };
  expect(decided).toEqual(decision);
  for (const fact of facts) expect(description).toContain(fact);
};

const task = (checks: readonly unknown[]) =>
  parseDesktopTask(
    { name: "edit-notes", prompt: "Edit my notes.", checks },
    portable,
  );

/** Task changes the parser refuses, each with part of its message. */
const REFUSALS: readonly (readonly [Record<string, unknown>, string])[] = [
  [{ name: "Add Milk" }, 'name "Add Milk" must be a portable bundle name'],
  [{ name: "smoke" }, "other than smoke"],
  [
    {
      prompt:
        "REPLACE: what the user asks to have done in the app, in their own words.",
    },
    "placeholder",
  ],
  [{ checks: [{ kind: "lines_exist", file: "a" }] }, "at checks.0.kind"],
  [{ checks: [{ kind: "file_present", file: "a", extra: 1 }] }, "at checks.0"],
  [
    {
      checks: [
        { id: "x", kind: "file_present", file: "a" },
        { id: "x", kind: "file_absent", file: "b" },
      ],
    },
    'two checks have the id "x"',
  ],
  [
    { checks: [{ kind: "file_present", file: "/home/ada/a" }] },
    "without a leading slash",
  ],
  [
    { checks: [{ kind: "file_present", file: "Documents/../a" }] },
    "without a leading slash",
  ],
  [
    { checks: [{ kind: "lines_present", file: "a", lines: ["x", "x"] }] },
    "lists a line twice",
  ],
  [
    { checks: [{ kind: "lines_present", file: "a", lines: ["x\ny"] }] },
    "line break",
  ],
  [
    {
      checks: [
        {
          kind: "line_count",
          file: "a",
          exact: "x",
          contains: "x",
          equals: 1,
        },
      ],
    },
    "exactly one of exact and contains",
  ],
  [
    { checks: [{ kind: "line_count", file: "a", exact: "x" }] },
    "exactly one of equals, at_least and at_most",
  ],
  [
    {
      checks: [
        { kind: "row_count", file: "a", table: "t", equals: 1, at_most: 2 },
      ],
    },
    "exactly one of equals, at_least and at_most",
  ],
  [
    { checks: [{ kind: "line_count", file: "a", regex: "(a+)+$", equals: 1 }] },
    "regex",
  ],
  [
    { checks: [{ kind: "value_equals", file: "a", pointer: "", value: 1 }] },
    "the empty pointer names the whole file",
  ],
  [
    { checks: [{ kind: "value_absent", file: "a", pointer: "wrap" }] },
    "must start with /",
  ],
  [
    {
      checks: [
        {
          kind: "value_equals",
          file: "a",
          pointer: "/saved",
          value: "2026-11-04T10:12:00Z",
        },
      ],
    },
    "looks like a time the app stamps",
  ],
  [
    {
      checks: [
        {
          kind: "text_equals",
          file: "a",
          pointer: "/m",
          value: "Thu Nov  5 22:03:14 2026\n",
        },
      ],
    },
    "looks like a time the app stamps",
  ],
  [
    {
      checks: [
        {
          kind: "row_present",
          file: "a",
          table: "t",
          where: { saved: "Mon Jan 12 07:00:00 2026" },
        },
      ],
    },
    "looks like a time the app stamps",
  ],
  [
    {
      checks: [
        {
          kind: "row_present",
          file: "a",
          table: "t",
          where: { at: "2026-11-04 10:12:00.123" },
        },
      ],
    },
    "looks like a time the app stamps",
  ],
  [
    { checks: [{ kind: "row_present", file: "a", table: "t", where: {} }] },
    "name at least one column",
  ],
  [
    {
      checks: [
        {
          kind: "value_equals",
          file: "a",
          pointer: "/x",
          value: "5",
          tolerance: 0.1,
        },
      ],
    },
    "tolerance compares numbers, so value must be a number",
  ],
  [
    {
      checks: [
        {
          kind: "value_equals",
          file: "a",
          pointer: "/x",
          value: 5,
          tolerance: -1,
        },
      ],
    },
    "at checks.0.tolerance",
  ],
  [
    { checks: [{ kind: "text_equals", file: "a", pointer: "", value: "x" }] },
    "the empty pointer names the whole file",
  ],
  [
    {
      checks: [{ kind: "text_contains", file: "a", pointer: "p", value: "x" }],
    },
    "must start with /",
  ],
  [
    {
      checks: [{ kind: "text_contains", file: "a", pointer: "/p", value: "" }],
    },
    "at checks.0.value",
  ],
  [
    {
      checks: [
        {
          kind: "text_contains",
          file: "a",
          pointer: "/p",
          value: " \n",
          normalize_whitespace: true,
        },
      ],
    },
    "text_contains",
  ],
  [
    {
      checks: [
        {
          kind: "text_equals",
          file: "a",
          pointer: "/p",
          value: "2026-11-04T10:12:00Z",
        },
      ],
    },
    "looks like a time the app stamps",
  ],
  [
    {
      checks: [
        {
          kind: "text_equals",
          file: "a",
          pointer: "/p",
          value: "x",
          normalize_whitespace: "yes",
        },
      ],
    },
    "at checks.0.normalize_whitespace",
  ],
];

describe("evaluateTaskChecks", () => {
  it("decides every kind of check by its own rule, an absent file reading as empty", () => {
    expect(
      CHECK_CASES.filter(([check]) => !task([check]).ok).map(
        ([check]) => check,
      ),
    ).toEqual([]);
    const checks = CHECK_CASES.map(([check], index) => ({
      ...check,
      id: `check-${String(index + 1)}`,
    }));

    const outcomes = evaluateTaskChecks(
      checks,
      new Map(Object.entries(CHECK_VIEWS)),
    );

    expect(outcomes.map(({ id, passed }) => [id, passed])).toEqual(
      CHECK_CASES.map(([, expected], index) => [
        `check-${String(index + 1)}`,
        expected,
      ]),
    );
    expect(outcomes[11]?.description).toBe(
      "the view of Documents/long.txt is truncated, so what it leaves out is unknown",
    );
    expect(outcomes[15]?.description).toBe(
      '2 line(s) of Documents/todo.txt match "buy milk", expected at least 3',
    );
  });

  it("marks a failure for want of a readable or whole view as undecided, apart from what a view shows", () => {
    const outcomes = evaluateTaskChecks(
      [
        {
          id: "unread",
          kind: "lines_absent",
          file: "Documents/huge.txt",
          lines: ["x"],
        },
        {
          id: "table",
          kind: "row_present",
          file: ".local/share/notes/notes.db",
          table: "broken",
          where: { id: 1 },
        },
        {
          id: "cut",
          kind: "lines_absent",
          file: "Documents/long.txt",
          lines: ["z"],
        },
        {
          id: "shown",
          kind: "lines_present",
          file: "Documents/todo.txt",
          lines: ["x"],
        },
        {
          id: "binary",
          kind: "lines_present",
          file: "Documents/photo.png",
          lines: ["x"],
        },
      ] as never,
      new Map(Object.entries(CHECK_VIEWS)),
    );
    expect(
      outcomes.map(({ id, passed, undecided }) => [id, passed, undecided]),
    ).toEqual([
      ["unread", false, true],
      ["table", false, true],
      ["cut", false, true],
      ["shown", false, undefined],
      ["binary", false, undefined],
    ]);
  });
});

describe("evaluateTaskChecks on cut views", () => {
  const note = (index: number) => `note ${String(index + 1)}`;
  const notes = Array.from({ length: 6000 }, (_, index) => note(index));
  const rows = (count: number) =>
    Array.from({ length: count }, (_, index) => [index + 1, note(index)]);
  const views = new Map<string, TaskFileView>([
    ["notes.txt", { format: "text", view: textView(notes.join("\n")) }],
    [
      "notes.db",
      {
        format: "sqlite",
        view: {
          tables: {
            entries: {
              columns: ["id", "body"],
              primary_key: ["id"],
              rows: rows(500),
              truncated: true,
            },
          },
          tables_truncated: false,
        },
      },
    ],
    [
      "page.xml",
      {
        format: "xml",
        view: {
          root: { name: "doc", attributes: {}, children: ["kept"] },
          truncated: true,
        },
      },
    ],
    [
      "notes.zip",
      {
        format: "zip",
        view: { entries: [], entry_count: 1200, truncated: true },
      },
    ],
  ]);
  const outcome = (check: Record<string, unknown>) =>
    evaluateTaskChecks([{ id: "c", ...check } as never], views)[0];

  it("leaves lines_present undecided on a line past the 5,000 a text view keeps, and decided on one it keeps", () => {
    expectOutcome(
      outcome({
        kind: "lines_present",
        file: "notes.txt",
        lines: ["note 5500"],
      }),
      { id: "c", passed: false, undecided: true },
      ["notes.txt", quoted("note 5500")],
    );
    expectOutcome(
      outcome({
        kind: "lines_present",
        file: "notes.txt",
        lines: ["note 5000"],
      }),
      { id: "c", passed: true },
      ["notes.txt", quoted("note 5000")],
    );
  });

  it("leaves row_present undecided on a row past those a table's view keeps, and decided on one it keeps", () => {
    expectOutcome(
      outcome({
        kind: "row_present",
        file: "notes.db",
        table: "entries",
        where: { id: 501 },
      }),
      { id: "c", passed: false, undecided: true },
      ["notes.db", "entries", quoted({ id: 501 })],
    );
    expectOutcome(
      outcome({
        kind: "row_present",
        file: "notes.db",
        table: "entries",
        where: { id: 500 },
      }),
      { id: "c", passed: true },
      ["notes.db", "entries", quoted({ id: 500 })],
    );
  });

  it("leaves value_equals undecided where its pointer names nothing in a cut view, and decided on a value it keeps", () => {
    for (const [file, pointer] of [
      ["notes.txt", "/lines/5499"],
      ["notes.db", "/tables/entries/rows/500/1"],
      ["page.xml", "/root/children/1"],
      ["notes.zip", "/entries/1100/name"],
    ] as const)
      expectOutcome(
        outcome({ kind: "value_equals", file, pointer, value: "note 5500" }),
        { id: "c", passed: false, undecided: true },
        [file, pointer],
      );
    expectOutcome(
      outcome({
        kind: "value_equals",
        file: "notes.txt",
        pointer: "/lines/0",
        value: "note 2",
      }),
      { id: "c", passed: false },
      ["notes.txt", "/lines/0", quoted("note 1"), quoted("note 2")],
    );
  });
});

describe("evaluateTaskChecks selectors and tolerance", () => {
  const plate = "Documents/plate.FCStd";
  const objects = "/entries/[name=Document.xml]/view/root/children";
  const outcome = (check: Record<string, unknown>) =>
    evaluateTaskChecks(
      [{ id: "c", file: plate, ...check } as never],
      new Map(Object.entries(CHECK_VIEWS)),
    )[0];

  it("leaves a selector undecided where the array it searches may be cut short, and a position decided", () => {
    const listing = "Documents/listing.zip";
    const cut = { id: "c", passed: false, undecided: true } as const;

    expectOutcome(
      outcome({
        kind: "value_equals",
        file: listing,
        pointer: "/entries/[name=a.json]/view/x",
        value: 1,
      }),
      cut,
      [listing],
    );
    expectOutcome(
      outcome({
        kind: "value_equals",
        file: listing,
        pointer: "/entries/1/view/root/children/[name=p]/attributes/id",
        value: "1",
      }),
      cut,
      [listing],
    );
    expect(
      outcome({
        kind: "value_equals",
        file: listing,
        pointer: "/entries/0/view/x",
        value: 1,
      })?.passed,
    ).toBe(true);
  });

  it("fails a check into an entry's view that could not be read, where JSON null passes", () => {
    expectOutcome(
      outcome({
        kind: "value_equals",
        pointer: "/entries/[name=huge.brp]/view",
        value: null,
      }),
      { id: "c", passed: false, undecided: true },
      [plate, "huge.brp", "larger than the 16 MiB an entry's view reads"],
    );
    expect(
      outcome({
        kind: "value_equals",
        pointer: "/entries/[name=empty.json]/view",
        value: null,
      })?.passed,
    ).toBe(true);
    expectOutcome(
      outcome({
        kind: "value_equals",
        pointer: "/entries/[name=thumbnails~1Thumbnail.png]/view",
        value: null,
      }),
      { id: "c", passed: false },
      [plate, "thumbnails/Thumbnail.png", "binary"],
    );
  });

  it("fails a selector that matches several members or, on the way, none, and says which", () => {
    const boxes = `${objects}/[name=Object][@type=Part::Box]/attributes/name`;

    expectOutcome(
      outcome({ kind: "value_equals", pointer: boxes, value: "Plate" }),
      { id: "c", passed: false },
      [plate, boxes, "2"],
    );
    expect(
      outcome({
        kind: "value_absent",
        pointer: `${objects}/[name=Object][@name=Gone]/attributes/type`,
      })?.description,
    ).toMatch(/: \[name=Object\]\[@name=Gone\] matches no member$/u);
    expect(
      outcome({
        kind: "value_equals",
        pointer: `${objects}/[name=Object][@name=Gone]`,
        value: 1,
      })?.description,
    ).toMatch(/matches no member$/u);
    expect(
      outcome({
        kind: "value_equals",
        pointer: `${objects}/[Object]`,
        value: 1,
      })?.description,
    ).toMatch(/: \[Object\] is not a selector of the form \[KEY=VALUE\]$/u);
  });

  it("compares numbers and numeral strings within a tolerance, and nothing else", () => {
    const radius = `${objects}/[name=Object][@name=Hole]/children/[name=Property][@name=Radius]/children/[name=Float]/attributes/value`;

    expectOutcome(
      outcome({
        kind: "value_equals",
        pointer: radius,
        value: 5.1,
        tolerance: 0.01,
      }),
      { id: "c", passed: false },
      [plate, radius, quoted("5.0000000000000000"), "0.01", "5.1"],
    );
    expect(
      outcome({
        kind: "value_equals",
        pointer: `${objects}/[name=Object][@name=Hole]/attributes/type`,
        value: 5,
        tolerance: 1,
      })?.description,
    ).toMatch(/is "Part::Cylinder", not a number$/u);
  });
});

describe("evaluateTaskChecks whole text", () => {
  const outcome = (check: Record<string, unknown>) =>
    evaluateTaskChecks(
      [{ id: "c", ...check } as never],
      new Map(Object.entries(CHECK_VIEWS)),
    )[0];
  const meeting = "Documents/meeting.xml";
  const plate = "Documents/plate.FCStd";
  const time = "/root/children/[name=p][@id=time]";
  /** A value as a description shows it: caller data and what the view holds, as JSON. */
  const quoted = (value: unknown) => JSON.stringify(value);
  const expectFacts = (
    found: { passed: boolean; description: string } | undefined,
    passed: boolean,
    facts: readonly string[],
  ) => {
    expect(found?.passed).toBe(passed);
    for (const fact of facts) expect(found?.description).toContain(fact);
  };

  it("reports the text an element has, its runs joined, beside the value it was compared with", () => {
    expectFacts(
      outcome({
        kind: "text_equals",
        file: meeting,
        pointer: time,
        value: "Starts at 3:45 today.",
      }),
      false,
      [
        meeting,
        time,
        quoted("Starts at 3:30 today."),
        quoted("Starts at 3:45 today."),
      ],
    );
    expectFacts(
      outcome({
        kind: "text_contains",
        file: meeting,
        pointer: time,
        value: "3:45",
      }),
      false,
      [quoted("Starts at 3:30 today."), quoted("3:45")],
    );
    const collapsed = outcome({
      kind: "text_contains",
      file: meeting,
      pointer: "/root/children/[name=p][@id=spaced]",
      value: "Doors  open",
      normalize_whitespace: true,
    });
    expectFacts(collapsed, true, [quoted("Doors open")]);
    expect(collapsed?.description).not.toContain(quoted("Doors  open"));
  });

  it("reads only an XML element, a text node or an attribute value, and names what it reached instead", () => {
    const refused: readonly (readonly [Record<string, unknown>, string[]])[] = [
      [
        { file: ".config/notes/settings.json", pointer: "/tags/0", value: "a" },
        [".config/notes/settings.json", "json"],
      ],
      [
        { file: meeting, pointer: "/root/attributes", value: "en" },
        ["/root/attributes", quoted({ lang: "en" })],
      ],
      [
        { file: meeting, pointer: "/root/name", value: "doc" },
        ["/root/name", quoted("doc")],
      ],
      [
        { file: meeting, pointer: "/doctype/system_id", value: "meeting.dtd" },
        ["/doctype/system_id", quoted("meeting.dtd")],
      ],
      [
        {
          file: plate,
          pointer: "/entries/[name=empty.json]/view/x",
          value: "x",
        },
        ["empty.json", "json"],
      ],
      [
        { file: plate, pointer: "/entries/0/name", value: "Document.xml" },
        ["/entries/0/name"],
      ],
    ];

    for (const [check, facts] of refused)
      expectFacts(outcome({ kind: "text_equals", ...check }), false, facts);
  });

  it("leaves an element of a truncated view undecided as a value check is, while a text node there is decided", () => {
    const cut = "Documents/cut.xml";

    expect(
      outcome({
        kind: "text_equals",
        file: cut,
        pointer: "/root/children/0",
        value: "",
      }),
    ).toEqual(
      outcome({
        kind: "value_absent",
        file: cut,
        pointer: "/root/attributes/x",
      }),
    );
    expect(
      outcome({
        kind: "value_absent",
        file: cut,
        pointer: "/root/attributes/x",
      })?.passed,
    ).toBe(false);
    expect(
      outcome({
        kind: "text_equals",
        file: cut,
        pointer: "/root/children/1",
        value: "kept",
      })?.passed,
    ).toBe(true);
    const missing = outcome({
      kind: "text_contains",
      file: cut,
      pointer: "/root/children/2",
      value: "later",
    });
    expect(missing?.passed).toBe(false);
    expect(missing?.undecided).toBe(true);
    expect(missing?.description).toBe(
      "the view of Documents/cut.xml is truncated, so what it leaves out is unknown",
    );
    const zipped = outcome({
      kind: "text_equals",
      file: "Documents/listing.zip",
      pointer: "/entries/1/view/root/children/2",
      value: "later",
    });
    expect(zipped?.passed).toBe(false);
    expect(zipped?.undecided).toBe(true);
  });
});

describe("parseDesktopTask", () => {
  it("settles ids and keeps the prompt trimmed", () => {
    const parsed = parseDesktopTask(
      {
        name: "add-milk",
        prompt: "  Add milk.\n",
        checks: [
          { kind: "file_present", file: "Documents/todo.txt" },
          {
            id: "milk",
            kind: "lines_present",
            file: "Documents/todo.txt",
            lines: ["milk"],
          },
        ],
      },
      portable,
    );

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        prompt: "Add milk.",
        checks: [{ id: "check-1" }, { id: "milk" }],
      },
    });
  });

  it.each(REFUSALS)("refuses %j", (change, message) => {
    const parsed = parseDesktopTask(
      {
        name: "add-milk",
        prompt: "Add milk.",
        checks: [{ kind: "file_present", file: "a" }],
        ...change,
      },
      portable,
    );

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
});
