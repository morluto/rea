import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { compareApplicationVersionsRequestSchema } from "../../../src/contracts/applicationWorkflowInputContracts.js";
import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import {
  compareApplicationVersionsEvidence,
  traceApplicationFeatureEvidence,
} from "../../../src/application/javascript/JavaScriptApplicationWorkflowService.js";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascriptApplicationAnalysis.js";
import {
  applicationVersionComparisonResultSchema,
  type ApplicationVersionComparisonResult,
} from "../../../src/domain/javascriptApplicationVersionComparisonSchemas.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascriptRuntimeReconciliationSchemas.js";
import { compareJavaScriptApplicationVersions } from "../../../src/domain/javascriptApplicationVersionComparison.js";
import { createJavaScriptApplicationGraph } from "../../../src/domain/javascriptApplicationGraph.js";
import { traceApplicationFeature } from "../../../src/domain/javascriptFeatureTrace.js";
import { applicationFeatureTraceResultSchema } from "../../../src/domain/javascriptFeatureTraceSchemas.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  buildSyntheticJavaScriptApplicationGraph,
} from "../../../src/domain/javascriptApplicationGraph.fixture.js";
import { writeVersionedJavaScriptApplicationFixtures } from "../../fixtures/javascriptArtifactApplication.js";
import { JAVASCRIPT_APPLICATION_PROVIDER } from "../../../src/application/InvestigationProviders.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../../src/contracts/javascriptRuntimeReconciliationExample.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

describe("JavaScript application workflows", () => {
  it("traces a contextBridge API through IPC into linked native evidence", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const nativeEvidence = createEvidence(
      {
        path: "/tmp/synthetic.node",
        sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
        format: "elf",
        architecture: "x86_64",
      },
      { id: "ghidra", name: "Ghidra", version: "fixture" },
      {
        operation: "analyze_function",
        parameters: { address: "openProject" },
        result: { name: "openProject", address: "0x1000" },
        limitations: ["Synthetic native provider observation."],
      },
    );

    const result = traceApplicationFeature({
      sourceEvidenceId: `ev_${"a".repeat(64)}`,
      graph,
      nativeEvidence: [nativeEvidence],
      seed: {
        kind: "api",
        value: "desktopApi",
        match: "exact",
        case_sensitive: false,
      },
      direction: "outgoing",
    });

    expect(() =>
      applicationFeatureTraceResultSchema.parse(result),
    ).not.toThrow();
    expect(result.summary).toMatchObject({
      matched_seeds: 1,
      native_handoffs: 1,
    });
    expect(result.native_handoffs).toContainEqual(
      expect.objectContaining({
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.nativeAddon,
        status: "evidence-linked",
        evidence_ids: [nativeEvidence.evidence_id],
        requested_exports: expect.arrayContaining(["openProject"]),
      }),
    );
    expect(result.paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ end_kind: "native-export" }),
      ]),
    );
    expect(
      result.graph?.edges.some(
        ({ evidence }) =>
          evidence.authority === "static-relationship-inference" &&
          evidence.state === "inferred",
      ),
    ).toBe(true);
  });

  it("keeps no-match explicit and traces the full reachable graph", () => {
    const graph = buildSyntheticJavaScriptApplicationGraph();
    const noMatch = traceApplicationFeature({
      sourceEvidenceId: `ev_${"a".repeat(64)}`,
      graph,
      nativeEvidence: [],
      seed: {
        kind: "route",
        value: "/missing",
        match: "exact",
        case_sensitive: false,
      },
      direction: "both",
    });
    expect(noMatch).toMatchObject({
      graph: null,
      coverage: { status: "no-match" },
      summary: { matched_seeds: 0 },
    });

    const complete = traceApplicationFeature({
      sourceEvidenceId: `ev_${"a".repeat(64)}`,
      graph,
      nativeEvidence: [],
      seed: {
        kind: "api",
        value: "desktopApi",
        match: "exact",
        case_sensitive: false,
      },
      direction: "outgoing",
    });
    expect(complete.coverage.status).toBe("complete-within-source");
    expect(complete.coverage.total_seed_matches).toBe(1);
    expect(complete.graph?.nodes.length).toBeGreaterThan(1);
    expect(complete.coverage).not.toHaveProperty("omitted_nodes");
  });
});

