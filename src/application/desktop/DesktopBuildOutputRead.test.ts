import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import {
  GUEST_FILE_ANSWER_SOURCE,
  guestFileAnswerCeiling,
} from "../../desktop/AgentEnvComputer.js";
import { readOutput } from "./DesktopBuildCommands.js";

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
      ceiling_source: GUEST_FILE_ANSWER_SOURCE,
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
