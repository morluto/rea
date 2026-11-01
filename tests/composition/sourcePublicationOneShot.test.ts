import { expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import {
  createBinarySessionTargets,
  createTestProviderRouter,
} from "../fixtures/binarySession.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { BinarySession } from "../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../src/application/investigation/InvestigationRecords.js";
import {
  runDirectAnalysis,
  runProviderAnalysis,
} from "../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import { createAnalysisExecution } from "../../src/application/AnalysisProvider.js";
import { createAnalysisExecutionEvidence } from "../../src/domain/analysisObservation.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { parseConfig } from "../../src/config/parseConfig.js";
import { err, ok } from "../../src/domain/result.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { primaryAnalysisError } from "../../src/domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../src/domain/analysisErrorCore.js";

it.each(["inspect_macho", "inspect_managed_members"] as const)(
  "recovers %s Evidence and caller input identity after source admission fails",
  async (tool) => {
    const [target] = await createBinarySessionTargets();
    const path = `${dirname(target)}/./${basename(target)}`;
    const provider = { id: "fixture", name: "Fixture", version: "1" };
    const source = createEvidence(undefined, provider, {
      operation: "health",
      parameters: {},
      result: "large".repeat(20000),
    });
    const calls: Readonly<Record<string, unknown>>[] = [];
    const run = async (maximumRepresentationBytes: number) => {
      const session = new BinarySession(
        createTestProviderRouter(() => ({
          execute: async (operation, parameters) => {
            if (operation !== "health") calls.push(parameters);
            return ok(
              createAnalysisExecution(
                operation === "health" ? null : "completed",
                provider,
                operation === "health" ? {} : { sourceEvidence: [source] },
              ),
            );
          },
          close: async () => ok(null),
        })),
        new InvestigationRecords({ maximumRepresentationBytes }),
      );
      const create = () => session;
      const dependencies: DirectAnalysisDependencies = {
        readConfiguration: () => parseConfig({}),
        createBinarySession: create,
        createNativeDispatchBinarySession: create,
        createArtifactBinarySession: create,
        createNativeBinarySession: create,
        createManagedBinarySession: create,
      };
      return runProviderAnalysis(dependencies, path, tool, {});
    };
    const success = await run(500000);
    if (!success.ok) throw new Error(JSON.stringify(success.error));
    const refused = await run(20000);
    if (refused.ok) throw new Error("Expected source admission failure");
    expect(refused.error).toMatchObject({
      details: {
        completed_observation: {
          evidence: {
            evidence_id: success.value.evidence_id,
            parameters: { input_path: path },
            caller_input_path: path,
          },
        },
      },
    });
    expect(calls).toEqual([{}, {}]);
  },
);

it("delivers a preexisting completed record inline after one-shot cleanup", async () => {
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const source = createEvidence(
    undefined,
    provider,
    { operation: "health", parameters: {}, result: "large".repeat(20000) },
    { immutable: true },
  );
  const path = join(
    await createTestTempDirectory("rea-oneshot-source-"),
    "fixture.com",
  );
  await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const router = createTestProviderRouter(() => ({
    execute: async (op) =>
      ok(
        createAnalysisExecution(
          op === "health" ? null : "completed",
          provider,
          op === "health" ? {} : { sourceEvidence: [source] },
        ),
      ),
    close: async () => ok(null),
  }));
  const records = new InvestigationRecords({
    maximumRepresentationBytes: 20000,
  });
  const session = new BinarySession(router, records);
  const opened = await session.open(path, { formatHint: "dos-com" });
  if (!opened.ok) throw opened.error;
  const args = { address: "0x100", length: 4 };
  const primary = createAnalysisExecutionEvidence(
    "read_bytes",
    args,
    {
      ...createAnalysisExecution("completed", provider, {
        sourceEvidence: [source],
      }),
      subject: opened.value,
    },
    "observed",
  );
  expect(session.recordEvidence(primary).ok).toBe(true);
  const create = () => session;
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: create,
    createNativeDispatchBinarySession: create,
    createArtifactBinarySession: create,
    createNativeBinarySession: create,
    createManagedBinarySession: create,
  };
  const result = await runDirectAnalysis(
    dependencies,
    path,
    "read_bytes",
    args,
    { formatHint: "dos-com" },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected source failure");
  expect(result.error).toMatchObject({
    code: "resource_constraint",
    details: {
      completed_observation: {
        kind: "inline-evidence",
        retention: "one-shot-session",
        source_closure: "not-established",
        evidence: {
          evidence_id: primary.evidence_id,
          caller_input_path: path,
          normalized_result: "completed",
        },
      },
    },
  });
});

it("keeps caller spelling on a raw observation when a source ID is malformed", async () => {
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const base = createEvidence(undefined, provider, {
    operation: "health",
    parameters: {},
    result: "source",
  });
  const source = { ...base, evidence_id: "invalid" };
  const path = join(
    await createTestTempDirectory("rea-oneshot-invalid-source-"),
    "fixture.com",
  );
  await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const router = createTestProviderRouter(() => ({
    execute: async (op) =>
      ok(
        createAnalysisExecution(
          op === "health" ? null : "completed",
          provider,
          op === "health" ? {} : { sourceEvidence: [source] },
        ),
      ),
    close: async () => ok(null),
  }));
  const session = new BinarySession(router);
  const create = () => session;
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: create,
    createNativeDispatchBinarySession: create,
    createArtifactBinarySession: create,
    createNativeBinarySession: create,
    createManagedBinarySession: create,
  };
  const result = await runDirectAnalysis(
    dependencies,
    path,
    "read_bytes",
    { address: "0x100", length: 4 },
    { formatHint: "dos-com" },
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected source failure");
  expect(result.error).toMatchObject({
    code: "evidence_integrity_mismatch",
    details: {
      completed_observation: {
        kind: "unretained-observation",
        source_closure: "not-established",
        observation: {
          operation: "read_bytes",
          result: "completed",
          caller_input_path: path,
        },
      },
    },
  });
});

it.each([false, true])(
  "keeps the source failure and primary when cancellation arrives during final close (close fails: %s)",
  async (closeFails) => {
    const provider = { id: "fixture", name: "Fixture", version: "1" };
    const source = createEvidence(
      undefined,
      provider,
      { operation: "health", parameters: {}, result: "large".repeat(20000) },
      { immutable: true },
    );
    const path = join(
      await createTestTempDirectory("rea-source-final-close-"),
      "fixture.com",
    );
    await writeFile(path, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
    const session = new BinarySession(
      createTestProviderRouter(() => ({
        execute: async (op) =>
          ok(
            createAnalysisExecution(
              op === "health" ? null : "completed",
              provider,
              op === "health" ? {} : { sourceEvidence: [source] },
            ),
          ),
        close: async () => ok(null),
      })),
      new InvestigationRecords({ maximumRepresentationBytes: 20000 }),
    );
    const opened = await session.open(path, { formatHint: "dos-com" });
    if (!opened.ok) throw opened.error;
    const args = { address: "0x100", length: 4 };
    const primary = createAnalysisExecutionEvidence(
      "read_bytes",
      args,
      {
        ...createAnalysisExecution("completed", provider, {
          sourceEvidence: [source],
        }),
        subject: opened.value,
      },
      "observed",
    );
    expect(session.recordEvidence(primary).ok).toBe(true);
    const create = () => session;
    const dependencies: DirectAnalysisDependencies = {
      readConfiguration: () => parseConfig({}),
      createBinarySession: create,
      createNativeDispatchBinarySession: create,
      createArtifactBinarySession: create,
      createNativeBinarySession: create,
      createManagedBinarySession: create,
    };
    const controller = new AbortController();
    const reason = { during: "final close" };
    const recordEvidence = vi.spyOn(session, "recordEvidence");
    const nativeClose = session.close.bind(session);
    const failure = new ProviderCleanupError("fixture", ["fixture-owner"], {});
    const close = vi
      .spyOn(session, "close")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return closeFails ? err(failure) : nativeClose();
      });
    try {
      const result = await runDirectAnalysis(
        dependencies,
        path,
        "read_bytes",
        args,
        {
          formatHint: "dos-com",
          signal: controller.signal,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected source failure");
      expect(result.error).toMatchObject({
        code: closeFails ? "cleanup_incomplete" : "resource_constraint",
        details: {
          partial_observation: {
            kind: "unretained-evidence",
            evidence: { evidence_id: source.evidence_id },
          },
          completed_observation: {
            kind: "inline-evidence",
            retention: "one-shot-session",
            source_closure: "not-established",
            evidence: {
              evidence_id: primary.evidence_id,
              caller_input_path: path,
              normalized_result: "completed",
            },
          },
          ...(closeFails
            ? {
                resources: ["fixture-owner"],
                cleanup: "incomplete",
                execution_failure: "resource_constraint",
              }
            : {}),
        },
      });
      const sourceFailure = recordEvidence.mock.results
        .map(({ value }) => value)
        .find((value) => value !== undefined && !value.ok);
      expect(sourceFailure).toBeDefined();
      expect(
        primaryAnalysisError(sourceFailure!.error).secondaryFailures,
      ).toContainEqual(expect.objectContaining({ cause: reason }));
      expect(
        primaryAnalysisError(sourceFailure!.error).secondaryFailures.some(
          (failure) =>
            failure instanceof AnalysisCancelledError &&
            failure.cause === reason,
        ),
      ).toBe(true);
      expect(result.error).toMatchObject({
        details: {
          secondary_failures: [expect.objectContaining({ code: "cancelled" })],
        },
      });
      expect(session.activeTarget() !== undefined).toBe(closeFails);
    } finally {
      close.mockRestore();
      const closed = await nativeClose();
      if (!closed.ok) throw closed.error;
      expect(session.activeTarget()).toBeUndefined();
    }
  },
);
