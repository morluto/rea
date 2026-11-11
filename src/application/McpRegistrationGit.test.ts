import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import * as owned from "../process/OwnedCommand.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { resolveKiloRegistrationWorktree } from "./McpRegistrationGit.js";
import type { McpRegistrationLocationContext } from "./McpRegistrationLocations.js";

let resources: ArtifactResourceScope;
beforeEach(() => {
  resources = new ArtifactResourceScope();
  vi.spyOn(owned, "prepareOwnedCommand").mockResolvedValue(undefined);
  vi.spyOn(owned, "runOwnedCommand").mockRejectedValue(
    new Error("An inert Git outcome must be selected by the fixture"),
  );
});
afterEach(async () => {
  try {
    await resources.close();
  } finally {
    vi.mocked(owned.prepareOwnedCommand).mockRestore();
    vi.mocked(owned.runOwnedCommand).mockRestore();
  }
});

const context = async (
  signal?: AbortSignal,
): Promise<McpRegistrationLocationContext> => {
  const root = await createTestTempDirectory("rea-registration-git-");
  await mkdir(join(root, ".git"));
  return {
    cwd: root,
    home: root,
    platform: process.platform,
    environment: {},
    setup: [],
    resources,
    ...(signal === undefined ? {} : { signal }),
  };
};

it.each(["process", "timeout", "output-limit"] as const)(
  "keeps observed %s failure primary when cancellation arrives during Git completion",
  async (reason) => {
    const abort = new AbortController();
    const opaque = { operator: "cancel", detail: new Error("opaque reason") };
    const failure = new owned.OwnedCommandFailure(
      reason,
      "Physical Git observation failed",
      null,
      null,
      { cancellation: { reason: opaque }, cause: new Error("physical cause") },
    );
    vi.mocked(owned.runOwnedCommand).mockImplementation(async () => {
      abort.abort(opaque);
      throw failure;
    });
    const observed: unknown = await resolveKiloRegistrationWorktree(
      await context(abort.signal),
    ).catch((cause: unknown) => cause);
    expect(observed).toBeInstanceOf(ConfigurationError);
    if (!(observed instanceof ConfigurationError))
      throw new Error("Physical Git failure lost its primary classification");
    expect(observed.cause).toBe(failure);
    expect(observed.secondaryFailures).toHaveLength(1);
    expect(observed.secondaryFailures[0]).toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(observed.secondaryFailures[0]?.cause).toBe(opaque);
    expect(failure.cancellation?.reason).toBe(opaque);
  },
);

it("retains primary cancellation and its opaque caller reason", async () => {
  const opaque = { operator: "cancel", detail: new Error("opaque reason") };
  vi.mocked(owned.runOwnedCommand).mockRejectedValue(
    new owned.OwnedCommandFailure(
      "cancelled",
      "Git observation cancelled",
      null,
      null,
      {
        cancellation: { reason: opaque },
      },
    ),
  );
  const observed: unknown = await resolveKiloRegistrationWorktree(
    await context(),
  ).catch((cause: unknown) => cause);
  expect(observed).toBeInstanceOf(AnalysisCancelledError);
  if (!(observed instanceof AnalysisCancelledError))
    throw new Error("Primary cancellation lost its classification");
  expect(observed.cause).toBe(opaque);
});

it("retains the exact incomplete UTF-8 snapshot behind the Git observation failure", async () => {
  const snapshot: ProviderProcessSnapshot = {
    stdout: { text: "\uFFFD", invalidUtf8: true, bytes: 1, observedBytes: 1 },
    stderr: { text: "native diagnostic", bytes: 17, observedBytes: 17 },
    exitCode: 0,
    signal: null,
  };
  vi.mocked(owned.runOwnedCommand).mockResolvedValue(snapshot);
  const observed: unknown = await resolveKiloRegistrationWorktree(
    await context(),
  ).catch((cause: unknown) => cause);
  expect(observed).toBeInstanceOf(ConfigurationError);
  if (!(observed instanceof ConfigurationError))
    throw new Error(
      "Incomplete Git observation lost its configuration failure",
    );
  expect(observed.cause).toBeInstanceOf(Error);
  if (!(observed.cause instanceof Error))
    throw new Error("Incomplete Git observation lost its immediate failure");
  expect(observed.cause.cause).toBe(snapshot);
});
