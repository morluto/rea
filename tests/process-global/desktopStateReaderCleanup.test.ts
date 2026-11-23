import { expect, it, onTestFinished, vi } from "vitest";
import { createCommandCli } from "../support/cli/commandCli.js";
import { registerDesktopCaptureCommands } from "../../src/cli/desktopCaptureCommands.js";
import { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { unknownTarget } from "../../src/domain/targetIdentity.js";
import { silentLogger } from "../../src/logger.js";
import { AnalysisCleanupLease } from "../../src/resources/AnalysisCleanupLease.js";
import type { ArtifactResourceScope } from "../../src/resources/index.js";

const fixture = vi.hoisted(() => ({
  lease: undefined as unknown,
  sqlite: undefined as unknown,
  worker: undefined as unknown,
  closed: undefined as unknown,
}));

// Observe the composite the close callback throws, without changing it.
vi.mock("../../src/cli/finishAnalysisCommand.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/cli/finishAnalysisCommand.js")
    >();
  return {
    ...original,
    finishAnalysisCommand: (
      run: Parameters<typeof original.finishAnalysisCommand>[0],
      service: Parameters<typeof original.finishAnalysisCommand>[1],
      ...rest: unknown[]
    ) =>
      (original.finishAnalysisCommand as (...args: unknown[]) => unknown)(
        run,
        {
          close: async () => {
            try {
              await service.close();
            } catch (cause: unknown) {
              fixture.closed = cause;
              throw cause;
            }
          },
        },
        ...rest,
      ),
  };
});

vi.mock("../../src/composition/sqlite.js", () => ({
  createSqliteDatabaseService: () => ({
    close: async () => {
      throw fixture.sqlite;
    },
  }),
}));

vi.mock("../../src/process/OwnedWorkerRuntime.js", () => ({
  OwnedWorkerRuntime: {
    retryPending: async () => {
      throw fixture.worker;
    },
  },
}));

// The export retains one lease in the command's real resource scope, so the
// scope's own close fails before the SQLite and worker closes run.
vi.mock("../../src/application/desktop/DesktopApplicationExport.js", () => ({
  exportDesktopApplication: async (
    _input: unknown,
    readers: { readonly resources: ArtifactResourceScope },
  ) => {
    readers.resources.retain({
      kind: "lease",
      resource: "/export-staging",
      lease: AnalysisCleanupLease.forCloseOwner(
        {
          close: async () => {
            throw fixture.lease;
          },
        },
        "/export-staging",
      ),
    });
    return createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Desktop export fixture", version: "1" },
      {
        operation: "export_desktop_application",
        parameters: {},
        result: {},
        confidence: "observed",
      },
    );
  },
}));

const releasable = (
  providerId: string,
  resource: string,
  reason: string,
  released: () => boolean,
) => {
  const failure = new ProviderCleanupError(
    providerId,
    [resource],
    { reason },
    { operation: "export_desktop_application" },
  );
  failure.bindCleanupReleaseClaim({
    get cleanupReleased() {
      return released();
    },
  });
  return failure;
};

it("keeps every state-reader close failure in the export's cleanup composite", async () => {
  const previousExitCode = process.exitCode;
  onTestFinished(() => {
    process.exitCode = previousExitCode;
  });
  const released = { sqlite: false, worker: false };
  fixture.lease = new Error("Export staging remains locked");
  fixture.sqlite = releasable(
    "rea-sqlite",
    "sqlite-handle",
    "SQLite handle remains open",
    () => released.sqlite,
  );
  fixture.worker = releasable(
    "rea-worker",
    "export-worker",
    "Export worker remains owned",
    () => released.worker,
  );
  const cli = createCommandCli();
  registerDesktopCaptureCommands(cli, silentLogger, {});
  let stdout = "";
  await cli.serve(
    [
      "export-desktop-application",
      "/capture-fixture",
      "/bundle-fixture",
      "--json",
    ],
    {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => {},
    },
  );
  const output: unknown = JSON.parse(stdout);
  expect(output).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: expect.arrayContaining([
        "/export-staging",
        "sqlite-handle",
        "export-worker",
      ]),
    },
  });

  const reported = JSON.stringify(output);
  for (const reason of [
    "Export staging remains locked",
    "SQLite handle remains open",
    "Export worker remains owned",
  ])
    expect(reported).toContain(reason);

  // Each owner still decides its own part of the composite's completion.
  const composite = fixture.closed;
  if (!(composite instanceof AnalysisError))
    throw new Error("Expected the close composite to be an AnalysisError");
  expect(composite.cleanupResources).toEqual(
    expect.arrayContaining([
      "/export-staging",
      "sqlite-handle",
      "export-worker",
    ]),
  );
  released.worker = true;
  expect(composite.cleanupResources).not.toContain("export-worker");
  released.sqlite = true;
  expect(composite.cleanupResources).not.toContain("sqlite-handle");
  // The scope's lease never confirms release.
  expect(composite.cleanupIncomplete).toBe(true);
});
