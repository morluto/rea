import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { redactSecrets } from "../../domain/desktop/buildSecrets.js";
import { createEvidence } from "../../domain/evidence.js";
import { guestFileAnswerCeiling } from "../../desktop/AgentEnvComputer.js";
import { readOutput } from "./DesktopBuildCommands.js";
import { endedCapture } from "./DesktopBuildCaptureFailure.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
} from "./DesktopCaptureRefusals.js";
import { seedEndCapture } from "./desktopCapture.fixture.js";

describe("readOutput", () => {
  it("does not fetch a command output whose reported size exceeds the host answer ceiling", async () => {
    let fetched = false;
    const failure = await readOutput(
      {
        homeFiles: () => {
          fetched = true;
          return Promise.resolve(new Map());
        },
        redacted: (text) => text,
        exec: () => Promise.reject(new Error("unused")),
      },
      "out.json",
      Number.MAX_SAFE_INTEGER,
      new AbortController().signal,
    ).catch((cause: unknown) => cause);
    expect(fetched).toBe(false);
    expect(failure).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(failure instanceof AnalysisResourceConstraintError)) return;
    expect(failure.reportedLimits).toMatchObject({
      guest_file_bytes: Number.MAX_SAFE_INTEGER,
      file_count: 1,
      answer_ceiling_bytes: guestFileAnswerCeiling(),
      ceiling_source: "v8.heap_size_limit/4",
    });
  });

  it("reads a reported failure that fits the ceiling", async () => {
    const body = Buffer.from(
      JSON.stringify({ code: "busy", message: "the app is busy" }),
    );
    let reported = 0;
    const output = await readOutput(
      {
        homeFiles: (_paths, bytes) => {
          reported = bytes;
          return Promise.resolve(new Map([["out.json", body]]));
        },
        redacted: (text) => text,
        exec: () => Promise.reject(new Error("unused")),
      },
      "out.json",
      body.length,
      new AbortController().signal,
    );
    expect(reported).toBe(body.length);
    expect(output.kind).toBe("failure");
    if (output.kind !== "failure") return;
    expect(output.failure).toMatchObject({
      code: "busy",
      message: "the app is busy",
    });
  });
});

describe("endedCapture", () => {
  it("keeps a capacity error from the capture output, including its recovery", async () => {
    let fetched = false;
    const failure = await endedCapture(
      {
        homeFiles: () => {
          fetched = true;
          return Promise.resolve(new Map());
        },
        redacted: (text) => text,
        exec: () => Promise.reject(new Error("unused")),
      },
      {
        operation: "desktop_build_capture_start",
        when: "before checkpoint seed",
        afterAppExit: "Start the capture again.",
        folder: "capture",
      },
      { exited: 0, output_bytes: Number.MAX_SAFE_INTEGER },
      new AbortController().signal,
    );
    expect(fetched).toBe(false);
    expect(failure).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(failure instanceof AnalysisResourceConstraintError)) return;
    expect(failure.operation).toBe("data/get");
    expect(failure.retryable).toBe(false);
    expect(failure.remediationAction).toContain("--max-old-space-size");
    expect(failure.reportedLimits).toMatchObject({
      guest_file_bytes: Number.MAX_SAFE_INTEGER,
      file_count: 1,
      answer_ceiling_bytes: guestFileAnswerCeiling(),
      ceiling_source: "v8.heap_size_limit/4",
    });
  });

  it("hides a typed secret before it quotes the end of the app's stderr or the capture's progress", async () => {
    // A made-up secret, which the quotes' front cuts would leave the end of.
    const secret = "e-Plum7-Kite-Throwaway-42";
    const redact = (text: string) =>
      redactSecrets(text, [{ handle: "master", value: secret }]);
    const base = seedEndCapture();
    const recorded = {
      ...base,
      session: {
        ...base.session,
        end_reason: "application_exited" as const,
        exit: { code: 1, signal: null },
        stderr: `${secret}${"y".repeat(790)}`,
      },
    };
    const body = Buffer.from(
      JSON.stringify(
        createEvidence(undefined, DESKTOP_PROVIDER, {
          predicateType: "rea.desktop-application-capture",
          operation: DESKTOP_OPERATION,
          parameters: {},
          result: recorded,
          confidence: "observed",
          authority: "controlled-replay",
        }),
      ),
    );
    const computer = {
      homeFiles: () =>
        Promise.resolve(new Map([["capture/capture.out", body]])),
      redacted: (text: string) => text,
      exec: () => Promise.reject(new Error("unused")),
    };
    const step = {
      operation: "desktop_build_capture_start",
      when: "before checkpoint seed",
      afterAppExit: "Start the capture again.",
      folder: "capture",
    };
    const exited = await endedCapture(
      computer,
      { ...step, redact },
      { exited: 0, output_bytes: body.length },
      new AbortController().signal,
    );
    const progressed = await endedCapture(
      computer,
      { ...step, redact },
      { exited: 1, progress: `${secret}${"z".repeat(290)}` },
      new AbortController().signal,
    );
    for (const failure of [exited, progressed]) {
      expect(failure.userMessage).toContain("…");
      expect(failure.userMessage).not.toContain(secret.slice(-10));
    }
  });
});
