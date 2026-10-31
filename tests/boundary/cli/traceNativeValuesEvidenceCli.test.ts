import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Cli } from "incur";
import pino from "pino";
import { expect, it, vi } from "vitest";

import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import { registerCoreNativeCommands } from "../../../src/cli/coreNativeCommands.js";
import { projectCliAnalysisResult } from "../../../src/cli/projectCliAnalysisResult.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
  type EvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { REA_WORKFLOW_PROVIDER } from "../../../src/domain/investigationProviders.js";
import { nativeValueTraceSchema } from "../../../src/domain/native/nativeValueTrace.js";
import { ok } from "../../../src/domain/result.js";
import { composedWorkflowFixture } from "../../fixtures/composedWorkflowEvidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const sourceProvider = { id: "fixture", name: "Fixture", version: "1" };
const sourceTarget = {
  path: "/fixtures/native.exe",
  format: "pe" as const,
  sha256: "a".repeat(64),
};

const createTraceFixture = () => {
  const leaf = createEvidence(sourceTarget, sourceProvider, {
    operation: "read_native_source",
    parameters: { address: "0x1000" },
    result: { text: "return 0;" },
  });
  const procedure = createEvidence(sourceTarget, sourceProvider, {
    operation: "analyze_function",
    parameters: { procedure: "main" },
    result: { procedure: { address: "0x1000" } },
    evidenceLinks: [leaf.evidence_id],
  });
  const traceResult = nativeValueTraceSchema.parse({
    seed: "main",
    target_sha256: sourceTarget.sha256,
    nodes: [
      {
        id: "node-1",
        procedure: "0x1000",
        evidence_id: procedure.evidence_id,
        kind: "operation",
        operation: null,
        parameter: null,
      },
    ],
    edges: [],
    procedures: [
      {
        address: "0x1000",
        depth: 0,
        evidence_id: procedure.evidence_id,
        provider: "fixture",
        analysis_profile_digest: null,
      },
    ],
    unknowns: [
      { procedure: "0x1000", address: null, reason: "fixture uncertainty" },
    ],
    total_nodes: 2,
    total_edges: 0,
    decompilations: 1,
    next_offset: 1,
    truncated: true,
    limitations: ["fixture trace limitation"],
  });
  const trace = createEvidence(sourceTarget, REA_WORKFLOW_PROVIDER, {
    operation: "trace_native_values",
    parameters: { procedure: "main" },
    result: traceResult,
    confidence: "derived",
    evidenceLinks: [procedure.evidence_id],
  });
  const unrelated = createEvidence(sourceTarget, sourceProvider, {
    operation: "address_name",
    parameters: { address: "0x2000" },
    result: { name: "unrelated" },
  });
  const sessionBundle = createEvidenceBundle([
    trace,
    procedure,
    leaf,
    unrelated,
  ]);
  return { leaf, procedure, trace, unrelated, sessionBundle };
};

type DirectAnalysisRunner = Parameters<typeof registerCoreNativeCommands>[2];

const createTraceCli = (run: DirectAnalysisRunner) => {
  const cli = Cli.create("rea-trace-evidence-test", {
    version: "1",
    sync: false,
  });
  registerCoreNativeCommands(
    cli as unknown as CliInstance,
    pino({ enabled: false }),
    run,
  );
  return cli;
};

