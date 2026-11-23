import { expect, it } from "vitest";

import { parseLipoCapture } from "./lipo.js";

it("retains native command capture when shared lipo parsing rejects records", () => {
  const capture = {
    tool: "lipo",
    executable: "/usr/bin/lipo",
    executableSha256: "1".repeat(64),
    toolVersion: null,
    versionReason: null,
    arguments: ["-detailed_info", "/fixture/fat"],
    stdout: "Fat header in: /fixture/fat\n",
    stderr: "lipo emitted no slice rows",
    stdoutBytes: 28,
    stderrBytes: 26,
    exitCode: 0,
    signal: null,
  };
  const parsed = parseLipoCapture(capture, "inspect_macho", "/fixture/fat");
  expect(parsed).toMatchObject({
    ok: false,
    error: {
      operation: "inspect_macho",
      cause: expect.objectContaining({
        _tag: "ParseFailureError",
        failure: {
          kind: "malformed",
          format: "lipo-output",
          detail: "lipo output contained no architectures",
        },
      }),
      capturedOutput: {
        stdout: capture.stdout,
        stderr: capture.stderr,
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
        exit_code: 0,
        signal: null,
      },
    },
  });
});
