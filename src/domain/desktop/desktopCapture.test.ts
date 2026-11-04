import { describe, expect, it } from "vitest";

import { checkpointNameRefusal } from "./desktopCapture.js";

describe("checkpointNameRefusal", () => {
  it("accepts an omitted name and a new one", () => {
    expect(checkpointNameRefusal(undefined, new Set(["saved"]))).toBe(
      undefined,
    );
    expect(checkpointNameRefusal("checkpoint-2", new Set(["saved"]))).toBe(
      undefined,
    );
  });

  it("refuses empty, reserved and repeated names", () => {
    expect(checkpointNameRefusal("", new Set())).toMatch(/empty/u);
    for (const name of ["baseline", "stop", "time-limit", "exit"])
      expect(checkpointNameRefusal(name, new Set())).toMatch(/reserved/u);
    expect(checkpointNameRefusal("saved", new Set(["saved"]))).toMatch(
      /already recorded/u,
    );
  });
});
