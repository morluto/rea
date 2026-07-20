import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const MANDATORY_FIXTURE_NAMES = [
  "c",
  "version-v1",
  "version-v2",
  "objc",
  "napi",
  "large",
];

const OPTIONAL_FIXTURE_NAMES = ["swift"];

/**
 * Bind the real-Hopper semantic verifier to source-owned manifest artifacts.
 *
 * Every present artifact is distinct and digest-bound. Swift remains optional.
 */
export async function loadRealHopperFixtureTargets(manifestPath) {
  const canonicalManifest = await realpath(manifestPath);
  const manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.fixtures))
    throw new Error("Invalid conformance fixture manifest");
  const root = dirname(canonicalManifest);
  const entries = new Map();
  for (const name of MANDATORY_FIXTURE_NAMES)
    entries.set(name, fixtureEntry(manifest.fixtures, name));
  for (const name of OPTIONAL_FIXTURE_NAMES) {
    const matches = manifest.fixtures.filter(
      (fixture) => fixture?.name === name,
    );
    if (matches.length === 1) entries.set(name, matches[0]);
    else if (matches.length > 1) throw new Error(`Duplicate fixture ${name}`);
  }
  const oracle = requireCOracle(entries.get("c")?.expectations?.hopperOracle);
  const largeOracle = requireLargeOracle(entries.get("large")?.expectations);
  const versionV1Expectations = requireStringArrayExpectations(
    entries.get("version-v1"),
    "version-v1",
  );
  const versionV2Expectations = requireStringArrayExpectations(
    entries.get("version-v2"),
    "version-v2",
  );
  const objcExpectations = requireStringArrayExpectations(
    entries.get("objc"),
    "objc",
  );
  const napiExpectations = requireStringArrayExpectations(
    entries.get("napi"),
    "napi",
  );
  const swiftExpectations = entries.has("swift")
    ? requireStringArrayExpectations(entries.get("swift"), "swift")
    : undefined;
  const bound = new Map();
  for (const [name, entry] of entries)
    bound.set(name, await bindFixtureArtifact(root, entry));
  requireDistinctArtifacts([...bound.values()]);
  const compilers = Object.fromEntries(
    [...entries].map(([name, entry]) => [name, requireCompiler(entry, name)]),
  );
  return {
    manifestPath: canonicalManifest,
    primary: bound.get("c"),
    secondary: bound.get("version-v2"),
    large: bound.get("large"),
    versionV1: bound.get("version-v1"),
    versionV2: bound.get("version-v2"),
    objc: bound.get("objc"),
    napi: bound.get("napi"),
    swift: bound.get("swift"),
    oracle,
    largeOracle,
    versionV1Expectations,
    versionV2Expectations,
    objcExpectations,
    napiExpectations,
    swiftExpectations,
    compilers,
  };
}

function requireCompiler(entry, name) {
  const compiler = entry?.compiler;
  if (
    compiler === null ||
    typeof compiler !== "object" ||
    typeof compiler.path !== "string" ||
    compiler.path.length === 0 ||
    typeof compiler.version !== "string" ||
    compiler.version.length === 0 ||
    !Array.isArray(compiler.arguments) ||
    compiler.arguments.some((argument) => typeof argument !== "string")
  )
    throw new Error(`Fixture ${name} omitted its compiler provenance`);
  return {
    path: compiler.path,
    version: compiler.version,
    arguments: [...compiler.arguments],
  };
}

function requireCOracle(oracle) {
  if (
    oracle === null ||
    typeof oracle !== "object" ||
    typeof oracle.mainProcedure !== "string" ||
    typeof oracle.entryProcedure !== "string" ||
    typeof oracle.branchProcedure !== "string" ||
    typeof oracle.leafProcedure !== "string" ||
    typeof oracle.entryString !== "string" ||
    typeof oracle.leafString !== "string" ||
    typeof oracle.globalName !== "string" ||
    [
      oracle.mainProcedure,
      oracle.entryProcedure,
      oracle.branchProcedure,
      oracle.leafProcedure,
      oracle.entryString,
      oracle.leafString,
      oracle.globalName,
    ].some((value) => value.length === 0)
  )
    throw new Error("C fixture omitted its Hopper semantic oracle");
  return oracle;
}

function requireLargeOracle(largeOracle) {
  if (
    largeOracle === null ||
    typeof largeOracle !== "object" ||
    typeof largeOracle.symbolPrefix !== "string" ||
    largeOracle.symbolPrefix.length === 0 ||
    typeof largeOracle.stringPrefix !== "string" ||
    largeOracle.stringPrefix.length === 0 ||
    !Number.isInteger(largeOracle.symbolCount) ||
    largeOracle.symbolCount !== largeOracle.stringCount ||
    largeOracle.symbolCount <= 0
  )
    throw new Error("Large fixture omitted its exact pagination oracle");
  return largeOracle;
}

function requireStringArrayExpectations(entry, name) {
  const expectations = entry?.expectations;
  if (
    expectations === null ||
    typeof expectations !== "object" ||
    Array.isArray(expectations)
  )
    throw new Error(`Fixture ${name} omitted its expectations`);
  const keys = Object.keys(expectations);
  if (keys.length === 0)
    throw new Error(`Fixture ${name} expectations must be nonempty`);
  for (const key of keys) {
    const value = expectations[key];
    if (!Array.isArray(value) || value.length === 0)
      throw new Error(`Fixture ${name} expectation ${key} must be nonempty`);
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0)
        throw new Error(
          `Fixture ${name} expectation ${key} must be nonempty strings`,
        );
    }
  }
  return expectations;
}

function requireDistinctArtifacts(artifacts) {
  if (
    new Set(artifacts.map(({ path }) => path)).size !== artifacts.length ||
    new Set(artifacts.map(({ sha256 }) => sha256)).size !== artifacts.length
  )
    throw new Error("Hopper conformance fixtures must be distinct artifacts");
}

function fixtureEntry(fixtures, name) {
  const matches = fixtures.filter((fixture) => fixture?.name === name);
  if (matches.length !== 1) throw new Error(`Missing fixture ${name}`);
  return matches[0];
}

async function bindFixtureArtifact(root, fixture) {
  if (
    typeof fixture.artifact !== "string" ||
    typeof fixture.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(fixture.artifactSha256)
  )
    throw new Error(`Invalid artifact declaration for ${fixture.name}`);
  const path = await realpath(resolve(root, fixture.artifact));
  const relation = relative(root, path);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  )
    throw new Error(`Fixture ${fixture.name} escapes its manifest root`);
  const actual = sha256(await readFile(path));
  if (actual !== fixture.artifactSha256)
    throw new Error(
      `Fixture ${fixture.name} digest did not match its manifest`,
    );
  return { path, sha256: actual };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
