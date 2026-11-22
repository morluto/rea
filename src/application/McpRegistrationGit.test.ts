import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import * as exec from "../process/ExecFileOutput.js";
import { resolveKiloRegistrationWorktree } from "./McpRegistrationGit.js";
import { resolveMcpRegistrationClients } from "./McpRegistrationCatalog.js";
import * as locations from "./McpRegistrationLocations.js";
import type { McpRegistrationLocationContext } from "./McpRegistrationLocations.js";

let resources: ArtifactResourceScope;
beforeEach(() => {
  resources = new ArtifactResourceScope();
  vi.spyOn(exec, "execFileBytes").mockRejectedValue(
    new Error("An inert Git outcome must be selected by the fixture"),
  );
});
afterEach(async () => {
  try {
    await resources.close();
  } finally {
    vi.mocked(exec.execFileBytes).mockRestore();
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

it("keeps an observed Git failure primary when cancellation arrives during completion", async () => {
  const abort = new AbortController();
  const opaque = { operator: "cancel", detail: new Error("opaque reason") };
  const failure = Object.assign(new Error("Command failed: git"), {
    code: 128,
  });
  vi.mocked(exec.execFileBytes).mockImplementation(async () => {
    abort.abort(opaque);
    throw failure;
  });
  const observed: unknown = await resolveKiloRegistrationWorktree(
    await context(abort.signal),
  ).catch((cause: unknown) => cause);
  if (!(observed instanceof ConfigurationError)) throw observed;
  expect(observed.cause).toBe(failure);
  expect(observed.secondaryFailures).toEqual([
    expect.objectContaining({ _tag: "AnalysisCancelledError", cause: opaque }),
  ]);
});

it("retains primary cancellation and its opaque caller reason", async () => {
  const opaque = { operator: "cancel", detail: new Error("opaque reason") };
  vi.mocked(exec.execFileBytes).mockRejectedValue(
    new exec.ExecFileOutputCancelledError(opaque),
  );
  const observed: unknown = await resolveKiloRegistrationWorktree(
    await context(),
  ).catch((cause: unknown) => cause);
  expect(observed).toBeInstanceOf(AnalysisCancelledError);
  if (!(observed instanceof AnalysisCancelledError))
    throw new Error("Primary cancellation lost its classification");
  expect(observed.cause).toBe(opaque);
});

it("runs each Git query as a stoppable process group with the caller's environment", async () => {
  const selected = await context();
  vi.mocked(exec.execFileBytes).mockRejectedValue(new Error("stop here"));
  await resolveKiloRegistrationWorktree(selected).catch(() => undefined);
  expect(exec.execFileBytes).toHaveBeenCalledWith(
    "git",
    ["rev-parse", "--show-toplevel"],
    expect.objectContaining({
      cwd: expect.any(String),
      env: selected.environment,
      stopSignal: "SIGTERM",
      timeout: 10_000,
    }),
  );
});

const undecodable = {
  stdout: Buffer.from([0xff]),
  stderr: Buffer.from("native diagnostic"),
};

it("preserves an undecodable Git observation and a late cancellation through selection", async () => {
  const controller = new AbortController();
  const reason = { operator: "cancel incomplete observation" };
  vi.mocked(exec.execFileBytes).mockImplementation(async () => {
    controller.abort(reason);
    return undecodable;
  });
  const selected = await context(controller.signal);
  const result = await resolveMcpRegistrationClients(
    {
      agents: ["kilo-code"],
      global: false,
      cwd: selected.cwd,
      home: selected.home,
      platform: selected.platform,
      environment: selected.environment,
      signal: controller.signal,
    },
    resources,
  );
  if (result.ok) throw new Error("Incomplete observation must fail");
  expect(result.error).toBeInstanceOf(ConfigurationError);
  expect(result.error.cause).toBeInstanceOf(Error);
  expect((result.error.cause as Error).cause).toBe(undecodable);
  expect(result.error.secondaryFailures).toEqual([
    expect.objectContaining({ _tag: "AnalysisCancelledError", cause: reason }),
  ]);
});

it("preserves a native location access failure and late cancellation through selection", async () => {
  const controller = new AbortController();
  const reason = { operator: "cancel location discovery" };
  const physical = new Error("client path could not be inspected");
  const failure = new ConfigurationError("Selected path unavailable", {
    cause: physical,
  });
  const present = vi
    .spyOn(locations, "present")
    .mockImplementationOnce(async () => {
      controller.abort(reason);
      throw failure;
    });
  try {
    const selected = await context(controller.signal);
    const result = await resolveMcpRegistrationClients(
      {
        agents: ["kilo-code"],
        global: true,
        cwd: selected.cwd,
        home: selected.home,
        platform: selected.platform,
        environment: selected.environment,
        signal: controller.signal,
      },
      resources,
    );
    if (result.ok) throw new Error("Location access failure was lost");
    expect(result.error).toBe(failure);
    expect(result.error.cause).toBe(physical);
    expect(result.error.secondaryFailures).toEqual([
      expect.objectContaining({
        _tag: "AnalysisCancelledError",
        cause: reason,
      }),
    ]);
  } finally {
    present.mockRestore();
  }
});
