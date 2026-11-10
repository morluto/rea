import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";
import { z } from "zod";

import { AnalysisCleanupLease } from "../../../src/artifacts/AnalysisCleanupLease.js";
import { captureDesktopApplication } from "../../../src/application/desktop/DesktopApplicationCapture.js";
import {
  projectFailure,
  publishedCaptureCleanup,
} from "../../../src/application/desktop/DesktopCaptureFailure.js";
import {
  capture,
  checkpoint,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  BUILD_REQUEST as REQUEST,
  buildCaptureFakes as fakes,
} from "../../fixtures/buildCaptureFakes.js";
import {
  callOk,
  expectNoToken,
  startBuildComputer,
} from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const reportedSchema = z.looseObject({
  message: z.string(),
  remediation: z.object({ action: z.string() }),
});

/** What `rea capture-desktop-application --json` prints for a capture that failed this way. */
const printedFailure = (error: AnalysisError) => ({
  error: "Desktop capture failed",
  ...projectAnalysisError(error),
});

/** A file holding a failure the capture prints, and the failure. */
const failureFile = async (failure: unknown) => {
  const path = join(await createTestTempDirectory("build-failure-"), "out");
  await writeFile(path, JSON.stringify(failure, null, 2));
  return { path, failure: reportedSchema.parse(failure) };
};

const call = (
  client: Awaited<ReturnType<typeof fakes>>["client"],
  name: string,
  args: Record<string, unknown>,
) => client.callTool({ name, arguments: args }).then(parseMcpToolError);

it("leads with the app's exit code and the end of its stderr when the app exits before its window opens", async () => {
  const exited = join(await createTestTempDirectory("build-exited-"), "c");
  const { computer, client } = await fakes({
    env: { FAKE_REA_APP_EXITS: exited },
  });
  const recorded = capture();
  const cause = "[error] notes: Unable to find an appropriate java runtime.";
  // More stderr than a message keeps, and the computer's control token near its end.
  const stderr = `${"[warning] notes: probing a runtime\n".repeat(200)}[warning] notes: AGENTENV_CONTROL_TOKEN=${computer.token} is not for apps\n${cause}\n`;
  await cp(
    await writeCaptureFolder({
      ...recorded,
      session: {
        ...recorded.session,
        end_reason: "application_exited",
        duration_ms: 1080,
        exit: { code: 1, signal: null },
        first_window_ms: null,
        window_match: null,
        windows: [],
        stderr,
      },
      state: {
        ...recorded.state,
        checkpoints: [
          checkpoint("baseline", "baseline", [], []),
          checkpoint("exit", "exit", [], []),
        ],
      },
      limitations: ["No application window was seen."],
    }),
    exited,
    { recursive: true },
  );
  const id = await startBuildComputer(client, REQUEST);
  const { error } = await call(client, "start_build_capture", {
    computer_id: id,
  });
  expect(error.message.split(" ")[0]).toBe(recorded.application.argv[0]);
  expect(error.message).toMatch(/\bcode 1\b/u);
  expect(error.message).toContain("1080 ms");
  expect(error.message).toContain(cause);
  expect(error.message.length).toBeLessThan(1500);
  expect(error.remediation.action).not.toContain(cause);
  // The capture's own record stays structured beside the message.
  expect(error.details?.diagnostics).toMatchObject({
    application: { argv: recorded.application.argv },
    session: {
      end_reason: "application_exited",
      exit: { code: 1, signal: null },
      first_window_ms: null,
      stderr: expect.stringContaining(cause),
    },
  });
  expectNoToken(computer, error);
  // The capture ended with the app, so none is left running.
  expect(
    (await call(client, "stop_build_capture", { computer_id: id })).error.code,
  ).toBe("invalid_request");
});

it("reports a capture that fails before the app's window opens with its own message and remediation", async () => {
  // What the capture prints when it refuses its host, as the CLI does.
  const refused = await captureDesktopApplication(
    {
      desktopEntry: "org.example.notes",
      executable: undefined,
      arguments: [],
      output: join(await createTestTempDirectory("build-refused-"), "capture"),
      statePaths: [],
      excludes: [],
      maxDurationSeconds: 60,
      maxEntries: 10_000,
      maxFileBytes: 1024 * 1024,
      maxContentBytes: 8 * 1024 * 1024,
      packageFile: undefined,
    },
    {
      platform: "darwin",
      environment: {},
      callerDirectory: "/",
      nextRequest: () => undefined,
      report: async () => {},
    },
  );
  const { path, failure } = await failureFile(refused);
  const { client } = await fakes({ env: { FAKE_REA_CAPTURE_FAILURE: path } });
  const id = await startBuildComputer(client, REQUEST);
  const { error } = await call(client, "start_build_capture", {
    computer_id: id,
  });
  expect(error.message).toContain(failure.message);
  expect(error.remediation.action).toBe(failure.remediation.action);
});

it("reports a checkpoint the capture failed to write with the failure it printed, at the mark and at the stop", async () => {
  const full = Object.assign(
    new Error("ENOSPC: no space left on device, write"),
    { code: "ENOSPC" },
  );
  const printed = printedFailure(projectFailure(full, undefined));
  const { path, failure } = await failureFile(printed);
  const { client } = await fakes({ env: { FAKE_REA_MARK_FAILURE: path } });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });

  const marked = await call(client, "mark_build_checkpoint", {
    computer_id: id,
    name: "seed",
  });
  expect(marked.error.message).toContain(failure.message);
  expect(marked.error.message).toContain("seed");
  expect(marked.error.details?.diagnostics).toEqual({
    command_failure: printed,
  });
  // The stop reads the same output the same way.
  const stopped = await call(client, "stop_build_capture", { computer_id: id });
  expect(stopped.error.message).toContain(failure.message);
  expect(stopped.error.details?.diagnostics).toEqual({
    command_failure: printed,
  });
});

it("keeps a capture's incomplete cleanup and its targets when it reports one", async () => {
  const runToken = "0b5ac1d2-5e4f-4c3a-9b8d-7e6f5a4b3c2d";
  const published = "/home/user/.rea-build/captures/1/capture/capture.json";
  const cleanup = await publishedCaptureCleanup(
    published,
    {
      close: async () => {},
      discard: async () => {},
      directory: "/home/user/.rea-build/captures/1/capture/content",
    },
    {
      reason: "a process still carries the capture's run token",
      leases: [
        new AnalysisCleanupLease(async () => {}, [
          runToken,
          "pid:42",
          "process-group:42",
        ]),
      ],
    },
  );
  if (cleanup === undefined) throw new Error("The cleanup was complete.");
  const printed = printedFailure(cleanup);
  const { path, failure } = await failureFile(printed);
  const { client } = await fakes({ env: { FAKE_REA_CAPTURE_FAILURE: path } });
  const id = await startBuildComputer(client, REQUEST);
  const { error } = await call(client, "start_build_capture", {
    computer_id: id,
  });
  expect(error.remediation.action).toBe(failure.remediation.action);
  // The remediation's "listed" run token is listed.
  expect(error.details?.resources).toEqual(
    expect.arrayContaining([runToken, "pid:42"]),
  );
  expect(error.details?.diagnostics).toEqual({ command_failure: printed });
});