describe("JavaScript application comparison workflows", () => {
  it("accepts complete inline Evidence and native observation arrays", () => {
    const native = Array.from({ length: 65 }, (_, index) =>
      createEvidence(
        {
          path: `/tmp/native-${index}.node`,
          sha256: index.toString(16).padStart(64, "0"),
          format: "elf",
          architecture: "x86_64",
        },
        { id: "ghidra", name: "Ghidra", version: "fixture" },
        {
          operation: "analyze_function",
          parameters: { address: `0x${index.toString(16)}` },
          result: { address: `0x${index.toString(16)}` },
        },
      ),
    );
    const applicationEvidence = (side: string) =>
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          predicateType: "rea.javascript-application-analysis",
          operation: "analyze_javascript_application",
          parameters: { side },
          result: {},
        },
      );
    const input = {
      left: applicationEvidence("left"),
      right: applicationEvidence("right"),
      left_native_observations: native,
    };
    expect(
      compareApplicationVersionsRequestSchema.safeParse(input).success,
    ).toBe(true);
  });
});

describe("complete comparison projections", () => {
  it("matches rechunked modules by exact source and minified modules by structural fingerprint", async () => {
    const root = await createTestTempDirectory("rea-application-versions-");
    temporary.push(root);
    const fixtures = await writeVersionedJavaScriptApplicationFixtures(root);
    const [left, right] = await Promise.all([
      analyzeFixture(fixtures.left),
      analyzeFixture(fixtures.right),
    ]);
    const compared = compareApplicationVersionsEvidence({ left, right });
    if (!compared.ok) throw compared.error;
    const result = applicationVersionComparisonResultSchema.parse(
      compared.value.normalized_result,
    );
    expectFullComparisonResultSchema(result);
    const modules = result.items.filter(
      ({ node_kind: kind }) => kind === "javascript-module",
    );

    expect(modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          match: expect.objectContaining({
            status: "matched",
            basis: "exact-module-source-digest",
            confidence: "exact",
          }),
        }),
        expect.objectContaining({
          status: "changed",
          match: expect.objectContaining({
            status: "matched",
            basis: "structural-fingerprint",
            confidence: "medium",
          }),
        }),
      ]),
    );
    expect(result.matching.ambiguous).toBeGreaterThanOrEqual(4);
    expect(modules.filter(({ match }) => match.status === "ambiguous")).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "unknown" })]),
    );
    expect(result.summary.added).toBeGreaterThan(0);
    expect(result.summary.removed).toBeGreaterThan(0);
    expect(result.coverage).not.toHaveProperty("omitted_graph_nodes");
    expect(result.coverage).not.toHaveProperty("omitted_graph_edges");
    expect(result.coverage).not.toHaveProperty("omitted_graph_observations");
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "changed_from",
          evidence: expect.objectContaining({
            authority: "cross-version-comparison",
            state: "inferred",
          }),
        }),
      ]),
    );
    expect(result.limitations.join(" ")).toMatch(
      /module ordinals|fuzzy pairing/u,
    );
    expectComparisonItemAlgebra(result);
  });

  it("pairs source-map originals without promoting the match to exact", async () => {
    const root = await createTestTempDirectory("rea-source-map-versions-");
    temporary.push(root);
    const fixtures = await writeVersionedJavaScriptApplicationFixtures(root);
    const [left, right] = await Promise.all([
      analyzeFixture(fixtures.left),
      analyzeFixture(fixtures.right),
    ]);
    const compared = compareApplicationVersionsEvidence({ left, right });
    if (!compared.ok) throw compared.error;
    const result = applicationVersionComparisonResultSchema.parse(
      compared.value.normalized_result,
    );
    expect(result.items).toContainEqual(
      expect.objectContaining({
        node_kind: "source-module",
        status: "changed",
        match: expect.objectContaining({
          basis: "source-map-identity",
          confidence: "high",
        }),
      }),
    );
  });

  it("keeps incomplete one-sided absence unknown and reports source omissions", () => {
    const complete = buildSyntheticJavaScriptApplicationGraph();
    const rootNode = complete.nodes.find(({ node_id: id }) =>
      complete.root_node_ids.includes(id),
    );
    if (rootNode === undefined) throw new Error("Synthetic graph root missing");
    const partial = createJavaScriptApplicationGraph({
      schema: "JavaScriptApplicationGraph",
      root_node_ids: [rootNode.node_id],
      nodes: [rootNode],
      edges: [],
      coverage: {
        status: "partial",
        truncated: true,
        omitted_count: complete.nodes.length - 1,
        limits: [{ name: "fixture_nodes", value: 1, unit: "items" }],
      },
      limitations: ["Synthetic partial graph."],
    });
    const input = {
      left: {
        evidenceId: `ev_${"a".repeat(64)}`,
        rootArtifactSha256: APPLICATION_GRAPH_DIGESTS.package,
        graph: complete,
      },
      right: {
        evidenceId: `ev_${"b".repeat(64)}`,
        rootArtifactSha256: APPLICATION_GRAPH_DIGESTS.package,
        graph: partial,
      },
      leftNativeEvidence: [],
      rightNativeEvidence: [],
    };

    const first = compareJavaScriptApplicationVersions(input);
    const second = compareJavaScriptApplicationVersions(input);
    expect(first.comparison_id).toBe(second.comparison_id);
    expect(first.coverage).toMatchObject({
      status: "truncated",
      right_graph_status: "partial",
      right_graph_omitted_count: complete.nodes.length - 1,
    });
    expect(first.summary.removed).toBe(0);
    expect(first.summary.unknown).toBeGreaterThan(0);
  });
});

