import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { expect, it, vi } from "vitest";

import {
  freezeJsonSnapshot,
  isImmutableJsonSnapshot,
} from "../immutableJson.js";
import { byteEntropySchema } from "../native/byteEntropy.js";
import * as jsApplicationAnalysis from "../javascript/javascriptApplicationAnalysis.js";
import {
  javascriptFactsViewRequestSchema,
  projectJavaScriptFacts,
} from "./javascriptFactsView.js";
import { functionDossierSchema } from "../native/functionDossier.js";
import { ghidraFunctionDossier } from "../ghidraValues.fixture.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../../contracts/artifactComparisonExample.js";
import {
  analysisViewBindJavaScriptGraphs,
  analysisViewJavaScriptAnalysis,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewLayoutEvidence,
  analysisViewLayoutFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  createImmutableJavaScriptApplicationGraphSteps,
} from "../javascript/javascriptApplicationGraph.js";
import {
  createJavaScriptSemanticGraph,
  sealTransferredJavaScriptSemanticGraphSteps,
} from "../javascript/javascriptSemanticGraph.js";
import { sourceMapReference } from "../javascript/javascriptApplicationGraph.fixture.js";
import { createArtifactInspection } from "../artifactInspection.js";
import {
  inspectAnalysisViewInputSchema,
  type AnalysisViewRequest,
} from "./analysisViewRequest.js";
import { projectAnalysisView } from "./analysisView.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";
import { analysisViewResultSchema } from "./analysisViewResult.js";

const layoutParent = (): AnalysisViewParent => {
  const evidence = analysisViewLayoutEvidence();
  return {
    predicateType: evidence.predicate_type,
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: evidence.normalized_result,
    limitations: evidence.limitations,
  };
};

const javascriptParent = (
  analysis = analysisViewJavaScriptAnalysis(),
): AnalysisViewParent => ({
  predicateType: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.predicate_type,
  evidenceId: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.evidence_id,
  operation: "analyze_javascript_application",
  normalizedResult: analysis,
  limitations: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.limitations,
});

const nativeParent = (
  result: unknown = ghidraFunctionDossier(),
): AnalysisViewParent => ({
  predicateType: "rea.analysis",
  evidenceId: "ev_" + "b".repeat(64),
  operation: "analyze_function",
  normalizedResult: result,
  limitations: ["Retained provider limitation"],
  artifact: { path: "/fixtures/example.exe", sha256: "a".repeat(64) },
});

