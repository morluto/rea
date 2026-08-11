import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const bridgeSource = await readFile(
  new URL("../../../../bridge/hopper_bridge.py", import.meta.url),
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
    expect(bridgeSource).toContain('"readable": None');
    expect(bridgeSource).toContain("permission_limitation = _unavailable(");
    expect(bridgeSource).toContain('"permissions": permission_limitation');
    expect(bridgeSource).toContain('"provenance": "hopper-public-python-api"');
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

  it("provides a raw-instruction fast path without decompilation or global scans", () => {
    const start = bridgeSource.indexOf("def _read_function_instructions");
    const end = bridgeSource.indexOf("\ndef _analyze_function", start);
    const implementation = bridgeSource.slice(start, end);
    expect(implementation).toContain("_instruction_addresses(");
    expect(implementation).toContain("offset + limit + 1");
    expect(implementation).not.toContain("decompile(");
    expect(implementation).not.toContain("_search_inventory(");
    expect(implementation).not.toContain("_strings(");
    expect(implementation).not.toContain("_name_map(");
    expect(bridgeSource).toContain(
      "pseudo = _pseudocode(document, procedure) or",
    );
    expect(bridgeSource).toContain("return _pseudocode(document, procedure)");
  });

  it("projects opaque Hopper locals into an exact provenance-bearing shape", () => {
    expect(bridgeSource).toContain("def _procedure_locals(procedure):");
    expect(bridgeSource).toContain('"description": str(local)');
    expect(bridgeSource).not.toContain(
      "_json_safe(procedure.getLocalVariableList())",
    );
  });

  it("stops background analysis and closes the session-owned document", () => {
    expect(bridgeSource).toContain("def _session_document():");
    expect(bridgeSource).toContain("os.path.realpath(REA_TARGET_PATH)");
    expect(bridgeSource).toContain("document.getExecutableFilePath()");
    expect(bridgeSource).toContain("document.getDatabaseFilePath()");
    expect(bridgeSource).toContain("document.backgroundProcessActive()");
    expect(bridgeSource).toContain("document.requestBackgroundProcessStop()");
    expect(bridgeSource).toContain(
      'if method == "shutdown" and REA_OWNS_PROCESS_LIFETIME:',
    );
    expect(bridgeSource).toContain('"cleanup_required": True');
    expect(bridgeSource).toContain(
      'method in ("shutdown", "shutdown_document")',
    );
    expect(bridgeSource).toContain("document.waitForBackgroundProcessToEnd()");
    expect(bridgeSource).toContain("document.closeDocument()");
    expect(bridgeSource).toContain(
      "document_closed = _session_document() is None",
    );
  });

  it("invalidates cached search inventories in both rename paths", () => {
    const singleRenameStart = bridgeSource.indexOf(
      'if method == "set_address_name":',
    );
    const bulkRenameStart = bridgeSource.indexOf(
      'if method == "set_addresses_names":',
      singleRenameStart,
    );
    const nextMethodStart = bridgeSource.indexOf(
      'if method in ("set_comment", "set_inline_comment"):',
      bulkRenameStart,
    );
    expect(singleRenameStart).toBeGreaterThan(-1);
    expect(bulkRenameStart).toBeGreaterThan(singleRenameStart);
    expect(nextMethodStart).toBeGreaterThan(bulkRenameStart);
    expect(bridgeSource.slice(singleRenameStart, bulkRenameStart)).toContain(
      "_invalidate_search_inventory(document)",
    );
    expect(bridgeSource.slice(bulkRenameStart, nextMethodStart)).toContain(
      "_invalidate_search_inventory(document)",
    );
  });

  it("returns deterministic addresses for direct procedure relationships", () => {
    expect(bridgeSource).toContain(
      "_hex(item.getEntryPoint()) for item in procedure.getAllCallerProcedures()",
    );
    expect(bridgeSource).toContain(
      "_hex(item.getEntryPoint()) for item in procedure.getAllCalleeProcedures()",
    );
    expect(bridgeSource).not.toContain(
      "_procedure_name(item) for item in procedure.getAllCallerProcedures()",
    );
    expect(bridgeSource).not.toContain(
      "_procedure_name(item) for item in procedure.getAllCalleeProcedures()",
    );
  });
});
