import { describe, expect, it } from "vitest";

import {
  nativeInvestigationGraphSchema,
  joinInterfaceBuilderDispatch,
  traceNativeInvestigationGraph,
} from "./nativeInvestigationGraph.js";
import {
  buildInterfaceBuilderAnalysis,
  interfaceBuilderLimitsSchema,
} from "./apple/interfaceBuilderGraph.js";

const evidence = [
  {
    kind: "reference" as const,
    description: "fixture edge",
    location: { address: "0x1000", file_offset: 0 },
    artifact_path: null,
    artifact_sha256: null,
  },
];
const graph = nativeInvestigationGraphSchema.parse({
  target_sha256: "a".repeat(64),
  provider: { id: "fixture", version: "1", tool_version: "test" },
  nodes: [
    {
      id: "a",
      kind: "control",
      name: "button",
      location: null,
      attributes: {},
      evidence,
    },
    {
      id: "b",
      kind: "function",
      name: "handler",
      location: null,
      attributes: {},
      evidence,
    },
    {
      id: "c",
      kind: "state_value",
      name: "balance",
      location: null,
      attributes: {},
      evidence,
    },
  ],
  edges: [
    {
      id: "1",
      from: "a",
      to: "b",
      relation: "target_action",
      resolution: "observed",
      evidence,
      limitations: [],
    },
    {
      id: "2",
      from: "b",
      to: "c",
      relation: "writes",
      resolution: "inferred",
      evidence,
      limitations: ["static slice"],
    },
    {
      id: "3",
      from: "b",
      to: null,
      relation: "swift_witness_dispatch",
      resolution: "unresolved",
      reason: "witness table unavailable",
      evidence,
      limitations: [],
    },
  ],
  coverage: [],
  truncated: false,
});