it("returns input errors for malformed parent Evidence identifiers before projection", () => {
  for (const evidenceId of [`xx_${"a".repeat(64)}`, "ev_bad"])
    expect(
      projectAnalysisView(
        { ...nativeParent(), evidenceId },
        { kind: "summary" },
      ),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(projectAnalysisView(nativeParent(), { kind: "summary" }).ok).toBe(
    true,
  );
});

it("projects native procedure and bounded assembly and high-pcode with exact parent identity", () => {
  const parent = nativeParent();
  const procedure = projectAnalysisView(parent, {
    kind: "native",
    facet: "procedure",
    offset: 0,
    limit: 64,
  });
  if (!procedure.ok) throw procedure.error;
  expect(procedure.value).toMatchObject({
    kind: "native",
    parent_operation: "analyze_function",
    artifact: parent.artifact,
    item: { address: "0x401000" },
  });
  expect(procedure.value.view_digest).not.toBe(parent.evidenceId.slice(3));
  const assembly = projectAnalysisView(parent, {
    kind: "native",
    facet: "assembly",
    offset: 0,
    limit: 1,
  });
  if (!assembly.ok) throw assembly.error;
  expect(assembly.value).toMatchObject({
    coverage: { examined: 1, total: 2, next_offset: 1 },
    item: ["0x401000: CALL 0x401020"],
  });
  const flow = projectAnalysisView(parent, {
    kind: "native",
    facet: "value_flow_operations",
    offset: 0,
    limit: 1,
  });
  if (!flow.ok) throw flow.error;
  expect(flow.value).toMatchObject({ item: [{ opcode: "COPY" }] });
});

it("projects a compact analyze_function summary that validates and retains the dossier", () => {
  const parent = nativeParent();
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  const validated = analysisViewResultSchema.parse(summary.value);
  expect(validated).toMatchObject({
    kind: "summary",
    parent_operation: "analyze_function",
    parent_evidence_id: parent.evidenceId,
    artifact: parent.artifact,
    summary: {
      procedure: { address: "0x401000" },
      pseudocode: { available: true },
      value_flow: { available: true },
      facet_availability: { references: { available: true } },
      counts: { assembly: 2, incoming_references: 0 },
    },
  });
});

it("keeps omitted optional dossier records unknown in the analyze_function summary", () => {
  const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
  // The fixture omits unresolved_calls and Swift literals, as IDA and Kuna
  // dossiers and non-Swift targets do: their counts are unknown, not zero.
  const omitted = projectAnalysisView(nativeParent(dossier), {
    kind: "summary",
  });
  if (!omitted.ok) throw omitted.error;
  expect(analysisViewResultSchema.parse(omitted.value)).toMatchObject({
    summary: {
      counts: {
        unresolved_calls: null,
        swift_string_literals: null,
        swift_string_literal_omissions: null,
      },
    },
    unknowns: expect.arrayContaining([
      "unresolved_calls not recorded",
      "swift_string_literals not recorded",
      "swift_string_literal_omissions not recorded",
    ]),
  });
  const recorded = projectAnalysisView(
    nativeParent({
      ...dossier,
      unresolved_calls: [{ address: "0x401010", reason: "indirect call" }],
      swift_string_literals: [],
      swift_string_literal_omissions: [],
    }),
    { kind: "summary" },
  );
  if (!recorded.ok) throw recorded.error;
  expect(analysisViewResultSchema.parse(recorded.value)).toMatchObject({
    summary: {
      counts: {
        unresolved_calls: 1,
        swift_string_literals: 0,
        swift_string_literal_omissions: 0,
      },
    },
  });
  expect(recorded.value.unknowns).not.toContain(
    "unresolved_calls not recorded",
  );
  expect(recorded.value.unknowns).not.toContain(
    "swift_string_literals not recorded",
  );
});

it("keeps value-flow counts unknown when value flow is unrecorded or unavailable", () => {
  const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
  const flowCounts = {
    value_flow_operations: null,
    value_flow_def_use: null,
    value_flow_effects: null,
    value_flow_parameters: null,
    value_flow_parameter_uses: null,
  };
  // IDA and Kuna dossiers record no value flow at all.
  const unrecorded = projectAnalysisView(
    nativeParent({ ...dossier, native_value_flow: null }),
    { kind: "summary" },
  );
  if (!unrecorded.ok) throw unrecorded.error;
  expect(analysisViewResultSchema.parse(unrecorded.value)).toMatchObject({
    summary: {
      value_flow: { available: false, truncated: null },
      counts: flowCounts,
    },
    unknowns: expect.arrayContaining(["native_value_flow was not recorded"]),
  });
  // A Ghidra dossier can declare value flow unavailable with a reason.
  const unavailable = projectAnalysisView(
    nativeParent({
      ...dossier,
      native_value_flow: {
        available: false,
        reason: "High p-code was not produced.",
        limitations: [],
      },
    }),
    { kind: "summary" },
  );
  if (!unavailable.ok) throw unavailable.error;
  expect(analysisViewResultSchema.parse(unavailable.value)).toMatchObject({
    summary: { value_flow: { available: false }, counts: flowCounts },
    unknowns: expect.arrayContaining([
      "native_value_flow unavailable: High p-code was not produced.",
    ]),
  });
  // Available value flow keeps its observed counts, including empty ones.
  const available = projectAnalysisView(nativeParent(dossier), {
    kind: "summary",
  });
  if (!available.ok) throw available.error;
  const flow = dossier.native_value_flow;
  if (flow === null || !flow.available) throw new Error("fixture value flow");
  expect(available.value).toMatchObject({
    summary: {
      value_flow: { available: true },
      counts: {
        value_flow_operations: flow.operations.length,
        value_flow_def_use: flow.def_use.length,
        value_flow_effects: flow.effects.length,
        value_flow_parameters: flow.parameters.length,
        value_flow_parameter_uses: flow.parameter_uses.length,
      },
    },
  });
  expect(flow.operations.length).toBeGreaterThan(0);
  expect(available.value.unknowns).not.toContain(
    "native_value_flow was not recorded",
  );
});

it("keeps provider-unavailable facets unknown in the analyze_function summary", () => {
  // A Kuna-style dossier: empty rows with explicit unavailability for several facets.
  const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
  const unsupported = {
    ...dossier,
    comments: [],
    incoming_references: [],
    outgoing_references: [],
    basic_blocks: [],
    facet_availability: {
      ...dossier.facet_availability,
      comments: {
        available: false,
        reason: "Kuna exports no analyst comments.",
      },
      references: {
        available: false,
        reason: "This provider does not report typed references.",
      },
      cfg: { available: false, reason: "Kuna exports no basic blocks." },
    },
  };
  const summary = projectAnalysisView(nativeParent(unsupported), {
    kind: "summary",
  });
  if (!summary.ok) throw summary.error;
  const validated = analysisViewResultSchema.parse(summary.value);
  expect(validated).toMatchObject({
    kind: "summary",
    summary: {
      facet_availability: unsupported.facet_availability,
      counts: {
        comments: null,
        incoming_references: null,
        outgoing_references: null,
        basic_blocks: null,
        // Declared-available facets keep their observed counts.
        assembly: 2,
        callers: 0,
        referenced_strings: dossier.referenced_strings.length,
      },
    },
    unknowns: expect.arrayContaining([
      "comments unavailable: Kuna exports no analyst comments.",
      "references unavailable: This provider does not report typed references.",
      "cfg unavailable: Kuna exports no basic blocks.",
    ]),
  });
  // A dossier that declares nothing reports null availability and plain counts.
  const { facet_availability: _declared, ...undeclared } = dossier;
  const silent = projectAnalysisView(nativeParent(undeclared), {
    kind: "summary",
  });
  if (!silent.ok) throw silent.error;
  expect(silent.value).toMatchObject({
    summary: { facet_availability: null, counts: { comments: 0 } },
  });
});

it("rejects invalid native parents, unsupported source operations and singleton offsets", () => {
  const view = {
    kind: "native",
    facet: "assembly",
    offset: 0,
    limit: 4,
  } as const;
  expect(projectAnalysisView(nativeParent({}), view)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(
    projectAnalysisView({ ...nativeParent(), artifact: null }, view),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(projectAnalysisView(layoutParent(), view)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(projectAnalysisView(javascriptParent(), view)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(
    projectAnalysisView(nativeParent(), {
      kind: "native",
      facet: "procedure",
      offset: 1,
      limit: 2,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

it("preserves native API limitations and unavailable residual unknowns", () => {
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const view = {
    kind: "native",
    facet: "procedure",
    offset: 0,
    limit: 64,
  } as const;
  const unavailable = projectAnalysisView(
    nativeParent({
      ...original,
      native_api: {
        available: false,
        reason: "No decompiler",
        residual_unknowns: ["Calling convention unresolved"],
      },
    }),
    view,
  );
  if (!unavailable.ok) throw unavailable.error;
  expect(unavailable.value.unknowns).toContain("Calling convention unresolved");
  const available = projectAnalysisView(nativeParent(), view);
  if (!available.ok) throw available.error;
  if (!original.native_api?.available) throw new Error("expected API fixture");
  expect(available.value.limitations).toEqual(
    expect.arrayContaining(original.native_api.limitations),
  );
});

it("rejects artifact summary views when inspection substep coverage count disagrees", () => {
  const source = ARTIFACT_COMPARISON_EXAMPLE.left;
  const inspection = createArtifactInspection(source);
  const parent: AnalysisViewParent = {
    predicateType: "rea.analysis",
    evidenceId: `ev_${"a".repeat(64)}`,
    operation: "inspect_artifact",
    normalizedResult: {
      ...inspection,
      coverage: {
        ...inspection.coverage,
        substeps_completed: inspection.substeps.length + 1,
      },
    },
    subject: source.subject,
    limitations: [],
  };
  expect(projectAnalysisView(parent, { kind: "summary" })).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("pages every retained dossier collection and the native API record", () => {
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const page = (
    facet:
      | "basic_blocks"
      | "comments"
      | "unresolved_calls"
      | "referenced_strings"
      | "referenced_names"
      | "swift_string_literals",
    result: unknown = original,
  ) => {
    const view = projectAnalysisView(nativeParent(result), {
      kind: "native",
      facet,
      offset: 0,
      limit: 64,
    });
    if (!view.ok) throw view.error;
    return view.value;
  };
  expect(page("basic_blocks")).toMatchObject({
    item: original.basic_blocks,
    coverage: { total: original.basic_blocks.length, exhausted: true },
  });
  expect(page("referenced_strings")).toMatchObject({
    item: original.referenced_strings,
  });
  expect(
    page("comments", {
      ...original,
      comments: [{ address: "0x401000", kind: "comment", text: "entry" }],
    }),
  ).toMatchObject({ item: [{ text: "entry" }] });
  expect(page("referenced_names")).toMatchObject({ coverage: { total: 0 } });
  const literal = {
    source_address: "0x401004",
    value: "SleepDisabled",
    representation: "small",
    address: null,
    registers: ["x0", "x1"],
    words: ["0x7369447065656c53", "0xed000064656c6261"],
  };
  expect(
    page("swift_string_literals", {
      ...original,
      swift_string_literals: [literal],
      swift_string_literal_omissions: [],
    }),
  ).toMatchObject({ item: [literal], coverage: { total: 1 } });
  expect(page("swift_string_literals")).toMatchObject({
    item: { available: false, reason: "not recorded" },
  });
  const { unresolved_calls: _omitted, ...withoutUnresolved } = original;
  expect(
    page("unresolved_calls", {
      ...withoutUnresolved,
      native_value_flow: {
        available: false,
        reason: "No high p-code",
        limitations: [],
      },
    }),
  ).toMatchObject({ item: { available: false, reason: "not recorded" } });
  const api = projectAnalysisView(nativeParent(), {
    kind: "native",
    facet: "native_api",
    offset: 0,
    limit: 64,
  });
  if (!api.ok) throw api.error;
  expect(api.value).toMatchObject({
    item: original.native_api,
    coverage: { status: "complete-within-view" },
  });
});

it("reports the malformed native dossier field", () => {
  const result = projectAnalysisView(
    nativeParent({
      ...functionDossierSchema.parse(ghidraFunctionDossier()),
      pseudocode: 12,
    }),
    {
      kind: "native",
      facet: "pseudocode",
      offset: 0,
      limit: 64,
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["source", "normalized_result", "pseudocode"],
        }),
      ]),
    },
  });
});

it.each(["inspect_binary_layout", "inspect_byte_entropy"] as const)(
  "retains owning field correction paths for empty %s parents",
  (operation) => {
    expect(
      projectAnalysisView(
        { ...layoutParent(), operation, normalizedResult: {} },
        { kind: "summary" },
      ),
    ).toMatchObject({
      ok: false,
      error: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["source", "normalized_result", "artifact"],
            reason: "missing_argument",
          }),
        ]),
      },
    });
  },
);

it("native pseudocode pages do not split surrogate pairs", () => {
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const parent = nativeParent({ ...original, pseudocode: "ab😀cd" });
  expect(
    projectAnalysisView(parent, {
      kind: "native",
      facet: "pseudocode",
      offset: 3,
      limit: 2,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  const safe = projectAnalysisView(parent, {
    kind: "native",
    facet: "pseudocode",
    offset: 2,
    limit: 3,
  });
  if (!safe.ok) throw safe.error;
  expect(safe.value).toMatchObject({
    item: { text: "😀c", unit: "utf16-code-units" },
    coverage: { examined: 3, next_offset: 5 },
  });
});

it.each([
  { kind: "page", collection: "sections", offset: 0, limit: 500 },
  { kind: "native", facet: "assembly", offset: 0, limit: 500 },
])(
  "accepts caller-selected page sizes and rejects malformed bounds: $kind",
  (view) => {
    const input = {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
      view,
    };
    expect(inspectAnalysisViewInputSchema.safeParse(input).success).toBe(true);
    for (const limit of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(
        inspectAnalysisViewInputSchema.safeParse({
          ...input,
          view: { ...input.view, limit },
        }).success,
      ).toBe(false);
  },
);

it("projects layout summary, facet, item, and stable pages", () => {
  const parent = layoutParent();
  const layout = analysisViewLayoutFixture();
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value).toMatchObject({
    kind: "summary",
    parent_operation: "inspect_binary_layout",
    summary: {
      format: "elf",
      counts: { sections: 3, symbols: 3, segments: 0, relocations: 0 },
    },
    coverage: completeWithinViewCoverage(6),
  });
  const mitigations = projectAnalysisView(parent, {
    kind: "facet",
    facet: "mitigations",
  });
  if (!mitigations.ok) throw mitigations.error;
  if (mitigations.value.kind !== "facet")
    throw new Error("expected facet view");
  expect(mitigations.value.facet).toEqual(layout.mitigations);
  const data = projectAnalysisView(parent, {
    kind: "item",
    collection: "sections",
    selector: { name: ".data" },
  });
  if (!data.ok) throw data.error;
  if (data.value.kind !== "item") throw new Error("expected item view");
  expect(data.value.item).toMatchObject({
    index: 2,
    name: { display: ".data" },
  });
  const indexed = projectAnalysisView(parent, {
    kind: "item",
    collection: "sections",
    selector: { index: 0 },
  });
  if (!indexed.ok) throw indexed.error;
  expect(indexed.value.view_digest).not.toBe(data.value.view_digest);
  expect(indexed.value.view_digest).not.toBe(parent.evidenceId.slice(3));
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "sections",
    offset: 0,
    limit: 2,
  });
  if (!page.ok) throw page.error;
  expect(page.value).toMatchObject({
    kind: "page",
    coverage: {
      status: "page",
      examined: 2,
      total: 3,
      next_offset: 2,
      exhausted: false,
    },
  });
  if (page.value.kind !== "page") throw new Error("expected page view");
  expect(page.value.items).toHaveLength(2);
  const exhausted = projectAnalysisView(parent, {
    kind: "page",
    collection: "symbols",
    offset: 3,
    limit: 8,
  });
  if (!exhausted.ok) throw exhausted.error;
  expect(exhausted.value).toMatchObject({
    items: [],
    coverage: pageViewCoverage(3, 0, 3),
  });
});

it.each(["sections", "symbols"] as const)(
  "selects %s by exact source bytes and preserves opaque names by index",
  (collection) => {
    const layout = analysisViewLayoutFixture();
    const rows = layout[collection];
    const original = rows[0];
    if (original === undefined) throw new Error("missing layout row");
    const opaque = {
      ...original,
      name: {
        ...original.name,
        display: "�name",
        bytes_base64: Buffer.from([0xff, ...Buffer.from("name")]).toString(
          "base64",
        ),
      },
    };
    const valid = {
      ...rows[1],
      name: {
        ...original.name,
        display: "provider-formatted-name",
        bytes_base64: Buffer.from("�name").toString("base64"),
      },
    };
    const parent = {
      ...layoutParent(),
      normalizedResult: {
        ...layout,
        [collection]: [opaque, valid],
      },
    };
    const selected = projectAnalysisView(parent, {
      kind: "item",
      collection,
      selector: { name: "�name" },
    });
    expect(selected).toMatchObject({ ok: true, value: { item: valid } });
    expect(
      projectAnalysisView(parent, {
        kind: "item",
        collection,
        selector: { name: "\ud800name" },
      }).ok,
    ).toBe(false);
    expect(
      projectAnalysisView(parent, {
        kind: "item",
        collection,
        selector: { name: "provider-formatted-name" },
      }).ok,
    ).toBe(false);
    expect(
      projectAnalysisView(parent, {
        kind: "item",
        collection,
        selector: { index: 0 },
      }),
    ).toMatchObject({ ok: true, value: { item: opaque } });
    expect(parent.normalizedResult[collection]).toEqual([opaque, valid]);
  },
);

it.each([
  { collection: "sections", name: ".data", ambiguous: ".text" },
  { collection: "symbols", name: "start", ambiguous: "main" },
] as const)(
  "reuses sealed $collection for exact-name selections",
  ({ collection, name, ambiguous }) => {
    const layout = freezeJsonSnapshot(analysisViewLayoutFixture());
    const parent = {
      ...layoutParent(),
      normalizedResult: layout,
      sealedResult: true,
    };
    expect(isImmutableJsonSnapshot(layout[collection])).toBe(false);
    const select = (name: string) =>
      projectAnalysisView(parent, {
        kind: "item",
        collection,
        selector: { name },
      });

    const first = select(name);
    expect(first).toMatchObject({
      ok: true,
      value: { item: layout[collection][2] },
    });
    expect(isImmutableJsonSnapshot(layout[collection])).toBe(true);
    expect(select(ambiguous)).toMatchObject({
      ok: false,
      error: { issues: [{ expected: [{ index: 0 }, { index: 1 }] }] },
    });
    expect(select(name)).toEqual(first);
  },
);

it("rejects ambiguous layout names with candidate indexes", () => {
  const parent = layoutParent();
  const result = projectAnalysisView(parent, {
    kind: "item",
    collection: "sections",
    selector: { name: ".text" },
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["view", "selector", "name"],
          expected: [{ index: 0 }, { index: 1 }],
        },
      ],
    },
  });
});

