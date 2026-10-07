import { describe, expect, it } from "vitest";
import {
  runDirectAnalysis,
  runManagedProviderExecution,
} from "../../src/application/DirectAnalysis.js";
import { runCapabilityStatus } from "../../src/application/DirectAnalysisStatus.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { observed } from "../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../fixtures/binarySession.js";

const recordingFactories = (failure?: Error) => {
  const sessions: BinarySession[] = [];
  let clientsClosed = 0;
  const createSession = () => {
    const session = createTestBinarySession(() => ({
      execute: (operation) => {
        if (failure !== undefined && operation === "read_bytes")
          return Promise.reject(failure);
        return Promise.resolve(observed({ operation }));
      },
      close: () => {
        clientsClosed += 1;
        return Promise.resolve();
      },
    }));
    sessions.push(session);
    return session;
  };
  const dependencies: DirectAnalysisDependencies = {
    createBinarySession: createSession,
    createManagedBinarySession: createSession,
  };
  return { dependencies, sessions, clientsClosed: () => clientsClosed };
};

describe("one-shot analysis factory boundary", () => {
  it("keeps independent commands and releases their actual session clients", async () => {
    const [path] = await createBinarySessionTargets();
    const factories = recordingFactories();
    const first = parseEvidence(
      await runDirectAnalysis(factories.dependencies, path, "read_bytes", {}),
    );
    const second = parseEvidence(
      await runDirectAnalysis(factories.dependencies, path, "read_bytes", {}),
    );
    expect(first).toMatchObject({
      operation: "read_bytes",
      normalized_result: { operation: "read_bytes" },
      subject: { local_path: path },
    });
    expect(second.subject).toEqual(first.subject);
    expect(factories.sessions).toHaveLength(2);
    expect(factories.sessions[0]).not.toBe(factories.sessions[1]);
    expect(factories.clientsClosed()).toBe(2);
    for (const session of factories.sessions) {
      expect(session.activeTarget()).toBeUndefined();
      expect(session.evidenceById(first.evidence_id)).toBeUndefined();
      expect(session.evidenceById(second.evidence_id)).toBeUndefined();
    }
  });

  it("preserves thrown failures while releasing clients and cancellation listeners", async () => {
    const [path] = await createBinarySessionTargets();
    const failure = new Error("fixture execution failed");
    const factories = recordingFactories(failure);
    const listeners = process.listenerCount("SIGINT");
    await expect(
      runDirectAnalysis(factories.dependencies, path, "read_bytes", {}),
    ).rejects.toBe(failure);
    expect(factories.clientsClosed()).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(factories.sessions[0]?.activeTarget()).toBeUndefined();
  });

  it("does not acquire a client after cancellation before target opening", async () => {
    const [path] = await createBinarySessionTargets();
    const factories = recordingFactories();
    const controller = new AbortController();
    controller.abort();
    const result = await runDirectAnalysis(
      factories.dependencies,
      path,
      "read_bytes",
      {},
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      error: "Analysis failed",
      code: "cancelled",
    });
    expect(factories.clientsClosed()).toBe(0);
    expect(factories.sessions[0]?.activeTarget()).toBeUndefined();
  });

  it("keeps managed execution independent of native construction", async () => {
    const [path] = await createBinarySessionTargets();
    const factories = recordingFactories();
    const result = await runManagedProviderExecution(
      {
        ...factories.dependencies,
        createBinarySession: () => {
          throw new Error("native factory must stay unused");
        },
      },
      path,
      "inspect_managed_artifact",
    );
    expect(result).toMatchObject({
      ok: true,
      value: { result: { operation: "inspect_managed_artifact" } },
    });
    expect(factories.clientsClosed()).toBe(1);
    expect(factories.sessions[0]?.activeTarget()).toBeUndefined();
  });
});

describe("status factory configuration", () => {
  it("passes the selected environment and logger without opening a target", async () => {
    const factories = recordingFactories();
    const selected: string[] = [];
    await runCapabilityStatus(
      {
        createBinarySession: (config, logger) => {
          selected.push(config.analysisProvider);
          expect(logger).toBeDefined();
          return factories.dependencies.createBinarySession(config, logger);
        },
      },
      undefined,
      { REA_ANALYSIS_PROVIDER: "ghidra" },
    );
    expect(selected).toEqual(["ghidra"]);
    expect(factories.clientsClosed()).toBe(0);
    expect(factories.sessions[0]?.activeTarget()).toBeUndefined();
  });

  it("retains configuration diagnostics before acquiring any session", async () => {
    const factories = recordingFactories();
    const result = await runCapabilityStatus(
      factories.dependencies,
      undefined,
      { REA_ANALYSIS_PROVIDER: "invalid_provider" },
    );
    expect(result).toHaveProperty("error");
    expect(factories.sessions).toEqual([]);
  });
});
