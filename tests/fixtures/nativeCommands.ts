import { readFile } from "node:fs/promises";
import type { BinaryTarget } from "../../src/domain/binaryTarget.js";
import { ok } from "../../src/domain/result.js";
import type {
  NativeCommandCapture,
  NativeCommandRunner,
} from "../../src/native/CommandRunner.js";

/** Replay captured native command outputs through the production runner seam. */
export class NativeFixtureRunner implements NativeCommandRunner {
  constructor(
    private readonly overrides: Readonly<Record<string, string>> = {},
    private readonly exitCode = 0,
  ) {}

  async run(tool: string, arguments_: readonly string[]) {
    const output =
      this.overrides[`${tool}:${arguments_[0] ?? ""}`] ??
      this.overrides[tool] ??
      (await outputFor(tool, arguments_));
    return ok({
      ...capture(tool, arguments_, output),
      exitCode: this.exitCode,
    });
  }
}

const outputFor = async (
  tool: string,
  arguments_: readonly string[],
): Promise<string> => {
  if (tool === "lipo") return nativeFixture("lipo-fat.txt");
  if (tool === "otool") return nativeFixture("otool-load.txt");
  if (tool === "nm") return "_main\n_$s4Test3fooyyF\n";
  if (tool === "dyld_info")
    return nativeFixture(
      arguments_[0] === "-imports" ? "dyld-imports.txt" : "dyld-exports.txt",
    );
  if (tool === "dwarfdump")
    return "UUID: 01234567-89AB-CDEF-0123-456789ABCDEF (arm64) fixture\n";
  if (tool === "file")
    return arguments_.at(-1)?.endsWith(".plist") === true
      ? "XML 1.0 document text\n"
      : "Mach-O 64-bit executable arm64, little-endian\n";
  if (tool === "vtool") return "Load command 3 LC_BUILD_VERSION\n";
  if (tool === "swift-demangle") return nativeFixture("demangle.txt");
  if (tool === "plutil") return nativeFixture("plist.json");
  if (tool === "codesign") {
    if (arguments_.includes("--entitlements"))
      return nativeFixture("entitlements.xml");
    if (arguments_.includes("-r-"))
      return "designated => identifier com.example.fixture\n";
    return nativeFixture("codesign.txt");
  }
  throw new Error(`Unexpected fixture tool ${tool}`);
};

/**
 * codesign prints display diagnostics to stderr and requirements or
 * entitlements to stdout.
 */
const fixtureStreams = (
  tool: string,
  arguments_: readonly string[],
  output: string,
) => {
  const stderr =
    tool === "codesign" &&
    !arguments_.includes("-r-") &&
    !arguments_.includes("--entitlements");
  return {
    stdout: stderr ? "" : output,
    stderr: stderr ? output : "",
    stdoutBytes: Buffer.byteLength(stderr ? "" : output),
    stderrBytes: Buffer.byteLength(stderr ? output : ""),
  };
};

const capture = (
  tool: string,
  arguments_: readonly string[],
  output: string,
): NativeCommandCapture => ({
  tool,
  executable: `/usr/bin/${tool}`,
  executableSha256: "a".repeat(64),
  toolVersion: null,
  versionReason: "fixture",
  arguments: [...arguments_],
  ...fixtureStreams(tool, arguments_, output),
  exitCode: 0,
  signal: null,
});

/** Build the Mach-O target identity used by native boundary fixtures. */
export const nativeMachoTarget = (
  path: string,
  sourcePath?: string,
): BinaryTarget => ({
  path,
  ...(sourcePath === undefined ? {} : { sourcePath }),
  sha256: "0".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["x86_64", "arm64"],
});

/** Load one captured native tool output. */
export const nativeFixture = (name: string): Promise<string> =>
  readFile(new URL(`./native-macos/${name}`, import.meta.url), "utf8");
