import { parseConfig } from "../../src/config.js";
import { ok as resultOk } from "../../src/domain/result.js";
import { describe, expect, it } from "vitest";
import {
  runDirectAnalysis,
  runManagedProviderExecution,
} from "../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
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
        return Promise.resolve(resultOk(null));
      },
    }));
    sessions.push(session);
    return session;
  };
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: createSession,
    createManagedBinarySession: createSession,
  };
  return { dependencies, sessions, clientsClosed: () => clientsClosed };
};

describe("one-shot analysis factory boundary", () => {
  it("preserves thrown failures while releasing clients and cancellation listeners", async () => {
    const [path] = await createBinarySessionTargets();
    const failure = new Error("fixture execution failed");
    const factories = recordingFactories(failure);
    const interruptListeners = process.listenerCount("SIGINT");
    const terminateListeners = process.listenerCount("SIGTERM");
    await expect(
      runDirectAnalysis(factories.dependencies, path, "read_bytes", {}),
    ).rejects.toBe(failure);
    expect(factories.clientsClosed()).toBe(1);
    expect(process.listenerCount("SIGINT")).toBe(interruptListeners);
    expect(process.listenerCount("SIGTERM")).toBe(terminateListeners);
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
    const managedDependencies = {
      ...factories.dependencies,
      readConfiguration: () => {
        throw new Error("native configuration must stay unused");
      },
      createBinarySession: () => {
        throw new Error("native factory must stay unused");
      },
    };
    const result = await runManagedProviderExecution(
      managedDependencies,
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
