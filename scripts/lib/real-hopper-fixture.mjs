import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bindConformanceFixtureArtifact,
  resolveConformanceFixturePath,
  parseConformanceFixtureManifest,
} from "./conformance-fixtures.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Bind the real-Hopper semantic verifier to source-owned manifest artifacts.
 *
 * `manifestPath` is resolved against `fixtureRoot` and must stay inside it
 * after symlink canonicalization. The default root is the repository, so an
 * operator-selected manifest cannot read an arbitrary filesystem path. Tests
 * pass the directory they created.
 */
export async function loadRealHopperFixtureTargets(
  manifestPath,
  { fixtureRoot = repositoryRoot } = {},
) {
  const root = resolve(fixtureRoot);
  const resolved = resolve(root, manifestPath);
  const lexical = relative(root, resolved);
  if (
    lexical === ".." ||
    lexical.startsWith(".." + sep) ||
    isAbsolute(lexical)
  )
    throw new Error(
      `Hopper conformance manifest escapes the fixture root: ${manifestPath}`,
    );
  const canonicalRoot = await realpath(root);
  const canonicalManifest = await realpath(resolved);
  const canonical = relative(canonicalRoot, canonicalManifest);
  if (
    canonical === ".." ||
    canonical.startsWith(".." + sep) ||
    isAbsolute(canonical)
  )
    throw new Error(
      `Hopper conformance manifest escapes the fixture root: ${manifestPath}`,
    );
  const manifest = parseConformanceFixtureManifest(
    JSON.parse(await readFile(canonicalManifest, "utf8")),
  );
  const primary = fixtureEntry(manifest.fixtures, "c");
  const secondary = fixtureEntry(manifest.fixtures, "version-v2");
  const large = fixtureEntry(manifest.fixtures, "large");
  const oracle = requireCOracle(primary.expectations?.hopperOracle);
  const largeOracle = requireLargeOracle(large.expectations);
  const manifestDirectory = dirname(canonicalManifest);
  const [primaryArtifact, secondaryArtifact, largeArtifact] = await Promise.all(
    [primary, secondary, large].map(async (fixture) =>
      bindConformanceFixtureArtifact(
        await resolveConformanceFixturePath(manifestDirectory, fixture.artifact),
        fixture,
      ),
    ),
  );
  const objc = manifest.fixtures.find((fixture) => fixture?.name === "objc");
  const unicode =
    objc === undefined ? undefined : fixtureEntry(manifest.fixtures, "objc");
  const unicodeArtifact =
    unicode === undefined
      ? undefined
      : await bindConformanceFixtureArtifact(
          await resolveConformanceFixturePath(manifestDirectory, unicode.artifact),
          unicode,
        );
  requireDistinctArtifacts([
    primaryArtifact,
    secondaryArtifact,
    largeArtifact,
    ...(unicodeArtifact === undefined ? [] : [unicodeArtifact]),
  ]);
  return {
    manifestPath: canonicalManifest,
    primary: primaryArtifact,
    secondary: secondaryArtifact,
    large: largeArtifact,
    ...(unicodeArtifact === undefined ? {} : { unicode: unicodeArtifact }),
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
    throw new Error("Large fixture omitted its complete-inventory oracle");
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
