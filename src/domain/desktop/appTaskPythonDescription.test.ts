import { describe, expect, it } from "vitest";

import type { DesktopTask } from "./appTask.js";
import { renderTaskVerifier, sameTaskVerifier } from "./appTaskPython.js";

const task: DesktopTask = {
  name: "add-eggs",
  prompt: "Add eggs to today's list.",
  checks: [
    {
      id: "eggs",
      kind: "text_contains",
      file: "Documents/today.txt",
      pointer: "/root",
      value: "eggs",
    },
  ],
};

describe("sameTaskVerifier", () => {
  it("accepts an older evaluator of the same checks and rejects a different task", () => {
    const hosted = renderTaskVerifier(task, "notes");
    const older = hosted.replace(
      'INDEX = re.compile(r"0|[1-9][0-9]*")',
      'INDEX = re.compile(r"[0-9]+")',
    );

    expect(older).not.toBe(hosted);
    expect(sameTaskVerifier(hosted, older)).toBe(true);
    expect(sameTaskVerifier(hosted, hosted.replace('"eggs"', '"milk"'))).toBe(
      false,
    );
    expect(
      sameTaskVerifier(hosted, older.replace("def _shown", "def _show")),
    ).toBe(false);
    expect(
      sameTaskVerifier(
        hosted,
        hosted.replace(/\nasync def verify[\s\S]*$/u, "\n"),
      ),
    ).toBe(false);
  });

  it("rejects the older index helper when a path segment has a leading zero", () => {
    const indexed: DesktopTask = {
      ...task,
      checks: [
        {
          id: "line",
          kind: "value_absent",
          file: "Documents/today.txt",
          pointer: "/lines/01",
        },
      ],
    };
    const hosted = renderTaskVerifier(indexed, "notes");
    const older = hosted.replace(
      'INDEX = re.compile(r"0|[1-9][0-9]*")',
      'INDEX = re.compile(r"[0-9]+")',
    );

    expect(sameTaskVerifier(hosted, older)).toBe(false);
    expect(sameTaskVerifier(hosted, hosted)).toBe(true);
  });

  it("accepts the older index helper when a leading zero is only in a file name or a URL", () => {
    const named: DesktopTask = {
      ...task,
      checks: [
        {
          id: "guide",
          kind: "text_contains",
          file: "Documents/01-notes.xml",
          pointer: "/root",
          value: "https://example.com/01-guide",
        },
      ],
    };
    const hosted = renderTaskVerifier(named, "notes");
    const older = hosted.replace(
      'INDEX = re.compile(r"0|[1-9][0-9]*")',
      'INDEX = re.compile(r"[0-9]+")',
    );

    expect(sameTaskVerifier(hosted, older)).toBe(true);
  });
});
