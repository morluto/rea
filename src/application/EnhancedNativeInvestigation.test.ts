import { describe, expect, it } from "vitest";

import { EnhancedTools } from "./EnhancedTools.js";
import { nativeInvestigationTraceSchema } from "../domain/nativeInvestigationGraph.js";

const target = "a".repeat(64);
const evidence = [
  {
  kind: "interface_builder_resource" as const,
  description: "Fixture UI archive",
  location: { address: null, file_offset: null },
  artifact_path: null,
  artifact_sha256: null,
  },
];
const graph = {
  target_sha256: target,
  provider: { id: "rea-artifact-graph", version: "1", tool_version: "test" },
  nodes: [
    {
      id: "button",
      kind: "control" as const,
      name: "Build",
      location: null,
      attributes: { class_name: "UIButton" },
      evidence,
    },
    {
      id: "action",
      kind: "action" as const,
      name: "buildTapped:",
      location: null,
      attributes: { selector: "buildTapped:" },
      evidence,
    },
    {
      id: "controller",
      kind: "view_controller" as const,
      name: "BuildViewController",
      location: null,
      attributes: { class_name: "BuildViewController" },
      evidence,
    },
    {
      id: "selector",
      kind: "objc_selector" as const,
      name: "buildTapped:",
      location: null,
      attributes: {},
      evidence,
    },
  ],
  edges: [
    {
      id: "button-action",
      from: "button",
      to: "action",
      relation: "target_action" as const,
      resolution: "observed" as const,
      evidence,
      limitations: [],
    },
    {
      id: "action-selector",
      from: "action",
      to: "selector",
      relation: "target_action" as const,
      resolution: "observed" as const,
      evidence,
      limitations: [],
    },
    {
      id: "action-controller",
      from: "action",
      to: "controller",
      relation: "target_action" as const,
      resolution: "observed" as const,
      evidence,
      limitations: [],
    },
  ],
  coverage: [],
  truncated: false,
};
const metadata = {
  objc_classes: [],
  objc_protocols: [],
  swift_decls: [],
  objc_ivars: [],
  objc_dispatch_implementations: [
    {
      class_name: "BuildViewController",
      selector: "buildTapped:",
      method_type: "instance" as const,
      implementation_address: "0x1000",
      location: { address: "0x1000", file_offset: null },
      decode: { status: "partial" as const, reason: "symbol_name_only" },
      evidence: [
        {
          kind: "symbol" as const,
          description: "method symbol",
          location: { address: "0x1000", file_offset: null },
          artifact_path: null,
          artifact_sha256: null,
        },
      ],
    },
  ],
  swift_conformances: [],
  swift_dispatch_slots: [],
  swift_symbols: [],
  relative_pointers: [],
  coverage: [],
  db_save_result: null,
};

describe("native investigation workflow", () => {
  it("joins UI dispatch to the matching controller symbol and traces the route", async () => {
    const tools = new EnhancedTools({
      execute: async () => {
        throw new Error("provider should not be called");
      },
    });
    const result = await tools.execute("trace_native_investigation", {
      graph,
      metadata: {
        target_sha256: target,
        provider: { id: "fixture", name: "Fixture", version: "1" },
        analysis_profile_digest: null,
        result: metadata,
      },
      start: "button",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trace = nativeInvestigationTraceSchema.parse(result.value);
    expect(trace).toMatchObject({ start: "button" });
    expect(trace.nodes).toContainEqual(
      expect.objectContaining({ id: "native:function:0x1000" }),
    );
    expect(trace.edges).toContainEqual(
      expect.objectContaining({
        relation: "objc_dispatch",
        resolution: "inferred",
      }),
    );
  });

  it("rejects metadata from a different target digest", async () => {
    const tools = new EnhancedTools({
      execute: async () => {
        throw new Error("provider should not be called");
      },
    });
    const result = await tools.execute("trace_native_investigation", {
      graph,
      metadata: {
        target_sha256: "b".repeat(64),
        provider: { id: "fixture", name: "Fixture", version: "1" },
        analysis_profile_digest: null,
        result: metadata,
      },
      start: "button",
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  });
});
