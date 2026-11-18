import { expect, it, onTestFinished, vi } from "vitest";
import { createCommandCli } from "../../support/cli/commandCli.js";
import { registerDesktopCaptureCommands } from "../../../src/cli/desktopCaptureCommands.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { silentLogger } from "../../../src/logger.js";

const failures = vi.hoisted(() => ({
  sqlite: undefined as unknown,
  worker: undefined as unknown,
  closed: undefined as unknown,
}));

// Observe the composite the close callback throws, without changing it.
vi.mock("../../../src/cli/finishAnalysisCommand.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../../src/cli/finishAnalysisCommand.js")
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
              failures.closed = cause;
              throw cause;
            }
          },
        },
        ...rest,
      ),
  };
});

vi.mock("../../../src/composition/sqlite.js", () => ({
  createSqliteDatabaseService: () => ({
    close: async () => {
      throw failures.sqlite;
    },
  }),
}));

vi.mock("../../../src/process/OwnedWorkerRuntime.js", () => ({
  OwnedWorkerRuntime: {
    retryPending: async () => {
      throw failures.worker;
    },
  },
}));

vi.mock("../../../src/application/desktop/DesktopApplicationExport.js", () => ({
  exportDesktopApplication: async () =>
    createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Desktop export fixture", version: "1" },
      {
        operation: "export_desktop_application",
        parameters: {},
        result: {},
        confidence: "observed",
      },
    ),
}));

it("keeps both SQLite and export-worker cleanup failures when both closes fail, completing when both release", async () => {
  const previousExitCode = process.exitCode;
  onTestFinished(() => {
    process.exitCode = previousExitCode;
  });
  const released = { sqlite: false, worker: false };
  const sqlite = new ProviderCleanupError(
    "rea-sqlite",
    ["sqlite-handle"],
    { reason: "SQLite handle remains open" },
    { operation: "export_desktop_application" },
  );
  const worker = new ProviderCleanupError(
    "rea-worker",
    ["export-worker"],
    { reason: "Export worker remains owned" },
    { operation: "export_desktop_application" },
  );
  sqlite.bindCleanupReleaseClaim({
    get cleanupReleased() {
      return released.sqlite;
    },
  });
  worker.bindCleanupReleaseClaim({
    get cleanupReleased() {
      return released.worker;
    },
  });
  failures.sqlite = sqlite;
  failures.worker = worker;
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
      resources: expect.arrayContaining(["sqlite-handle", "export-worker"]),
    },
  });
  expect(JSON.stringify(output)).toContain("SQLite handle remains open");
  expect(JSON.stringify(output)).toContain("Export worker remains owned");

  // The composite reads completion from both parts: it stays incomplete
  // until each part's owner confirms release, then completes.
  const composite = failures.closed;
  if (!(composite instanceof AnalysisError))
    throw new Error("Expected the close composite to be an AnalysisError");
  expect(composite.cleanupIncomplete).toBe(true);
  released.sqlite = true;
  expect(composite.cleanupIncomplete).toBe(true);
  released.worker = true;
  expect(composite.cleanupIncomplete).toBe(false);
});