describe("native investigation graph traces", () => {
  it("retains observed and inferred route edges plus unresolved dispatch", () => {
    const trace = traceNativeInvestigationGraph(graph, { start: "a" });
    expect(trace.nodes.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(trace.edges.map(({ resolution }) => resolution)).toEqual([
      "observed",
      "inferred",
    ]);
    expect(trace.unresolved).toHaveLength(1);
    expect(trace.unresolved[0]).toMatchObject({
      reason: "witness table unavailable",
    });
    const fromHandler = traceNativeInvestigationGraph(graph, { start: "b" });
    expect(fromHandler.unresolved[0]).toMatchObject({
      relation: "swift_witness_dispatch",
      reason: "witness table unavailable",
    });
  });

  it("stops at explicit node and edge bounds", () => {
    const trace = traceNativeInvestigationGraph(graph, {
      start: "a",
      limits: { max_nodes: 2, max_edges: 1 },
    });
    expect(trace.truncated).toBe(true);
    expect(trace.reason).toBe("max_edges_reached");
    expect(trace.nodes).toHaveLength(2);
  });

  it("does not retain a resolved edge beyond the depth boundary", () => {
    const trace = traceNativeInvestigationGraph(graph, {
      start: "a",
      limits: { max_depth: 0 },
    });

    expect(trace.nodes.map(({ id }) => id)).toEqual(["a"]);
    expect(trace.edges).toEqual([]);
    expect(trace.truncated).toBe(true);
    expect(trace.reason).toBe("max_depth_reached");
  });

  it("reports an unknown seed instead of treating it as an empty answer", () => {
    expect(
      traceNativeInvestigationGraph(graph, { start: "missing" }),
    ).toMatchObject({
      reason: "start_node_missing",
      nodes: [],
      truncated: false,
    });
  });
});

describe("Interface Builder dispatch joins", () => {
  it("joins a UI action to the target controller class, not the source control", () => {
    const ui = buildInterfaceBuilderAnalysis({
      targetSha256: "b".repeat(64),
      toolVersion: "test",
      documents: [
        {
          relativePath: "Main.storyboardc/scene.nib/objects.nib",
          archiveSha256: "c".repeat(64),
          documentKind: "storyboard_scene",
          raw: {
            "com.apple.ibtool.document.objects": {
              controller: { customClass: "BuildViewController" },
              button: { class: "UIButton", title: "Build" },
            },
            "com.apple.ibtool.document.connections": {
              button: [
                {
                  type: "action",
                  label: "buildTapped:",
                  destinationId: "controller",
                },
              ],
            },
          },
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({}),
    });
    const joined = joinInterfaceBuilderDispatch(ui.graph, {
      objc_classes: [],
      objc_protocols: [],
      objc_categories: [],
      swift_decls: [],
      objc_ivars: [],
      objc_protocol_records: [],
      objc_dispatch_implementations: [
        {
          class_name: "BuildViewController",
          selector: "buildTapped:",
          method_type: "instance",
          implementation_address: "0x1000",
          location: { address: "0x1000", file_offset: 0 },
          decode: { status: "decoded", reason: null },
          evidence,
        },
      ],
      swift_conformances: [],
      swift_dispatch_slots: [],
      swift_symbols: [],
      relative_pointers: [],
      coverage: [],
      db_save_result: null,
    });
    expect(joined.edges).toContainEqual(
      expect.objectContaining({
        relation: "objc_dispatch",
        resolution: "resolved",
        to: "native:function:0x1000",
      }),
    );
  });

  it("chooses an instance method and matches category-qualified owner names", () => {
    const ui = buildInterfaceBuilderAnalysis({
      targetSha256: "b".repeat(64),
      toolVersion: "test",
      documents: [
        {
          relativePath: "Main.nib",
          archiveSha256: "c".repeat(64),
          documentKind: "nib",
          raw: {
            "com.apple.ibtool.document.objects": {
              controller: { customClass: "BuildViewController" },
              button: { class: "UIButton" },
            },
            "com.apple.ibtool.document.connections": {
              button: [
                {
                  type: "action",
                  label: "buildTapped:",
                  destinationId: "controller",
                },
              ],
            },
          },
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({}),
    });
    const metadata = {
      objc_classes: [],
      objc_protocols: [],
      objc_categories: [],
      swift_decls: [],
      objc_ivars: [],
      objc_protocol_records: [],
      objc_dispatch_implementations: [
        {
          class_name: "BuildViewController",
          selector: "buildTapped:",
          method_type: "class" as const,
          implementation_address: "0x9999",
          location: { address: "0x9999", file_offset: 0 },
          decode: { status: "decoded" as const, reason: null },
          evidence,
        },
        {
          class_name: "BuildViewController(BuilderActions)",
          selector: "buildTapped:",
          method_type: "instance" as const,
          implementation_address: "0x1000",
          location: { address: "0x1000", file_offset: 0 },
          decode: { status: "decoded" as const, reason: null },
          evidence,
        },
      ],
      swift_conformances: [],
      swift_dispatch_slots: [],
      swift_symbols: [],
      relative_pointers: [],
      coverage: [],
      db_save_result: null,
    };

    const joined = joinInterfaceBuilderDispatch(ui.graph, metadata);
    expect(joined.edges).toContainEqual(
      expect.objectContaining({
        relation: "objc_dispatch",
        resolution: "resolved",
        to: "native:function:0x1000",
      }),
    );
    expect(joined.edges).not.toContainEqual(
      expect.objectContaining({ to: "native:function:0x9999" }),
    );
  });
});

describe("placeholder dispatch joins", () => {
  it("keeps a unique selector match inferred when the receiver is only a placeholder", () => {
    const ui = buildInterfaceBuilderAnalysis({
      targetSha256: "b".repeat(64),
      toolVersion: "test",
      documents: [
        {
          relativePath: "Main.storyboardc/scene.nib/objects.nib",
          archiveSha256: "c".repeat(64),
          documentKind: "storyboard_scene",
          raw: {
            "com.apple.ibtool.document.objects": {
              receiver: { class: "NSStoryboardPlaceholder" },
              button: { class: "UIButton", title: "Build" },
            },
            "com.apple.ibtool.document.connections": {
              button: [
                {
                  type: "action",
                  label: "buildTapped:",
                  destinationId: "receiver",
                },
              ],
            },
          },
        },
      ],
      limits: interfaceBuilderLimitsSchema.parse({}),
    });
    const joined = joinInterfaceBuilderDispatch(ui.graph, {
      objc_classes: [],
      objc_protocols: [],
      objc_categories: [],
      swift_decls: [],
      objc_ivars: [],
      objc_protocol_records: [],
      objc_dispatch_implementations: [
        {
          class_name: "BuildViewController",
          selector: "buildTapped:",
          method_type: "instance",
          implementation_address: "0x1000",
          location: { address: "0x1000", file_offset: null },
          decode: { status: "partial", reason: "symbol_name_only" },
          evidence,
        },
      ],
      swift_conformances: [],
      swift_dispatch_slots: [],
      swift_symbols: [],
      relative_pointers: [],
      coverage: [],
      db_save_result: null,
    });

    expect(joined.edges).toContainEqual(
      expect.objectContaining({
        relation: "objc_dispatch",
        resolution: "inferred",
        to: "native:function:0x1000",
        limitations: [
          expect.stringContaining("receiver is an unresolved placeholder"),
        ],
      }),
    );
    expect(joined.coverage).toContainEqual(
      expect.objectContaining({
        facet: "ui_to_objc_dispatch",
        status: "partial",
        reason: "some_action_receivers_remain_placeholders",
      }),
    );
  });
});
