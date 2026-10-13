import { describe, expect, it } from "vitest";

import {
  CPU,
  LC,
  dylibCommand,
  fatImage,
  machoImage,
} from "../artifacts/apple/MachoImage.fixture.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import { parseMachoLayout, selectMachoSlice } from "./AppleMachoSelection.js";
import type { NativeCommandCapture } from "./CommandRunner.js";
import { inspectNativeMacho } from "./NativeMachoInspection.js";
import {
  NativeFixtureRunner,
  nativeMachoTarget,
  withOtoolMachHeader,
} from "../../tests/fixtures/nativeCommands.js";

const capture = (tool: string, stdout: string): NativeCommandCapture => ({
  tool,
  executable: tool,
  executableSha256: "a".repeat(64),
  toolVersion: null,
  versionReason: null,
  arguments: [],
  stdout,
  stderr: "",
  stdoutBytes: stdout.length,
  stderrBytes: 0,
  exitCode: 0,
  signal: null,
});

const inspect = async (lipo: string, architecture: "x86" | "arm64") => {
  const commands: {
    readonly tool: string;
    readonly args: readonly string[];
  }[] = [];
  const result = await inspectNativeMacho({
    target: {
      kind: "executable",
      format: "mach-o",
      path: "/fixture/app",
      sha256: "b".repeat(64),
      architecture,
      availableArchitectures: ["x86", "arm64"],
    },
    run: (tool, args) => {
      commands.push({ tool, args });
      if (tool === "lipo") return Promise.resolve(ok(capture(tool, lipo)));
      if (tool === "file") return Promise.resolve(ok(capture(tool, "Mach-O")));
      return Promise.resolve(err(new AnalysisCancelledError("inspect_native")));
    },
    invocation: () => {
      throw new Error("invocation is not reached");
    },
  });
  return { result, commands };
};

describe("Mach-O tool architecture selection", () => {
  it("rejects a CPU lipo did not list instead of reading another slice", async () => {
    const { result, commands } = await inspect("architecture arm64\n", "x86");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      _tag: "AnalysisOutputError",
      reason: "lipo did not list i386; refusing to read another slice",
    });
    expect(commands.map(({ tool }) => tool)).toEqual(["file", "lipo"]);
  });

  it("passes the arm64e slice lipo listed for an arm64 target", async () => {
    const { commands } = await inspect("architecture arm64e\n", "arm64");
    const otool = commands.find(({ tool }) => tool === "otool");
    expect(otool?.args).toEqual([
      "-h",
      "-l",
      "-arch",
      "arm64e",
      "/fixture/app",
    ]);
  });

  it.each([
    { names: ["arm64v8", "arm64e"], selected: "arm64e" },
    { names: ["arm64e", "arm64v8"], selected: "arm64e" },
    { names: ["arm64v8", "arm64e", "arm64"], selected: "arm64" },
    { names: ["arm64v8"], selected: "arm64v8" },
    { names: ["arm64v8", "arm64e.x1"], selected: "arm64v8" },
    { names: ["arm64e.x1", "arm64v8"], selected: "arm64v8" },
    { names: ["arm64v8", "arm64e.v1"], selected: "arm64e.v1" },
    { names: ["arm64e.v1", "arm64v8"], selected: "arm64e.v1" },
  ] as const)(
    "keeps inspection and dispatch on $selected for FAT order $names",
    async ({ names, selected }) => {
      const cpus = {
        arm64: CPU.arm64,
        arm64v8: { type: CPU.arm64.type, subtype: 1 },
        arm64e: CPU.arm64e,
        "arm64e.x1": { type: CPU.arm64.type, subtype: 0x8000000c },
        "arm64e.v1": { type: CPU.arm64.type, subtype: 0x81000002 },
      };
      const slices = names.map((name) => {
        const cpu = cpus[name];
        return {
          cpu,
          bytes: machoImage({
            cpu,
            commands: [dylibCommand(LC.LOAD_DYLIB, `/fixture/${name}.dylib`)],
          }),
        };
      });
      const fat = Buffer.from(fatImage(slices));
      const lipo = names
        .map(
          (name, index) =>
            `architecture ${name}\n cputype ${cpus[name].type}\n cpusubtype ${cpus[name].subtype}\n offset ${(index + 1) * 4096}\n size ${slices[index]?.bytes.length}\n align 2^12\n`,
        )
        .join("");
      const { commands } = await inspect(lipo, "arm64");
      expect(commands.find(({ tool }) => tool === "otool")?.args).toEqual([
        "-h",
        "-l",
        "-arch",
        selected.split(".")[0],
        "/fixture/app",
      ]);
      expect(commands.find(({ tool }) => tool === "dyld_info")?.args).toContain(
        selected,
      );
      expect(selectMachoSlice(fat, "arm64").slice).toBe(
        (names.findIndex((name) => name === selected) + 1) * 4096,
      );
      expect(parseMachoLayout(fat, "arm64").fixups.dylibs).toEqual([
        `/fixture/${selected}.dylib`,
      ]);
    },
  );
});

