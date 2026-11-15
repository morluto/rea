import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { cutterBridgeSource } from "./CutterBridgeSource.js";

const packaged = new URL("../../bridge/cutter/rea_bridge.py", import.meta.url);
const packagedSha256 = createHash("sha256")
  .update(readFileSync(packaged))
  .digest("hex");

it("classifies a session's plugin against the packaged plugin bytes", () => {
  expect(cutterBridgeSource(packagedSha256, "list_cutter_sessions")).toBe(
    "packaged",
  );
  expect(cutterBridgeSource("0".repeat(64), "list_cutter_sessions")).toBe(
    "modified",
  );
  expect(cutterBridgeSource(undefined, "list_cutter_sessions")).toBe("unknown");
  expect(cutterBridgeSource(null, "list_cutter_sessions")).toBe("unknown");
});

it("reports an unreadable packaged plugin as REA's own typed failure", () => {
  const missing = new URL("./missing-rea-bridge.py", import.meta.url);

  expect(() =>
    cutterBridgeSource("0".repeat(64), "list_cutter_sessions", missing),
  ).toThrow(
    expect.objectContaining({
      _tag: "AnalysisCapabilityUnavailableError",
      operation: "list_cutter_sessions",
      remediationAction: expect.stringContaining("Reinstall REA"),
    }),
  );
  expect(
    cutterBridgeSource(undefined, "list_cutter_sessions", missing),
    "a plugin without a digest needs no packaged comparison",
  ).toBe("unknown");
});
