import { createHash } from "node:crypto";
import { DarwinProcessOwnershipInspectionError } from "../../../../src/process/DarwinProcessRunTokenReader.js";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
  NATIVE_FAILURE_DIAGNOSTIC_BYTES,
  NativeCommandFailure,
  XcrunCommandRunner,
  type NativeCommandRunner,
} from "../../../../src/native/CommandRunner.js";
import { err, ok } from "../../../../src/domain/result.js";
import { parseLipoOutput } from "../../../../src/native/parsers/lipo.js";
import { parseCodeSignature } from "../../../../src/native/parsers/codesign.js";
import { prepareProcessOwnershipInspection } from "../../../../src/process/ProcessOwnershipObservation.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ProviderProcessSupervisor } from "../../../../src/process/ProviderProcess.js";

import {
  NativeFixtureRunner as FixtureRunner,
  nativeFixture as fixture,
  nativeMachoTarget as machoTarget,
  nativeMachoTargetForFile,
} from "../../../fixtures/nativeCommands.js";

const cleanupOwner = (runId: string): ProviderProcessSupervisor => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  return new ProviderProcessSupervisor({
    process: child,
    ownsProcessLifetime: true,
    ownership: {
      runId,
      leaderPid: 46_000,
      processGroupId: 46_000,
      expectedParentPid: process.pid,
    },
    cleanup: async () => ({ cleaned: false, reason: "still running" }),
  });
};

beforeAll(() => prepareProcessOwnershipInspection());

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("native macOS provider discovery", () => {
  it.each([
    "ordinary.fixture",
    "  spaced.fixture  ",
    " leading",
    "trailing ",
    "literal\r\nidentifier\r",
  ])(
    "preserves the exact signing identifier %j reported by codesign",
    (identifier) => {
      const parsed = parseCodeSignature(
        `Identifier=${identifier}\nFormat=Mach-O thin (arm64)\nTeamIdentifier=not set\n`,
        false,
      );
      expect(parsed.identifier).toBe(identifier);
      expect(parsed.team_identifier).toBeNull();
      expect(parsed.format).toBe("Mach-O thin (arm64)");
    },
  );

  it.each(["\n", "\r\n"])(
    "separates echoed path and identifier text from signature fields (%j)",
    (newline) => {
      const path = "/apps/x\r\nAuthority=Forged\nIdentifier=forged";
      const identifier = "x\r\nFormat=forged\nAuthority=Forged-5555\r";
      const parsed = parseCodeSignature(
        [
          `Executable=${path}`,
          `Identifier=${identifier}`,
          "Format=Mach-O thin (arm64)",
          "CodeDirectory v=20400 size=342 flags=0x2(adhoc) hashes=2+2",
          "CDHash=6aee90e6",
          "Signature=adhoc",
          "TeamIdentifier=not set",
          "",
        ].join(newline),
        false,
        ["/elsewhere", path],
      );
      expect(parsed).toMatchObject({
        identifier,
        format: "Mach-O thin (arm64)",
        authorities: [],
        cdhashes: ["6aee90e6"],
        team_identifier: null,
      });
    },
  );

  it.each([
    { executable: "", paths: [], newline: "\r\n", identifier: "fixture" },
    {
      executable: "Executable=/apps/fixture\r\n",
      paths: [],
      newline: "\r\n",
      identifier: "fixture\nFormat=payload\r",
    },
    {
      executable: "Executable=/apps/fixture\n",
      paths: ["/elsewhere"],
      newline: "\n",
      identifier: "fixture\r\nFormat=payload\r",
    },
    {
      executable: "Executable=/apps/fixture\r\n",
      paths: ["/elsewhere"],
      newline: "\r\n",
      identifier: "fixture\r",
    },
  ])(
    "frames the identifier without a matching executable path: %j",
    ({ executable, paths, newline, identifier }) => {
      const parsed = parseCodeSignature(
        `${executable}Identifier=${identifier}${newline}Format=Mach-O thin (arm64)${newline}TeamIdentifier=not set${newline}`,
        false,
        paths,
      );
      expect(parsed.identifier).toBe(identifier);
      expect(parsed.format).toBe("Mach-O thin (arm64)");
      expect(parsed.team_identifier).toBeNull();
    },
  );

  it.each(["timeout", "output-limit"] as const)(
    "preserves %s resolution failures with their captured output and cleanup status",
    async (reason) => {
      const failure = new NativeCommandFailure(
        "file",
        reason,
        9,
        undefined,
        {
          stdout: "partial xcrun output",
          stderr: "partial xcrun diagnostic",
          stdoutBytes: 20,
          stderrBytes: 25,
          exitCode: 9,
          signal: null,
          truncated: reason === "output-limit",
        },
        "ownership cleanup was not confirmed",
        ["process-group:1234"],
      );
      const runner = new XcrunCommandRunner({}, () =>
        Promise.resolve(err(failure)),
      );

      const result = await runner.run("file", [], {});

      expect(result).toEqual(err(failure));
      if (result.ok) throw new Error("Resolution failure unexpectedly passed");
      expect(result.error).toMatchObject({
        reason,
        capture: {
          stdout: "partial xcrun output",
          truncated: reason === "output-limit",
        },
        cleanupFailure: "ownership cleanup was not confirmed",
        cleanupResources: ["process-group:1234"],
      });
    },
  );
});

