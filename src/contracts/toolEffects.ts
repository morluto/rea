/** Canonical side effects for one caller-visible tool. */
export interface ToolEffects {
  readonly mutatesTarget: boolean;
  readonly mutatesSession: boolean;
  readonly writesFilesystem: boolean;
  readonly launchesProcess: boolean;
  readonly accessesNetwork: boolean;
  readonly changesUiState: boolean;
  readonly mayDiscardData: boolean;
  readonly idempotent: boolean;
}

/** MCP execution hints derived only from canonical effects. */
export interface DerivedToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

const effects = (overrides: Partial<ToolEffects> = {}): ToolEffects => ({
  mutatesTarget: false,
  mutatesSession: false,
  writesFilesystem: false,
  launchesProcess: false,
  accessesNetwork: false,
  changesUiState: false,
  mayDiscardData: false,
  idempotent: true,
  ...overrides,
});

const evidence = effects({ mutatesSession: true });
const nativeEvidence = effects({ mutatesSession: true, launchesProcess: true });
const browserEvidence = effects({
  mutatesSession: true,
  accessesNetwork: true,
});
const sessionEvidence = effects({ mutatesSession: true });

/** Explicit effect audit for every public tool. */
export const TOOL_EFFECTS: Readonly<Record<string, ToolEffects>> = {
  address_name: evidence,
  comment: evidence,
  current_address: evidence,
  current_procedure: evidence,
  current_document: evidence,
  goto_address: effects({ mutatesSession: true, changesUiState: true }),
  inline_comment: evidence,
  list_bookmarks: evidence,
  list_documents: evidence,
  list_names: evidence,
  list_procedures: evidence,
  list_segments: evidence,
  list_strings: evidence,
  next_address: evidence,
  prev_address: evidence,
  procedure_address: evidence,
  procedure_assembly: evidence,
  procedure_callees: evidence,
  procedure_callers: evidence,
  procedure_info: evidence,
  procedure_references: evidence,
  procedure_pseudo_code: evidence,
  resolve_containing_procedure: evidence,
  search_procedures: evidence,
  search_strings: evidence,
  set_address_name: effects({ mutatesTarget: true, mutatesSession: true }),
  set_addresses_names: effects({ mutatesTarget: true, mutatesSession: true }),
  set_bookmark: effects({ mutatesTarget: true, mutatesSession: true }),
  set_comment: effects({ mutatesTarget: true, mutatesSession: true }),
  set_current_document: effects({ mutatesSession: true, changesUiState: true }),
  set_inline_comment: effects({ mutatesTarget: true, mutatesSession: true }),
  unset_bookmark: effects({
    mutatesTarget: true,
    mutatesSession: true,
    mayDiscardData: true,
  }),
  xrefs: evidence,
  swift_classes: evidence,
  get_objc_classes: evidence,
  get_objc_protocols: evidence,
  batch_decompile: evidence,
  get_call_graph: evidence,
  analyze_swift_types: evidence,
  find_xrefs_to_name: evidence,
  binary_overview: evidence,
  analyze_function: evidence,
  trace_feature: effects({ mutatesSession: true, idempotent: false }),
  inspect_macho: nativeEvidence,
  inspect_signature: nativeEvidence,
  inspect_plist: nativeEvidence,
  list_architectures: nativeEvidence,
  demangle_swift: nativeEvidence,
  inventory_artifact: evidence,
  extract_artifact: effects({ mutatesSession: true, writesFilesystem: true }),
  inspect_managed_artifact: evidence,
  inspect_managed_members: evidence,
  inspect_managed_native_boundaries: evidence,
  compare_managed_members: sessionEvidence,
  verify_managed_native_boundaries: sessionEvidence,
  import_managed_reconstruction: sessionEvidence,
  plan_managed_runtime_correlation: sessionEvidence,
  project_managed_application_graph: sessionEvidence,
  project_apple_application_graph: sessionEvidence,
  project_android_application_graph: sessionEvidence,
  identify_runtime: sessionEvidence,
  list_browser_targets: browserEvidence,
  inspect_web_page: browserEvidence,
  analyze_web_bundle: browserEvidence,
  observe_web_session: browserEvidence,
  discover_webmcp_tools: browserEvidence,
  compare_web_captures: browserEvidence,
  capture_web_screenshot: browserEvidence,
  compare_web_screenshots: browserEvidence,
  list_electron_targets: browserEvidence,
  inspect_electron_page: browserEvidence,
  analyze_javascript_application: evidence,
  reconcile_javascript_runtime: evidence,
  trace_application_feature: evidence,
  compare_application_versions: evidence,
  run_controlled_replay: effects({
    mutatesSession: true,
    writesFilesystem: true,
    launchesProcess: true,
  }),
  prepare_node_characterization: effects({
    mutatesSession: true,
    launchesProcess: true,
  }),
  execute_node_characterization: effects({
    mutatesSession: true,
    writesFilesystem: true,
    launchesProcess: true,
  }),
  commit_reconstruction_coverage: effects({
    writesFilesystem: true,
    mutatesSession: true,
  }),
  query_reconstruction_coverage: effects({ mutatesSession: true }),
  open_binary: effects({ mutatesSession: true, launchesProcess: true }),
  close_binary: effects({
    mutatesSession: true,
    writesFilesystem: true,
    mayDiscardData: true,
    idempotent: false,
  }),
  binary_session: effects(),
  export_evidence_bundle: effects({
    writesFilesystem: true,
    mayDiscardData: true,
  }),
  import_evidence_bundle: effects({ mutatesSession: true }),
  capture_process_scenario: effects({
    mutatesSession: true,
    writesFilesystem: true,
    launchesProcess: true,
    idempotent: false,
  }),
  compare_process_captures: sessionEvidence,
  compare_artifacts: sessionEvidence,
  compare_functions: sessionEvidence,
  compare_bundles: effects({ mutatesSession: true }),
  find_changed_behavior: sessionEvidence,
  build_call_path: sessionEvidence,
  correlate_static_and_runtime: sessionEvidence,
  verify_reconstruction: sessionEvidence,
  list_unknowns: effects(),
  record_unknown: effects({ mutatesSession: true, idempotent: false }),
  update_unknown: effects({ mutatesSession: true, idempotent: false }),
  verify_unknown_resolution: effects(),
};

/** Derive MCP annotations without tool-name or tool-family heuristics. */
export const annotationsFromEffects = (
  value: ToolEffects,
): DerivedToolAnnotations => ({
  readOnlyHint: !(
    value.mutatesTarget ||
    value.mutatesSession ||
    value.writesFilesystem ||
    value.launchesProcess ||
    value.accessesNetwork ||
    value.changesUiState ||
    value.mayDiscardData
  ),
  destructiveHint: value.mayDiscardData,
  idempotentHint: value.idempotent,
  openWorldHint: value.launchesProcess || value.accessesNetwork,
});

/** Resolve the audited metadata for one public tool. */
export const toolContractMetadata = (name: string) => {
  const audited = TOOL_EFFECTS[name];
  if (audited === undefined)
    throw new Error(`Missing effect audit for ${name}`);
  return {
    title: name
      .split("_")
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(" "),
    effects: audited,
    annotations: annotationsFromEffects(audited),
  };
};
