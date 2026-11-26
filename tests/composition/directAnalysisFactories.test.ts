import { projectCliAnalysisResult } from "../../src/cli/projectCliAnalysisResult.js";
import {
  AnalysisSnapshotMismatchError,
  EvidenceFileError,
} from "../../src/domain/evidenceErrors.js";
import { analysisErrorRemediationAction } from "../../src/domain/analysisErrorPresentation.js";
import { err, ok as resultOk } from "../../src/domain/result.js";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseConfig } from "../../src/config/parseConfig.js";
import { describe, expect, it, vi } from "vitest";
import {
  runDirectAnalysis,
  runProviderAnalysis,
  runManagedProviderExecution,
} from "../../src/application/DirectAnalysis.js";
import type { DirectAnalysisDependencies } from "../../src/application/DirectAnalysisDependencies.js";
import type { NativeToolName } from "../../src/contracts/native/nativeToolContracts.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import {
  createFixtureProviderIdentity,
  observed,
} from "../fixtures/analysisExecution.js";
import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../fixtures/binarySession.js";

type SessionFactory = Exclude<
  keyof DirectAnalysisDependencies,
  "readConfiguration"
>;

const recordingFactories = (
  failure?: Error,
  profile?: ReturnType<typeof createAnalysisProfile>,
) => {
  const sessions: BinarySession[] = [];
  let clientsClosed = 0;
  const selectedFactories: SessionFactory[] = [];
  const createSession = () => {
    const session = createTestBinarySession(
      () => ({
        execute: (operation) => {
          if (failure !== undefined && operation === "read_bytes")
            return Promise.reject(failure);
          return Promise.resolve(observed({ operation }));
        },
        close: () => {
          clientsClosed += 1;
          return Promise.resolve(resultOk(null));
        },
      }),
      profile === undefined
        ? {}
        : {
            resolveAnalysisProfile: () =>
              Promise.resolve(resultOk({ profile })),
          },
    );
    sessions.push(session);
    return session;
  };
  const select = (name: SessionFactory) => () => {
    selectedFactories.push(name);
    return createSession();
  };
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig({}),
    createBinarySession: select("createBinarySession"),
    createArtifactBinarySession: select("createArtifactBinarySession"),
    createNativeDispatchBinarySession: select(
      "createNativeDispatchBinarySession",
    ),
    createNativeBinarySession: select("createNativeBinarySession"),
    createManagedBinarySession: select("createManagedBinarySession"),
  };
  return {
    dependencies,
    sessions,
    selectedFactories,
    clientsClosed: () => clientsClosed,
  };
};

/** Schema-valid read_bytes input so lifecycle tests reach the session. */
const admittedReadBytes = { address: "0x1000" } as const;

/** Schema-valid inputs for the ordinary native session route. */
const admittedNativeSessionInput = {
  observe_native_ui: { pid: 123, window_id: 456 },
  capture_native_ui_scenario: {
    pid: 123,
    window_id: 456,
    steps: [{ kind: "wait", milliseconds: 100 }],
  },
  observe_native_calls: {
    breakpoints: [
      {
        kind: "objc-method",
        class_name: "NSURLSession",
        selector: "dataTaskWithRequest:completionHandler:",
      },
    ],
  },
};

