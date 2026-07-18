import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Bind the real-Hopper semantic verifier to source-owned manifest artifacts. */
export async function loadRealHopperFixtureTargets(manifestPath) {
  const canonicalManifest = await realpath(manifestPath);
  const manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.fixtures))
    throw new Error("Invalid conformance fixture manifest");
  const primary = fixtureEntry(manifest.fixtures, "c");
  const secondary = fixtureEntry(manifest.fixtures, "version-v2");
  const large = fixtureEntry(manifest.fixtures, "large");
  const oracle = requireCOracle(primary.expectations?.hopperOracle);
  const largeOracle = requireLargeOracle(large.expectations);
  const root = dirname(canonicalManifest);
  const [primaryArtifact, secondaryArtifact, largeArtifact] = await Promise.all(
    [
      bindFixtureArtifact(root, primary),
      bindFixtureArtifact(root, secondary),
      bindFixtureArtifact(root, large),
    ],
  );
  requireDistinctArtifacts([primaryArtifact, secondaryArtifact, largeArtifact]);
  return {
    manifestPath: canonicalManifest,
    primary: primaryArtifact,
    secondary: secondaryArtifact,
    large: largeArtifact,
    oracle,
    largeOracle,
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
