import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAnalysisExecution,
  type AnalysisExecution,
  type AnalysisOperation,
} from "./AnalysisProvider.js";
import type { AnalysisError } from "../domain/errors.js";
import { EnhancedTools } from "./EnhancedTools.js";
import {
  nativeInvestigationGraphSchema,
  nativeInvestigationTraceSchema,
} from "../domain/nativeInvestigationGraph.js";
import { ok } from "../domain/result.js";
import type { Result } from "../domain/result.js";

const target = "a".repeat(64);
const provider = { id: "fixture", name: "Fixture", version: "1" };
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
  provider: {
    id: provider.id,
    version: provider.version,
    tool_version: "fixture",
  },
  nodes: [
    {
      id: "button",
      kind: "control" as const,
      name: "Build",
      location: null,
      attributes: {
        class_name: "UIButton",
        interface_builder_object_id: "button",
      },
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

const execution = (
  operation: AnalysisOperation,
  result: unknown,
  sha256 = target,
) =>
  ok(
    createAnalysisExecution(result, provider, {
      subject: {
        sha256,
        path: "/fixture.app",
        format: "mach-o",
        architecture: "arm64",
      },
    }),
  );

const testAnalysis = (
  overrides: Partial<
    Record<
      AnalysisOperation,
      (
        parameters: Readonly<Record<string, unknown>>,
      ) => Result<AnalysisExecution, AnalysisError>
    >
  > = {},
  uiGraph: z.input<typeof nativeInvestigationGraphSchema> = graph,
) => ({
  execute: async (
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<Result<AnalysisExecution, AnalysisError>> => {
    const override = overrides[operation];
    if (override !== undefined) return override(parameters);
    switch (operation) {
      case "decode_interface_builder":
        return execution(operation, {
          target_sha256: target,
          documents: [
            {
              relative_path: "Base.lproj/Main.nib",
              archive_sha256: "b".repeat(64),
              document_kind: "nib",
              object_count: 4,
              connection_count: 3,
              hierarchy_complete: true,
            },
          ],
          graph: uiGraph,
          limitations: [],
        });
      case "list_names":
        return execution(operation, [
          { address: "0x1000", name: "-[BuildViewController buildTapped:]" },
        ]);
      case "procedure_callees":
        return execution(
          operation,
          parameters.procedure === "0x1000" ? ["0x2000"] : [],
        );
      default:
        throw new Error(`Unexpected provider operation: ${operation}`);
    }
  },
});

describe("native UI action trace", () => {
  it("builds the evidence path from the active app and native provider", async () => {
    const tools = new EnhancedTools(testAnalysis());
    const result = await tools.execute("trace_native_ui_action", {
      action: "buildTapped:",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const trace = nativeInvestigationTraceSchema.parse(result.value);
    expect(trace.start).toBe("action");
    expect(trace.nodes.map(({ id }) => id)).toContain("native:function:0x1000");
    expect(trace.nodes.map(({ id }) => id)).toContain("native:function:0x2000");
    expect(trace.edges).toContainEqual(
      expect.objectContaining({
        relation: "objc_dispatch",
        resolution: "inferred",
      }),
    );
    expect(trace.edges).toContainEqual(
      expect.objectContaining({
        relation: "direct_call",
        to: "native:function:0x2000",
      }),
    );
    expect(trace.coverage).toContainEqual(
      expect.objectContaining({
        facet: "cross_function_value_flow",
        status: "unsupported",
      }),
    );
  });
});

describe("bounded native UI tracing", () => {
  it("continues handler traversal from its own depth when another UI branch is deeper", async () => {
    const deepGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: "view",
          kind: "view" as const,
          name: "Container",
          location: null,
          attributes: {},
          evidence,
        },
        {
          id: "nested-view",
          kind: "view" as const,
          name: "Nested container",
          location: null,
          attributes: {},
          evidence,
        },
      ],
      edges: [
        ...graph.edges,
        {
          id: "controller-view",
          from: "controller",
          to: "view",
          relation: "contains" as const,
          resolution: "observed" as const,
          evidence,
          limitations: [],
        },
        {
          id: "view-nested-view",
          from: "view",
          to: "nested-view",
          relation: "contains" as const,
          resolution: "observed" as const,
          evidence,
          limitations: [],
        },
      ],
    };
    const result = await new EnhancedTools(testAnalysis({}, deepGraph)).execute(
      "trace_native_ui_action",
      { action: "buildTapped:", max_depth: 3 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      nativeInvestigationTraceSchema
        .parse(result.value)
        .nodes.map(({ id }) => id),
    ).toContain("native:function:0x2000");
  });

  it("returns a typed input error for malformed direct metadata requests", async () => {
    const result = await new EnhancedTools(testAnalysis()).execute(
      "inspect_native_dispatch_metadata",
      { max_records: 0 },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  });

  it("binds dispatch metadata to the active target digest", async () => {
    const result = await new EnhancedTools(testAnalysis()).execute(
      "inspect_native_dispatch_metadata",
      { max_records: 10 },
    );

    expect(result).toMatchObject({
      ok: true,
      value: { target_sha256: target },
    });
  });
});

describe("native UI query outcomes", () => {
  it("resolves a control object ID through its authored action edge", async () => {
    const tools = new EnhancedTools(testAnalysis());
    const result = await tools.execute("trace_native_ui_action", {
      action: "button",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ start: "action" });
  });

  it("rejects UI and native observations with different target identities", async () => {
    const tools = new EnhancedTools(
      testAnalysis({
        list_names: () => execution("list_names", [], "c".repeat(64)),
      }),
    );
    const result = await tools.execute("trace_native_ui_action", {
      action: "buildTapped:",
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        operation: "decode_interface_builder",
      },
    });
  });

  it("returns candidates and a reason for an ambiguous selector", async () => {
    const duplicateGraph = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          ...graph.nodes[1],
          id: "second-action",
        },
      ],
    };
    const tools = new EnhancedTools(
      testAnalysis({
        decode_interface_builder: () =>
          execution("decode_interface_builder", {
            target_sha256: target,
            documents: [],
            graph: duplicateGraph,
            limitations: [],
          }),
      }),
    );
    const result = await tools.execute("trace_native_ui_action", {
      action: "buildTapped:",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      reason: "action_selector_matches_multiple_ui_connections",
      nodes: [{ id: "action" }, { id: "second-action" }],
    });
  });

  it("retains decoder truncation coverage when the action is absent", async () => {
    const boundedGraph = {
      ...graph,
      coverage: [
        {
          facet: "objects:Main.nib",
          status: "partial" as const,
          reason: "object_limit_reached",
          examined: 2,
          omitted: 1,
        },
      ],
      truncated: true,
    };
    const result = await new EnhancedTools(
      testAnalysis({}, boundedGraph),
    ).execute("trace_native_ui_action", { action: "missing-selector" });

    expect(result).toMatchObject({ ok: true, value: { truncated: true } });
    if (!result.ok) return;
    expect(result.value).toHaveProperty("coverage");
    expect(result.value).toMatchObject({
      coverage: expect.arrayContaining([
        expect.objectContaining({
          facet: "objects:Main.nib",
          status: "partial",
          reason: "object_limit_reached",
        }),
      ]),
    });
  });
});