describe("Mach-O UUID reconciliation", () => {
  const validUuid = "01234567-89AB-CDEF-0123-456789ABCDEF";

  const runInspection = async (
    dwarfdump: string,
    otoolUuids: readonly string[] = [validUuid],
    targetPath = "/fixture/app",
  ) => {
    const runner = new NativeFixtureRunner({
      dwarfdump,
      otool: withOtoolMachHeader(
        otoolUuids
          .map(
            (uuid, index) =>
              `Load command ${index}\n      cmd LC_UUID\n  cmdsize 24\n     uuid ${uuid}`,
          )
          .join("\n"),
      ),
    });
    const result = await inspectNativeMacho({
      target: nativeMachoTarget(targetPath),
      run: (tool, args) => runner.run(tool, args),
      invocation: (capture) => ({
        tool: capture.tool,
        command: [capture.executable, ...capture.arguments],
        tool_version: capture.toolVersion,
        version_reason: capture.versionReason,
        executable_sha256: capture.executableSha256,
        exit: { code: capture.exitCode, signal: capture.signal },
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
      }),
    });
    return result;
  };

  it("keeps a valid otool UUID when dwarfdump is malformed and reports the limitation", async () => {
    const result = await runInspection("UUID: A (arm64) /fixture/app\n");
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: validUuid });
    expect(result.value.limitations).toContain(
      'dwarfdump --uuid returned malformed UUID "A"; using the unambiguous otool LC_UUID.',
    );
  });

  it("does not choose between conflicting valid UUIDs", async () => {
    const result = await runInspection(
      `UUID: FEDCBA98-7654-3210-FEDC-BA9876543210 (arm64) /fixture/app\n`,
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: null });
    expect(result.value.limitations).toContain(
      `dwarfdump --uuid (FEDCBA98-7654-3210-FEDC-BA9876543210) conflicts with otool LC_UUID (${validUuid}); the image UUID is unknown.`,
    );
  });

  it("accepts matching UUIDs with different case and preserves dwarfdump spelling", async () => {
    const lower = validUuid.toLowerCase();
    const result = await runInspection(`UUID: ${lower} (arm64) /fixture/app\n`);
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: lower });
  });

  it("uses a valid dwarfdump UUID when otool has no UUID observation", async () => {
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) /fixture/app\n`,
      [],
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: validUuid });
  });

  it("frames a path containing a newline and UUID-like text as one dwarfdump row", async () => {
    const path =
      "/fixture/\nUUID: FEDCBA98-7654-3210-FEDC-BA9876543210 (arm64) fake";
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) ${path}\n`,
      [validUuid],
      path,
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: validUuid });
  });

  it("keeps a conflict between duplicate valid LC_UUID commands unknown despite dwarfdump", async () => {
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) /fixture/app\n`,
      [validUuid, "FEDCBA98-7654-3210-FEDC-BA9876543210"],
      "/fixture/app",
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: null });
    expect(result.value.limitations).toContain(
      `otool returned conflicting LC_UUID values ${JSON.stringify(validUuid)} and ${JSON.stringify("FEDCBA98-7654-3210-FEDC-BA9876543210")}`,
    );
  });

  it("keeps conflicting duplicate dwarfdump rows unknown despite otool", async () => {
    const conflictingUuid = "FEDCBA98-7654-3210-FEDC-BA9876543210";
    const result = await runInspection(
      `UUID: ${validUuid} (arm64) /fixture/app\nUUID: ${conflictingUuid} (arm64) /fixture/app\n`,
    );
    if (!result.ok) throw result.error;
    expect(result.value.result).toMatchObject({ uuid: null });
    expect(result.value.limitations).toContain(
      "dwarfdump --uuid returned conflicting UUIDs for selected architecture arm64",
    );
  });
});

describe("Mach-O slice command scheduling", () => {
  const SLICE_TOOLS = ["otool", "nm", "dyld_info", "dyld_info", "dwarfdump"];

  /** Finish later-launched slice commands first and record overlap. */
  const reorderingRunner = (failing: ReadonlySet<string> = new Set()) => {
    const fixtures = new NativeFixtureRunner();
    let inFlight = 0;
    let maxInFlight = 0;
    let launched = 0;
    const run = async (tool: string, args: readonly string[]) => {
      if (tool === "file" || tool === "lipo") return fixtures.run(tool, args);
      const order = launched++;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      for (let turn = 0; turn < 12 - order * 2; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      if (failing.has(tool))
        return err(new AnalysisOutputError("inspect_macho", `${tool} failed`));
      return fixtures.run(tool, args);
    };
    return { run, maxInFlight: () => maxInFlight };
  };

  const inspectWith = (run: ReturnType<typeof reorderingRunner>["run"]) =>
    inspectNativeMacho({
      target: nativeMachoTarget("/fixture/app"),
      run,
      invocation: (capture) => ({
        tool: capture.tool,
        command: [capture.executable, ...capture.arguments],
        tool_version: capture.toolVersion,
        version_reason: capture.versionReason,
        executable_sha256: capture.executableSha256,
        exit: { code: capture.exitCode, signal: capture.signal },
        stdout_bytes: capture.stdoutBytes,
        stderr_bytes: capture.stderrBytes,
      }),
    });

  it("runs independent slice commands together and keeps provenance in declared order", async () => {
    const runner = reorderingRunner();
    const result = await inspectWith(runner.run);
    if (!result.ok) throw result.error;
    expect(runner.maxInFlight()).toBe(SLICE_TOOLS.length + 1);
    expect(result.value.result).toMatchObject({
      provenance: ["file", "lipo", ...SLICE_TOOLS, "vtool"].map((tool) => ({
        tool,
      })),
    });
  });

  it("reports the first failing slice command in declared order", async () => {
    const runner = reorderingRunner(new Set(["nm", "dwarfdump"]));
    const result = await inspectWith(runner.run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ reason: "nm failed" });
  });
});
