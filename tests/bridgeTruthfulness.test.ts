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

  it("projects opaque Hopper locals into an exact provenance-bearing shape", () => {
    expect(bridgeSource).toContain("def _procedure_locals(procedure):");
    expect(bridgeSource).toContain('"description": str(local)');
    expect(bridgeSource).not.toContain(
      "_json_safe(procedure.getLocalVariableList())",
    );
  });

  it("bounds search and makes regex an explicitly constrained opt-in", () => {
    expect(bridgeSource).toContain('params.get("mode", "literal")');
    expect(bridgeSource).toContain("pattern.casefold()");
    expect(bridgeSource).toContain("_validate_regex_node(parsed)");
    expect(bridgeSource).toContain(
      "Nested regex repetitions are not supported",
    );
    expect(bridgeSource).toContain("MAX_SEARCH_PATTERN_LENGTH = 256");
    expect(bridgeSource).toContain("MAX_SEARCH_VALUE_LENGTH = 4096");
    expect(bridgeSource).toContain("MAX_REGEX_BACKTRACKING_PATHS = 10000");
    expect(bridgeSource).toContain("MAX_REGEX_CANDIDATE_LENGTH = 4096");
    expect(bridgeSource).toContain("MAX_REGEX_SEARCH_WORK_UNITS = 1000000");
    expect(bridgeSource).toContain("_checked_regex_paths(");
    expect(bridgeSource).toContain("_bounded_regex_matcher(");
    expect(bridgeSource).toContain('"value_truncated"');
    expect(bridgeSource).toContain("page_end = offset + limit");
    expect(bridgeSource).toContain("if offset <= total < page_end:");
    expect(bridgeSource).not.toContain(
      "matching = [item for item in _search_inventory(document, kind)",
    );
  });

  it("caches sorted search inventories and invalidates them after renames", () => {
    expect(bridgeSource).toContain("_search_inventory_cache");
    expect(bridgeSource).toContain("tuple(sorted(values.items()");
    expect(bridgeSource).toContain("_invalidate_search_inventory(document)");
  });

  it("classifies bridge exceptions without forwarding tracebacks", () => {
    expect(bridgeSource).toContain("def _diagnostic_type(error):");
    expect(bridgeSource).toContain('"type": _diagnostic_type(error)');
    expect(bridgeSource).not.toContain("traceback.format_exc");
  });

  it("stops background analysis and closes the session-owned document", () => {
    expect(bridgeSource).toContain("def _session_document():");
    expect(bridgeSource).toContain("os.path.realpath(REA_TARGET_PATH)");
    expect(bridgeSource).toContain("document.getExecutableFilePath()");
    expect(bridgeSource).toContain("document.getDatabaseFilePath()");
    expect(bridgeSource).toContain("document.backgroundProcessActive()");
    expect(bridgeSource).toContain("document.requestBackgroundProcessStop()");
    expect(bridgeSource).toContain("if REA_OWNS_PROCESS_LIFETIME:");
    expect(bridgeSource).toContain('"cleanup_required": True');
    expect(bridgeSource).toContain("document.waitForBackgroundProcessToEnd()");
    expect(bridgeSource).toContain("document.closeDocument()");
    expect(bridgeSource).toContain(
      "document_closed = _session_document() is None",
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
