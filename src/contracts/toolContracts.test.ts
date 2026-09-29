import { describe, expect, it } from "vitest";

import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
} from "./toolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "./artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "./managedToolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "./managedWorkflowToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "./nativeToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "./browserToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "./electronToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "./applicationToolContracts.js";

describe("tool contract inventory", () => {
  it("publishes the canonical analysis and session tool inventory", () => {
    expect(OFFICIAL_TOOL_CONTRACTS).toHaveLength(36);
    expect(ENHANCED_TOOL_CONTRACTS).toHaveLength(14);
    expect(NATIVE_TOOL_CONTRACTS).toHaveLength(5);
    expect(ARTIFACT_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "inspect_artifact",
      "extract_artifact",
      "decode_interface_builder",
    ]);
    expect(MANAGED_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "inspect_managed_artifact",
      "inspect_managed_members",
      "inspect_managed_native_boundaries",
    ]);
    expect(MANAGED_WORKFLOW_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "compare_managed_members",
      "verify_managed_native_boundaries",
      "import_managed_reconstruction",
      "plan_managed_runtime_correlation",
      "project_managed_application_graph",
    ]);
    expect(BROWSER_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "list_browser_targets",
      "inspect_web_page",
      "analyze_web_bundle",
      "observe_web_session",
      "discover_webmcp_tools",
      "compare_web_captures",
      "capture_web_screenshot",
      "compare_web_screenshots",
    ]);
    expect(ELECTRON_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "list_electron_targets",
      "inspect_electron_page",
      "analyze_javascript_application",
      "reconcile_javascript_runtime",
      "capture_electron_scenario",
    ]);
    expect(APPLICATION_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "trace_application_feature",
      "trace_javascript_semantics",
      "compare_application_versions",
      "compare_source_to_bundle",
      "compare_javascript_export_shapes",
      "run_controlled_replay",
      "prepare_node_characterization",
      "execute_node_characterization",
      "build_reconstruction_obligation_ledger",
      "evaluate_reconstruction_coverage",
    ]);
    expect(new Set(TOOL_CONTRACTS.map(({ name }) => name)).size).toBe(
      TOOL_CONTRACTS.length,
    );
  });
});
