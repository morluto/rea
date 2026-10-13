import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { z } from "zod";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import { PwntoolsRecordedCrashProvider } from "../../src/native/pwntools/PwntoolsRecordedCrashProvider.js";
import type { PwntoolsLauncher } from "../../src/native/pwntools/PwntoolsDecoder.js";
import {
  PWNTOOLS_MEMORY_FAILURE_EXIT,
  PWNTOOLS_PROVIDER_IDENTITY,
} from "../../src/native/pwntools/PwntoolsRelease.js";
import { cleanupOwnedProcessGroup } from "../../src/process/ProcessOwnership.js";
import { prepareProcessOwnershipInspection } from "../../src/process/ProcessOwnershipObservation.js";
import { spawnOwnedProviderProcess } from "../../src/process/ProviderProcess.js";
import { PrivateRuntimeRoot } from "../../src/process/PrivateRuntimeRoot.js";
import * as artifacts from "../../src/artifacts/readStableArtifact.js";
import {
  recordedCrashFixture,
  recordedCrashFixtureBytes,
  recordedCrashDebuggerFixture,
} from "../fixtures/binaryDiagnostics/recordedCrash.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../support/workspace/workspaceFixture.js";

const supportedHost = process.platform !== "win32";
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const architecture = Object.getOwnPropertyDescriptor(process, "arch");
const worker = fileURLToPath(
  new URL("../fixtures/pwntoolsChangingArtifact.mjs", import.meta.url),
);
beforeAll(() =>
  supportedHost ? prepareProcessOwnershipInspection() : undefined,
);
beforeEach(() => {
  // Use the actual host inspector; simulate only the decoder availability gate.
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process, "arch", { value: "x64" });
});
afterEach(() => {
  if (platform !== undefined)
    Object.defineProperty(process, "platform", platform);
  if (architecture !== undefined)
    Object.defineProperty(process, "arch", architecture);
  vi.restoreAllMocks();
});