describe("JavaScript application workflow error diagnostics", () => {
  it("returns safe explicit Evidence constraints from graph workflows", async () => {
    const root = await createTestTempDirectory(
      "rea-application-workflow-diagnostics-",
    );
    temporary.push(root);
    const evidence = await analyzeFixture(root);
    const subject = evidence.subject;
    if (subject === null) throw new Error("Analysis Evidence subject missing");
    const secretPath = "/private/token=do-not-return";
    const inconsistent = {
      ...evidence,
      subject: { ...subject, local_path: secretPath },
    };

    const result = traceApplicationFeatureEvidence({
      application: inconsistent,
      seed: { kind: "route", value: "/" },
      direction: "both",
    });

    if (result.ok) throw new Error("Expected inconsistent Evidence to fail");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    if (!(result.error instanceof AnalysisInputError)) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        reason: "invalid_value",
        message:
          "JavaScript application Evidence subject does not match its result",
      }),
    );
    expect(JSON.stringify(result.error.issues)).not.toContain(secretPath);
  });

  it("preserves schema-authored Evidence validation messages", async () => {
    const root = await createTestTempDirectory(
      "rea-application-workflow-schema-diagnostics-",
    );
    temporary.push(root);
    const evidence = await analyzeFixture(root);
    const subject = evidence.subject;
    if (subject === null) throw new Error("Analysis Evidence subject missing");
    const result = javascriptApplicationAnalysisResultSchema.parse(
      evidence.normalized_result,
    );
    const malformedResult = {
      ...result,
      semantic_graph: {
        ...result.semantic_graph,
        application_graph_id: `jag_${"f".repeat(64)}`,
      },
    };
    const malformedEvidence = createEvidence(
      {
        path: subject.local_path,
        sha256: subject.digest.sha256,
        format: subject.format,
      },
      JAVASCRIPT_APPLICATION_PROVIDER,
      {
        predicateType: evidence.predicate_type,
        operation: evidence.operation,
        parameters: evidence.parameters,
        result: jsonValueSchema.parse(malformedResult),
        confidence: evidence.confidence,
        authority: evidence.authority,
        limitations: evidence.limitations,
        locations: evidence.locations,
        evidenceLinks: evidence.evidence_links,
      },
    );

    const traced = traceApplicationFeatureEvidence({
      application: malformedEvidence,
      seed: { kind: "route", value: "/" },
      direction: "both",
    });
    const reconciled = reconcileJavaScriptRuntimeEvidence({
      static_layers: [{ role: "application", analysis: malformedEvidence }],
      runtime_observations: [evidence],
    });

    expect(traced.ok).toBe(false);
    expect(reconciled.ok).toBe(false);
    if (!traced.ok && traced.error instanceof AnalysisInputError)
      expect(traced.error.issues).toContainEqual(
        expect.objectContaining({
          message:
            "Semantic graph must commit the containing application graph",
        }),
      );
    if (!reconciled.ok && reconciled.error instanceof AnalysisInputError)
      expect(reconciled.error.issues).toContainEqual(
        expect.objectContaining({
          message:
            "Semantic graph must commit the containing application graph",
        }),
      );
  });

  it("returns supported-operation constraints from runtime reconciliation", async () => {
    const root = await createTestTempDirectory(
      "rea-runtime-workflow-diagnostics-",
    );
    temporary.push(root);
    const evidence = await analyzeFixture(root);

    const result = reconcileJavaScriptRuntimeEvidence({
      static_layers: [{ role: "application", analysis: evidence }],
      runtime_observations: [evidence],
    });

    if (result.ok) throw new Error("Expected non-runtime Evidence to fail");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    if (!(result.error instanceof AnalysisInputError)) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        reason: "invalid_value",
        message:
          "Runtime reconciliation requires inspect_web_page, inspect_electron_page, observe_javascript_runtime, or capture_electron_scenario Evidence",
      }),
    );
  });
});

