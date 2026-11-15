import { ProcessOutputTokenScanner } from "../process/ProcessOutputTokenScanner.js";
import {
  GHIDRA_DIAGNOSTIC_EXCERPT_BYTES,
  ghidraDiagnosticStream,
  ghidraFailureOutput,
  ghidraLauncherFailure,
  createGhidraDiagnostics,
} from "./GhidraDiagnostics.js";
import { describe, expect, it } from "vitest";

it("keeps request output and provenance without projecting launcher history", () => {
  const output = { text: "launcher output", bytes: 15, observedBytes: 15 };
  const options = {
    targetPath: "./caller-selected/../target",
    targetSha256: "a".repeat(64),
    transport: "unix-socket" as const,
    providerVersion: "12.1.4",
    profileDigest: "b".repeat(64),
    runtimeRoot: "/owned/runtime",
    snapshot: { stdout: output, stderr: output, exitCode: null, signal: null },
    previous: {},
    failure_output: { stdout: { text: "query output" }, complete: false },
  };
  const request = createGhidraDiagnostics({ ...options, scope: "request" });
  expect(request).toMatchObject({
    diagnostic_scope: "request",
    target_path: options.targetPath,
    target_sha256: options.targetSha256,
    profile_digest: options.profileDigest,
    runtime_root: options.runtimeRoot,
    failure_output: options.failure_output,
  });
  expect(request).not.toHaveProperty("stdout");
  expect(request).not.toHaveProperty("stderr");
  expect(createGhidraDiagnostics(options)).toMatchObject({
    stdout: { text: output.text },
    stderr: { text: output.text },
    failure_output: options.failure_output,
  });
});

it("keeps cached session output owned while projecting historical request coordinates", () => {
  const previous = {
    target_path: "/selected/target",
    ghidra_log_path: "/owned/project/ghidra.log",
    stdout: { text: "old launcher output" },
    stderr: { text: "old launcher stderr" },
    launch_support: [{ stdout: "JDK version" }],
    failure_output: { stdout: { text: "old request" }, complete: true },
  };
  const request = createGhidraDiagnostics({
    scope: "request",
    targetPath: "/selected/target",
    targetSha256: "a".repeat(64),
    transport: "unix-socket",
    providerVersion: "12.1.4",
    profileDigest: "b".repeat(64),
    previous,
  });
  expect(request).toEqual({
    diagnostic_scope: "request",
    target_path: previous.target_path,
    ghidra_log_path: previous.ghidra_log_path,
  });
  expect(previous.stdout.text).toBe("old launcher output");
  expect(previous.failure_output.stdout.text).toBe("old request");
});

it("does not reuse historical operation-scoped failure output without a current owner", () => {
  const diagnostics = createGhidraDiagnostics({
    targetPath: "/tmp/target",
    targetSha256: "a".repeat(64),
    transport: "unix-socket",
    providerVersion: "11.4",
    profileDigest: "b".repeat(64),
    previous: {
      stdout: { text: "historical OOME" },
      failure_output: {
        stdout: { text: "historical OOME" },
        stderr: { text: "" },
        complete: true,
      },
    },
  });

  expect(diagnostics.stdout).toEqual({ text: "historical OOME" });
  expect(diagnostics).not.toHaveProperty("failure_output");
  expect(diagnostics).not.toHaveProperty("stop_requested");
});

it.each([false, true])(
  "redacts credential tails only when the captured line's right edge is incomplete (open=%s)",
  (open) => {
    const scanner = new ProcessOutputTokenScanner("java.lang.OutOfMemoryError");
    const prefix = Buffer.from("prior operation prefix ");
    scanner.scan(prefix, 0);
    const suffix = Buffer.from(
      open
        ? "java.lang.OutOfMemoryError: e-trans"
        : "java.lang.OutOfMemoryError: Java heap space\n",
    );
    scanner.scan(suffix, prefix.length);
    const marker = scanner.latestWithin(
      prefix.length,
      prefix.length + suffix.length,
    );
    if (marker === undefined) throw new Error("Expected confirmed class token");
    const stream = { text: "", bytes: 0, observedBytes: suffix.length };
    const output = ghidraFailureOutput(
      {
        snapshot: {
          stdout: stream,
          stderr: stream,
          exitCode: null,
          signal: null,
        },
        complete: false,
        markers: [{ stream: "stderr", ...marker }],
      },
      "e-transport-secret",
      false,
    );
    expect(output).toMatchObject({
      observed_oome: [
        {
          line: open
            ? "java.lang.OutOfMemoryError: [REDACTED]"
            : "java.lang.OutOfMemoryError: Java heap space",
          line_complete: !open,
          truncated: true,
        },
      ],
    });
  },
);

