import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  generateLargeFixture,
  HOPPER_C_ORACLE,
  LARGE_FIXTURE_COUNT,
  sha256,
  sourceDigest,
} from "./lib/conformance-fixtures.mjs";

const exec = promisify(execFile);
const root = process.cwd();
const sourceRoot = join(root, "tests/conformance");
const outputRoot = resolve(
  process.env.REA_CONFORMANCE_BUILD ?? join(root, "build/conformance"),
);
if (platform() !== "darwin")
  throw new Error(
    "Mach-O conformance fixtures require macOS and Xcode command-line tools",
  );
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const clang = (await exec("xcrun", ["--find", "clang"])).stdout.trim();
const clangVersion = (await exec(clang, ["--version"])).stdout.split("\n")[0];
const sdkPath = (await exec("xcrun", ["--show-sdk-path"])).stdout.trim();
const architecture = arch();
const common = [
  "-arch",
  architecture,
  "-isysroot",
  sdkPath,
  "-O0",
  "-g",
  "-fno-inline",
];
const fixtures = [];

await build(
  "c",
  ["c/fixture.c"],
  [...common, join(sourceRoot, "c/fixture.c"), "-o", join(outputRoot, "c")],
  {
    expectations: {
      symbols: ["_rea_entry", "_rea_branch", "_rea_leaf", "_rea_c_global"],
      strings: ["REA_C_ENTRY", "REA_C_LEAF"],
      hopperOracle: HOPPER_C_ORACLE,
    },
  },
);
await build(
  "version-v1",
  ["versions/v1.c"],
  [
    ...common,
    join(sourceRoot, "versions/v1.c"),
    "-o",
    join(outputRoot, "version-v1"),
  ],
  {
    expectations: {
      symbols: ["_rea_version_entry", "_rea_version_leaf"],
      strings: ["REA_VERSION_ONE"],
    },
  },
);
await build(
  "version-v2",
  ["versions/v2.c"],
  [
    ...common,
    join(sourceRoot, "versions/v2.c"),
    "-o",
    join(outputRoot, "version-v2"),
  ],
  {
    expectations: {
      symbols: ["_rea_version_entry", "_rea_version_leaf", "_rea_added"],
      strings: ["REA_VERSION_TWO"],
    },
  },
);

const largeSource = generateLargeFixture();
const largePath = join(outputRoot, "large.c");
await writeFile(largePath, largeSource);
await build(
  "large",
  [{ path: "generated/large.c", content: largeSource }],
  [...common, largePath, "-o", join(outputRoot, "large")],
  {
    expectations: {
      symbolPrefix: "_rea_page_",
      symbolCount: LARGE_FIXTURE_COUNT,
      stringPrefix: "REA_PAGE_",
      stringCount: LARGE_FIXTURE_COUNT,
    },
  },
);

await build(
  "objc",
  ["objc/fixture.m"],
  [
    ...common,
    "-fobjc-arc",
    join(sourceRoot, "objc/fixture.m"),
    "-framework",
    "Foundation",
    "-o",
    join(outputRoot, "objc"),
  ],
  {
    expectations: {
      symbols: ["_OBJC_CLASS_$_REAWidget"],
      strings: ["REAWidget", "REAWidgetDelegate", "performAction:error:"],
    },
  },
);
await build(
  "napi",
  ["napi/fixture.c"],
  [
    ...common,
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    join(sourceRoot, "napi/fixture.c"),
    "-o",
    join(outputRoot, "fixture.node"),
  ],
  {
    expectations: {
      symbols: ["_napi_register_module_v1"],
      strings: ["reaProbeOne", "reaProbeTwo", "reaProbeThree"],
    },
  },
);

try {
  const swiftc = (await exec("xcrun", ["--find", "swiftc"])).stdout.trim();
  const swiftVersion = (await exec(swiftc, ["--version"])).stdout.split(
    "\n",
  )[0];
  await build(
    "swift",
    ["swift/fixture.swift"],
    [
      "-sdk",
      sdkPath,
      "-Onone",
      "-g",
      join(sourceRoot, "swift/fixture.swift"),
      "-o",
      join(outputRoot, "swift"),
    ],
    {
      expectations: {
        strings: [
          "REA_SWIFT_EXECUTE",
          "REAService",
          "REARecord",
          "REAState",
          "REAProtocol",
        ],
      },
      compiler: swiftc,
      compilerVersion: swiftVersion,
    },
  );
} catch (cause) {
  process.stderr.write(
    `Skipping optional Swift fixture: ${cause instanceof Error ? cause.message : String(cause)}\n`,
  );
}

const manifest = {
  schemaVersion: 1,
  platform: platform(),
  architecture,
  generatedAt: new Date(0).toISOString(),
  fixtures,
};
await writeFile(
  join(outputRoot, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ outputRoot, fixtureCount: fixtures.length })}\n`,
);

async function build(name, sources, args, options) {
  const compiler = options.compiler ?? clang;
  const compilerVersion = options.compilerVersion ?? clangVersion;
  const normalized = await Promise.all(
    sources.map(async (source) => {
      if (typeof source !== "string") return source;
      return {
        path: source,
        content: await readFile(join(sourceRoot, source), "utf8"),
      };
    }),
  );
  await exec(compiler, args, { maxBuffer: 10 * 1024 * 1024 });
  const artifactPath = args.at(-1);
  if (typeof artifactPath !== "string")
    throw new Error(`Missing output for ${name}`);
  const artifact = await readFile(artifactPath);
  fixtures.push({
    name,
    artifact: relative(outputRoot, artifactPath),
    artifactSha256: sha256(artifact),
    sourceSha256: sourceDigest(normalized),
    sources: normalized.map(({ path, content }) => ({
      path,
      sha256: sha256(content),
    })),
    compiler: { path: compiler, version: compilerVersion, arguments: args },
    expectations: options.expectations,
  });
}
