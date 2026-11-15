/** Canonical MCP operations reached by CLI commands with different names. */
export const CLI_COMMAND_TOOL_ALIASES = Object.freeze({
  "environment-build": ["export_environment_bundle"],
  guidance: ["search_guidance", "read_guidance_section"],
  analyze: ["binary_overview"],
  inspect: ["binary_overview"],
  decompile: ["procedure_pseudo_code"],
  function: ["analyze_function"],
  instructions: ["read_function_instructions"],
  trace: ["trace_feature"],
  search: ["search_strings", "search_procedures"],
  "capture-process": ["capture_process_scenario"],
  compare: ["compare_bundles"],
  "list-objdump-architectures": ["inspect_with_objdump"],
  "debug-with-gdb": ["gdb_console"],
  "debug-with-lldb": ["lldb_command"],
  "debug-with-rizin": ["rizin_debug_command"],
});
