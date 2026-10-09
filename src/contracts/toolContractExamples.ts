import type { JsonValue } from "../domain/jsonValue.js";
import { UNKNOWN_CONTRACT_EXAMPLES } from "./unknownContractExamples.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "./artifactComparisonExample.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "./functionComparisonExample.js";
import {
  INVESTIGATION_EXAMPLES,
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_CAPTURE_RECONSTRUCTION,
} from "./investigationExamples.js";

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
  trace_native_values: { procedure: "0x1000" },
  inspect_native_data_type: { type: "/MyStruct" },
  inspect_native_instruction: { address: "0x1000" },
  resolve_native_call_targets: { address: "0x1000" },
  read_function_instructions: { procedure: "main" },
  read_bytes: { address: "0x1000", length: 16 },
  address_to_file_offset: { address: "0x1000" },
  procedure_references: { procedure: "main" },
  procedure_pseudo_code: { procedure: "main" },
  resolve_containing_procedure: { address: "0x1000" },
  search_procedures: { pattern: "main" },
  search_strings: { pattern: "authorization failed" },
  set_address_name: { address: "0x1000", name: "entry" },
  set_addresses_names: { names: { "0x1000": "entry" } },
  set_bookmark: { address: "0x1000" },
  set_comment: { address: "0x1000", comment: "validated entry point" },
  set_inline_comment: { address: "0x1000", comment: "calls parser" },
  unset_bookmark: { address: "0x1000" },
  get_call_graph: { address: "0x1000" },
  find_xrefs_to_name: { name: "malloc" },
  analyze_function: { procedure: "main" },
  annotate_native_function: {
    procedure: "0x10100",
    name: "entry",
    comment: "Analyst observation",
  },
  analyze_swift_types: { category: "classes", pattern: "Account" },
  inspect_native_api: { procedure: "main" },
  trace_feature: { query: "license" },
  trace_call_path: { start: "0x1000", goal: "0x1100" },
  trace_native_ui_action: { action: "buildTapped:" },
  open_binary: { path: "/tmp/fixture" },
  export_evidence_bundle: { path: "/tmp/evidence.json" },
  inspect_address_context: { address: "0x1000" },
  import_evidence_bundle: { path: "/tmp/evidence.json" },
  capture_process_scenario: {
    executable: "/usr/bin/true",
    working_directory: "/tmp",
  },
  compare_process_captures: {
    left: PROCESS_CAPTURE_REFERENCE,
    right: PROCESS_CAPTURE_RECONSTRUCTION,
  },
  compare_artifacts: {
    left: ARTIFACT_COMPARISON_EXAMPLE.left,
    right: ARTIFACT_COMPARISON_EXAMPLE.right,
  },
  compare_functions: {
    left: FUNCTION_COMPARISON_EXAMPLE.left,
    right: FUNCTION_COMPARISON_EXAMPLE.right,
  },
  compare_bundles: {
    left_bundle_path: "/tmp/left-evidence.json",
    right_bundle_path: "/tmp/right-evidence.json",
  },
  inspect_with_objdump: {
    path: "/tmp/program",
    operation: "disassemble",
  },
  execute_rizin_command: { path: "/tmp/program", command: "iI" },
  start_gdb_session: {},
  gdb_console: {
    session_id: "00000000-0000-4000-8000-000000000001",
    command: "info functions",
  },
  gdb_session_status: { session_id: "00000000-0000-4000-8000-000000000001" },
  close_gdb_session: { session_id: "00000000-0000-4000-8000-000000000001" },
  start_rizin_debug_session: { path: "/tmp/program" },
  rizin_debug_command: {
    session_id: "00000000-0000-4000-8000-000000000001",
    command: "dr",
  },
  rizin_debug_session_status: {
    session_id: "00000000-0000-4000-8000-000000000001",
  },
  close_rizin_debug_session: {
    session_id: "00000000-0000-4000-8000-000000000001",
  },
  list_cutter_sessions: {},
  cutter_command: {
    session_id: "00000000-0000-4000-8000-000000000001",
    expected_generation: 0,
    command: "iI",
  },
};
