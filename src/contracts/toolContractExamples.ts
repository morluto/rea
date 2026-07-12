import type { JsonValue } from "../domain/jsonValue.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCaptureExample.js";
import { UNKNOWN_CONTRACT_EXAMPLES } from "./unknownContractExamples.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "./artifactComparisonExample.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "./functionComparisonExample.js";
import { INVESTIGATION_EXAMPLES } from "./investigationExamples.js";

/** Canonical examples for contracts whose required inputs have no defaults. */
export const TOOL_EXAMPLE_OVERRIDES: Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
> = {
  ...UNKNOWN_CONTRACT_EXAMPLES,
  ...INVESTIGATION_EXAMPLES,
  goto_address: { address: "0x1000" },
  procedure_address: { procedure: "main" },
  procedure_assembly: { procedure: "main" },
  procedure_callees: { procedure: "main" },
  procedure_callers: { procedure: "main" },
  procedure_info: { procedure: "main" },
  procedure_references: { procedure: "main" },
  procedure_pseudo_code: { procedure: "main" },
  resolve_containing_procedure: { address: "0x1000" },
  search_procedures: { pattern: "main" },
  search_strings: { pattern: "authorization failed" },
  set_address_name: { address: "0x1000", name: "entry" },
  set_addresses_names: { names: { "0x1000": "entry" } },
  set_bookmark: { address: "0x1000" },
  set_comment: { address: "0x1000", comment: "validated entry point" },
  set_current_document: { document: "fixture" },
  set_inline_comment: { address: "0x1000", comment: "calls parser" },
  unset_bookmark: { address: "0x1000" },
  get_call_graph: { address: "0x1000" },
  find_xrefs_to_name: { name: "malloc" },
  analyze_function: { procedure: "main" },
  trace_feature: { query: "license" },
  open_binary: { path: "/tmp/fixture" },
  import_evidence_bundle: { path: "evidence.json" },
  capture_process_scenario: {
    approved: true,
    executable: "/usr/bin/true",
    working_directory: "/tmp",
  },
  compare_process_captures: {
    left_evidence_id: `ev_${"0".repeat(64)}`,
    left: EMPTY_PROCESS_CAPTURE_EXAMPLE,
    right_evidence_id: `ev_${"1".repeat(64)}`,
    right: EMPTY_PROCESS_CAPTURE_EXAMPLE,
  },
  compare_artifacts: ARTIFACT_COMPARISON_EXAMPLE,
  compare_functions: FUNCTION_COMPARISON_EXAMPLE,
  compare_bundles: {
    left: {
      bundle_version: 2,
      artifacts: [],
      providers: [],
      environments: [],
      scenarios: [],
      captures: [],
      unknowns: [],
      records: [],
    },
    right: {
      bundle_version: 2,
      artifacts: [],
      providers: [],
      environments: [],
      scenarios: [],
      captures: [],
      unknowns: [],
      records: [],
    },
  },
};
