import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const bridgeSource = await readFile(
  new URL("../bridge/hopper_bridge.py", import.meta.url),
  "utf8",
);

describe("Hopper bridge truthfulness", () => {
  it("collects CFG successors from Hopper instead of fabricating empty edges", () => {
    expect(bridgeSource).toContain("block.getSuccessorCount()");
    expect(bridgeSource).toContain("block.getSuccessorAddressAtIndex(index)");
    expect(bridgeSource).not.toContain(
      "Hopper's public Python API does not expose CFG successor edges",
    );
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

  it("scans procedure instructions for comments and typed reference evidence", () => {
    expect(bridgeSource).toContain("for address in addresses:");
    expect(bridgeSource).toContain("segment.getCommentAtAddress(address)");
    expect(bridgeSource).toContain(
      "segment.getInlineCommentAtAddress(address)",
    );
    expect(bridgeSource).toContain('"source_procedure"');
    expect(bridgeSource).toContain('"target_procedure"');
    expect(bridgeSource).toContain('"outgoing_references"');
    expect(bridgeSource).toContain('"referenced_strings"');
    expect(bridgeSource).toContain('"referenced_names"');
  });

  it("supports independent dossier continuation offsets", () => {
    expect(bridgeSource).toContain('_offset(params, "pseudocode_offset")');
    expect(bridgeSource).toContain('_offset(params, "assembly_offset")');
    expect(bridgeSource).toContain('params.get("collection_offset", {})');
  });
});
