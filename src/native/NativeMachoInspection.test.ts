import { describe, expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { err, ok } from "../domain/result.js";
import type { NativeCommandCapture } from "./CommandRunner.js";
import { inspectNativeMacho } from "./NativeMachoInspection.js";

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
});
