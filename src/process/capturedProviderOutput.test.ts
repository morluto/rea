import { expect, it } from "vitest";

import {
  capturedProviderOutput,
  providerResultDiagnostics,
} from "./capturedProviderOutput.js";
import type { ProviderProcessSnapshot } from "./ProviderProcess.js";

const snapshot = (
  overrides: Partial<ProviderProcessSnapshot> = {},
): ProviderProcessSnapshot => ({
  stdout: { text: "head", bytes: 4, observedBytes: 4096 },
  stderr: { text: "", bytes: 0, observedBytes: 0 },
  exitCode: undefined,
  signal: undefined,
  ...overrides,
});

it("keeps the retained text beside the bytes the process wrote", () => {
  expect(
    capturedProviderOutput(snapshot({ diagnosticTruncated: true })),
  ).toEqual({
    stdout: "head",
    stderr: "",
    stdout_bytes: 4096,
    stderr_bytes: 0,
    exit_code: null,
    signal: null,
    truncated: true,
  });
});

it("narrows to the three fields a successful result declares", () => {
  expect(
    providerResultDiagnostics(
      capturedProviderOutput(snapshot({ exitCode: 0, signal: null })),
    ),
  ).toStrictEqual({ stdout: "head", stderr: "", truncated: false });
});

it("reports exit facts and an untruncated capture as observed", () => {
  expect(
    capturedProviderOutput(snapshot({ exitCode: 2, signal: null })),
  ).toMatchObject({ exit_code: 2, signal: null, truncated: false });
});