it("counts JavaScript summary coverage in module units", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const moduleNode = analysis.graph.nodes[0];
  const observation = moduleNode?.observations[0];
  if (moduleNode === undefined || observation === undefined)
    throw new Error("missing module observation");
  const packageNode = createJavaScriptApplicationNode({
    kind: "artifact",
    identity: moduleNode.identity,
    observations: moduleNode.observations.map((item) => ({
      label: item.label,
      properties: item.properties,
      evidence: item.evidence,
      ...(item.source_map_reference === null
        ? {}
        : { source_map_reference: item.source_map_reference }),
    })),
  });
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [moduleNode.node_id],
    nodes: [moduleNode, packageNode],
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: analysis.graph.limitations,
  });
  const parent = javascriptParent(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value.coverage).toEqual({
    status: "complete-within-view",
    examined: 1,
    total: 1,
    next_offset: null,
    exhausted: true,
  });
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 8,
  });
  if (!page.ok) throw page.error;
  expect(page.value.coverage).toMatchObject({ examined: 1, total: 1 });
});

it("projects JavaScript summary and preserves selected module observations", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const parent = javascriptParent(analysis);
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  if (summary.value.kind !== "summary") throw new Error("expected summary");
  expect(summary.value.summary).toMatchObject({
    format: "directory",
    limitation_count: summary.value.limitations.length,
  });
  expect(JSON.stringify(summary.value)).not.toMatch(/"graph"/);
  expect(summary.value.summary).not.toHaveProperty("semantic_graph");
  const item = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "renderer.js" },
  });
  if (!item.ok) throw item.error;
  if (item.value.kind !== "item") throw new Error("expected item view");
  expect(item.value.item).toMatchObject({
    path: "renderer.js",
    kind: "javascript-asset",
    observations: expect.arrayContaining([
      expect.objectContaining({
        properties: expect.objectContaining({
          source: "export const secret = 1;\n",
          text: "should not leak",
        }),
      }),
    ]),
  });
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 8,
  });
  if (!page.ok) throw page.error;
  if (page.value.kind !== "page") throw new Error("expected page view");
  expect(page.value.items).toEqual([
    {
      node_id: analysis.graph.nodes[0]?.node_id,
      kind: "javascript-asset",
      path: "renderer.js",
    },
  ]);
  expect(page.value.coverage).toMatchObject({
    status: "page",
    examined: 1,
    total: 1,
    next_offset: null,
    exhausted: true,
  });
});

it("projects typed module facts without source bodies and keeps source coverage independent of paging", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const parent = javascriptParent(analysis);
  const input = inspectAnalysisViewInputSchema.parse({
    source: { kind: "retained-evidence", evidence_id: parent.evidenceId },
    view: {
      kind: "javascript",
      collection: "modules",
      projection: "references",
      where: { path: "renderer.js" },
      limit: 1,
    },
  });
  const projected = projectAnalysisView(parent, input.view);
  if (!projected.ok) throw projected.error;
  if (projected.value.kind !== "javascript")
    throw new Error("expected JavaScript view");
  const node = analysis.graph.nodes[0];
  if (!node) throw new Error("missing module");
  expect(projected.value.rows).toEqual([
    {
      node_id: node.node_id,
      kind: node.kind,
      path: "renderer.js",
      identity: node.identity,
      retained_source_range_count: 0,
      basis: [
        { authority: "artifact-bytes", state: "observed", confidence: "exact" },
      ],
    },
  ]);
  expect(projected.value.coverage).toMatchObject({ total: 1, exhausted: true });
  expect(projected.value.source_coverage).toMatchObject({
    application: analysis.graph.coverage,
    semantic: { status: analysis.semantic_graph.coverage.status },
  });
  expect(JSON.stringify(projected.value.rows)).not.toMatch(
    /secret|should not leak|observations/,
  );
  const row = projected.value.rows[0];
  if (!row) throw new Error("missing reference");
  const retainedIdentity = structuredClone(node.identity);
  if (row.identity.strategy !== "content-digest")
    throw new Error("expected digest identity");
  row.identity.sha256 = "e".repeat(64);
  expect(node.identity).toEqual(retainedIdentity);
  const empty = projectAnalysisView(parent, {
    ...input.view,
    kind: "javascript",
    collection: "modules",
    projection: "references",
    where: { kind: "javascript-module" },
    offset: 0,
    limit: 1,
  });
  if (!empty.ok) throw empty.error;
  expect(empty.value).toMatchObject({
    rows: [],
    coverage: { total: 0, exhausted: true },
  });
});

it("counts retained range observations including repeats and skips unavailable locations", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const original = analysis.graph.nodes.find(
    ({ kind }) => kind === "javascript-asset",
  );
  const observed = original?.observations[0];
  if (!original || !observed) throw new Error("missing module observation");
  const range = {
    kind: "source-range",
    source: "renderer.js",
    start: { line: 1, column: 0 },
    end: { line: 1, column: 8 },
  };
  const node = createJavaScriptApplicationNode({
    kind: original.kind,
    identity: original.identity,
    observations: [
      ...["first retained observation", "second retained observation"].map(
        (label) => ({
          label,
          properties: {},
          evidence: {
            ...observed.evidence,
            location: { available: true, value: range },
          },
        }),
      ),
      {
        label: "unavailable location",
        properties: {},
        evidence: {
          ...observed.evidence,
          authority: "unknown",
          state: "unavailable",
          confidence: "unknown",
          location: {
            available: false,
            reason: "not-observed",
            detail: "Location was not recorded.",
          },
          limitations: ["Location was not recorded."],
        },
      },
    ],
  });
  const { graph_id: _graphId, ...application } = analysis.graph;
  const graph = createJavaScriptApplicationGraph({
    ...application,
    nodes: [node],
    root_node_ids: [node.node_id],
    edges: [],
  });
  const parent = javascriptParent(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  const references = projectAnalysisView(parent, {
    kind: "javascript",
    collection: "modules",
    projection: "references",
    where: {},
    offset: 0,
    limit: 1,
  });
  const item = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { node_id: node.node_id },
  });
  if (!references.ok) throw references.error;
  if (!item.ok) throw item.error;
  expect(references.value).toMatchObject({
    rows: [{ node_id: node.node_id, retained_source_range_count: 2 }],
  });
  expect(item.value).toMatchObject({ item: { source_ranges: [range, range] } });
});

it("validates typed module selectors without coercing null or empty paths", () => {
  const source = {
    kind: "retained-evidence",
    evidence_id: javascriptParent().evidenceId,
  };
  const view = {
    kind: "javascript",
    collection: "modules",
    projection: "references",
  };
  for (const path of [null, "", "renderer.js"])
    expect(
      inspectAnalysisViewInputSchema.safeParse({
        source,
        view: { ...view, where: { path } },
      }).success,
    ).toBe(true);
  for (const where of [
    { path: 1 },
    { kind: "electron-main" },
    { glob: "*.js" },
  ])
    expect(
      inspectAnalysisViewInputSchema.safeParse({
        source,
        view: { ...view, where },
      }).success,
    ).toBe(false);
  expect(
    projectAnalysisView(layoutParent(), {
      ...view,
      kind: "javascript",
      collection: "modules",
      projection: "references",
      where: {},
      offset: 0,
      limit: 1,
    }).ok,
  ).toBe(false);
});

it("keeps mixed observation support distinct instead of promoting a module to observed", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const original = analysis.graph.nodes.find(
    ({ kind }) => kind === "javascript-asset",
  );
  const observed = original?.observations[0];
  if (!original || !observed) throw new Error("missing module observation");
  const inferred = {
    ...observed.evidence,
    authority: "static-relationship-inference" as const,
    state: "inferred" as const,
    confidence: "low" as const,
    limitations: ["Static candidate; runtime loading is unknown."],
  };
  const node = createJavaScriptApplicationNode({
    kind: original.kind,
    identity: original.identity,
    observations: [
      {
        label: observed.label,
        properties: observed.properties,
        evidence: observed.evidence,
      },
      { label: "candidate one", properties: {}, evidence: inferred },
      { label: "candidate two", properties: {}, evidence: inferred },
    ],
  });
  const { graph_id: _graphId, ...application } = analysis.graph;
  const graph = createJavaScriptApplicationGraph({
    ...application,
    nodes: [node],
    root_node_ids: [node.node_id],
    edges: [],
  });
  const result = projectAnalysisView(
    javascriptParent(analysisViewBindJavaScriptGraphs(analysis, graph)),
    {
      kind: "javascript",
      collection: "modules",
      projection: "references",
      where: {},
      offset: 0,
      limit: 1,
    },
  );
  if (!result.ok) throw result.error;
  if (result.value.kind !== "javascript")
    throw new Error("expected references");
  expect(result.value.rows[0]?.basis).toHaveLength(2);
  expect(result.value.rows[0]?.basis).toEqual(
    expect.arrayContaining([
      { authority: "artifact-bytes", state: "observed", confidence: "exact" },
      {
        authority: "static-relationship-inference",
        state: "inferred",
        confidence: "low",
      },
    ]),
  );
});

