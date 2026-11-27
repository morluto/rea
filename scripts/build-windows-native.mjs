#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

const {
  WINDOWS_NATIVE_ARTIFACT,
  WINDOWS_NATIVE_INSPECTION_FIXTURE_SOURCE_FILES,
  WINDOWS_NATIVE_NODE_VERSION,
  WINDOWS_NATIVE_SOURCE_FILES,
  WINDOWS_NATIVE_TARGETS,
  computeWindowsNativeSourceSha256,
  createWindowsNativeManifest,
  parseWindowsNativeManifest,
  validateWindowsNativeArtifact,
} = await importVerifierSource(
  new URL("../src/domain/windowsNativeArtifact.ts", import.meta.url).href,
  import.meta.url,
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeVersion = WINDOWS_NATIVE_NODE_VERSION;
const cache = join(homedir(), ".cache", "rea-windows-native");
const arguments_ = process.argv.slice(2);
const inspectionFixture = arguments_.includes("--inspection-fixture");
const archFlag = arguments_.find((argument) => argument.startsWith("--arch="));
const architecture = archFlag?.slice("--arch=".length) ?? "x64";
if (architecture !== "x64" && architecture !== "arm64")
  throw new Error("Windows native --arch must be x64 or arm64");
const allowed = new Set(
  [inspectionFixture ? "--inspection-fixture" : undefined, archFlag].filter(
    (argument) => argument !== undefined,
  ),
);
if (arguments_.some((argument) => !allowed.has(argument)))
  throw new Error("Unknown Windows native build argument");
const compilerPrefixFor = (arch) =>
  arch === "arm64" ? "aarch64-w64-mingw32" : "x86_64-w64-mingw32";
const compilerPrefix = compilerPrefixFor(architecture);
const compiler = `${compilerPrefix}-g++`;
const output = inspectionFixture
  ? join(root, ".cache", "windows-native-inspection-fixture")
  : join(root, "native", "windows", "build");
const run = (command, args, cwd = root) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
    timeout: 120_000,
  });
  if (result.error !== undefined)
    throw new Error(
      `Windows native build lane requires ${command}: ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(
      `Windows native build failed: ${result.stdout}${result.stderr}`,
    );
  return result.stdout;
};
if (process.platform !== "linux")
  throw new Error(
    "The Windows native artifact build lane currently requires Linux and MinGW-w64.",
  );
run(compiler, ["--version"]);
await mkdir(cache, { recursive: true });
await mkdir(output, { recursive: true });
const canonicalOutput = await realpath(output);
const provenancePath = join(cache, "build-provenance.json");
const provenanceKeyFor = (arch) => `${canonicalOutput}::${arch}`;
const probeToolchainSha256 = (arch) => {
  const prefix = compilerPrefixFor(arch);
  const gpp = spawnSync(`${prefix}-g++`, ["-v"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
    timeout: 30_000,
  });
  if (gpp.error !== undefined || gpp.status !== 0) return undefined;
  const dlltool = spawnSync(`${prefix}-dlltool`, ["--version"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
    timeout: 30_000,
  });
  if (dlltool.error !== undefined) return undefined;
  // llvm-dlltool does not support --version; GNU dlltool prints its banner.
  const dlltoolBanner = dlltool.status === 0 ? dlltool.stdout.trim() : "";
  return createHash("sha256")
    .update(`compiler:${prefix}-g++\n${`${gpp.stdout}${gpp.stderr}`.trim()}\n`)
    .update(`dlltool:${prefix}-dlltool\n${dlltoolBanner}\n`)
    .digest("hex");
};
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const fetchBytes = async (name) => {
  const response = await fetch(
    `https://nodejs.org/dist/v${nodeVersion}/${name}`,
    {
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `Node build prerequisite download failed: ${name}: HTTP ${response.status}`,
    );
  return Buffer.from(await response.arrayBuffer());
};
const verifiedDownload = async (name, path) => {
  const checksums = (await fetchBytes("SHASUMS256.txt")).toString("utf8");
  const expected = checksums
    .split("\n")
    .find((line) => line.slice(66) === name)
    ?.slice(0, 64);
  const mismatch = () =>
    new Error(`Node build prerequisite SHA-256 mismatch: ${name}`);
  if (expected === undefined) throw mismatch();
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const cached = await readFile(path).catch((cause) => {
    if (cause?.code === "ENOENT") return undefined;
    throw cause;
  });
  if (cached !== undefined && digest(cached) === expected) return;

  const downloaded = await fetchBytes(name);
  if (digest(downloaded) !== expected) throw mismatch();
  // Publish verified bytes in one rename, so readers never see a partial write.
  const staging = await mkdtemp(join(dirname(path), ".node-headers-"));
  try {
    const stagedArchive = join(staging, name);
    await writeFile(stagedArchive, downloaded);
    await rename(stagedArchive, path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};
const cachedHeaders = join(
  homedir(),
  ".cache",
  "node-gyp",
  nodeVersion,
  "include",
  "node",
);
let headers = cachedHeaders;
if (!(await exists(join(headers, "node_api.h")))) {
  const archive = join(cache, `node-v${nodeVersion}-headers.tar.gz`);
  await verifiedDownload(`node-v${nodeVersion}-headers.tar.gz`, archive);
  run("tar", ["xzf", archive, "-C", cache]);
  headers = join(cache, `node-v${nodeVersion}`, "include", "node");
}
const artifact = WINDOWS_NATIVE_TARGETS[architecture].artifact;
// MSVC short-import libraries do not produce a correct Node import table with
// GNU ld. Generate a GNU delay-import library for the exact stable Node-API
// symbols; addon.cc binds it to the host executable, whatever its file name.
const sources = ["addon.cc", "filesystem.cc", "process.cc"];
const sourceText = (
  await Promise.all(
    sources.map((path) =>
      readFile(join(root, "native", "windows", "src", path), "utf8"),
    ),
  )
).join("\n");
const sourceInputPaths = inspectionFixture
  ? WINDOWS_NATIVE_INSPECTION_FIXTURE_SOURCE_FILES
  : WINDOWS_NATIVE_SOURCE_FILES;
const sourceEntries = await Promise.all(
  sourceInputPaths.map(async (path) => [
    path,
    await readFile(join(root, path)),
  ]),
);
const sourceDigest = computeWindowsNativeSourceSha256(
  Object.fromEntries(sourceEntries),
  { nodeVersion, inspectionFixture },
);
if (!sourceDigest.ok) throw sourceDigest.error;
const sourceSha256 = sourceDigest.value;
const symbols = [
  ...new Set(
    [...sourceText.matchAll(/\b(napi_[a-z0-9_]+)\s*\(/gu)].map(
      (match) => match[1],
    ),
  ),
].sort();
const importDirectory = await mkdtemp(join(tmpdir(), "rea-windows-import-"));
try {
  const definition = join(importDirectory, "node-api.def");
  const library = join(importDirectory, "libnode-api.a");
  await writeFile(
    definition,
    `LIBRARY node.exe\nEXPORTS\n${symbols.join("\n")}\n`,
  );
  // dlltool derives PE symbols from the output operand, so pass its basename.
  run(
    `${compilerPrefix}-dlltool`,
    architecture === "arm64"
      ? ["-d", "node-api.def", "-l", "libnode-api.a"]
      : ["-d", "node-api.def", "-y", "libnode-api.a"],
    importDirectory,
  );
  run(compiler, [
    "-std=c++17",
    "-O2",
    `-DNAPI_VERSION=${WINDOWS_NATIVE_ARTIFACT.nodeApiVersion}`,
    "-D_WIN32_WINNT=0x0A00",
    "-shared",
    "-static",
    "-static-libgcc",
    "-static-libstdc++",
    "-Wl,--no-insert-timestamp",
    ...(architecture === "arm64" ? ["-Wl,--delayload=node.exe"] : []),
    `-I${headers}`,
    "native/windows/src/addon.cc",
    inspectionFixture
      ? "tests/fixtures/windows-native-inspection-failure.cc"
      : "native/windows/src/filesystem.cc",
    "native/windows/src/process.cc",
    library,
    ...(architecture === "arm64" ? ["-ldelayimp"] : []),
    "-ladvapi32",
    "-lbcrypt",
    "-lntdll",
    "-o",
    join(output, artifact),
  ]);
} finally {
  await rm(importDirectory, { recursive: true, force: true });
}
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const bytes = await readFile(join(output, artifact));
const currentToolchainSha256 = probeToolchainSha256(architecture);
const readBuildProvenance = async () => {
  if (!(await exists(provenancePath))) return {};
  try {
    const parsed = JSON.parse(await readFile(provenancePath, "utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
};
const hasMatchingProvenance = (
  entry,
  expectedArtifactSha256,
  expectedSourceSha256,
  expectedToolchainSha256,
) =>
  entry !== null &&
  typeof entry === "object" &&
  !Array.isArray(entry) &&
  entry.artifactSha256 === expectedArtifactSha256 &&
  entry.sourceSha256 === expectedSourceSha256 &&
  entry.toolchainSha256 === expectedToolchainSha256;
const provenance = await readBuildProvenance();
const manifestPath = join(output, "manifest.json");
const preservedArtifacts = {};
if (await exists(manifestPath)) {
  try {
    const previousRaw = JSON.parse(await readFile(manifestPath, "utf8"));
    const previousParsed = parseWindowsNativeManifest(
      previousRaw,
      packageJson.version,
    );
    if (
      previousParsed.ok &&
      previousParsed.value.sourceSha256 === sourceSha256
    ) {
      const candidateArchs =
        previousParsed.value.artifacts !== undefined
          ? Object.keys(previousParsed.value.artifacts)
          : [previousParsed.value.architecture];
      for (const candidateArch of candidateArchs) {
        if (candidateArch === architecture) continue;
        const resolved = parseWindowsNativeManifest(
          previousRaw,
          packageJson.version,
          candidateArch,
        );
        if (!resolved.ok) continue;
        const candidatePath = join(output, resolved.value.artifact);
        if (!(await exists(candidatePath))) continue;
        const candidateToolchainSha256 = probeToolchainSha256(candidateArch);
        if (candidateToolchainSha256 === undefined) continue;
        const key = provenanceKeyFor(candidateArch);
        const recorded = Object.hasOwn(provenance, key)
          ? provenance[key]
          : undefined;
        if (
          !hasMatchingProvenance(
            recorded,
            resolved.value.artifactSha256,
            sourceSha256,
            candidateToolchainSha256,
          )
        )
          continue;
        const candidateBytes = await readFile(candidatePath);
        if (validateWindowsNativeArtifact(resolved.value, candidateBytes).ok)
          preservedArtifacts[candidateArch] = {
            artifact: resolved.value.artifact,
            artifactSha256: resolved.value.artifactSha256,
          };
      }
    }
  } catch {
    // Replace unreadable or stale manifest state with the newly built target.
  }
}
const created = createWindowsNativeManifest(packageJson.version, bytes, {
  architecture,
  sourceSha256,
  preservedArtifacts,
  includeArtifactsTable: true,
});
if (!created.ok) throw created.error;
const metadata = created.value;
const nextProvenance = { ...provenance };
for (const [arch, target] of Object.entries(WINDOWS_NATIVE_TARGETS)) {
  if (metadata.artifacts?.[arch] === undefined) {
    await rm(join(output, target.artifact), { force: true });
    delete nextProvenance[provenanceKeyFor(arch)];
  }
}
if (currentToolchainSha256 !== undefined)
  nextProvenance[provenanceKeyFor(architecture)] = {
    artifactSha256: metadata.artifactSha256,
    sourceSha256,
    toolchainSha256: currentToolchainSha256,
  };
else delete nextProvenance[provenanceKeyFor(architecture)];
await writeFile(manifestPath, `${JSON.stringify(metadata, null, 2)}\n`);
await writeFile(provenancePath, `${JSON.stringify(nextProvenance, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ ...metadata, artifactBytes: bytes.length })}\n`,
);
