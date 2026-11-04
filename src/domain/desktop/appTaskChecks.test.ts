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
