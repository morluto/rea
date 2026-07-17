import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectManagedApplicationGraphEvidence } from "../src/application/ManagedApplicationGraphService.js";
import { traceApplicationFeatureEvidence } from "../src/application/JavaScriptApplicationWorkflowService.js";
import { MANAGED_STATIC_PROVIDER } from "../src/application/InvestigationProviders.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { createEvidence, parseEvidence } from "../src/domain/evidence.js";
import { parseJavaScriptApplicationGraph } from "../src/domain/javascriptApplicationGraph.js";
import { managedApplicationGraphResultSchema } from "../src/domain/managedApplicationGraph.js";
import { inspectManagedArtifactBytes } from "../src/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "../src/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../src/dotnet/ManagedNativeBoundaryInspector.js";
import { buildManagedPeFixture } from "./fixtures/managedPe.js";

const artifactLimits = {
  referenceOffset: 0,
  referenceLimit: 100,
  resourceOffset: 0,
  resourceLimit: 100,
  attributeOffset: 0,
  attributeLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

const memberLimits = {
  typeOffset: 0,
  typeLimit: 100,
  methodOffset: 0,
  methodLimit: 100,
  fieldOffset: 0,
  fieldLimit: 100,
  memberRefOffset: 0,
  memberRefLimit: 100,
  edgeOffset: 0,
  edgeLimit: 100,
  instructionAnchorLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
  maxMethodBodyBytes: 1024 * 1024,
  maxMethodInstructions: 1_000,
};

const boundaryLimits = {
  moduleRefOffset: 0,
  moduleRefLimit: 100,
  importOffset: 0,
  importLimit: 100,
  implementationOffset: 0,
  implementationLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

describe("managed application graph projection", () => {
  it("projects managed metadata and native declarations into authenticated graph Evidence", () => {
    const bytes = buildManagedPeFixture({
      pinvoke: {
        moduleName: "user32.dll",
        importName: "MessageBoxW",
        mappingFlags: 0x0345,
      },
    });
    const binary = target(bytes);
    const managedArtifact = inspectManagedArtifactBytes(
      bytes,
      binary,
      artifactLimits,
    );
    const members = inspectManagedMembersBytes(bytes, binary, memberLimits);
    const boundaries = inspectManagedNativeBoundariesBytes(
      bytes,
      binary,
      boundaryLimits,
    );
    const artifactEvidence = createEvidence(binary, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_artifact",
      parameters: {},
      result: managedArtifact,
      rawResult: null,
      limitations: managedArtifact.limitations,
      locations: [{ kind: "artifact-path", path: binary.path }],
    });
    const memberEvidence = createEvidence(binary, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_members",
      parameters: {},
      result: members,
      rawResult: null,
      limitations: members.limitations,
      locations: [{ kind: "artifact-path", path: binary.path }],
    });
    const boundaryEvidence = createEvidence(binary, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_native_boundaries",
      parameters: {},
      result: boundaries,
      rawResult: null,
      limitations: boundaries.limitations,
      locations: [{ kind: "artifact-path", path: binary.path }],
    });

    const evidence = projectManagedApplicationGraphEvidence({
      managed_artifact: artifactEvidence,
      managed_members: memberEvidence,
      managed_native_boundaries: boundaryEvidence,
      limits: {
        max_types: 100,
        max_methods: 100,
        max_fields: 100,
        max_pinvoke_imports: 100,
        max_native_implementations: 100,
      },
    });

    expect(
      evidence.ok,
      evidence.ok
        ? undefined
        : `${JSON.stringify(evidence.error)} cause=${String(evidence.error.cause)}`,
    ).toBe(true);
    if (!evidence.ok) throw new Error("projection failed");
    const parsed = parseEvidence(evidence.value);
    expect(parsed).toMatchObject({
      operation: "project_managed_application_graph",
      predicate_type: "rea.managed-application-graph/v1",
      provider: { id: "rea-dotnet-workflows" },
      confidence: "inferred",
      authority: "analyst-inference",
      evidence_links: [
        artifactEvidence.evidence_id,
        memberEvidence.evidence_id,
        boundaryEvidence.evidence_id,
      ],
    });
    const result = managedApplicationGraphResultSchema.parse(
      parsed.normalized_result,
    );
    const graph = parseJavaScriptApplicationGraph(result.graph);
    expect(result.summary).toMatchObject({
      assemblies: 1,
      modules: 1,
      types: 1,
      methods: 1,
      fields: 1,
      pinvoke_imports: 1,
    });
    expect(graph.nodes.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "artifact",
        "managed-assembly",
        "managed-module",
        "managed-type",
        "managed-method",
        "managed-field",
        "managed-pinvoke-import",
      ]),
    );
    const method = graph.nodes.find(
      ({ kind, observations }) =>
        kind === "managed-method" &&
        observations[0]?.label === "Fixture.Program.Main",
    );
    expect(method).toBeDefined();
    expect(
      graph.edges.some(
        ({ source_node_id, relation, target_node_id }) =>
          source_node_id === method?.node_id &&
          relation === "imports" &&
          graph.nodes.find(({ node_id: id }) => id === target_node_id)?.kind ===
            "managed-pinvoke-import",
      ),
    ).toBe(true);
    expect(
      graph.nodes.flatMap(({ observations }) =>
        observations.map(({ evidence }) => evidence.authority),
      ),
    ).toContain("managed-static-analysis");

    const trace = traceApplicationFeatureEvidence({
      application: parsed,
      native_observations: [],
      seed: {
        kind: "string",
        value: "MessageBoxW",
        match: "exact",
        case_sensitive: true,
      },
      direction: "incoming",
      limits: {
        max_seed_matches: 5,
        max_depth: 4,
        max_nodes: 50,
        max_edges: 100,
        max_paths: 10,
      },
    });
    expect(trace.ok).toBe(true);
    if (!trace.ok) throw new Error("trace failed");
    expect(trace.value.normalized_result).toMatchObject({
      source_evidence_id: parsed.evidence_id,
      summary: { matched_seeds: 1 },
    });
  });

  it("preserves source-page omissions in graph and per-fact coverage", () => {
    const bytes = buildManagedPeFixture();
    const binary = target(bytes);
    const members = inspectManagedMembersBytes(bytes, binary, memberLimits);
    const partialMembers = {
      ...members,
      methods: {
        ...members.methods,
        total: 2,
        returned: 1,
        dropped: 1,
        complete: false,
      },
    };
    const memberEvidence = createEvidence(binary, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_members",
      parameters: {},
      result: partialMembers,
      rawResult: null,
      limitations: partialMembers.limitations,
      locations: [{ kind: "artifact-path", path: binary.path }],
    });

    const evidence = projectManagedApplicationGraphEvidence({
      managed_members: memberEvidence,
      limits: {
        max_types: 100,
        max_methods: 100,
        max_fields: 100,
        max_pinvoke_imports: 100,
        max_native_implementations: 100,
      },
    });

    expect(
      evidence.ok,
      evidence.ok
        ? undefined
        : `${JSON.stringify(evidence.error)} cause=${String(evidence.error.cause)}`,
    ).toBe(true);
    if (!evidence.ok) throw new Error("projection failed");
    const result = managedApplicationGraphResultSchema.parse(
      parseEvidence(evidence.value).normalized_result,
    );
    const graph = parseJavaScriptApplicationGraph(result.graph);
    expect(result.coverage).toMatchObject({
      status: "truncated",
      omitted_types: 0,
      omitted_methods: 1,
      omitted_fields: 0,
    });
    expect(graph.coverage).toMatchObject({
      status: "partial",
      truncated: true,
      omitted_count: 1,
    });
    const method = graph.nodes.find(({ kind }) => kind === "managed-method");
    expect(method?.observations[0]?.evidence.coverage).toMatchObject({
      status: "partial",
      truncated: true,
      omitted_count: 1,
    });
    expect(
      graph.edges.find(
        ({ target_node_id }) => target_node_id === method?.node_id,
      )?.evidence.coverage,
    ).toMatchObject({
      status: "partial",
      truncated: true,
      omitted_count: 1,
    });

    const parserPartialMembers = {
      ...partialMembers,
      coverage: {
        state: "partial" as const,
        issues: [
          {
            code: "limit-exceeded" as const,
            scope: "method.0x06000001.body.instructions",
            offset: 0x0a00,
            detail: "instruction limit reached",
          },
        ],
      },
    };
    const parserPartialEvidence = createEvidence(
      binary,
      MANAGED_STATIC_PROVIDER,
      {
        operation: "inspect_managed_members",
        parameters: {},
        result: parserPartialMembers,
        rawResult: null,
        limitations: parserPartialMembers.limitations,
      },
    );
    const parserPartialProjection = projectManagedApplicationGraphEvidence({
      managed_members: parserPartialEvidence,
      limits: {
        max_types: 100,
        max_methods: 100,
        max_fields: 100,
        max_pinvoke_imports: 100,
        max_native_implementations: 100,
      },
    });

    expect(parserPartialProjection.ok).toBe(true);
    if (!parserPartialProjection.ok)
      throw new Error("partial projection failed");
    const parserPartialResult = managedApplicationGraphResultSchema.parse(
      parseEvidence(parserPartialProjection.value).normalized_result,
    );
    expect(parserPartialResult.coverage).toMatchObject({
      status: "partial",
      omitted_methods: 1,
    });
    expect(parserPartialResult.graph.coverage).toEqual({
      status: "partial",
      truncated: false,
      omitted_count: null,
      limits: [],
    });
  });
});

const target = (bytes: Buffer): BinaryTarget => ({
  path: "/fixture/ManagedInterop.exe",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
});
