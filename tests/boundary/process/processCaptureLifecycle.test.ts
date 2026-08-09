import { execFile } from "node:child_process";
import { rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  captureProcessScenario,
  probeProcessCaptureCapability,
  ProcessCaptureError,
} from "../../../src/application/ProcessHarness.js";
import {
  parseProcessScenario,
  type ProcessExecutionPolicy,
} from "../../../src/domain/processCapture.js";

const processFixture = fileURLToPath(
  new URL("../../fixtures/processFidelity.mjs", import.meta.url),
);
const execFileAsync = promisify(execFile);

it("does not follow or disclose symlink targets outside declared roots", async () => {
  const root = await createTestTempDirectory("rea-symlink-test-");
  await symlink("/etc/passwd", join(root, "escape"));
  try {
    const capability = await probeProcessCaptureCapability();
    if (!capability.available) return;
    const result = await captureProcessScenario(
      parseProcessScenario({
        approved: true,
        executable: "/usr/bin/true",
        working_directory: root,
        filesystem_roots: [root],
      }),
      {
        status: "enabled",
        executableRoots: ["/usr/bin"],
        workingRoots: [root],
        allowedEnvironment: [],
        networkAccess: "external",
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    const escaped = result.value.files_after.find((file) =>
      file.path.endsWith(":escape"),
    );
    expect(escaped?.symlink_target).toBe("<outside-declared-root>");
    expect(result.value.truncated).toBe(true);
    expect(JSON.stringify(result.value.files_after)).not.toContain(root);
    expect(JSON.stringify(result.value.files_after)).not.toContain(
      "/etc/passwd",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not launch when policy denies capture", async () => {
  const scenario = parseProcessScenario({
    approved: true,
    executable: "/bin/sh",
    working_directory: "/tmp",
  });
  const result = await captureProcessScenario(scenario, {
    status: "disabled",
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected policy refusal");
  expect(result.error).toBeInstanceOf(ProcessCaptureError);
});

it("distinguishes timeout from cancellation and cleans both runs", async () => {
  const capability = await probeProcessCaptureCapability();
  if (!capability.available) return;
  const policy: ProcessExecutionPolicy = {
    status: "enabled",
    executableRoots: [dirname(process.execPath)],
    workingRoots: [dirname(processFixture)],
    allowedEnvironment: [],
    networkAccess: "external",
  };
  const timedOut = await captureProcessScenario(
    parseProcessScenario({
      approved: true,
      executable: process.execPath,
      arguments: [processFixture, "hang"],
      working_directory: dirname(processFixture),
      timeout_ms: 50,
      idle_timeout_ms: 5_000,
    }),
    policy,
  );
  expect(timedOut.ok).toBe(true);
  if (!timedOut.ok) throw timedOut.error;
  expect(timedOut.value.exit.reason).toBe("timeout");
  expect(timedOut.value.cleanup).toEqual({
    owned_process_group: "verified",
    temporary_root: "removed",
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const cancelled = await captureProcessScenario(
    parseProcessScenario({
      approved: true,
      executable: process.execPath,
      arguments: [processFixture, "hang"],
      working_directory: dirname(processFixture),
      timeout_ms: 5_000,
      idle_timeout_ms: 5_000,
    }),
    policy,
    controller.signal,
  );
  expect(cancelled.ok).toBe(false);
  if (cancelled.ok) throw new Error("expected cancellation");
  expect(cancelled.error.message).toContain("cancelled");
});

it("captures source-owned interactive, resize, Unicode, and signal behavior", async () => {
  const capability = await probeProcessCaptureCapability();
  if (!capability.available) return;
  const result = await captureProcessScenario(
    parseProcessScenario({
      approved: true,
      executable: process.execPath,
      arguments: [processFixture, "interactive"],
      working_directory: dirname(processFixture),
      events: [
        { type: "input", at_ms: 100, data: "answer" },
        { type: "resize", at_ms: 300, columns: 100, rows: 40 },
        { type: "signal", at_ms: 700, signal: "SIGINT" },
      ],
      normalization: { time_bucket_ms: 60_000 },
      timeout_ms: 2_000,
      idle_timeout_ms: 2_000,
    }),
    {
      status: "enabled",
      executableRoots: [dirname(process.execPath)],
      workingRoots: [dirname(processFixture)],
      allowedEnvironment: [],
      networkAccess: "external",
    },
  );
  if (!result.ok) throw result.error;
  expect(result.ok).toBe(true);
  const output = result.value.frames.map(({ data }) => data).join("");
  expect(output).toContain("prompt>");
  expect(output).toContain("input:answer unicode:雪");
  expect(output).toContain("resize:100x40");
  expect(output).toContain("signal:SIGINT");
  expect(result.value.exit.code).toBe(0);
});

it("dispatches scheduled events before a silent PTY produces output", async () => {
  const capability = await probeProcessCaptureCapability();
  if (!capability.available) return;
  const result = await captureProcessScenario(
    parseProcessScenario({
      approved: true,
      executable: process.execPath,
      arguments: [processFixture, "silent-interactive"],
      working_directory: dirname(processFixture),
      events: [
        { type: "resize", at_ms: 25, columns: 100, rows: 40 },
        { type: "input", at_ms: 50, data: "answer" },
      ],
      timeout_ms: 2_000,
      idle_timeout_ms: 2_000,
    }),
    {
      status: "enabled",
      executableRoots: [
        join(dirname(process.execPath), "missing"),
        dirname(process.execPath),
      ],
      workingRoots: [
        join(dirname(processFixture), "missing"),
        dirname(processFixture),
      ],
      allowedEnvironment: [],
      networkAccess: "external",
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.frames.map(({ data }) => data).join("")).toContain(
    "input:answer",
  );
  expect(result.value.interaction_events).toMatchObject([
    { type: "resize", outcome: "dispatched" },
    { type: "input", outcome: "dispatched" },
  ]);
});

it("samples and cleans a source-owned child and grandchild process tree", async () => {
  const capability = await probeProcessCaptureCapability();
  if (!capability.available) return;
  const result = await captureProcessScenario(
    parseProcessScenario({
      approved: true,
      executable: process.execPath,
      arguments: [processFixture, "tree"],
      working_directory: dirname(processFixture),
      timeout_ms: 2_000,
      idle_timeout_ms: 2_000,
    }),
    {
      status: "enabled",
      executableRoots: [dirname(process.execPath)],
      workingRoots: [dirname(processFixture)],
      allowedEnvironment: [],
      networkAccess: "external",
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  const commands = result.value.process_samples.map(({ command }) => command);
  expect(commands.some((command) => command.includes("tree-child"))).toBe(true);
  expect(commands.some((command) => command.includes("forks.js"))).toBe(false);
  expect(commands.some((command) => command.includes("tree-grandchild"))).toBe(
    true,
  );
  expect(JSON.stringify(result.value.process_samples)).not.toContain(
    dirname(processFixture),
  );
  const { stdout } = await execFileAsync("ps", ["-axo", "command="]);
  expect(stdout).not.toContain(`${processFixture} tree-child`);
  expect(stdout).not.toContain(`${processFixture} tree-grandchild`);
}, 20_000);
