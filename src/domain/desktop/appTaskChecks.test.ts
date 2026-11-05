import { describe, expect, it } from "vitest";

import { parseDesktopTask } from "./appTask.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
import { CHECK_CASES, CHECK_VIEWS } from "./appTaskChecks.fixture.js";

const portable = (name: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name);

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
    "text_contains needs a value with more than whitespace in it",
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
    const cut =
      "the view of Documents/listing.zip is truncated, so what it leaves out is unknown";

    expect(
      outcome({
        kind: "value_equals",
        file: "Documents/listing.zip",
        pointer: "/entries/[name=a.json]/view/x",
        value: 1,
      }),
    ).toEqual({ id: "c", passed: false, description: cut });
    expect(
      outcome({
        kind: "value_equals",
        file: "Documents/listing.zip",
        pointer: "/entries/1/view/root/children/[name=p]/attributes/id",
        value: "1",
      }),
    ).toEqual({ id: "c", passed: false, description: cut });
    expect(
      outcome({
        kind: "value_equals",
        file: "Documents/listing.zip",
        pointer: "/entries/0/view/x",
        value: 1,
      })?.passed,
    ).toBe(true);
  });

  it("fails a check into an entry's view that could not be read, where JSON null passes", () => {
    expect(
      outcome({
        kind: "value_equals",
        pointer: "/entries/[name=huge.brp]/view",
        value: null,
      }),
    ).toEqual({
      id: "c",
      passed: false,
      description:
        "Documents/plate.FCStd entry huge.brp has no view: larger than the 16 MiB an entry's view reads",
    });
    expect(
      outcome({
        kind: "value_equals",
        pointer: "/entries/[name=empty.json]/view",
        value: null,
      })?.passed,
    ).toBe(true);
    expect(
      outcome({
        kind: "value_equals",
        pointer: "/entries/[name=thumbnails~1Thumbnail.png]/view",
        value: null,
      }),
    ).toEqual({
      id: "c",
      passed: false,
      description:
        "Documents/plate.FCStd entry thumbnails/Thumbnail.png is binary and has no view",
    });
  });

  it("fails a selector that matches several members or, on the way, none, and says which", () => {
    expect(
      outcome({
        kind: "value_equals",
        pointer: `${objects}/[name=Object][@type=Part::Box]/attributes/name`,
        value: "Plate",
      }),
    ).toMatchObject({
      passed: false,
      description: `${plate} at ${objects}/[name=Object][@type=Part::Box]/attributes/name: [name=Object][@type=Part::Box] matches 2 members, not one`,
    });
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

    expect(
      outcome({
        kind: "value_equals",
        pointer: radius,
        value: 5.1,
        tolerance: 0.01,
      })?.description,
    ).toBe(
      `${plate} at ${radius} is "5.0000000000000000", not within 0.01 of 5.1`,
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
    )[0]?.description;
  const meeting = "Documents/meeting.xml";
  const time = "/root/children/[name=p][@id=time]";

  it("says what text an element has, its runs joined, and how it was compared", () => {
    expect(
      outcome({
        kind: "text_equals",
        file: meeting,
        pointer: time,
        value: "Starts at 3:45 today.",
      }),
    ).toBe(
      `${meeting} at ${time} has the text "Starts at 3:30 today.", not "Starts at 3:45 today."`,
    );
    expect(
      outcome({
        kind: "text_contains",
        file: meeting,
        pointer: "/root/children/[name=p][@id=spaced]",
        value: "Doors  open",
        normalize_whitespace: true,
      }),
    ).toBe(
      `${meeting} at /root/children/[name=p][@id=spaced] has text containing "Doors open" with whitespace collapsed`,
    );
    expect(
      outcome({
        kind: "text_contains",
        file: meeting,
        pointer: time,
        value: "3:45",
      }),
    ).toBe(
      `${meeting} at ${time} has the text "Starts at 3:30 today.", without "3:45"`,
    );
  });

  it("reads only XML elements and their text, and leaves an element of a truncated view undecided", () => {
    expect(
      outcome({
        kind: "text_equals",
        file: ".config/notes/settings.json",
        pointer: "/tags/0",
        value: "a",
      }),
    ).toBe(".config/notes/settings.json is read as json, not xml");
    expect(
      outcome({
        kind: "text_equals",
        file: meeting,
        pointer: "/root/attributes",
        value: "en",
      }),
    ).toBe(
      `${meeting} at /root/attributes is {"lang":"en"}, not an element or its text`,
    );
    expect(
      outcome({
        kind: "text_equals",
        file: "Documents/plate.FCStd",
        pointer: "/entries/[name=empty.json]/view/x",
        value: "x",
      }),
    ).toBe("Documents/plate.FCStd entry empty.json is read as json, not xml");
    expect(
      outcome({
        kind: "text_equals",
        file: "Documents/plate.FCStd",
        pointer: "/entries/0/name",
        value: "Document.xml",
      }),
    ).toBe(
      "Documents/plate.FCStd at /entries/0/name does not point into an entry's view",
    );
    expect(
      outcome({
        kind: "text_equals",
        file: "Documents/cut.xml",
        pointer: "/root/children/0",
        value: "",
      }),
    ).toBe(
      "the view of Documents/cut.xml is truncated, so what it leaves out is unknown",
    );
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