it("rejects ambiguous JavaScript module paths with candidate node ids", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const first = analysis.graph.nodes[0];
  if (first === undefined) throw new Error("missing module");
  const duplicate = createJavaScriptApplicationNode({
    kind: first.kind,
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: "c".repeat(64),
    },
    observations: first.observations.map((observation) => ({
      label: observation.label,
      properties: observation.properties,
      evidence: {
        ...observation.evidence,
        artifact: {
          ...observation.evidence.artifact,
          sha256: "c".repeat(64),
          artifact_id: `art_${"c".repeat(64)}`,
        },
      },
    })),
  });
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [first.node_id, duplicate.node_id],
    nodes: [first, duplicate],
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: analysis.graph.limitations,
  });
  const parent = javascriptParent(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  const result = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "renderer.js" },
  });
  if (result.ok) throw new Error("expected ambiguous path");
  expect(result.error).toMatchObject({
    _tag: "AnalysisInputError",
    issues: [
      {
        path: ["view", "selector", "path"],
        expected: expect.arrayContaining([
          { node_id: first.node_id },
          { node_id: duplicate.node_id },
        ]),
      },
    ],
  });
  const view = {
    kind: "javascript",
    collection: "modules",
    projection: "references",
    where: { path: "renderer.js" },
    offset: 0,
    limit: 1,
  } as const;
  const ids: string[] = [];
  for (const offset of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
    const page = projectAnalysisView(parent, { ...view, offset });
    if (!page.ok) throw page.error;
    if (page.value.kind !== "javascript")
      throw new Error("expected references");
    ids.push(...page.value.rows.map(({ node_id }) => node_id));
    expect(page.value.coverage).toMatchObject({
      total: 2,
      next_offset: offset === 0 ? 1 : null,
      exhausted: offset !== 0,
    });
  }
  expect(ids).toEqual(graph.nodes.map(({ node_id }) => node_id));
});

it("keeps export bindings out of module pages and path selection", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const original = analysis.graph.nodes[0];
  const observation = original?.observations[0];
  if (original === undefined || observation === undefined)
    throw new Error("missing module observation");
  const exportBinding = createJavaScriptApplicationNode({
    kind: "javascript-module",
    identity: {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: "c".repeat(64),
      namespace: "module-export",
      key: "renderer.js:alpha",
    },
    observations: [
      {
        label: "renderer.js:alpha",
        properties: {
          semantic_role: "export-binding",
          module_path: "renderer.js",
          exported_name: "alpha",
        },
        evidence: {
          ...observation.evidence,
          artifact: {
            ...observation.evidence.artifact,
            sha256: "c".repeat(64),
            artifact_id: `art_${"c".repeat(64)}`,
          },
        },
      },
    ],
  });
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [original.node_id, exportBinding.node_id],
    nodes: [original, exportBinding],
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: analysis.graph.limitations,
  });
  const parent = javascriptParent(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 10,
  });
  if (!page.ok) throw page.error;
  if (page.value.kind !== "page") throw new Error("expected page");
  expect(page.value.items).toEqual([
    {
      node_id: original.node_id,
      kind: original.kind,
      path: "renderer.js",
    },
  ]);
  expect(page.value.coverage).toMatchObject({
    total: 1,
    examined: 1,
    exhausted: true,
  });
  const item = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "renderer.js" },
  });
  if (!item.ok) throw item.error;
  if (item.value.kind !== "item") throw new Error("expected item view");
  expect(item.value.item).toMatchObject({ node_id: original.node_id });
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value.coverage).toMatchObject({ total: 1, examined: 1 });
});

it("pages actual modules, including unknown and empty paths, without unrelated roles", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const original = analysis.graph.nodes[0];
  if (original === undefined) throw new Error("missing module");
  const nodes = [
    original,
    ...(
      [
        "asar-entry",
        "electron-renderer",
        "javascript-module",
        "source-module",
      ] as const
    ).map((kind) =>
      createJavaScriptApplicationNode({
        kind,
        identity:
          kind === "source-module"
            ? {
                strategy: "source-map-original",
                source_root: null,
                stability: "source-map-exact",
                original_source: "",
                source_map_sha256: "c".repeat(64),
                source_sha256: null,
              }
            : kind === "javascript-module"
              ? {
                  strategy: "artifact-local-key",
                  stability: "artifact-version",
                  artifact_sha256: "c".repeat(64),
                  namespace: kind,
                  key: "module",
                }
              : original.identity,
        observations: original.observations.map((observation) => ({
          ...(kind === "source-module"
            ? {
                source_map_reference: sourceMapReference(
                  "",
                  null,
                  "renderer.js",
                ),
              }
            : {}),
          label: observation.label,
          properties: {},
          evidence:
            kind === "javascript-module" || kind === "source-module"
              ? {
                  ...observation.evidence,
                  artifact: {
                    ...observation.evidence.artifact,
                    sha256: "c".repeat(64),
                    artifact_id: `art_${"c".repeat(64)}`,
                  },
                  ...(kind === "javascript-module"
                    ? {
                        state: "unknown",
                        confidence: "unknown",
                        limitations: ["Source location unavailable"],
                        location: {
                          available: false,
                          reason: "unknown",
                          detail: "Source location unavailable",
                        },
                      }
                    : {}),
                }
              : observation.evidence,
        })),
      }),
    ),
  ];
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: nodes.map((node) => node.node_id),
    nodes,
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: [],
  });
  const parent = javascriptParent(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 1000,
  });
  if (!page.ok) throw page.error;
  expect(page.value).toMatchObject({
    coverage: { total: 3, examined: 3, exhausted: true },
  });
  if (page.value.kind !== "page") throw new Error("expected page");
  expect(page.value.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "javascript-module", path: null }),
      expect.objectContaining({ kind: "source-module", path: "" }),
    ]),
  );
  const emptyPath = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "" },
  });
  for (const [path, kind] of [
    [null, "javascript-module"],
    ["", "source-module"],
  ] as const) {
    const references = projectAnalysisView(parent, {
      kind: "javascript",
      collection: "modules",
      projection: "references",
      where: { path },
      offset: 0,
      limit: 1,
    });
    if (!references.ok) throw references.error;
    expect(references.value).toMatchObject({
      rows: [{ path, kind }],
      coverage: { total: 1, exhausted: true },
    });
  }
  expect(emptyPath.ok).toBe(true);
  const role = nodes.find((node) => node.kind === "electron-renderer");
  if (role === undefined) throw new Error("missing role");
  expect(
    projectAnalysisView(parent, {
      kind: "item",
      collection: "modules",
      selector: { node_id: role.node_id },
    }).ok,
  ).toBe(false);
});

const complete = <Value>(steps: Generator<void, Value>): Value => {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

it("reuses authenticated graphs while rejecting malformed metadata and imported companions", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const { graph_id: _applicationId, ...application } = analysis.graph;
  const graph = complete(
    createImmutableJavaScriptApplicationGraphSteps(application),
  );
  const { graph_id: _semanticId, ...semantic } = analysis.semantic_graph;
  const semanticGraph = complete(
    sealTransferredJavaScriptSemanticGraphSteps({
      ...semantic,
      application_graph_id: graph.graph_id,
    }),
  );
  const owned = { ...analysis, graph, semantic_graph: semanticGraph };
  expect(
    projectAnalysisView(javascriptParent(owned), { kind: "summary" }).ok,
  ).toBe(true);
  for (const malformed of [
    { ...owned, root_artifact_sha256: "d".repeat(64) },
    {
      ...owned,
      statistics: { ...owned.statistics, parsed_javascript_files: -1 },
    },
    {
      ...owned,
      semantic_graph: Object.freeze({
        ...semanticGraph,
        application_graph_id: "jag_" + "d".repeat(64),
      }),
    },
  ]) {
    const result = projectAnalysisView(
      { ...javascriptParent(owned), normalizedResult: malformed },
      { kind: "summary" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.arrayContaining(["source", "normalized_result"]),
          }),
        ]),
      },
    });
  }
});

it("retains semantic coverage and limitations in a summary", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const { graph_id: _graphId, ...semantic } = analysis.semantic_graph;
  const semanticGraph = createJavaScriptSemanticGraph({
    ...semantic,
    coverage: {
      ...semantic.coverage,
      status: "partial",
      truncated: true,
      omitted_nodes: null,
      omitted_relations: null,
      limits: [
        { name: "semantic_graph_node_ceiling", value: 100000, unit: "items" },
      ],
    },
    limitations: ["Some semantic nodes could not be retained."],
  });
  const result = projectAnalysisView(
    javascriptParent({ ...analysis, semantic_graph: semanticGraph }),
    { kind: "summary" },
  );
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    summary: {
      limitation_count: 1,
      coverage: { semantic: { status: "partial", truncated: true } },
    },
    limitations: ["Some semantic nodes could not be retained."],
    unknowns: expect.arrayContaining([
      "semantic_graph.coverage.status is partial",
    ]),
  });
});