describe("native command output collection", () => {
  it("retries discovery and resamples the executable after its tool path is replaced", async () => {
    directory = await createTestTempDirectory("rea-native-tool-identity-");
    const executable = join(directory, "fixture-tool");
    const source = (value: string): string =>
      `#!/bin/sh\nprintf '%s\\n' '${value}'\n`;
    const install = async (value: string): Promise<string> => {
      const contents = source(value);
      await writeFile(executable, contents, { mode: 0o700 });
      await chmod(executable, 0o700);
      return createHash("sha256").update(contents).digest("hex");
    };
    let unavailable = true;
    const runner = new XcrunCommandRunner({}, async (tool) => {
      if (unavailable) {
        unavailable = false;
        return err(new NativeCommandFailure(tool, "unavailable"));
      }
      const digest = createHash("sha256")
        .update(await readFile(executable))
        .digest("hex");
      return ok({ path: executable, sha256: digest });
    });

    const originalDigest = await install("original-tool-output");
    expect(await runner.run("file", [], {})).toMatchObject({
      ok: false,
      error: { reason: "unavailable" },
    });
    const original = await runner.run("file", [], {});
    if (!original.ok) throw original.error;
    expect(original.value.stdout).toBe("original-tool-output\n");
    expect(original.value.executableSha256).toBe(originalDigest);

    const replacementDigest = await install("replacement-tool-output");
    const replacement = await runner.run("file", [], {});
    if (!replacement.ok) throw replacement.error;
    expect(replacement.value.stdout).toBe("replacement-tool-output\n");
    expect(replacement.value.executableSha256).toBe(replacementDigest);
    expect(replacement.value.versionReason).toContain("prelaunch file sample");
    expect(replacement.value.versionReason).toContain(
      "does not prove atomic OS image binding",
    );
  });

  it("retains the complete native command output", async () => {
    const runner = new XcrunCommandRunner({}, () =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    const output = "x".repeat(4096);
    const captured = await runner.run(
      "file",
      ["-e", `process.stdout.write(${JSON.stringify(output)})`],
      {},
    );

    expect(captured.ok && captured.value.stdout).toBe(output);
  });

  it("retains both output streams and exit status when a command fails", async () => {
    const runner = new XcrunCommandRunner({}, () =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    const result = await runner.run(
      "file",
      [
        "-e",
        'process.stdout.write("partial stdout"); process.stderr.write("partial stderr"); process.exitCode = 7',
      ],
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      reason: "nonzero-exit",
      exitCode: 7,
      capture: {
        stdout: "partial stdout",
        stderr: "partial stderr",
        stdoutBytes: 14,
        stderrBytes: 14,
        exitCode: 7,
        signal: null,
        truncated: false,
      },
    });
  });

  it("retains accepted nonzero output as a complete command capture", async () => {
    const runner = new XcrunCommandRunner({}, () =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    const result = await runner.run(
      "file",
      [
        "-e",
        'process.stdout.write("unsigned observation"); process.exitCode = 1',
      ],
      { acceptNonZero: true },
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        stdout: "unsigned observation",
        stdoutBytes: 20,
        exitCode: 1,
        signal: null,
      },
    });
  });
});

