import { describe, expect, it } from "vitest";

import { projectManagedApplicationGraphEvidence } from "../../../src/application/managed/ManagedApplicationGraphService.js";
import { managedApplicationGraphReferenceInputSchema } from "../../../src/contracts/managed/managedWorkflowToolContracts.js";
import { MANAGED_APPLICATION_GRAPH_EXAMPLE } from "../../../src/contracts/managed/managedWorkflowExamples.js";
import { traceApplicationFeatureEvidence } from "../../../src/application/javascript/JavaScriptApplicationWorkflowService.js";
import { MANAGED_STATIC_PROVIDER } from "../../../src/application/InvestigationProviders.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { parseJavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { managedApplicationGraphResultSchema } from "../../../src/domain/managed/managedApplicationGraph.js";
import { inspectManagedArtifactBytes } from "../../../src/dotnet/ManagedArtifactInspector.js";
import { inspectManagedMembersBytes } from "../../../src/dotnet/ManagedMemberInspector.js";
import { inspectManagedNativeBoundariesBytes } from "../../../src/dotnet/ManagedNativeBoundaryInspector.js";
import {
  buildManagedPeFixture,
  managedPeFixtureTarget,
} from "../../../src/dotnet/ManagedPe.fixture.js";

describe("managed application graph projection", () => {
  it("projects managed metadata and native declarations into authenticated graph Evidence", () => {
    const bytes = buildManagedPeFixture({
      pinvoke: {
        moduleName: "user32.dll",
        importName: "MessageBoxW",
        mappingFlags: 0x0345,
      },
    });
    const binary = managedPeFixtureTarget(bytes, "/fixture/ManagedInterop.exe");
    const managedArtifact = inspectManagedArtifactBytes(bytes, binary);
    const members = inspectManagedMembersBytes(bytes, binary);
    const boundaries = inspectManagedNativeBoundariesBytes(bytes, binary);
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
      predicate_type: "rea.managed-application-graph",
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
    });
    expect(trace.ok, trace.ok ? undefined : JSON.stringify(trace.error)).toBe(
      true,
    );
    if (!trace.ok) throw new Error("trace failed");
    expect(trace.value.normalized_result).toMatchObject({
      source_evidence_id: parsed.evidence_id,
      summary: { matched_seeds: 1 },
    });
  });
});

describe("managed application graph request", () => {
  it("accepts any nonempty set of inline sources and rejects duplicates", () => {
    const evidence = MANAGED_APPLICATION_GRAPH_EXAMPLE.managed_members;
    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({
        managed_members: evidence,
      }).success,
    ).toBe(true);
    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({}).success,
    ).toBe(false);
    expect(
      managedApplicationGraphReferenceInputSchema.safeParse({
        managed_members: evidence,
        managed_native_boundaries: evidence,
      }).success,
    ).toBe(false);
  });
});

describe("managed application graph coverage", () => {
  it("rejects managed Evidence digest mismatch and discloses missing artifact observations", () => {
    const bytes = buildManagedPeFixture();
    const binary = managedPeFixtureTarget(bytes, "/fixture/Mismatch.dll");
    const members = inspectManagedMembersBytes(bytes, binary);
    const mismatched = createEvidence(binary, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_members",
      parameters: {},
      result: {
        ...members,
        artifact: { ...members.artifact, sha256: "b".repeat(64) },
        identity_scope: {
          ...members.identity_scope,
          requires_artifact_sha256: "b".repeat(64),
        },
      },
    });
    const rejected = projectManagedApplicationGraphEvidence({
      managed_members: mismatched,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("mismatched managed Evidence accepted");
    expect(JSON.stringify(rejected.error)).toContain(
      `Managed Evidence inspect_managed_members (${mismatched.evidence_id}) subject SHA-256 ${binary.sha256} does not match normalized artifact SHA-256 ${"b".repeat(64)}`,
    );

    const aligned = createEvidence(binary, MANAGED_STATIC_PROVIDER, {
      operation: "inspect_managed_members",
      parameters: {},
      result: members,
    });
    const projected = projectManagedApplicationGraphEvidence({
      managed_members: aligned,
    });
    if (!projected.ok) throw projected.error;
    const result = managedApplicationGraphResultSchema.parse(
      parseEvidence(projected.value).normalized_result,
    );
    expect(result.limitations).toContain(
      "Managed artifact Evidence was not supplied; assembly identity observations are absent.",
    );
  });

  it("preserves partial parser coverage in graph and per-fact coverage", () => {
    const bytes = buildManagedPeFixture();
    const binary = managedPeFixtureTarget(bytes, "/fixture/ManagedInterop.exe");
    const members = inspectManagedMembersBytes(bytes, binary);
    const parserPartialMembers = {
      ...members,
      coverage: {
        state: "partial" as const,
        issues: [
          {
            code: "invalid-blob" as const,
            scope: "metadata.#Blob",
            offset: 0x0a00,
            detail: "Blob content leaves #Blob",
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
    });

    if (!parserPartialProjection.ok)
      throw new Error("partial projection failed");
    const parserPartialResult = managedApplicationGraphResultSchema.parse(
      parseEvidence(parserPartialProjection.value).normalized_result,
    );
    expect(parserPartialResult.coverage).toMatchObject({
      status: "partial",
    });
    expect(parserPartialResult.graph.coverage).toEqual({
      status: "partial",
      truncated: false,
      omitted_count: null,
      limits: [],
    });
  });
});