describe("one-shot analysis factory boundary", () => {
  it("preserves thrown failures while releasing clients and cancellation listeners", async () => {
    const [path] = await createBinarySessionTargets();
    const failure = new Error("fixture execution failed");
    const factories = recordingFactories(failure);
    const interruptListeners = process.listenerCount("SIGINT");
    const terminateListeners = process.listenerCount("SIGTERM");
    const execution = runDirectAnalysis(
      factories.dependencies,
      path,
      "read_bytes",
      admittedReadBytes,
    ).then(projectCliAnalysisResult);
    await expect(execution).rejects.toBe(failure);
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
    ).then(projectCliAnalysisResult);
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

  it.each([undefined, "/fixture/committed.snapshot"])(
    "selects the dispatch inspection factory only without a requested snapshot (%s)",
    async (snapshotPath) => {
      const factories = recordingFactories();
      const expected = new Error("selected factory");
      const unexpected = (): never => {
        throw new Error("wrong session policy");
      };
      const selected = (): never => {
        throw expected;
      };
      await expect(
        runDirectAnalysis(
          {
            ...factories.dependencies,
            createBinarySession:
              snapshotPath === undefined ? unexpected : selected,
            createNativeDispatchBinarySession:
              snapshotPath === undefined ? selected : unexpected,
          },
          "/fixture/target",
          "inspect_native_dispatch_metadata",
          {},
          { snapshotPath },
        ).then(projectCliAnalysisResult),
      ).rejects.toBe(expected);
      expect(factories.sessions).toEqual([]);
    },
  );
});

it.each([
  {
    factory: "createNativeBinarySession",
    needsConfiguration: false,
    cases: (
      [
        "inspect_macho",
        "inspect_signature",
        "list_architectures",
        "inspect_plist",
        "demangle_swift",
      ] satisfies readonly NativeToolName[]
    ).map((tool) => ({
      tool,
      input: tool === "demangle_swift" ? { symbols: ["$s4Test3fooyyF"] } : {},
    })),
  },
  {
    factory: "createBinarySession",
    needsConfiguration: true,
    cases: (
      [
        "observe_native_ui",
        "capture_native_ui_scenario",
        "observe_native_calls",
      ] as const
    ).map((tool) => ({ tool, input: admittedNativeSessionInput[tool] })),
  },
])(
  "routes one-shot native operations through $factory",
  async ({ factory, needsConfiguration, cases }) => {
    const [path] = await createBinarySessionTargets();
    const fixtures = recordingFactories();
    const readConfiguration = vi.fn(fixtures.dependencies.readConfiguration);
    const dependencies = { ...fixtures.dependencies, readConfiguration };
    for (const { tool, input } of cases) {
      const result = await runProviderAnalysis(
        dependencies,
        path,
        tool,
        input,
      ).then(projectCliAnalysisResult);
      expect(result, tool).toMatchObject({
        operation: tool,
        normalized_result: { operation: tool },
      });
      expect(fixtures.selectedFactories.at(-1), tool).toBe(factory);
    }
    expect(fixtures.clientsClosed()).toBe(cases.length);
    expect(readConfiguration).toHaveBeenCalledTimes(
      needsConfiguration ? cases.length : 0,
    );
    expect(fixtures.sessions.map((session) => session.activeTarget())).toEqual(
      cases.map(() => undefined),
    );
  },
);

it("preserves a managed execution profile in direct analysis Evidence", async () => {
  const [path] = await createBinarySessionTargets();
  const profile = createAnalysisProfile(createFixtureProviderIdentity(), {
    fixture: true,
  });
  const factories = recordingFactories(undefined, profile);
  const evidence = await runProviderAnalysis(
    factories.dependencies,
    path,
    "inspect_managed_artifact",
    {},
  ).then(projectCliAnalysisResult);
  expect(evidence).toMatchObject({ analysis_profile: profile });
});

it("direct analysis snapshot target mismatch retains actionable snapshot recovery", async () => {
  const [path, other] = await createBinarySessionTargets();
  const profile = createAnalysisProfile(createFixtureProviderIdentity(), {
    fixture: true,
  });
  const factories = recordingFactories(undefined, profile);
  const snapshotPath = join(dirname(path), "snapshot.json");
  expect(
    await runDirectAnalysis(
      factories.dependencies,
      path,
      "read_bytes",
      admittedReadBytes,
      { snapshotPath },
    ).then(projectCliAnalysisResult),
  ).not.toHaveProperty("code");
  const mismatch = await runDirectAnalysis(
    factories.dependencies,
    other,
    "read_bytes",
    admittedReadBytes,
    { snapshotPath },
  ).then(projectCliAnalysisResult);
  const sha = async (input: string) =>
    createHash("sha256")
      .update(await readFile(input))
      .digest("hex");
  expect(mismatch).toMatchObject({
    code: "evidence_integrity_mismatch",
    remediation: {
      action: analysisErrorRemediationAction(
        new AnalysisSnapshotMismatchError(""),
      ),
    },
    details: {
      binding_mismatch: {
        target: {
          snapshot: { identity: { sha256: await sha(path) } },
          selected: { identity: { sha256: await sha(other) } },
        },
        profile_comparison: "not_compared",
      },
    },
  });
  expect(
    await runDirectAnalysis(
      factories.dependencies,
      path,
      "read_bytes",
      admittedReadBytes,
      { snapshotPath },
    ).then(projectCliAnalysisResult),
  ).not.toHaveProperty("code");
});

it("retries snapshot file cleanup before final close even when a published identity is excluded", async () => {
  const [path] = await createBinarySessionTargets();
  const profile = createAnalysisProfile(createFixtureProviderIdentity(), {
    fixture: true,
  });
  const factories = recordingFactories(undefined, profile);
  const events: string[] = [];
  const publication = new EvidenceFileError("write", "io", {
    published: { bytes: 42 },
  });
  const dependencies: DirectAnalysisDependencies = {
    ...factories.dependencies,
    createBinarySession: async (...args) => {
      const session = await factories.dependencies.createBinarySession(...args);
      vi.spyOn(session, "writeAnalysisSnapshot").mockResolvedValue(
        err(publication),
      );
      const closeResources = session.closeFileResources.bind(session);
      vi.spyOn(session, "closeFileResources").mockImplementation(async () => {
        events.push("file-cleanup");
        return closeResources();
      });
      const close = session.close.bind(session);
      vi.spyOn(session, "close").mockImplementation(async () => {
        events.push("session-close");
        return close();
      });
      return session;
    },
  };
  const result = await runDirectAnalysis(
    dependencies,
    path,
    "read_bytes",
    admittedReadBytes,
    { snapshotPath: join(dirname(path), "excluded.snapshot") },
  ).then(projectCliAnalysisResult);
  expect(events[0]).toBe("file-cleanup");
  expect(events).toContain("session-close");
  expect(result).toMatchObject({ details: { published: true, bytes: 42 } });
  expect(result).not.toHaveProperty("details.published_path");
});