const fixture = async () => {
  const workspace = await createTestWorkspace("rea-stage-retirement-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = workspace.path("selected.core");
  const value = recordedCrashFixture(path);
  await writeFile(path, recordedCrashFixtureBytes(value));
  const root = await PrivateRuntimeRoot.create({
    parent: workspace.root,
    prefix: "owned-",
  });
  const venv = workspace.path("venv");
  const plugin = workspace.path("gdbinit.py");
  await mkdir(venv);
  await writeFile(plugin, "");
  const environment = {
    REA_PWNTOOLS_PYTHON: process.execPath,
    REA_PWNDBG_GDB: process.execPath,
    REA_PWNDBG_GDBINIT: plugin,
    REA_PWNDBG_VENV_PATH: venv,
  };
  const {
    artifact: _artifact,
    diagnostics: _diagnostics,
    debugger: _debugger,
    decoder_diagnostics: _decoderDiagnostics,
    ...payload
  } = value;
  const reply = JSON.stringify({
    ok: true,
    profile: PWNTOOLS_PROVIDER_IDENTITY.version,
    value: payload,
  });
  const basic: PwntoolsLauncher = async (spawn) => {
    await writeFile(join(root.path, "reply.json"), reply);
    return spawnOwnedProviderProcess({
      ...spawn,
      arguments: ["-e", "process.stdout.write('basic diagnostic')"],
    });
  };
  return { path, root, environment, basic };
};

const changingWorker = async (
  spawn: Parameters<NonNullable<PwntoolsLauncher>>[0],
  path: string,
  contents: { initial: string; final: string; exitCode: number },
  cleanupAllowed: () => boolean = () => true,
) => {
  const trigger = join(spawn.cwd ?? "", "change.trigger");
  const ready = join(spawn.cwd ?? "", "descendant.ready");
  const done = join(spawn.cwd ?? "", "change.done");
  const launched = await spawnOwnedProviderProcess({
    ...spawn,
    arguments: [
      worker,
      "leader",
      path,
      contents.initial,
      contents.final,
      trigger,
      ready,
      done,
      String(contents.exitCode),
    ],
  });
  let stops = 0;
  return {
    ...launched,
    cleanup: async () => {
      if (++stops === 1 || !cleanupAllowed())
        return {
          cleaned: false as const,
          reason: "fixture inspection unavailable",
        };
      const descendant = Number(await readFile(ready, "utf8"));
      expect(() => process.kill(descendant, 0)).not.toThrow();
      await writeFile(trigger, "change now");
      await expect
        .poll(() =>
          access(done).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      return cleanupOwnedProcessGroup(launched.ownership);
    },
  };
};

it.runIf(supportedHost).each(["decoder", "debugger"] as const)(
  "classifies %s failure markers only after surviving descendants stop",
  async (stage) => {
    const { path, root, environment, basic } = await fixture();
    let launches = 0;
    const provider = new PwntoolsRecordedCrashProvider(
      environment,
      async (spawn) => {
        if (stage === "debugger" && ++launches === 1) return basic(spawn);
        const marker = join(spawn.cwd ?? "", "resource.failure");
        await writeFile(
          join(spawn.cwd ?? "", "limits.json"),
          JSON.stringify(recordedCrashDebuggerFixture().reported_limits),
        );
        return changingWorker(spawn, marker, {
          initial: "M",
          final: "!",
          exitCode: PWNTOOLS_MEMORY_FAILURE_EXIT,
        });
      },
      async () => root,
    );
    onTestFinished(() => provider.close());
    const result = await provider.inspectAndClose({
      path,
      include_debugger_context: stage === "debugger",
    });
    if (result.ok) throw new Error("Expected the original command failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "execution_failure",
      details: {
        diagnostics: {
          phase: stage,
          resource_failure_marker: { resource: null },
          exit_code: PWNTOOLS_MEMORY_FAILURE_EXIT,
          captured_output: { stdout: "stage diagnostic" },
        },
      },
    });
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(supportedHost)(
  "publishes debugger replies only after surviving descendants stop",
  async () => {
    const { path, root, environment, basic } = await fixture();
    let launches = 0;
    const context = recordedCrashDebuggerFixture();
    const finalContext = { ...context, pwndbg_version: "after retirement" };
    const provider = new PwntoolsRecordedCrashProvider(
      environment,
      async (spawn) => {
        if (++launches === 1) return basic(spawn);
        return changingWorker(spawn, join(spawn.cwd ?? "", "reply.json"), {
          initial: JSON.stringify({ ok: true, value: context }),
          final: JSON.stringify({ ok: true, value: finalContext }),
          exitCode: 0,
        });
      },
      async () => root,
    );
    onTestFinished(() => provider.close());
    const result = await provider.inspectAndClose({
      path,
      include_debugger_context: true,
    });
    if (!result.ok) throw result.error;
    expect(result.value.debugger).toMatchObject({
      status: "available",
      pwndbg_version: "after retirement",
    });
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.runIf(supportedHost).each([
  { stage: "decoder", outcome: "success" },
  { stage: "decoder", outcome: "failure" },
  { stage: "debugger", outcome: "success" },
  { stage: "debugger", outcome: "failure" },
] as const)(
  "does not read unresolved $stage files after command $outcome",
  async ({ stage, outcome }) => {
    const { path, root, environment, basic } = await fixture();
    let launches = 0;
    let cleanupAllowed = false;
    const read = vi.spyOn(artifacts, "readStableArtifact");
    const provider = new PwntoolsRecordedCrashProvider(
      environment,
      async (spawn) => {
        if (stage === "debugger" && ++launches === 1) return basic(spawn);
        return changingWorker(
          spawn,
          join(spawn.cwd ?? "", "resource.failure"),
          {
            initial: "M",
            final: "!",
            exitCode: outcome === "success" ? 0 : PWNTOOLS_MEMORY_FAILURE_EXIT,
          },
          () => cleanupAllowed,
        );
      },
      async () => root,
    );
    onTestFinished(async () => {
      cleanupAllowed = true;
      await provider.close();
    });
    const result = await provider.inspectAndClose({
      path,
      include_debugger_context: true,
    });
    if (result.ok) throw new Error("Expected unresolved process ownership");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("cleanup_incomplete");
    expect(projected).toMatchObject({
      details: {
        resources: expect.arrayContaining([
          expect.stringMatching(/^pid:\d+$/u),
          expect.stringMatching(/^process-group:\d+$/u),
        ]),
      },
    });
    if (stage === "debugger")
      expect(projected).toMatchObject({
        details: {
          partial_observation: {
            artifact: { path },
            debugger: { status: "unavailable", requested: true },
          },
        },
      });
    if (outcome === "failure")
      expect(projected).toMatchObject({
        details: {
          diagnostics: {
            primary_error: { code: "execution_failure" },
          },
        },
      });
    const stagePath =
      stage === "debugger" ? join(root.path, "debugger") : root.path;
    const paths = read.mock.calls.map(([selected]) => selected);
    for (const file of ["reply.json", "resource.failure", "limits.json"])
      expect(paths).not.toContain(join(stagePath, file));
    const descendant = Number(
      await readFile(join(stagePath, "descendant.ready"), "utf8"),
    );
    expect(() => process.kill(descendant, 0)).not.toThrow();
    await expect(access(root.path)).resolves.toBeUndefined();
  },
);

it.runIf(supportedHost)(
  "retains a live debugger after output overflow with basic evidence and retryable cleanup",
  async () => {
    const { path, root, environment, basic } = await fixture();
    let launches = 0;
    let pid: number | undefined;
    let cleanupAllowed = false;
    const provider = new PwntoolsRecordedCrashProvider(
      environment,
      async (spawn) => {
        if (++launches === 1) return basic(spawn);
        const launched = await spawnOwnedProviderProcess({
          ...spawn,
          arguments: [
            "-e",
            'process.stdout.write("x".repeat(1048577)); setInterval(() => undefined, 1000)',
          ],
        });
        pid = launched.process.pid;
        return {
          ...launched,
          cleanup: () =>
            cleanupAllowed
              ? cleanupOwnedProcessGroup(launched.ownership)
              : Promise.resolve({
                  cleaned: false as const,
                  reason: "fixture inspection unavailable",
                }),
        };
      },
      async () => root,
    );
    onTestFinished(async () => {
      cleanupAllowed = true;
      await provider.close();
    });
    const result = await provider.inspectAndClose({
      path,
      include_debugger_context: true,
    });
    if (result.ok) throw new Error("Expected retained output-limit failure");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        captured_output: { truncated: true },
        diagnostics: { primary_error: { code: "unreadable_output" } },
        partial_observation: {
          artifact: { path },
          diagnostics: { stdout: "basic diagnostic" },
          debugger: { status: "unavailable", requested: true },
        },
      },
    });
    if (pid === undefined) throw new Error("Expected a live owned debugger");
    const debuggerPid = pid;
    expect(() => process.kill(debuggerPid, 0)).not.toThrow();
    cleanupAllowed = true;
    await provider.close();
    expect(() => process.kill(debuggerPid, 0)).toThrow();
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