describe("native command failure capture and limits", () => {
  it("projects captured diagnostics from a failed native provider command", async () => {
    const runner = new XcrunCommandRunner({}, () =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    const result = await new NativeMacOSProvider({}, runner, "darwin")
      .createClient(machoTarget("/private/fixture"))
      .execute("demangle_swift", { symbols: ["fixture-symbol"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("ProviderAdapterError");
    expect(result.error.capturedOutput?.stderr).toContain("Cannot find module");
    expect(result.error.capturedOutput?.stderr_bytes).toBeGreaterThan(0);
    expect(result.error.capturedOutput?.exit_code).not.toBe(0);
    expect(projectAnalysisError(result.error).details).toMatchObject({
      captured_output: {
        stderr: expect.stringContaining("Cannot find module"),
        stderr_bytes: expect.any(Number),
        exit_code: expect.any(Number),
      },
      diagnostics: {
        reason: "nonzero-exit",
        stderr_bytes: expect.any(Number),
      },
    });
    expect(projectAnalysisError(result.error).details).not.toHaveProperty(
      "diagnostics.detail",
    );
  });

  it("projects the ownership helper prerequisite when a command cannot be supervised", async () => {
    const inspection = new DarwinProcessOwnershipInspectionError(
      "Direct Darwin helper compilation requires absolute REA_DARWIN_SWIFTC_PATH and SDKROOT paths.",
    );
    const runner = new XcrunCommandRunner(
      {},
      () =>
        Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
      () => Promise.reject(inspection),
    );
    const result = await new NativeMacOSProvider({}, runner, "darwin")
      .createClient(machoTarget("/private/fixture"))
      .execute("demangle_swift", { symbols: ["fixture-symbol"] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: { reason: "io", detail: inspection.message },
    });
  });

  it("retains output written before cancellation and reaps the stalled command", async () => {
    const runner = new XcrunCommandRunner({}, () =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    const controller = new AbortController();
    const pending = runner.run(
      "file",
      [
        "-e",
        'process.stdout.write("started"); process.stderr.write("warning"); setInterval(() => {}, 1000)',
      ],
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);

    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      reason: "cancelled",
      capture: {
        stdout: "started",
        stderr: "warning",
        stdoutBytes: 7,
        stderrBytes: 7,
        truncated: false,
      },
    });
  });

  it("bounds both failure streams at a UTF-8 boundary while keeping their totals", async () => {
    const runner = new XcrunCommandRunner({}, () =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    // "é" is two bytes and straddles the excerpt boundary, so it is dropped whole.
    const stdout = `${"x".repeat(NATIVE_FAILURE_DIAGNOSTIC_BYTES - 1)}é${"y".repeat(1024)}`;
    const stderr = "z".repeat(NATIVE_FAILURE_DIAGNOSTIC_BYTES + 1024);
    // Build the output in the child: one Linux argument is limited to 128 KiB.
    const result = await runner.run(
      "file",
      [
        "-e",
        `const stdout = "x".repeat(${String(NATIVE_FAILURE_DIAGNOSTIC_BYTES - 1)}) + "\u00e9" + "y".repeat(1024); const stderr = "z".repeat(${String(NATIVE_FAILURE_DIAGNOSTIC_BYTES + 1024)}); process.stdout.write(stdout, () => process.stderr.write(stderr, () => process.exit(3)));`,
      ],
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("nonzero-exit");
    expect(result.error.capture).toMatchObject({
      stdout: "x".repeat(NATIVE_FAILURE_DIAGNOSTIC_BYTES - 1),
      stderr: "z".repeat(NATIVE_FAILURE_DIAGNOSTIC_BYTES),
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      exitCode: 3,
      truncated: true,
    });
  });

  it("rejects output beyond the complete native-command budget", async () => {
    const runner = new XcrunCommandRunner({}, () =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    const megabytesOverBudget =
      Math.ceil(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES / (1024 * 1024)) + 1;
    const result = await runner.run(
      "file",
      [
        "-e",
        `async function main() { const chunk = "x".repeat(1024 * 1024); for (let i = 0; i < ${String(megabytesOverBudget)}; i += 1) await new Promise((resolve) => process.stdout.write(chunk, resolve)); } void main()`,
      ],
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("output-limit");
    expect(result.error.capture?.truncated).toBe(true);
    expect(
      (result.error.capture?.stdoutBytes ?? 0) +
        (result.error.capture?.stderrBytes ?? 0),
    ).toBeLessThanOrEqual(NATIVE_COMMAND_OUTPUT_BUDGET_BYTES);
    // The failure carries an excerpt, not the whole retained output budget.
    expect(result.error.capture?.stdout.length).toBe(
      NATIVE_FAILURE_DIAGNOSTIC_BYTES,
    );
    expect(result.error.capture?.stdoutBytes).toBeGreaterThan(
      NATIVE_FAILURE_DIAGNOSTIC_BYTES,
    );
  });
});

describe("native command cleanup lifecycle", () => {
  it("waits for an active command before retrying its failed owner at close", async () => {
    let finishCommand!: (
      result: Awaited<ReturnType<NativeCommandRunner["run"]>>,
    ) => void;
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const command = new Promise<
      Awaited<ReturnType<NativeCommandRunner["run"]>>
    >((resolve) => {
      finishCommand = resolve;
    });
    let cleanupRetries = 0;
    const runner: NativeCommandRunner = {
      run: () => {
        commandStarted();
        return command;
      },
      retryCleanup: async () => {
        cleanupRetries += 1;
        return cleanupRetries === 1
          ? [
              {
                owner: cleanupOwner("run:first"),
                reason: "first process group remains live",
                resources: ["run:first", "process-group:1234"],
              },
              {
                owner: cleanupOwner("run:second"),
                reason: "second process group remains live",
                resources: ["run:second", "process-group:5678"],
              },
            ]
          : [];
      },
    };
    const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
      machoTarget("/private/fixture"),
    );

    const execution = client.execute("list_architectures", {});
    await started;
    const closing = client.close();
    await Promise.resolve();
    expect(cleanupRetries).toBe(0);
    finishCommand(
      err(
        new NativeCommandFailure("lipo", "timeout", null, undefined, {
          stdout: "partial architecture output",
          stderr: "partial diagnostic",
          stdoutBytes: 27,
          stderrBytes: 19,
          exitCode: null,
          signal: null,
          truncated: false,
        }),
      ),
    );

    const [observed, closed] = await Promise.all([execution, closing]);
    expect(observed.ok).toBe(false);
    expect(closed.ok).toBe(false);
    expect(cleanupRetries).toBe(1);
    if (!closed.ok) {
      expect(closed.error.cleanupResources).toEqual([
        "run:first",
        "process-group:1234",
        "run:second",
        "process-group:5678",
      ]);
      expect(closed.error).toHaveProperty("diagnostics", {
        reason: "Native command process cleanup remains incomplete",
        failures: [
          {
            reason: "first process group remains live",
            resources: ["run:first", "process-group:1234"],
          },
          {
            reason: "second process group remains live",
            resources: ["run:second", "process-group:5678"],
          },
        ],
      });
    }
    await expect(client.close()).resolves.toMatchObject({ ok: true });
    expect(cleanupRetries).toBe(2);
  });
});

describe("native command failure projection", () => {
  it("projects native cancellation output and incomplete cleanup to callers", async () => {
    const capture = {
      stdout: "partial output",
      stderr: "partial diagnostic",
      stdoutBytes: 14,
      stderrBytes: 19,
      exitCode: null,
      signal: "SIGKILL",
      truncated: false,
    };
    const runner: NativeCommandRunner = {
      async run(tool) {
        return err(
          new NativeCommandFailure(
            tool,
            "cancelled",
            null,
            undefined,
            capture,
            "process group cleanup was not confirmed",
            ["process-group:1234"],
          ),
        );
      },
    };
    const result = await new NativeMacOSProvider({}, runner, "darwin")
      .createClient(machoTarget("/private/fixture"))
      .execute("list_architectures", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.capturedOutput).toMatchObject({
      stdout: "partial output",
      stderr: "partial diagnostic",
      stdout_bytes: 14,
      stderr_bytes: 19,
      signal: "SIGKILL",
      truncated: false,
    });
    expect(result.error.cleanup).toEqual({
      reason: "process group cleanup was not confirmed",
      resources: ["process-group:1234"],
    });
    expect(projectAnalysisError(result.error).details).toMatchObject({
      captured_output: {
        stdout_bytes: 14,
        stderr_bytes: 19,
        signal: "SIGKILL",
      },
      cleanup: "incomplete",
      resources: ["process-group:1234"],
    });
  });

  it.each([
    ["timeout", "AnalysisTimeoutError", "provider_timeout"],
    ["output-limit", "AnalysisResourceConstraintError", "resource_constraint"],
  ] as const)(
    "projects native command %s as a typed resource failure",
    async (reason, tag, code) => {
      const runner: NativeCommandRunner = {
        async run(tool) {
          return err(new NativeCommandFailure(tool, reason));
        },
      };
      const result = await new NativeMacOSProvider({}, runner, "darwin")
        .createClient(machoTarget("/private/fixture"))
        .execute("list_architectures", {});

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error._tag).toBe(tag);
      expect(projectAnalysisError(result.error).code).toBe(code);
    },
  );
});

describe("native macOS provider inspection", () => {
  it("normalizes comprehensive Mach-O inspection with exact bounded provenance", async () => {
    const runner = new FixtureRunner();
    const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
      machoTarget("/private/fixture"),
    );
    const execution = await client.execute("inspect_macho", {});
    if (!execution.ok) throw execution.error;
    expect(execution.value.provider.id).toBe("native-macos");
    expect(execution.value.result).toMatchObject({
      format: "mach-o",
      word_size: 64,
      uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
      architectures: { total: 2, exhaustive: true },
      dependencies: {
        items: [{ path: "/usr/lib/libSystem.B.dylib", kind: "LC_LOAD_DYLIB" }],
      },
      segments: {
        items: [
          {
            name: "__TEXT",
            initial_permissions: { read: true, write: false, execute: true },
            sections: { items: [{ segment: "__TEXT", name: "__text" }] },
          },
        ],
      },
      imports: { exhaustive: false },
      exports: { exhaustive: false },
    });
    expect(JSON.stringify(execution.value.result)).not.toContain(
      "/private/fixture",
    );
    expect(execution.value.locations).toContainEqual({
      kind: "file-offset-range",
      start: 16384,
      end: 20480,
    });
  });

  it("preserves 64-bit addresses and alignment from captured otool output", async () => {
    const runner = new FixtureRunner({
      otool: await fixture("otool-high-address.txt"),
    });
    const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
      machoTarget("/private/fixture"),
    );

    const execution = await client.execute("inspect_macho", {});

    if (!execution.ok) throw execution.error;
    expect(execution.value.result).toMatchObject({
      segments: {
        items: [
          {
            vm_address: "0xfffffff007004001",
            vm_size: 4096,
            file_offset: 0,
            file_size: 185,
            sections: {
              items: [
                {
                  address: "0xfffffff0070040b9",
                  size: 1,
                  file_offset: 184,
                  alignment: 1,
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("keeps Mach-O inspection available when optional vtool is unavailable", async () => {
    const client = new NativeMacOSProvider(
      {},
      new VtoolFailingRunner("unavailable"),
      "darwin",
    ).createClient(machoTarget("/private/fixture"));

    const execution = await client.execute("inspect_macho", {});

    if (!execution.ok) throw execution.error;
    expect(execution.value.limitations).toEqual(
      expect.arrayContaining([expect.stringMatching(/vtool.*unavailable/iu)]),
    );
    expect(execution.value.result).toMatchObject({
      architectures: { total: 2 },
      provenance: expect.not.arrayContaining([
        expect.objectContaining({ tool: "vtool" }),
      ]),
    });
  });

  it("propagates optional vtool failures other than unavailability", async () => {
    const client = new NativeMacOSProvider(
      {},
      new VtoolFailingRunner("io"),
      "darwin",
    ).createClient(machoTarget("/private/fixture"));

    const execution = await client.execute("inspect_macho", {});

    expect(execution).toMatchObject({
      ok: false,
      error: { _tag: "ProviderAdapterError" },
    });
  });

  it("supports architectures, signatures, plists, and ordered demangling", async () => {
    directory = await createTestTempDirectory("rea-native-");
    const app = join(directory, "Fixture.app");
    const executable = join(app, "Contents/MacOS/Fixture");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(join(app, "Contents/Info.plist"), "fixture");
    const externalPlist = join(directory, "Outside.plist");
    await writeFile(externalPlist, "fixture");
    const client = new NativeMacOSProvider(
      {},
      new FixtureRunner(),
      "darwin",
    ).createClient(await nativeMachoTargetForFile(executable, app));

    const architectures = await client.execute("list_architectures", {});
    expect(architectures.ok && architectures.value.result).toMatchObject({
      architectures: { total: 2 },
    });
    const signature = await client.execute("inspect_signature", {});
    expect(signature.ok && signature.value.result).toMatchObject({
      signed: true,
      identifier: "com.example.fixture",
      hardened_runtime: true,
      entitlements: { "com.apple.security.app-sandbox": true },
    });
    const defaultPlist = await client.execute("inspect_plist", {});
    expect(defaultPlist.ok && defaultPlist.value.result).toMatchObject({
      source_path: join(app, "Contents/Info.plist"),
    });
    const plist = await client.execute("inspect_plist", {
      path: externalPlist,
    });
    expect(plist.ok && plist.value.result).toMatchObject({
      bundle: { identifier: "com.example.fixture", version: "42" },
      source_path: externalPlist,
    });
    const demangled = await client.execute("demangle_swift", {
      symbols: ["$s4Test3fooyyF", "plain_symbol"],
    });
    expect(demangled.ok && demangled.value.result).toMatchObject({
      symbols: [
        { input: "$s4Test3fooyyF", status: "demangled" },
        { input: "plain_symbol", status: "unchanged" },
      ],
    });
  });
});

describe("native macOS provider raw results", () => {
  it("records command provenance once, in the normalized result", async () => {
    directory = await createTestTempDirectory("rea-native-");
    const app = join(directory, "Fixture.app");
    const executable = join(app, "Contents/MacOS/Fixture");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(join(app, "Contents/Info.plist"), "fixture");
    const client = new NativeMacOSProvider(
      {},
      new FixtureRunner(),
      "darwin",
    ).createClient(await nativeMachoTargetForFile(executable, app));
    const requests: readonly (readonly [
      Parameters<typeof client.execute>[0],
      Parameters<typeof client.execute>[1],
    ])[] = [
      ["inspect_macho", {}],
      ["list_architectures", {}],
      ["inspect_signature", {}],
      ["inspect_plist", {}],
      ["demangle_swift", { symbols: ["$s4Test3fooyyF", "plain_symbol"] }],
    ];

    for (const [operation, parameters] of requests) {
      const execution = await client.execute(operation, parameters);
      if (!execution.ok) throw execution.error;
      expect(execution.value.rawResult, operation).toBeNull();
      expect(execution.value.result, operation).toMatchObject({
        provenance: expect.arrayContaining([
          expect.objectContaining({ tool: expect.any(String) }),
        ]),
      });
    }
  });
});

describe("native plist defaults for iOS-style bundles", () => {
  it("defaults to the Info.plist the bundle program was resolved from", async () => {
    directory = await createTestTempDirectory("rea-native-flat-");
    const app = join(directory, "Flat.app");
    const executable = join(app, "Flat");
    await mkdir(app, { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(join(app, "Info.plist"), "fixture");
    const client = new NativeMacOSProvider(
      {},
      new FixtureRunner(),
      "darwin",
    ).createClient({
      ...machoTarget(executable, app),
      bundleInfoPlist: join(app, "Info.plist"),
    });

    const plist = await client.execute("inspect_plist", {});
    expect(plist.ok && plist.value.result).toMatchObject({
      source_path: join(app, "Info.plist"),
    });
  });
});

/** Emit entitlements whose dictionary also holds a legal `__proto__` key. */
class PrototypeEntitlementsRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || !arguments_.includes("--entitlements")) return result;
    const stdout =
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/><key>__proto__</key><dict><key>com.apple.security.get-task-allow</key><true/></dict></dict></plist>';
    return ok({
      ...result.value,
      stdout,
      stdoutBytes: Buffer.byteLength(stdout),
    });
  }
}

describe("native signature entitlements", () => {
  it("reports entitlement entries keyed __proto__ that the result omits", async () => {
    directory = await createTestTempDirectory("rea-signature-entitlements-");
    const executable = join(directory, "fixture");
    await writeFile(executable, "fixture");
    const client = new NativeMacOSProvider(
      {},
      new PrototypeEntitlementsRunner(),
      "darwin",
    ).createClient(await nativeMachoTargetForFile(executable));

    const signature = await client.execute("inspect_signature", {});

    if (!signature.ok) throw signature.error;
    expect(signature.value.result).toMatchObject({
      entitlements: { "com.apple.security.app-sandbox": true },
    });
    expect(signature.value.limitations).toContain(
      "Entitlements: 1 dictionary entry keyed __proto__ was omitted because REA results cannot represent that key.",
    );
  });
});

/** Fail every codesign call nonzero after writing more than one excerpt. */
class VerboseCodeSignFailureRunner extends FixtureRunner {
  override async run(tool: string, arguments_: readonly string[]) {
    const result = await super.run(tool, arguments_);
    if (!result.ok || tool !== "codesign") return result;
    const stderr = "e".repeat(NATIVE_FAILURE_DIAGNOSTIC_BYTES * 2);
    return ok({
      ...result.value,
      stderr,
      stderrBytes: Buffer.byteLength(stderr),
      exitCode: 1,
    });
  }
}

describe("native signature failure diagnostics", () => {
  it("bounds accepted nonzero codesign output once it becomes a failure", async () => {
    directory = await createTestTempDirectory("rea-signature-failure-");
    const executable = join(directory, "fixture");
    await writeFile(executable, "fixture");
    const client = new NativeMacOSProvider(
      {},
      new VerboseCodeSignFailureRunner(),
      "darwin",
    ).createClient(await nativeMachoTargetForFile(executable));

    const signature = await client.execute("inspect_signature", {});

    if (signature.ok) throw new Error("A failed codesign run must fail");
    expect(signature.error.capturedOutput).toMatchObject({
      stderr: "e".repeat(NATIVE_FAILURE_DIAGNOSTIC_BYTES),
      stderr_bytes: NATIVE_FAILURE_DIAGNOSTIC_BYTES * 2,
      truncated: true,
    });
  });
});

describe("native dispatch metadata error results", () => {
  it("preserves tagged cancellation and integrity failures", async () => {
    directory = await createTestTempDirectory("rea-dispatch-errors-");
    const targetPath = join(directory, "fixture.macho");
    await writeFile(targetPath, "bound target bytes");
    const client = new NativeMacOSProvider(
      {},
      new FixtureRunner(),
      "darwin",
    ).createClient(machoTarget(targetPath));
    const controller = new AbortController();
    const cancelled = client.execute(
      "inspect_native_dispatch_metadata",
      {},
      { signal: controller.signal },
    );
    controller.abort();
    const cancellationResult = await cancelled;
    expect(!cancellationResult.ok && cancellationResult.error._tag).toBe(
      "AnalysisCancelledError",
    );

    const mismatchedClient = new NativeMacOSProvider(
      {},
      new FixtureRunner(),
      "darwin",
    ).createClient({ ...machoTarget(targetPath), sha256: "f".repeat(64) });
    const integrityResult = await mismatchedClient.execute(
      "inspect_native_dispatch_metadata",
      {},
    );
    expect(!integrityResult.ok && integrityResult.error._tag).toBe(
      "EvidenceIntegrityError",
    );
  });
});

describe("native macOS provider failures and parsing", () => {
  it("classifies unavailable, malformed, command failure, and cancellation", async () => {
    const unavailable = new NativeMacOSProvider(
      {},
      new FailingRunner("unavailable"),
      "darwin",
    ).createClient(machoTarget("/fixture"));
    const unavailableResult = await unavailable.execute(
      "list_architectures",
      {},
    );
    expect(!unavailableResult.ok && unavailableResult.error._tag).toBe(
      "AnalysisCapabilityUnavailableError",
    );
    if (unavailableResult.ok) throw new Error("Expected an unavailable tool");
    expect(projectAnalysisError(unavailableResult.error).message).toBe(
      "lipo is unavailable through xcrun.",
    );

    const malformed = new NativeMacOSProvider(
      {},
      new FixtureRunner({ lipo: "malformed" }),
      "darwin",
    ).createClient(machoTarget("/fixture"));
    const malformedResult = await malformed.execute("list_architectures", {});
    expect(!malformedResult.ok && malformedResult.error._tag).toBe(
      "AnalysisOutputError",
    );

    for (const [reason, tag] of [
      ["io", "ProviderAdapterError"],
      ["cancelled", "AnalysisCancelledError"],
    ] as const) {
      const client = new NativeMacOSProvider(
        {},
        new FailingRunner(reason),
        "darwin",
      ).createClient(machoTarget("/fixture"));
      const result = await client.execute("list_architectures", {});
      expect(!result.ok && result.error._tag).toBe(tag);
    }
  });

  it.each([
    {
      ...machoTarget("/fixture.dll"),
      format: "pe" as const,
      executableRole: "shared-library" as const,
      managed: false,
    },
    { ...machoTarget("/fixture.elf"), format: "elf" as const },
  ])(
    "refuses to list architectures of a $format target without running lipo",
    async (target) => {
      const runner = new CountingRunner();
      const result = await new NativeMacOSProvider({}, runner, "darwin")
        .createClient(target)
        .execute("list_architectures", {});
      if (result.ok) throw new Error("Expected a non-Mach-O refusal");
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "capability_unavailable",
        details: { reason: "Active artifact is not Mach-O." },
      });
      expect(runner.calls).toBe(0);
    },
  );

  it("classifies pre-aborted requests before operation or runner discovery", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new CountingRunner();
    const client = new NativeMacOSProvider({}, runner, "linux").createClient(
      machoTarget("/fixture"),
    );

    const result = await client.execute(
      "list_architectures",
      {},
      {
        signal: controller.signal,
      },
    );

    expect(!result.ok && result.error._tag).toBe("AnalysisCancelledError");
    expect(runner.calls).toBe(0);
  });

  it("parses thin and universal lipo fixtures", async () => {
    expect(parseLipoOutput(await fixture("lipo-thin.txt"))).toMatchObject({
      format: "thin",
      architectures: [{ name: "arm64" }],
    });
    expect(parseLipoOutput(await fixture("lipo-fat.txt"))).toMatchObject({
      format: "fat",
      architectures: [
        { name: "x86_64", file_offset: 16384, size: 4096 },
        { name: "arm64", file_offset: 32768, size: 8192 },
      ],
    });
  });

  it("rejects trailing text in lipo numeric fields instead of truncating", () => {
    const output = [
      "architecture arm64",
      "    cputype CPU_TYPE_ARM64",
      "    cpusubtype CPU_SUBTYPE_ARM64_ALL",
      "    offset 16384 trailing-junk",
      "    size 0x10",
      "    align 2^14 (16384)",
    ].join("\n");
    expect(parseLipoOutput(output).architectures).toMatchObject([
      { name: "arm64", file_offset: null, size: null, alignment: 16384 },
    ]);
  });

  it("requires the full alignment field to use a recognized spelling", () => {
    const output = [
      "architecture arm64",
      "    offset 0",
      "    size 16",
      "    align 2^14 (16384)",
    ].join("\n");
    expect(
      parseLipoOutput(output.replace("(16384)", "(8192)")).architectures[0]
        ?.alignment,
    ).toBeNull();
    expect(
      parseLipoOutput(output.replace("2^14 (16384)", "2^14")).architectures[0]
        ?.alignment,
    ).toBe(16384);
  });

  it("reads hardened runtime only from CodeDirectory flags", () => {
    expect(
      parseCodeSignature("Diagnostic: runtime policy unavailable", false)
        .hardened_runtime,
    ).toBeNull();
    expect(
      parseCodeSignature(
        "CodeDirectory v=20500 flags=0x10000(runtime) hashes=10+7",
        false,
      ).hardened_runtime,
    ).toBe(true);
    expect(
      parseCodeSignature(
        "CodeDirectory v=20500 flags=0x2(adhoc,hard) runtime=1",
        false,
      ).hardened_runtime,
    ).toBe(false);
  });
});

describe("native signature inspection target scope", () => {
  // This provider's inspect_signature path is scoped to Mach-O targets; on
  // another container a codesign verdict cannot see a format-level signature
  // such as a xar pkg signature.
  it.each([
    {
      path: "/fixture.pkg",
      sha256: "0".repeat(64),
      kind: "archive" as const,
      format: "pkg" as const,
    },
    {
      ...machoTarget("/fixture.elf"),
      format: "elf" as const,
    },
  ])(
    "refuses inspect_signature on a $format target without running codesign",
    async (target) => {
      const runner = new CountingRunner();
      const result = await new NativeMacOSProvider({}, runner, "darwin")
        .createClient(target)
        .execute("inspect_signature", {});
      if (result.ok) throw new Error("Expected a non-Mach-O refusal");
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "capability_unavailable",
      });
      expect(runner.calls).toBe(0);
    },
  );
});

class FailingRunner implements NativeCommandRunner {
  constructor(private readonly reason: NativeCommandFailure["reason"]) {}

  run(tool: string) {
    return Promise.resolve(err(new NativeCommandFailure(tool, this.reason)));
  }
}

class VtoolFailingRunner implements NativeCommandRunner {
  readonly #fixture = new FixtureRunner();

  constructor(private readonly reason: NativeCommandFailure["reason"]) {}

  run(tool: string, arguments_: readonly string[]) {
    return tool === "vtool"
      ? Promise.resolve(err(new NativeCommandFailure(tool, this.reason)))
      : this.#fixture.run(tool, arguments_);
  }
}

class CountingRunner implements NativeCommandRunner {
  calls = 0;

  run(tool: string) {
    this.calls += 1;
    return Promise.resolve(err(new NativeCommandFailure(tool, "unavailable")));
  }
}
