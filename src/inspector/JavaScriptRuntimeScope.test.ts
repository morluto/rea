import { describe, expect, it } from "vitest";

import {
  authorizeRuntimeLocation,
  inspectorExclusionKey,
} from "./JavaScriptRuntimeScope.js";

describe("runtime location authorization", () => {
  it("reports canonical exclusion reasons per denial case", async () => {
    expect(await authorizeRuntimeLocation("not a url")).toEqual({
      allowed: false,
      reason: "unsupported_url",
    });
    expect(await authorizeRuntimeLocation("ftp://example.test/app.js")).toEqual(
      {
        allowed: false,
        reason: "unsupported_url",
      },
    );
    expect(
      await authorizeRuntimeLocation("file:///outside-approved-scope.js"),
    ).toEqual({ allowed: false, reason: "not_approved" });
  });

  it("collapses every canonical denial onto the fixed wire bucket", () => {
    expect(inspectorExclusionKey("unsupported_url")).toBe(
      "unsupported_location",
    );
    expect(inspectorExclusionKey("not_approved")).toBe("unsupported_location");
    expect(inspectorExclusionKey("disallowed_origin")).toBe(
      "unsupported_location",
    );
  });
});
