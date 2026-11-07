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
  });
});