describe("JavaScript runtime reconciliation local paths", () => {
  it("resolves relative file mapping roots before deriving result Evidence", () => {
    const absoluteRoot = resolve(process.cwd(), "runtime-cache-fixture");
    const relativeRoot = relative(process.cwd(), absoluteRoot);
    const base = JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE;
    const [baseLayer] = base.static_layers;
    if (baseLayer === undefined) throw new Error("Static layer missing");
    const input = {
      ...base,
      static_layers: [
        {
          ...baseLayer,
          runtime_mappings: [
            { kind: "file-root" as const, root: relativeRoot },
          ],
        },
      ],
    };
    const relativeResult = reconcileJavaScriptRuntimeEvidence(input);
    const absoluteResult = reconcileJavaScriptRuntimeEvidence({
      ...input,
      static_layers: [
        {
          ...input.static_layers[0],
          runtime_mappings: [{ kind: "file-root", root: absoluteRoot }],
        },
      ],
    });

    expect(relativeResult.ok).toBe(true);
    expect(absoluteResult.ok).toBe(true);
    if (!relativeResult.ok || !absoluteResult.ok) return;
    expect(relativeResult.value.evidence_id).toBe(
      absoluteResult.value.evidence_id,
    );
    expect(relativeResult.value.normalized_result).toEqual(
      absoluteResult.value.normalized_result,
    );
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      relativeResult.value.normalized_result,
    );
    expect(result.static_layers[0]?.runtime_mappings[0]).toMatchObject({
      kind: "file-root",
      root: absoluteRoot,
    });
  });

  it("preserves foreign absolute file roots without matching another path syntax", () => {
    const base = JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE;
    const [baseLayer] = base.static_layers;
    if (baseLayer === undefined) throw new Error("Static layer missing");
    const remoteWindowsRoot = String.raw`C:\runtime\cache`;
    const reconciled = reconcileJavaScriptRuntimeEvidence({
      ...base,
      static_layers: [
        {
          ...baseLayer,
          runtime_mappings: [{ kind: "file-root", root: remoteWindowsRoot }],
        },
      ],
    });

    expect(reconciled.ok).toBe(true);
    if (!reconciled.ok) return;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.normalized_result,
    );
    expect(result.static_layers[0]?.runtime_mappings[0]).toMatchObject({
      kind: "file-root",
      root: remoteWindowsRoot,
    });
    expect(
      result.reconciliations.some(
        ({ basis }) => basis === "operator-file-mapping",
      ),
    ).toBe(false);
  });
});

const analyzeFixture = async (root: string) => {
  const result = await analyzeJavaScriptApplication({
    input_path: root,
  });
  if (!result.ok) throw result.error;
  return result.value;
};

const expectComparisonItemAlgebra = (
  result: ApplicationVersionComparisonResult,
): void => {
  const matched = result.items.find(({ match }) => match.status === "matched");
  expect(matched).toBeDefined();
  if (matched === undefined) return;
  expect(
    applicationVersionComparisonResultSchema.safeParse({
      ...result,
      items: [{ ...matched, right_node_id: null }],
    }).success,
  ).toBe(false);
  expect(
    applicationVersionComparisonResultSchema.safeParse({
      ...result,
      items: [
        {
          ...matched,
          match: {
            ...matched.match,
            basis: "none",
            confidence: "unknown",
          },
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    applicationVersionComparisonResultSchema.safeParse({
      ...result,
      coverage: {
        ...result.coverage,
        status: "complete-within-inputs",
        left_graph_status: "partial",
      },
    }).success,
  ).toBe(false);
};

const expectFullComparisonResultSchema = (
  result: ApplicationVersionComparisonResult,
): void => {
  const candidateNodeIds = Array.from(
    { length: 1_001 },
    (_, index) => `jag_node_${index.toString(16).padStart(64, "0")}`,
  );
  const expanded = {
    ...result,
    evidence_links: Array.from(
      { length: 131 },
      (_, index) => `ev_${index.toString(16).padStart(64, "0")}`,
    ),
    items: result.items.map((item) =>
      item.match.status === "ambiguous"
        ? {
            ...item,
            match: {
              ...item.match,
              ...(item.match.candidate_left_node_ids.length === 0
                ? { candidate_right_node_ids: candidateNodeIds }
                : { candidate_left_node_ids: candidateNodeIds }),
            },
          }
        : item,
    ),
  };
  expect(
    applicationVersionComparisonResultSchema.safeParse(expanded).success,
  ).toBe(true);
};