it.each([63, 64, 65, 10_000])(
  "bounds and deduplicates %i messages in JavaScript and layout views",
  (count) => {
    const messages = Array.from(
      { length: count },
      (_, index) => `Module ${String(index).padStart(5, "0")} was not parsed.`,
    );
    const analysis = analysisViewJavaScriptAnalysis();
    const { graph_id: _graphId, ...semantic } = analysis.semantic_graph;
    const parent = javascriptParent({
      ...analysis,
      limitations: messages,
      semantic_graph: createJavaScriptSemanticGraph({
        ...semantic,
        limitations: messages.slice(0, 1),
      }),
    });
    const duplicatedParent = { ...parent, limitations: messages };
    const notice = (
      omitted: number,
      field: "limitations" | "unknowns",
      evidenceId: string,
    ) =>
      `${String(omitted)} additional ${field} omitted from this view; consult source parent Evidence ${evidenceId} for the complete list (the caller-supplied record, or its retaining session).`;
    for (const view of [
      { kind: "summary" },
      { kind: "page", collection: "modules", offset: 0, limit: 1 },
    ] as const) {
      const result = projectAnalysisView(duplicatedParent, view);
      if (!result.ok) throw result.error;
      if (
        result.value.kind === "summary" &&
        result.value.parent_operation === "analyze_javascript_application"
      )
        expect(result.value.summary.limitation_count).toBe(count);
      if (count <= 65) {
        expect(result.value.limitations).toEqual(messages);
        expect(result.value.unknowns).toEqual(
          [...messages, "semantic_graph.coverage.status is unknown"].sort(),
        );
      } else {
        const limitations = result.value.limitations;
        const unknowns = result.value.unknowns;
        expect(limitations.length).toBeGreaterThan(65);
        expect(limitations.at(-1)).toBe(
          notice(
            count - limitations.length + 1,
            "limitations",
            parent.evidenceId,
          ),
        );
        expect(unknowns.length).toBeGreaterThan(65);
        expect(unknowns.at(-1)).toBe(
          notice(
            count + 1 - unknowns.length + 1,
            "unknowns",
            parent.evidenceId,
          ),
        );
      }
    }
    const layout = layoutParent();
    const layoutWithMessages = {
      ...layout,
      limitations: messages,
      normalizedResult: {
        ...analysisViewLayoutFixture(),
        limitations: messages,
      },
    };
    for (const view of [
      { kind: "summary" },
      { kind: "page", collection: "sections", offset: 0, limit: 1 },
    ] as const) {
      const result = projectAnalysisView(layoutWithMessages, view);
      if (!result.ok) throw result.error;
      if (count <= 65) expect(result.value.limitations).toEqual(messages);
      else {
        expect(result.value.limitations.length).toBeGreaterThan(65);
        expect(result.value.limitations.at(-1)).toBe(
          notice(
            count - result.value.limitations.length + 1,
            "limitations",
            layout.evidenceId,
          ),
        );
      }
    }
  },
);

it.each(["partial", "unknown"] as const)(
  "preserves %s parent graph completeness when a module page is exhausted",
  (status) => {
    const analysis = analysisViewJavaScriptAnalysis();
    const first = analysis.graph.nodes[0];
    if (first === undefined) throw new Error("missing module");
    const unknown = createJavaScriptApplicationNode({
      kind: "unknown",
      identity: {
        strategy: "observation-fingerprint",
        stability: "observation-only",
        observation_sha256: "8".repeat(64),
        scope: "unclassified module",
      },
      observations: first.observations.map((observation) => ({
        label: "unclassified module",
        properties: {},
        evidence: observation.evidence,
      })),
    });
    const messages = [
      ...Array.from(
        { length: 65 },
        (_, index) =>
          `Module ${String(index).padStart(5, "0")} was not parsed.`,
      ),
      "z".repeat(300_000),
    ];
    const { graph_id: _applicationId, ...application } = analysis.graph;
    const graph = createJavaScriptApplicationGraph({
      ...application,
      nodes: [...application.nodes, unknown],
      limitations: messages.slice(0, 1),
      coverage: { ...application.coverage, status, omitted_count: null },
    });
    const bound = analysisViewBindJavaScriptGraphs(analysis, graph);
    const { graph_id: _semanticId, ...semantic } = bound.semantic_graph;
    const parent = javascriptParent({
      ...bound,
      limitations: messages,
      semantic_graph: createJavaScriptSemanticGraph({
        ...semantic,
        limitations: messages.slice(0, 1),
      }),
    });
    for (const view of [
      { kind: "page", collection: "modules", offset: 0, limit: 10 },
      {
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: {},
        offset: 0,
        limit: 10,
      },
      {
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: { path: "not-retained.js" },
        offset: 0,
        limit: 10,
      },
      {
        kind: "item",
        collection: "modules",
        selector: { path: "renderer.js" },
      },
    ] as const) {
      const result = projectAnalysisView(parent, view);
      if (!result.ok) throw result.error;
      if (result.value.coverage === null)
        throw new Error("Expected known coverage");
      expect(result.value.coverage.exhausted).toBe(true);
      if (result.value.kind === "javascript")
        expect(result.value.source_coverage).toMatchObject({
          application: { status, omitted_count: null },
          semantic: { status: "unknown" },
          application_unknown_count: 1,
        });
      expect(result.value.unknowns).toEqual([
        "1 application graph unknowns remain in the parent Evidence.",
        ...messages.slice(0, 65),
        `graph.coverage.status is ${status}`,
        "semantic_graph.coverage.status is unknown",
        `1 additional unknowns omitted from this view; consult source parent Evidence ${parent.evidenceId} for the complete list (the caller-supplied record, or its retaining session).`,
      ]);
    }
  },
);

it("does not match unavailable layout names using a display placeholder", () => {
  const layout = analysisViewLayoutFixture();
  const section = layout.sections[2];
  if (section === undefined) throw new Error("missing section");
  const result = projectAnalysisView(
    {
      ...layoutParent(),
      normalizedResult: {
        ...layout,
        sections: [
          ...layout.sections.slice(0, 2),
          {
            ...section,
            name: {
              ...section.name,
              display: "<unavailable>",
              unknown_reason: "Name bytes unavailable",
              bytes_base64: null,
              location: null,
            },
          },
        ],
      },
    },
    {
      kind: "item",
      collection: "sections",
      selector: { name: "<unavailable>" },
    },
  );
  expect(result.ok).toBe(false);
});

it("rejects unsupported parent operations and incompatible collections", () => {
  expect(
    projectAnalysisView(layoutParent(), {
      kind: "managed",
      collection: "attributes",
      offset: 0,
      limit: 1,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  const unsupported = projectAnalysisView(
    {
      predicateType: "rea.analysis",
      evidenceId: `ev_${"d".repeat(64)}`,
      operation: "inspect_recorded_crash",
      normalizedResult: { path: "/artifacts/crash.core" },
      limitations: [],
    },
    { kind: "summary" },
  );
  expect(unsupported).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisTargetFailureError" },
  });
  const modulesOnLayout = projectAnalysisView(layoutParent(), {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 1,
  });
  expect(modulesOnLayout).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  const sectionsOnJs = projectAnalysisView(javascriptParent(), {
    kind: "item",
    collection: "sections",
    selector: { name: ".text" },
  });
  expect(sectionsOnJs).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("keeps the complete unique set when it fits the byte budget", () => {
  const messages = ["a".repeat(2_400), "b".repeat(2_400)];
  expect(
    boundedViewMessages(messages, `ev_${"a".repeat(64)}`, "limitations"),
  ).toEqual(messages);
});

it("does not impose a message-count cutoff below the byte budget", () => {
  const messages = Array.from(
    { length: 100 },
    (_, index) => `message ${String(index).padStart(2, "0")}`,
  );
  expect(
    boundedViewMessages(messages, `ev_${"a".repeat(64)}`, "limitations"),
  ).toEqual(messages.toSorted());
});

it("bounds repeated view messages even when fewer than 64 source strings are huge", () => {
  const oversized = ["\u0000".repeat(300_000), "\\".repeat(300_000)];
  const projected = boundedViewMessages(
    oversized,
    `ev_${"a".repeat(64)}`,
    "limitations",
  );
  expect(projected).toHaveLength(1);
  expect(projected[0]).toContain("2 additional limitations omitted");
  expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(256 * 1024);
});

it("preserves selected native facet unavailability instead of an exhausted empty page", () => {
  const parent = nativeParent({
    ...functionDossierSchema.parse(ghidraFunctionDossier()),
    facet_availability: {
      comments: { available: false, reason: "Typed comments unavailable" },
      references: { available: false, reason: "Typed references unavailable" },
    },
  });
  for (const [facet, reason] of [
    ["comments", "Typed comments unavailable"],
    ["incoming_references", "Typed references unavailable"],
  ] as const) {
    const result = projectAnalysisView(parent, {
      kind: "native",
      facet,
      offset: 0,
      limit: 8,
    });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      item: { available: false, reason },
      unknowns: expect.arrayContaining([reason]),
    });
  }
});

it("selects a unique content-deduplicated module by any retained path", () => {
  const source = analysisViewJavaScriptAnalysisWithSource();
  const original = source.graph.nodes[0];
  const observation = original?.observations[0];
  if (original === undefined || observation === undefined)
    throw new Error("Missing module fixture");
  const node = createJavaScriptApplicationNode({
    kind: original.kind,
    identity: original.identity,
    observations: [
      ...original.observations.map(({ label, properties, evidence }) => ({
        label,
        properties,
        evidence,
      })),
      {
        evidence: observation.evidence,
        label: "renderer-alias.js",
        properties: { ...observation.properties, path: "renderer-alias.js" },
      },
    ],
  });
  const { graph_id: _graphId, ...graphFacts } = source.graph;
  const graph = createJavaScriptApplicationGraph({
    ...graphFacts,
    nodes: [node],
  });
  const parent = javascriptParent(
    analysisViewBindJavaScriptGraphs(source, graph),
  );
  for (const path of ["renderer.js", "renderer-alias.js"]) {
    const selected = projectAnalysisView(parent, {
      kind: "item",
      collection: "modules",
      selector: { path },
    });
    if (!selected.ok) throw selected.error;
    expect(selected.value).toMatchObject({
      kind: "item",
      item: { node_id: node.node_id, path },
    });
  }
});

it("ranks only the longest byte entropy runs with stable offset ties", () => {
  const runs = Array.from({ length: 1024 }, (_, index) => ({
    offset: Math.floor((1023 - index) / 2) * 256,
    length: ((index % 19) + 1) * 256,
    classification: index % 2 === 0 ? "high" : "low",
  }));
  runs.push({ offset: 0, length: 8192, classification: "high" });
  runs.push({ offset: 0, length: 8192, classification: "low" });
  const result = projectAnalysisView(
    {
      predicateType: "rea.byte-entropy",
      evidenceId: `ev_${"1".repeat(64)}`,
      operation: "inspect_byte_entropy",
      limitations: [],
      normalizedResult: {
        artifact: {
          path: "/tmp/fixture",
          bytes: 262144,
          sha256: "2".repeat(64),
        },
        block_size: 256,
        window: { offset: 0, length: 262144 },
        file_entropy: 4,
        thresholds: { high: 7.5, low: 0.5 },
        blocks: [],
        runs,
        limitations: [],
      },
    },
    { kind: "summary" },
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      summary: {
        run_count: runs.length,
        top_runs: runs
          .toSorted((a, b) => b.length - a.length || a.offset - b.offset)
          .slice(0, 10),
      },
    },
  });
});

