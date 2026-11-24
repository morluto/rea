/** Minimal complete static checkpoint shared by worker protocol fixtures. */
export const staticCheckpointFacts = {
  parse_status: "complete",
  parse_error_count: 0,
  visited_ast_nodes: 1,
  references: [],
  endpoints: [],
  storage: [],
  bundler_registrations: [],
  role_paths: [],
  source_map_urls: [],
  vendors: [],
  electron: {
    browser_windows: [],
    context_bridge_apis: [],
    ipc: [],
    sender_validations: [],
    utility_processes: [],
    native_addon_bindings: [],
    protocols: [],
  },
  limitations: [],
  analysis_coverage: {
    syntax: { status: "complete", error_count: 0 },
    semantics: { unknown_findings: 0, uncertainty: [] },
    examination: {
      status: "complete",
      semantic_resource_limits: [],
      electron_call_paths_limited: false,
    },
    applicability: { electron: "unknown" },
  },
};
