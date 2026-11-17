import { expect, it } from "vitest";

import { AnalysisCleanupRelease } from "../../../src/domain/analysisCleanupRelease.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { serviceToolBindings } from "../../../src/server/serviceToolBindings.js";
import type { Radare2SessionManager } from "../../../src/radare2/Radare2SessionManager.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import type { Result } from "../../../src/domain/result.js";

interface BindingMutation {
  readonly run: (
    input: unknown,
    signal: AbortSignal,
  ) => Promise<
    Result<
      {
        readonly value: unknown;
        readonly retained?: Readonly<Record<string, string>>;
      },
      AnalysisError
    >
  >;
}
const retainedCloseFailure = (release: AnalysisCleanupRelease) => {
  const failure = new AnalysisCapabilityUnavailableError(
    "radare2",
    "close_radare2_session",
    "The owned Radare2 process could not be confirmed stopped: injected uncertainty",
    {
      cleanup: {
        reason: "injected uncertainty",
        resources: ["session-1"],
      },
    },
  );
  return release.bind(failure);
};

const failingEvidence = () =>
  createEvidence(
    unknownTarget("not-observed"),
    {
      id: "radare2.session",
      name: "Radare2 session",
      version: null,
    },
    {
      predicateType: "rea.reverse-engineering.command-observation",
      operation: "radare2_command",
      parameters: { session_id: "session-1", command: "__fail__" },
      result: {
        completion_status: "complete",
        output_truncated: false,
        command_error: true,
      },
      rawResult: { command: "__fail__", output: "" },
    },
  );

const startBinding = (manager: Record<string, unknown>): BindingMutation => {
  const bindings = serviceToolBindings(
    {
      radare2: {
        manager: manager as unknown as Radare2SessionManager,
        session: undefined,
      },
    },
    { recordEvidence: undefined, evidenceById: undefined },
  ) as unknown as Record<string, { mutation: BindingMutation }>;
  return bindings["start_radare2_session"]!.mutation;
};

it("releases the failed-start wrapper's cleanup once the failed close is released (command error path)", async () => {
  const release = new AnalysisCleanupRelease();
  const closeFailure = retainedCloseFailure(release);
  const binding = startBinding({
    start: async () => ok({ session_id: "session-1" }),
    execute: async () =>
      ok({
        result: {
          command: "__fail__",
          output: "",
          output_truncated: false,
          completion_status: "complete" as const,
          command_error: true,
          command_code: 1,
          command_logs: [],
        },
        evidence: failingEvidence(),
      }),
    status: () => undefined,
    close: async () => err(closeFailure),
    retryCleanupFailures: async () => ok(null),
  });

  const result = await binding.run(
    { path: "/tmp/f", initial_commands: ["__fail__"] },
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.cleanupIncomplete).toBe(true);
  // A verified retry confirms the manager-retained release; the wrapper must
  // read the owner's completion instead of staying incomplete forever.
  release.confirm();
  expect(result.error.cleanupIncomplete).toBe(false);
});

it("releases the failed-start wrapper's cleanup once the failed close is released (execution failure path)", async () => {
  const release = new AnalysisCleanupRelease();
  const closeFailure = retainedCloseFailure(release);
  const binding = startBinding({
    start: async () => ok({ session_id: "session-1" }),
    execute: async () =>
      err(
        new AnalysisCapabilityUnavailableError(
          "radare2",
          "radare2_command",
          "injected execution failure",
        ),
      ),
    status: () => undefined,
    close: async () => err(closeFailure),
    retryCleanupFailures: async () => ok(null),
  });

  const result = await binding.run(
    { path: "/tmp/f", initial_commands: ["__fail__"] },
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.cleanupIncomplete).toBe(true);
  release.confirm();
  expect(result.error.cleanupIncomplete).toBe(false);
});