const entropyParent = (blockCount: number) => {
  const blocks = Array.from({ length: blockCount }, (_, index) => ({
    offset: 16 + index * 256,
    length: 256,
    entropy: index % 3 === 2 ? 4 : index % 3 === 0 ? 7.9 : 0.1,
  }));
  const runs = blocks.flatMap((block) =>
    block.entropy === 4
      ? []
      : [
          {
            offset: block.offset,
            length: block.length,
            classification: block.entropy > 4 ? "high" : "low",
          },
        ],
  );
  return {
    predicateType: "rea.byte-entropy",
    evidenceId: `ev_${"3".repeat(64)}`,
    operation: "inspect_byte_entropy",
    limitations: [],
    normalizedResult: {
      artifact: {
        path: "/tmp/fixture",
        bytes: 16 + blockCount * 256,
        sha256: "4".repeat(64),
      },
      block_size: 256,
      window: { offset: 16, length: blockCount * 256 },
      file_entropy: 4,
      thresholds: { high: 7.2, low: 1 },
      blocks,
      runs,
      limitations: [],
    },
  };
};

it("lists the first runs in offset order in the byte entropy summary", () => {
  const parent = entropyParent(200);
  const runs = parent.normalizedResult.runs;
  const result = projectAnalysisView(parent, { kind: "summary" });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    summary: { block_count: 200, run_count: runs.length },
  });
  expect(runs.length).toBeGreaterThan(64);
  expect((result.value as { summary: { runs: unknown } }).summary.runs).toEqual(
    runs.slice(0, 64),
  );
});