const runJsonCli = async (
  cli: ReturnType<typeof Cli.create>,
  args: string[],
) => {
  let stdout = "";
  await cli.serve(args, {
    env: {},
    stdout: (text: string) => {
      stdout += text;
    },
    exit: () => undefined,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
};

const verifyDirectAnalysisEvidenceBundleCallback = async (
  snapshotPath: string,
) => {
  const fixture = await composedWorkflowFixture();
  let captured: EvidenceBundle | undefined;
  const direct = parseEvidence(
    await runDirectAnalysis(
      fixture.dependencies,
      fixture.path,
      "binary_overview",
      {},
      { snapshotPath, onEvidenceBundle: (bundle) => (captured = bundle) },
    ).then(projectCliAnalysisResult),
  );
  expect(captured?.records.map(({ evidence_id }) => evidence_id)).toContain(
    direct.evidence_id,
  );

  let replayedBundle: EvidenceBundle | undefined;
  const replayed = parseEvidence(
    await runDirectAnalysis(
      fixture.dependencies,
      fixture.path,
      "binary_overview",
      {},
      {
        snapshotPath,
        onEvidenceBundle: (bundle) => (replayedBundle = bundle),
      },
    ).then(projectCliAnalysisResult),
  );
  expect(replayed).toEqual(direct);
  expect(
    replayedBundle?.records.map(({ evidence_id }) => evidence_id),
  ).toContain(replayed.evidence_id);
};

it("exports only the transitive source Evidence closure for a native value trace", async () => {
  const { leaf, procedure, trace, unrelated, sessionBundle } =
    createTraceFixture();
  const run = vi.fn<DirectAnalysisRunner>(
    async (_path, _tool, _arguments, options) => {
      options?.onEvidenceBundle?.(sessionBundle);
      return ok(trace);
    },
  );
  const cli = createTraceCli(run);
  const directory = await createTestTempDirectory("rea-trace-evidence-");
  const destination = join(directory, "trace-evidence.json");
  const delivered = await runJsonCli(cli, [
    "trace-native-values",
    sourceTarget.path,
    "main",
    "--evidence_output",
    destination,
    "--json",
  ]);

  expect(delivered.evidence_id).toBe(trace.evidence_id);
  expect(run).toHaveBeenCalledOnce();
  const exported = parseEvidenceBundle(
    JSON.parse(await readFile(destination, "utf8")),
  );
  expect(exported.records.map(({ evidence_id }) => evidence_id).sort()).toEqual(
    [trace.evidence_id, procedure.evidence_id, leaf.evidence_id].sort(),
  );
  expect(
    exported.records.some(
      ({ evidence_id }) => evidence_id === unrelated.evidence_id,
    ),
  ).toBe(false);

  const summaryOutput = await runJsonCli(cli, [
    "trace-native-values",
    "/missing-target",
    "main",
    "--detail",
    "summary",
    "--json",
  ]);
  expect(run).toHaveBeenCalledOnce();
  expect(JSON.stringify(summaryOutput)).toContain("evidence_output");
});

it("publishes a bounded trace summary with a complete evidence bundle", async () => {
  const { leaf, procedure, trace, sessionBundle } = createTraceFixture();
  const run = vi.fn<DirectAnalysisRunner>(
    async (_path, _tool, _arguments, options) => {
      options?.onEvidenceBundle?.(sessionBundle);
      return ok(trace);
    },
  );
  const cli = createTraceCli(run);
  const directory = await createTestTempDirectory("rea-trace-summary-");
  const destination = join(directory, "trace-summary-evidence.json");
  const receipt = await runJsonCli(cli, [
    "trace-native-values",
    sourceTarget.path,
    "main",
    "--detail",
    "summary",
    "--evidence_output",
    destination,
    "--json",
  ]);

  const summaryResult = (
    receipt.summary as { normalized_result?: unknown } | undefined
  )?.normalized_result;
  const expectedSummary = {
    kind: "summary",
    parent_operation: "trace_native_values",
    parent_evidence_id: trace.evidence_id,
    summary: {
      seed: "main",
      node_count: 1,
      total_nodes: 2,
      edge_count: 0,
      procedure_count: 1,
      unknown_count: 1,
      decompilations: 1,
      next_offset: 1,
      truncated: true,
      limitation_count: 1,
    },
  };
  expect(summaryResult).toMatchObject(expectedSummary);
  const summaryEvidence = parseEvidence(receipt.summary);
  expect(summaryEvidence.operation).toBe("inspect_analysis_view");
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(destination, "utf8")),
  );
  expect(bundle.records.map(({ evidence_id }) => evidence_id).sort()).toEqual(
    [trace.evidence_id, procedure.evidence_id, leaf.evidence_id].sort(),
  );
  expect(run).toHaveBeenCalledOnce();
});

it("retains completed trace Evidence when the session returns no bundle", async () => {
  const { trace } = createTraceFixture();
  const run = vi.fn<DirectAnalysisRunner>(async () => ok(trace));
  const cli = createTraceCli(run);
  const directory = await createTestTempDirectory("rea-trace-no-bundle-");
  const destination = join(directory, "missing-bundle.json");
  const error = await runJsonCli(cli, [
    "trace-native-values",
    sourceTarget.path,
    "main",
    "--evidence_output",
    destination,
    "--json",
  ]);

  expect(error).toMatchObject({
    code: "unreadable_output",
    details: {
      operation: "trace_native_values",
      partial_observation: {
        operation: "trace_native_values",
        normalized_result: { seed: "main" },
      },
    },
  });
  await expect(readFile(destination, "utf8")).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
});

it("reports a missing linked source with its identity and completed trace", async () => {
  const { leaf, procedure, trace } = createTraceFixture();
  const run = vi.fn<DirectAnalysisRunner>(
    async (_path, _tool, _arguments, options) => {
      options?.onEvidenceBundle?.(createEvidenceBundle([trace, procedure]));
      return ok(trace);
    },
  );
  const cli = createTraceCli(run);
  const directory = await createTestTempDirectory("rea-trace-missing-source-");
  const destination = join(directory, "missing-source.json");
  const error = await runJsonCli(cli, [
    "trace-native-values",
    sourceTarget.path,
    "main",
    "--evidence_output",
    destination,
    "--json",
  ]);

  expect(error).toMatchObject({
    code: "evidence_integrity_mismatch",
    details: {
      evidence_id: leaf.evidence_id,
      reason: "missing",
      operation: "trace_native_values",
      reference_scope: "retained-closure",
      partial_observation: {
        operation: "trace_native_values",
        normalized_result: { seed: "main" },
      },
    },
  });
  await expect(readFile(destination, "utf8")).rejects.toThrow();
  expect(run).toHaveBeenCalledOnce();
});

it("replays direct-analysis Evidence bundle callbacks without rerunning", async () => {
  const directory = await createTestTempDirectory("rea-trace-callback-");
  await verifyDirectAnalysisEvidenceBundleCallback(
    join(directory, "analysis-snapshot.json"),
  );
});
