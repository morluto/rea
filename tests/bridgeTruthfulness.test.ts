import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const bridgeSource = await readFile(
  new URL("../bridge/hopper_bridge.py", import.meta.url),
  "utf8",
);

describe("Hopper bridge truthfulness", () => {
  it("marks unavailable CFG successors instead of returning deceptive empty arrays", () => {
    expect(bridgeSource).toContain('"successors": _unavailable(');
    expect(bridgeSource).not.toContain('"successors": []');
  });

  it("does not fabricate non-writable and non-executable segment permissions", () => {
    expect(bridgeSource).toContain('"writable": None');
    expect(bridgeSource).toContain('"executable": None');
    expect(bridgeSource).toContain('"permissions": _unavailable(');
    expect(bridgeSource).not.toContain('"writable": False');
    expect(bridgeSource).not.toContain('"executable": False');
  });

  it("uses Hopper containment and raw-reference APIs without inferring kinds", () => {
    expect(bridgeSource).toContain("segment.getProcedureAtAddress(address)");
    expect(bridgeSource).toContain("segment.getReferencesFromAddress(address)");
    expect(bridgeSource).toContain("segment.getReferencesOfAddress(address)");
    expect(bridgeSource).toContain(
      "Hopper's public Python API does not classify reference kinds",
    );
  });
});