it("retains bounded, redacted launcher failure lines before clipping output", () => {
  const line =
    "java.io.FileNotFoundException: /tmp/secret-token/java_home.save (Access is denied)";
  const text = `${line}\n${"later output\n".repeat(7000)}`;
  const stream = {
    text,
    bytes: Buffer.byteLength(text),
    observedBytes: Buffer.byteLength(text),
  };
  const empty = { text: "", bytes: 0, observedBytes: 0 };
  const output = ghidraFailureOutput(
    {
      snapshot: { stdout: empty, stderr: stream, exitCode: 1, signal: null },
      complete: true,
    },
    "secret-token",
    false,
  );
  expect(output).toMatchObject({
    launcher_failures: {
      failures: [
        {
          kind: "java_home_save_denied",
          stream: "stderr",
          line: "java.io.FileNotFoundException: /tmp/[REDACTED]/java_home.save (Access is denied)",
          path: "/tmp/[REDACTED]/java_home.save",
        },
      ],
      truncated: false,
    },
  });
  expect(JSON.stringify(output)).not.toContain("secret-token");
});

it.each([
  [undefined, false],
  [true, true],
] as const)(
  "carries the supervisor's stop request into exit diagnostics (%s)",
  (stopRequested, expected) => {
    const stream = { text: "", bytes: 0, observedBytes: 0 };
    const diagnostics = createGhidraDiagnostics({
      targetPath: "/tmp/target",
      targetSha256: "a".repeat(64),
      transport: "unix-socket",
      providerVersion: "12.1.4",
      profileDigest: "b".repeat(64),
      previous: {},
      snapshot: {
        stdout: stream,
        stderr: stream,
        exitCode: null,
        signal: "SIGKILL",
        ...(stopRequested === undefined ? {} : { stopRequested }),
      },
    });
    expect(diagnostics.exit_signal).toBe("SIGKILL");
    expect(diagnostics.stop_requested).toBe(expected);
  },
);

it("carries only the latest launcher output in an error, with its byte counts", () => {
  const retained = `${"early line\n".repeat(400_000)}last line: startup timed out\n`;
  const bytes = Buffer.byteLength(retained);
  const projected = ghidraDiagnosticStream(
    { text: retained, bytes, observedBytes: bytes + 1_000 },
    undefined,
  ) as {
    text: string;
    bytes: number;
    retained_bytes: number;
    text_bytes: number;
  };
  expect(projected.text.endsWith("last line: startup timed out\n")).toBe(true);
  expect(Buffer.byteLength(projected.text)).toBe(projected.text_bytes);
  expect(projected.text_bytes).toBeLessThanOrEqual(
    GHIDRA_DIAGNOSTIC_EXCERPT_BYTES,
  );
  expect(projected).toMatchObject({
    bytes: bytes + 1_000,
    retained_bytes: bytes,
  });
});

it("keeps short launcher output whole", () => {
  expect(
    ghidraDiagnosticStream(
      { text: "ok\n", bytes: 3, observedBytes: 3 },
      undefined,
    ),
  ).toEqual({ text: "ok\n", bytes: 3, retained_bytes: 3 });
});

describe("Ghidra launcher failure lines", () => {
  it("extracts the denied java_home.save path from JVM output", () => {
    const line =
      "java.io.FileNotFoundException: C:\\Users\\a b\\Temp\\rea-provider-1\\config\\ghidra\\ghidra_12.1.4_PUBLIC\\java_home.save (Access is denied)";
    expect(ghidraLauncherFailure("stderr", line)).toEqual({
      kind: "java_home_save_denied",
      stream: "stderr",
      line,
      path: "C:\\Users\\a b\\Temp\\rea-provider-1\\config\\ghidra\\ghidra_12.1.4_PUBLIC\\java_home.save",
    });
  });

  it.each([
    [
      "another denied path",
      "java.io.FileNotFoundException: C:\\x\\other.txt (Access is denied)",
    ],
    [
      "a different failure for the file",
      "java.io.FileNotFoundException: C:\\x\\java_home.save (The system cannot find the path specified)",
    ],
    ["only a mention", "Reading java_home.save failed"],
    ["no output", ""],
  ])("does not classify %s", (_label, line) => {
    expect(ghidraLauncherFailure("stderr", line)).toBeUndefined();
  });

  it("keeps a differently cased denial that falls outside the delivered excerpt", () => {
    const line =
      "java.io.FileNotFoundException: C:\\x\\java_home.save (ACCESS IS DENIED)";
    const text = `${line}\n${"later output\n".repeat(7000)}`;
    const stream = {
      text,
      bytes: Buffer.byteLength(text),
      observedBytes: Buffer.byteLength(text),
    };
    const empty = { text: "", bytes: 0, observedBytes: 0 };
    const output = ghidraFailureOutput(
      {
        snapshot: { stdout: empty, stderr: stream, exitCode: 1, signal: null },
        complete: true,
      },
      undefined,
      false,
    ) as {
      stderr: { text: string };
      launcher_failures: { failures: unknown[] };
    };
    expect(output.stderr.text).not.toContain("java_home.save");
    expect(output.launcher_failures.failures).toEqual([
      expect.objectContaining({
        kind: "java_home_save_denied",
        path: "C:\\x\\java_home.save",
      }),
    ]);
  });

  it("records the requested program list after Ghidra's refusal marker", () => {
    expect(
      ghidraLauncherFailure(
        "stdout",
        "ERROR Requested project program file(s) not found: target.bin (HeadlessAnalyzer)",
      ),
    ).toMatchObject({
      kind: "missing_program",
      requested: "target.bin (HeadlessAnalyzer)",
    });
  });
});
