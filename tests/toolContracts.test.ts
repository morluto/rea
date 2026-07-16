import { describe, expect, it } from "vitest";

import {
  ENHANCED_TOOL_CONTRACTS,
  OFFICIAL_TOOL_CONTRACTS,
  SESSION_TOOL_CONTRACTS,
  TOOL_CONTRACTS,
} from "../src/contracts/toolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "../src/contracts/artifactToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../src/contracts/nativeToolContracts.js";
import { BROWSER_TOOL_CONTRACTS } from "../src/contracts/browserToolContracts.js";
import { ELECTRON_TOOL_CONTRACTS } from "../src/contracts/electronToolContracts.js";
import { APPLICATION_TOOL_CONTRACTS } from "../src/contracts/applicationToolContracts.js";

describe("tool contract inventory", () => {
  it("publishes 65 analysis contracts and eighteen session tools", () => {
    expect(OFFICIAL_TOOL_CONTRACTS).toHaveLength(33);
    expect(ENHANCED_TOOL_CONTRACTS).toHaveLength(10);
    expect(NATIVE_TOOL_CONTRACTS).toHaveLength(5);
    expect(ARTIFACT_TOOL_CONTRACTS).toHaveLength(2);
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
    ]);
    expect(APPLICATION_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "trace_application_feature",
      "compare_application_versions",
      "run_controlled_replay",
    ]);
    expect(SESSION_TOOL_CONTRACTS.map(({ name }) => name)).toEqual([
      "open_binary",
      "close_binary",
      "binary_session",
      "export_evidence_bundle",
      "import_evidence_bundle",
      "capture_process_scenario",
      "compare_process_captures",
      "compare_artifacts",
      "compare_functions",
      "compare_bundles",
      "find_changed_behavior",
      "build_call_path",
      "correlate_static_and_runtime",
      "verify_reconstruction",
      "list_unknowns",
      "record_unknown",
      "update_unknown",
      "verify_unknown_resolution",
    ]);
    expect(TOOL_CONTRACTS).toHaveLength(83);
    expect(new Set(TOOL_CONTRACTS.map(({ name }) => name)).size).toBe(83);
  });

  it("retains documented enhanced-tool limits at the input boundary", () => {
    const batch = ENHANCED_TOOL_CONTRACTS.find(
      ({ name }) => name === "batch_decompile",
    );
    const graph = ENHANCED_TOOL_CONTRACTS.find(
      ({ name }) => name === "get_call_graph",
    );

    expect(
      batch?.inputSchema.safeParse({
        addresses: Array.from({ length: 21 }, () => "0x1"),
      }).success,
    ).toBe(false);
    expect(
      graph?.inputSchema.safeParse({ address: "0x1", depth: 6 }).success,
    ).toBe(false);
    expect(graph?.inputSchema.parse({ address: "0x1" })).toEqual({
      address: "0x1",
      depth: 2,
      direction: "forward",
    });
  });
});
