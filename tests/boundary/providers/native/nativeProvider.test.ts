import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NATIVE_COMMAND_OUTPUT_BUDGET_BYTES,
  NativeCommandFailure,
  XcrunCommandRunner,
  type NativeCommandRunner,
} from "../../../../src/native/CommandRunner.js";
import { err, ok } from "../../../../src/domain/result.js";
import { parseLipoArchitectures } from "../../../../src/native/parsers/lipo.js";
import { parseCodeSignature } from "../../../../src/native/parsers/codesign.js";
import { prepareProcessOwnershipInspection } from "../../../../src/process/ProcessOwnershipObservation.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";

import {
  NativeFixtureRunner as FixtureRunner,
  nativeFixture as fixture,
  nativeMachoTarget as machoTarget,
  nativeMachoTargetForFile,
} from "../../../fixtures/nativeCommands.js";

beforeAll(() => prepareProcessOwnershipInspection());

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("native macOS provider discovery", () => {
  it.each(["ordinary.fixture", "  spaced.fixture  ", " leading", "trailing "])(
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

  it("separates echoed path and identifier text from signature fields", () => {
    const path = "/apps/x\nAuthority=Forged\nIdentifier=forged";
    const identifier = "x\nFormat=forged\nAuthority=Forged-5555";
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
      ].join("\r\n"),
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
  });

  it("retries a failed native tool resolution and caches only success", async () => {
    let resolutions = 0;
    const runner = new XcrunCommandRunner((tool) => {
      resolutions += 1;
      return Promise.resolve(
        resolutions === 1
          ? err(new NativeCommandFailure(tool, "unavailable"))
          : ok({ path: "/usr/bin/true", sha256: "a".repeat(64) }),
      );
    });
    const options = {};

    expect((await runner.run("file", [], options)).ok).toBe(false);
    expect((await runner.run("file", [], options)).ok).toBe(true);
    expect((await runner.run("file", [], options)).ok).toBe(true);
    expect(resolutions).toBe(2);
  });

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
      const runner = new XcrunCommandRunner(() =>
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
  it("retains the complete native command output", async () => {
    const runner = new XcrunCommandRunner(() =>
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
    const runner = new XcrunCommandRunner(() =>
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
    const runner = new XcrunCommandRunner(() =>
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
    const runner = new XcrunCommandRunner(() =>
      Promise.resolve(ok({ path: process.execPath, sha256: "a".repeat(64) })),
    );
    const result = await new NativeMacOSProvider(runner, "darwin")
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
  });

  it("retains output written before cancellation and reaps the stalled command", async () => {
    const runner = new XcrunCommandRunner(() =>
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

  it("rejects output beyond the complete native-command budget", async () => {
    const runner = new XcrunCommandRunner(() =>
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
    const result = await new NativeMacOSProvider(runner, "darwin")
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
      const result = await new NativeMacOSProvider(runner, "darwin")
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
    const client = new NativeMacOSProvider(runner, "darwin").createClient(
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
    const client = new NativeMacOSProvider(runner, "darwin").createClient(
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

describe("native plist defaults for iOS-style bundles", () => {
  it("defaults to the Info.plist the bundle program was resolved from", async () => {
    directory = await createTestTempDirectory("rea-native-flat-");
    const app = join(directory, "Flat.app");
    const executable = join(app, "Flat");
    await mkdir(app, { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(join(app, "Info.plist"), "fixture");
    const client = new NativeMacOSProvider(
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

describe("native dispatch metadata error results", () => {
  it("preserves tagged cancellation and integrity failures", async () => {
    directory = await createTestTempDirectory("rea-dispatch-errors-");
    const targetPath = join(directory, "fixture.macho");
    await writeFile(targetPath, "bound target bytes");
    const client = new NativeMacOSProvider(
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

    const malformed = new NativeMacOSProvider(
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
        new FailingRunner(reason),
        "darwin",
      ).createClient(machoTarget("/fixture"));
      const result = await client.execute("list_architectures", {});
      expect(!result.ok && result.error._tag).toBe(tag);
    }
  });

  it("classifies pre-aborted requests before operation or runner discovery", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new CountingRunner();
    const client = new NativeMacOSProvider(runner, "linux").createClient(
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
    expect(
      parseLipoArchitectures(await fixture("lipo-thin.txt")),
    ).toMatchObject([{ name: "arm64" }]);
    expect(parseLipoArchitectures(await fixture("lipo-fat.txt"))).toMatchObject(
      [
        { name: "x86_64", file_offset: 16384, size: 4096 },
        { name: "arm64", file_offset: 32768, size: 8192 },
      ],
    );
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
    expect(parseLipoArchitectures(output)).toMatchObject([
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
      parseLipoArchitectures(output.replace("(16384)", "(8192)"))[0]?.alignment,
    ).toBeNull();
    expect(
      parseLipoArchitectures(output.replace("2^14 (16384)", "2^14"))[0]
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
