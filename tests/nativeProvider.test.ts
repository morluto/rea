import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NativeMacOSProvider } from "../src/native/NativeMacOSProvider.js";
import {
  NativeCommandFailure,
  XcrunCommandRunner,
  type NativeCommandCapture,
  type NativeCommandRunner,
} from "../src/native/CommandRunner.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { err, ok } from "../src/domain/result.js";
import { parseLipoArchitectures } from "../src/native/parsers/lipo.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("native macOS provider", () => {
  it("retries a failed native tool resolution and caches only success", async () => {
    let resolutions = 0;
    const runner = new XcrunCommandRunner((tool) => {
      resolutions += 1;
      return Promise.resolve(
        resolutions === 1
          ? err(new NativeCommandFailure(tool, "unavailable"))
          : ok({ path: "/bin/true", sha256: "a".repeat(64) }),
      );
    });
    const options = { timeoutMs: 1_000, maxOutputBytes: 1_024 };

    expect((await runner.run("file", [], options)).ok).toBe(false);
    expect((await runner.run("file", [], options)).ok).toBe(true);
    expect((await runner.run("file", [], options)).ok).toBe(true);
    expect(resolutions).toBe(2);
  });

  it("normalizes comprehensive Mach-O inspection with exact bounded provenance", async () => {
    const runner = new FixtureRunner();
    const client = new NativeMacOSProvider(runner, "darwin").createClient(
      machoTarget("/private/fixture"),
    );
    const execution = await client.execute("inspect_macho", {});
    expect(execution.ok).toBe(true);
    if (!execution.ok) return;
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

  it("supports architectures, signatures, plists, and ordered demangling", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-native-"));
    const app = join(directory, "Fixture.app");
    const executable = join(app, "Contents/MacOS/Fixture");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(executable, "fixture");
    await writeFile(join(app, "Contents/Info.plist"), "fixture");
    const client = new NativeMacOSProvider(
      new FixtureRunner(),
      "darwin",
    ).createClient(machoTarget(executable, app));

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
    const plist = await client.execute("inspect_plist", {
      relative_path: "Contents/Info.plist",
    });
    expect(plist.ok && plist.value.result).toMatchObject({
      bundle: { identifier: "com.example.fixture", version: "42" },
      source_path: "Contents/Info.plist",
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

  it("classifies unavailable, malformed, timeout, and cancellation", async () => {
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
      ["timeout", "AnalysisTimeoutError"],
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
});

class FixtureRunner implements NativeCommandRunner {
  constructor(
    private readonly overrides: Readonly<Record<string, string>> = {},
  ) {}

  async run(tool: string, arguments_: readonly string[]) {
    const output = this.overrides[tool] ?? (await outputFor(tool, arguments_));
    return ok(capture(tool, arguments_, output));
  }
}

class FailingRunner implements NativeCommandRunner {
  constructor(private readonly reason: NativeCommandFailure["reason"]) {}

  run(tool: string) {
    return Promise.resolve(err(new NativeCommandFailure(tool, this.reason)));
  }
}

class CountingRunner implements NativeCommandRunner {
  calls = 0;

  run(tool: string) {
    this.calls += 1;
    return Promise.resolve(err(new NativeCommandFailure(tool, "unavailable")));
  }
}

const outputFor = async (
  tool: string,
  arguments_: readonly string[],
): Promise<string> => {
  if (tool === "lipo") return fixture("lipo-fat.txt");
  if (tool === "otool") return fixture("otool-load.txt");
  if (tool === "nm") return "_main\n_$s4Test3fooyyF\n";
  if (tool === "dyld_info")
    return fixture(
      arguments_[0] === "-imports" ? "dyld-imports.txt" : "dyld-exports.txt",
    );
  if (tool === "dwarfdump")
    return "UUID: 01234567-89AB-CDEF-0123-456789ABCDEF (arm64) fixture\n";
  if (tool === "file")
    return arguments_.at(-1)?.endsWith(".plist") === true
      ? "XML 1.0 document text\n"
      : "Mach-O 64-bit executable arm64, little-endian\n";
  if (tool === "vtool") return "Load command 3 LC_BUILD_VERSION\n";
  if (tool === "swift-demangle") return fixture("demangle.txt");
  if (tool === "plutil") return fixture("plist.json");
  if (tool === "codesign") {
    if (arguments_.includes("--entitlements"))
      return fixture("entitlements.xml");
    if (arguments_.includes("-r-"))
      return "designated => identifier com.example.fixture\n";
    return fixture("codesign.txt");
  }
  throw new Error(`Unexpected fixture tool ${tool}`);
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
  stdout: tool === "codesign" ? "" : output,
  stderr: tool === "codesign" ? output : "",
  stdoutBytes: Buffer.byteLength(tool === "codesign" ? "" : output),
  stderrBytes: Buffer.byteLength(tool === "codesign" ? output : ""),
  stdoutTruncated: false,
  stderrTruncated: false,
  exitCode: 0,
  signal: null,
});

const machoTarget = (path: string, sourcePath?: string): BinaryTarget => ({
  path,
  ...(sourcePath === undefined ? {} : { sourcePath }),
  sha256: "0".repeat(64),
  kind: "executable",
  format: "mach-o",
  architecture: "arm64",
  availableArchitectures: ["x86_64", "arm64"],
  loaderArgs: [],
});

const fixture = (name: string): Promise<string> =>
  readFile(new URL(`./fixtures/native-macos/${name}`, import.meta.url), "utf8");