it("pages retained byte entropy blocks and runs by index with a cursor", () => {
  const parent = entropyParent(200);
  const blocks = projectAnalysisView(parent, {
    kind: "byte-entropy",
    collection: "blocks",
    offset: 190,
    limit: 4,
  });
  if (!blocks.ok) throw blocks.error;
  expect(blocks.value).toMatchObject({
    kind: "byte-entropy",
    parent_evidence_id: parent.evidenceId,
    entropy: {
      block_size: 256,
      window: { offset: 16, length: 51200 },
      block_count: 200,
      run_count: parent.normalizedResult.runs.length,
    },
    items: parent.normalizedResult.blocks.slice(190, 194),
    coverage: { status: "page", total: 200, next_offset: 194 },
  });
  const runs = projectAnalysisView(parent, {
    kind: "byte-entropy",
    collection: "runs",
    offset: 130,
    limit: 64,
  });
  if (!runs.ok) throw runs.error;
  expect(runs.value).toMatchObject({
    items: parent.normalizedResult.runs.slice(130),
    coverage: {
      total: parent.normalizedResult.runs.length,
      next_offset: null,
      exhausted: true,
    },
  });
  expect(
    projectAnalysisView(parent, {
      kind: "native-exports",
      collection: "issues",
      offset: 0,
      limit: 1,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

const multiModuleJavaScriptAnalysis = () => {
  const base = analysisViewJavaScriptAnalysis();
  const baseObs = base.graph.nodes[0]!.observations[0]!;
  const makeNode = (
    kind: "javascript-asset" | "javascript-module",
    path: string,
    shaSuffix: string,
    extraPaths: readonly string[] = [],
  ) => {
    const sha256 = shaSuffix.repeat(64);
    const makeObs = (obsPath: string | null, tag: string) => ({
      label: tag,
      properties: { ...(obsPath === null ? {} : { path: obsPath }), tag },
      evidence: {
        ...baseObs.evidence,
        ...(obsPath === null
          ? {
              state: "inferred" as const,
              confidence: "medium" as const,
              limitations: ["Inferred without source location"],
            }
          : {}),
        artifact: {
          available: true as const,
          artifact_id: `art_${sha256}`,
          sha256,
        },
        location:
          obsPath === null
            ? {
                available: false as const,
                reason: "not-applicable" as const,
                detail: "Location omitted",
              }
            : {
                available: true as const,
                value: { kind: "artifact-path" as const, path: obsPath },
              },
      },
    });
    return createJavaScriptApplicationNode({
      kind,
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256,
      },
      observations: [
        makeObs(path, `${tagPrefix(kind)}:${path}`),
        ...extraPaths.map((extra) =>
          makeObs(extra, `${tagPrefix(kind)}:${extra}`),
        ),
        makeObs(null, `${tagPrefix(kind)}:noloc`),
      ],
    });
  };
  const tagPrefix = (kind: "javascript-asset" | "javascript-module") =>
    kind === "javascript-asset" ? "asset" : "mod";
  const assetA = makeNode("javascript-asset", "a.js", "1", ["b.js"]);
  const modB = makeNode("javascript-module", "b.js", "2");
  const assetA2 = makeNode("javascript-asset", "a.js", "3");
  const modC = makeNode("javascript-module", "c.js", "4");
  const { graph_id: _gid, ...restGraph } = base.graph;
  const graph = createJavaScriptApplicationGraph({
    ...restGraph,
    root_node_ids: [base.graph.nodes[0]!.node_id],
    nodes: [base.graph.nodes[0]!, assetA, modB, assetA2, modC],
    edges: [],
  });
  return {
    analysis: analysisViewBindJavaScriptGraphs(base, graph),
    ids: {
      assetA: assetA.node_id,
      modB: modB.node_id,
      assetA2: assetA2.node_id,
      modC: modC.node_id,
    },
  };
};

it("preserves exact parity and WeakMap reuse for indexed JavaScript module and fact views", () => {
  const { analysis, ids } = multiModuleJavaScriptAnalysis();
  const unsealed = javascriptParent(analysis);
  const sealed: AnalysisViewParent = {
    ...unsealed,
    sealedResult: true,
    normalizedResult: freezeJsonSnapshot(structuredClone(analysis)),
  };
  const parseSpy = vi.spyOn(
    jsApplicationAnalysis,
    "parseOwnedJavaScriptApplicationAnalysisSteps",
  );
  try {
    const views: AnalysisViewRequest[] = [
      { kind: "summary" },
      { kind: "item", collection: "modules", selector: { node_id: ids.modB } },
      { kind: "item", collection: "modules", selector: { node_id: "missing" } },
      { kind: "item", collection: "modules", selector: { path: "c.js" } },
      { kind: "item", collection: "modules", selector: { path: "a.js" } },
      { kind: "item", collection: "modules", selector: { path: "none.js" } },
      { kind: "page", collection: "modules", offset: 1, limit: 2 },
      {
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: {},
        offset: 1,
        limit: 2,
      },
      {
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: { path: "b.js" },
        offset: 0,
        limit: 10,
      },
      {
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: { kind: "javascript-module" },
        offset: 0,
        limit: 10,
      },
      {
        kind: "javascript",
        collection: "modules",
        projection: "references",
        where: { kind: "javascript-asset", path: "b.js" },
        offset: 0,
        limit: 10,
      },
      {
        kind: "javascript-facts",
        where: {},
        property_keys: ["tag", "path"],
        include_available_property_keys: true,
        offset: 1,
        limit: 5,
      },
      {
        kind: "javascript-facts",
        where: { kinds: ["javascript-asset"], paths: ["a.js"] },
        property_keys: ["tag"],
        include_available_property_keys: false,
        offset: 0,
        limit: 10,
      },
      {
        kind: "javascript-facts",
        where: {
          kinds: ["javascript-module", "javascript-asset"],
          paths: ["b.js", "a.js"],
        },
        property_keys: ["tag"],
        include_available_property_keys: false,
        offset: 1,
        limit: 4,
      },
      {
        kind: "javascript-facts",
        where: { kinds: [] },
        property_keys: [],
        include_available_property_keys: false,
        offset: 0,
        limit: 10,
      },
    ];

    const sealedResults = views.map((view) =>
      projectAnalysisView(sealed, view),
    );
    expect(parseSpy).toHaveBeenCalledTimes(1);
    for (const [index, view] of views.entries()) {
      const sealedRes = sealedResults[index]!;
      const unsealedRes = projectAnalysisView(unsealed, view);
      expect(sealedRes.ok).toBe(unsealedRes.ok);
      if (sealedRes.ok && unsealedRes.ok)
        expect(sealedRes.value).toEqual(unsealedRes.value);
    }
    expect(parseSpy).toHaveBeenCalledTimes(1 + views.length);

    const factView = inspectAnalysisViewInputSchema.parse({
      source: { kind: "inline", evidence: {} },
      view: {
        kind: "javascript-facts",
        where: {
          kinds: ["javascript-module", "javascript-asset"],
          paths: ["b.js", "a.js"],
        },
        property_keys: ["tag"],
        offset: 0,
        limit: 10,
      },
    }).view;
    if (factView.kind !== "javascript-facts") throw new Error("wrong view");
    expect(
      projectJavaScriptFacts(
        (sealed.normalizedResult as typeof analysis).graph.nodes,
        factView,
        sealed.normalizedResult as object,
      ),
    ).toEqual(projectJavaScriptFacts(analysis.graph.nodes, factView));
  } finally {
    parseSpy.mockRestore();
  }
});

const interleavedFactsJavaScriptAnalysis = () => {
  const base = analysisViewJavaScriptAnalysis();
  const baseObs = base.graph.nodes[0]!.observations[0]!;
  type FactKind =
    | "javascript-asset"
    | "javascript-module"
    | "javascript-expression"
    | "browser-window"
    | "native-addon";
  type ObsSpec =
    | {
        readonly kind: "artifact-path";
        readonly path: string;
        readonly tag: string;
      }
    | {
        readonly kind: "source-range";
        readonly source: string;
        readonly tag: string;
      }
    | { readonly kind: "url"; readonly url: string; readonly tag: string }
    | { readonly kind: "unavailable"; readonly tag: string };

  let counter = 0;
  const makeNode = (kind: FactKind, specs: readonly ObsSpec[]) => {
    counter += 1;
    const hex = counter.toString(16).padStart(2, "0");
    const sha256 = hex.repeat(32);
    return createJavaScriptApplicationNode({
      kind,
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256,
      },
      observations: specs.map((spec) => ({
        label: spec.tag,
        properties: {
          tag: spec.tag,
          ...(spec.kind === "artifact-path"
            ? { path: spec.path }
            : spec.kind === "source-range"
              ? { path: spec.source }
              : {}),
        },
        evidence: {
          ...baseObs.evidence,
          ...(spec.kind === "unavailable"
            ? {
                state: "inferred" as const,
                confidence: "medium" as const,
                limitations: ["Inferred without source location"],
              }
            : {}),
          artifact: {
            available: true as const,
            artifact_id: `art_${sha256}`,
            sha256,
          },
          location:
            spec.kind === "artifact-path"
              ? {
                  available: true as const,
                  value: { kind: "artifact-path" as const, path: spec.path },
                }
              : spec.kind === "source-range"
                ? {
                    available: true as const,
                    value: {
                      kind: "source-range" as const,
                      source: spec.source,
                      start: { line: 1, column: 0 },
                      end: { line: 1, column: 8 },
                    },
                  }
                : spec.kind === "url"
                  ? {
                      available: true as const,
                      value: { kind: "url" as const, url: spec.url },
                    }
                  : {
                      available: false as const,
                      reason: "not-applicable" as const,
                      detail: "Location omitted",
                    },
        },
      })),
    });
  };

  const nodes = [
    base.graph.nodes[0]!,
    makeNode("javascript-asset", [
      { kind: "artifact-path", path: "a.js", tag: "asset-a-1" },
      { kind: "artifact-path", path: "b.js", tag: "asset-b-1" },
      { kind: "source-range", source: "d.js", tag: "asset-d-1" },
    ]),
    makeNode("javascript-module", [
      { kind: "artifact-path", path: "b.js", tag: "mod-b-1" },
      { kind: "artifact-path", path: "a.js", tag: "mod-a-1" },
      { kind: "unavailable", tag: "mod-noloc-1" },
    ]),
    makeNode("browser-window", [
      { kind: "artifact-path", path: "c.js", tag: "win-c-1" },
      {
        kind: "url",
        url: "https://example.invalid/app.html",
        tag: "win-url-1",
      },
    ]),
    makeNode("javascript-expression", [
      { kind: "source-range", source: "d.js", tag: "expr-d-1" },
      { kind: "artifact-path", path: "a.js", tag: "expr-a-1" },
    ]),
    makeNode("javascript-module", [
      { kind: "source-range", source: "d.js", tag: "mod-d-1" },
      { kind: "artifact-path", path: "b.js", tag: "mod-b-2" },
    ]),
    // Skewed large bucket in (javascript-asset, a.js) plus small interleaved entries
    makeNode(
      "javascript-asset",
      Array.from({ length: 14 }, (_, idx) => ({
        kind: "artifact-path" as const,
        path: "a.js",
        tag: `asset-a-bulk-${idx}`,
      })),
    ),
    makeNode("native-addon", [
      { kind: "artifact-path", path: "c.js", tag: "addon-c-1" },
    ]),
    makeNode("javascript-asset", [
      { kind: "artifact-path", path: "b.js", tag: "asset-b-2" },
      { kind: "artifact-path", path: "a.js", tag: "asset-a-2" },
    ]),
    makeNode("browser-window", [
      { kind: "artifact-path", path: "a.js", tag: "win-a-1" },
    ]),
  ];

  const { graph_id: _gid, ...restGraph } = base.graph;
  const graph = createJavaScriptApplicationGraph({
    ...restGraph,
    root_node_ids: [base.graph.nodes[0]!.node_id],
    nodes,
    edges: [],
  });
  return analysisViewBindJavaScriptGraphs(base, graph);
};

it("paginates multi-bucket JavaScript facts with exact parity across kinds, paths, and combined filters", () => {
  const analysis = interleavedFactsJavaScriptAnalysis();
  const unsealed = javascriptParent(analysis);
  const sealedResult = freezeJsonSnapshot(structuredClone(analysis));
  const sealed: AnalysisViewParent = {
    ...unsealed,
    sealedResult: true,
    normalizedResult: sealedResult,
  };
  const sealedNodes = (sealedResult as typeof analysis).graph.nodes;

  const whereModes: readonly {
    readonly paths?: readonly string[];
    readonly kinds?: readonly (typeof analysis.graph.nodes)[number]["kind"][];
  }[] = [
    { kinds: ["javascript-asset", "javascript-module", "browser-window"] },
    { paths: ["a.js", "b.js", "d.js"] },
    {
      kinds: ["javascript-asset", "javascript-module"],
      paths: ["a.js", "b.js", "d.js"],
    },
  ];

  for (const where of whereModes) {
    const baseline = projectJavaScriptFacts(analysis.graph.nodes, {
      kind: "javascript-facts",
      where: {
        ...(where.paths ? { paths: [...where.paths] } : {}),
        ...(where.kinds ? { kinds: [...where.kinds] } : {}),
      },
      property_keys: ["tag", "path"],
      include_available_property_keys: true,
      offset: 0,
      limit: 1000,
    });
    const total = baseline.total;
    expect(total).toBeGreaterThan(6);

    const windowCases: readonly {
      readonly offset: number;
      readonly limit: number;
    }[] = [
      { offset: 0, limit: 3 },
      { offset: 2, limit: 5 },
      { offset: Math.max(0, total - 2), limit: 5 },
      { offset: total - 1, limit: 1 },
      { offset: total, limit: 4 },
      { offset: total + 50, limit: 5 },
    ];

    for (const { offset, limit } of windowCases) {
      const view: AnalysisViewRequest = {
        kind: "javascript-facts",
        where: {
          ...(where.paths ? { paths: [...where.paths] } : {}),
          ...(where.kinds ? { kinds: [...where.kinds] } : {}),
        },
        property_keys: ["tag", "path"],
        include_available_property_keys: true,
        offset,
        limit,
      };
      const sealedView = projectAnalysisView(sealed, view);
      const unsealedView = projectAnalysisView(unsealed, view);
      expect(sealedView.ok).toBe(true);
      expect(unsealedView.ok).toBe(true);
      if (sealedView.ok && unsealedView.ok) {
        expect(sealedView.value).toEqual(unsealedView.value);
      }

      if (view.kind !== "javascript-facts") throw new Error("wrong view");
      const sealedDirect = projectJavaScriptFacts(
        sealedNodes,
        view,
        sealedResult,
      );
      const unsealedDirect = projectJavaScriptFacts(analysis.graph.nodes, view);
      expect(sealedDirect).toEqual(unsealedDirect);
      expect(sealedDirect.total).toBe(total);
      expect(sealedDirect.rows).toEqual(
        baseline.rows.slice(offset, offset + limit),
      );
    }

    for (const pageLimit of [1, 5]) {
      const collected: typeof baseline.rows = [];
      let cursor = 0;
      while (true) {
        const view: AnalysisViewRequest = {
          kind: "javascript-facts",
          where: {
            ...(where.paths ? { paths: [...where.paths] } : {}),
            ...(where.kinds ? { kinds: [...where.kinds] } : {}),
          },
          property_keys: ["tag"],
          include_available_property_keys: false,
          offset: cursor,
          limit: pageLimit,
        };
        const sealedRes = projectAnalysisView(sealed, view);
        const unsealedRes = projectAnalysisView(unsealed, view);
        expect(sealedRes).toEqual(unsealedRes);
        if (!sealedRes.ok || sealedRes.value.kind !== "javascript-facts") {
          throw new Error("unexpected result");
        }
        collected.push(...sealedRes.value.rows);
        if (sealedRes.value.coverage.exhausted) {
          expect(sealedRes.value.coverage.next_offset).toBeNull();
          break;
        }
        cursor = sealedRes.value.coverage.next_offset!;
      }
      expect(collected).toHaveLength(total);
      expect(collected.map((row) => row.properties.tag)).toEqual(
        baseline.rows.map((row) => row.properties.tag),
      );
    }
  }
});

it("matches unindexed output across large-offset multi-bucket seek thresholds", () => {
  const base = analysisViewJavaScriptAnalysis();
  const baseObs = base.graph.nodes[0]!.observations[0]!;
  const kinds = [
    "javascript-asset",
    "javascript-module",
    "javascript-expression",
  ] as const;
  const paths = ["chunk-0.js", "chunk-1.js", "chunk-2.js"] as const;
  const nodes = Array.from({ length: 160 }, (_, nodeIdx) => {
    const sha256 = (nodeIdx + 1).toString(16).padStart(64, "0");
    const kind = kinds[nodeIdx % kinds.length]!;
    return createJavaScriptApplicationNode({
      kind,
      identity: {
        strategy: "content-digest",
        stability: "global-exact",
        sha256,
      },
      observations: Array.from({ length: 4 }, (_, obsIdx) => {
        const path = paths[(nodeIdx + obsIdx) % paths.length]!;
        return {
          label: `obs-${nodeIdx}-${obsIdx}`,
          properties: { seq: nodeIdx * 4 + obsIdx, path },
          evidence: {
            ...baseObs.evidence,
            artifact: {
              available: true as const,
              artifact_id: `art_${sha256}`,
              sha256,
            },
            location: {
              available: true as const,
              value: { kind: "artifact-path" as const, path },
            },
          },
        };
      }),
    });
  });

  const { graph_id: _gid, ...restGraph } = base.graph;
  const graph = createJavaScriptApplicationGraph({
    ...restGraph,
    root_node_ids: [base.graph.nodes[0]!.node_id],
    nodes: [base.graph.nodes[0]!, ...nodes],
    edges: [],
  });
  const analysis = analysisViewBindJavaScriptGraphs(base, graph);
  const unsealed = javascriptParent(analysis);
  const sealedResult = freezeJsonSnapshot(structuredClone(analysis));
  const sealed: AnalysisViewParent = {
    ...unsealed,
    sealedResult: true,
    normalizedResult: sealedResult,
  };
  const sealedNodes = (sealedResult as typeof analysis).graph.nodes;
  const total = 640; // 160 * 4 across 9 (kind, path) buckets; seekThreshold = max(64, 9 * 8) = 72

  for (const [offset, limit] of [
    [0, 5],
    [250, 7],
    [total - 3, 10],
    [total, 5],
  ] as const) {
    const view: AnalysisViewRequest = {
      kind: "javascript-facts",
      where: {
        kinds: [...kinds],
        paths: [...paths],
      },
      property_keys: ["seq", "path"],
      include_available_property_keys: false,
      offset,
      limit,
    };
    expect(projectAnalysisView(sealed, view)).toEqual(
      projectAnalysisView(unsealed, view),
    );
    if (view.kind !== "javascript-facts") throw new Error("wrong view");
    expect(projectJavaScriptFacts(sealedNodes, view, sealedResult)).toEqual(
      projectJavaScriptFacts(analysis.graph.nodes, view),
    );
  }
});

it("handles missing buckets, deduplicated filters, and single-bucket fallback", () => {
  const analysis = interleavedFactsJavaScriptAnalysis();
  const unsealed = javascriptParent(analysis);
  const sealedResult = freezeJsonSnapshot(structuredClone(analysis));
  const sealed: AnalysisViewParent = {
    ...unsealed,
    sealedResult: true,
    normalizedResult: sealedResult,
  };
  const sealedNodes = (sealedResult as typeof analysis).graph.nodes;

  const edgeViews: readonly AnalysisViewRequest[] = [
    // Missing filter values mixed with populated multi-bucket filters
    {
      kind: "javascript-facts",
      where: {
        kinds: ["javascript-asset", "unknown", "javascript-module"],
        paths: ["a.js", "missing.js", "b.js"],
      },
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 1,
      limit: 6,
    },
    {
      kind: "javascript-facts",
      where: { paths: ["missing.js", "a.js", "b.js"] },
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 2,
      limit: 5,
    },
    // All-missing buckets (buckets.length === 0)
    {
      kind: "javascript-facts",
      where: { kinds: ["unknown"], paths: ["missing.js"] },
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 0,
      limit: 5,
    },
    // Single matching bucket alongside missing entries (buckets.length === 1)
    {
      kind: "javascript-facts",
      where: {
        kinds: ["javascript-asset", "unknown"],
        paths: ["a.js", "missing.js"],
      },
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 3,
      limit: 4,
    },
    {
      kind: "javascript-facts",
      where: {
        kinds: ["javascript-asset", "unknown"],
        paths: ["a.js", "missing.js"],
      },
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 999,
      limit: 4,
    },
    // Duplicate entries collapsing to single bucket vs multi-bucket
    {
      kind: "javascript-facts",
      where: {
        kinds: ["javascript-asset", "javascript-asset"],
        paths: ["a.js", "a.js"],
      },
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 0,
      limit: 50,
    },
    {
      kind: "javascript-facts",
      where: {
        kinds: ["javascript-asset", "javascript-asset", "javascript-module"],
      },
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 1,
      limit: 8,
    },
  ];

  for (const view of edgeViews) {
    expect(projectAnalysisView(sealed, view)).toEqual(
      projectAnalysisView(unsealed, view),
    );
    if (view.kind !== "javascript-facts") throw new Error("wrong view");
    expect(projectJavaScriptFacts(sealedNodes, view, sealedResult)).toEqual(
      projectJavaScriptFacts(analysis.graph.nodes, view),
    );
  }
});

it("enforces limit boundaries and filter-order determinism across cold and warm caches", () => {
  const analysis = interleavedFactsJavaScriptAnalysis();
  const unsealed = javascriptParent(analysis);
  const sealedResult = freezeJsonSnapshot(structuredClone(analysis));
  const sealed: AnalysisViewParent = {
    ...unsealed,
    sealedResult: true,
    normalizedResult: sealedResult,
  };
  const sealedNodes = (sealedResult as typeof analysis).graph.nodes;

  // Schema rejects limit: 0
  expect(
    javascriptFactsViewRequestSchema.safeParse({
      kind: "javascript-facts",
      property_keys: [],
      limit: 0,
    }).success,
  ).toBe(false);
  expect(
    inspectAnalysisViewInputSchema.safeParse({
      source: { kind: "inline", evidence: {} },
      view: { kind: "javascript-facts", property_keys: [], limit: 0 },
    }).success,
  ).toBe(false);

  // Direct call parity for limit: 0 across unfiltered, single-bucket, and multi-bucket
  for (const where of [
    {},
    { kinds: ["javascript-asset" as const], paths: ["a.js"] },
    {
      kinds: ["javascript-asset" as const, "javascript-module" as const],
      paths: ["a.js", "b.js"],
    },
  ]) {
    const directZeroLimit = {
      kind: "javascript-facts" as const,
      where,
      property_keys: ["tag"],
      include_available_property_keys: false,
      offset: 0,
      limit: 0,
    };
    const indexedZero = projectJavaScriptFacts(
      sealedNodes,
      directZeroLimit,
      sealedResult,
    );
    const unindexedZero = projectJavaScriptFacts(
      analysis.graph.nodes,
      directZeroLimit,
    );
    expect(indexedZero).toEqual(unindexedZero);
    expect(indexedZero.rows).toEqual([]);
    expect(indexedZero.total).toBeGreaterThan(0);
  }

  // Determinism across reversed filter order and cold vs warm WeakMap cache
  const freshColdResult = freezeJsonSnapshot(structuredClone(analysis));
  const freshColdParent: AnalysisViewParent = {
    ...unsealed,
    sealedResult: true,
    normalizedResult: freshColdResult,
  };
  const forwardView = {
    kind: "javascript-facts" as const,
    where: {
      kinds: ["javascript-asset" as const, "javascript-module" as const],
      paths: ["a.js", "b.js", "d.js"],
    },
    property_keys: ["tag"],
    include_available_property_keys: false,
    offset: 2,
    limit: 6,
  };
  const reversedView = {
    ...forwardView,
    where: {
      kinds: ["javascript-module" as const, "javascript-asset" as const],
      paths: ["d.js", "b.js", "a.js"],
    },
  };
  const coldForward = projectAnalysisView(freshColdParent, forwardView);
  const warmReversed = projectAnalysisView(freshColdParent, reversedView);
  const cachedForward = projectAnalysisView(sealed, forwardView);
  if (
    !coldForward.ok ||
    !warmReversed.ok ||
    !cachedForward.ok ||
    coldForward.value.kind !== "javascript-facts" ||
    warmReversed.value.kind !== "javascript-facts"
  ) {
    throw new Error("expected javascript-facts result");
  }
  expect(coldForward.value.rows).toEqual(warmReversed.value.rows);
  expect(coldForward.value.coverage).toEqual(warmReversed.value.coverage);
  expect(coldForward).toEqual(cachedForward);
  expect(
    projectJavaScriptFacts(sealedNodes, forwardView, sealedResult),
  ).toEqual(projectJavaScriptFacts(sealedNodes, reversedView, sealedResult));
});

it("caches sealed inspect_byte_entropy and analyze_function parents across repeated calls", () => {
  const entropyPayload = {
    artifact: { path: "/tmp/fixture", bytes: 256, sha256: "2".repeat(64) },
    block_size: 256,
    window: { offset: 0, length: 256 },
    file_entropy: 4,
    thresholds: { high: 7.5, low: 0.5 },
    blocks: [{ offset: 0, length: 256, entropy: 4 }],
    runs: [],
    limitations: [],
  };
  const entropyParent: AnalysisViewParent = {
    predicateType: "rea.byte-entropy",
    evidenceId: `ev_${"1".repeat(64)}`,
    operation: "inspect_byte_entropy",
    limitations: [],
    sealedResult: true,
    normalizedResult: freezeJsonSnapshot(entropyPayload),
  };
  const native = nativeParent();
  const sealedNative: AnalysisViewParent = {
    ...native,
    sealedResult: true,
    normalizedResult: freezeJsonSnapshot(
      structuredClone(native.normalizedResult) as Record<string, never>,
    ),
  };
  const entropySpy = vi.spyOn(byteEntropySchema, "safeParse");
  const dossierSpy = vi.spyOn(functionDossierSchema, "safeParse");
  try {
    expect(projectAnalysisView(entropyParent, { kind: "summary" }).ok).toBe(
      true,
    );
    expect(
      projectAnalysisView({ ...entropyParent }, { kind: "summary" }).ok,
    ).toBe(true);
    expect(entropySpy).toHaveBeenCalledTimes(1);

    expect(projectAnalysisView(sealedNative, { kind: "summary" }).ok).toBe(
      true,
    );
    expect(
      projectAnalysisView(
        { ...sealedNative },
        { kind: "native", facet: "procedure", offset: 0, limit: 64 },
      ).ok,
    ).toBe(true);
    expect(dossierSpy).toHaveBeenCalledTimes(1);
  } finally {
    entropySpy.mockRestore();
    dossierSpy.mockRestore();
  }
});
