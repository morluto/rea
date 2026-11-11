import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const LARGE_FIXTURE_COUNT = 1_205;

/** Admit the current producer contract; unversioned substring checks are retired. */
export const parseConformanceFixtureManifest = (manifest) => {
  if (
    manifest?.schemaVersion !== 2 ||
    !["darwin", "linux"].includes(manifest.platform) ||
    !Array.isArray(manifest.fixtures)
  )
    throw new Error(
      "Unsupported conformance manifest; regenerate with npm run build:fixtures",
    );
  for (const fixture of manifest.fixtures) {
    if (fixture === null || typeof fixture !== "object")
      throw new Error("Invalid conformance fixture entry");
    const expectations = fixture.expectations;
    if (expectations === undefined) continue;
    if (
      expectations === null ||
      typeof expectations !== "object" ||
      Object.hasOwn(expectations, "strings") ||
      ["stringMarkers", "stringFragments"].some(
        (key) =>
          expectations[key] !== undefined &&
          (!Array.isArray(expectations[key]) ||
            expectations[key].some((value) => typeof value !== "string")),
      )
    )
      throw new Error("Invalid conformance fixture string expectations");
  }
  return manifest;
};

export const HOPPER_C_ORACLE = Object.freeze({
  mainProcedure: "main",
  entryProcedure: "rea_entry",
  branchProcedure: "rea_branch",
  leafProcedure: "rea_leaf",
  entryString: "REA_C_ENTRY",
  leafString: "REA_C_LEAF",
  globalName: "rea_c_global",
});

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");

export const generateLargeFixture = () => {
  const declarations = Array.from(
    { length: LARGE_FIXTURE_COUNT },
    (_, index) =>
      `__attribute__((noinline, used)) int rea_inventory_${String(index).padStart(4, "0")}(void) { puts("REA_INVENTORY_${String(index).padStart(4, "0")}"); return ${index}; }`,
  );
  return [
    "#include <stdio.h>",
    ...declarations,
    "int main(void) { return rea_inventory_0000(); }",
    "",
  ].join("\n");
};

export const sourceDigest = (sources) => {
  const canonical = [...sources]
    .sort(({ path: left }, { path: right }) => left.localeCompare(right))
    .map(({ path, content }) => `${path}\0${sha256(content)}\n`)
    .join("");
  return sha256(canonical);
};

/** Resolve manifest-relative paths once, including their real symlink destination. */
export const resolveConformanceFixturePath = async (root, declaredPath) => {
  if (typeof declaredPath !== "string")
    throw new Error("Conformance manifest path is invalid");
  const path = await realpath(resolve(root, declaredPath));
  const relation = relative(root, path);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  )
    throw new Error(`Conformance path escapes its root: ${declaredPath}`);
  return path;
};

/** Read a resolved artifact and bind its exact bytes to the manifest digest. */
export const bindConformanceFixtureArtifact = async (path, fixture) => {
  if (
    fixture === null ||
    typeof fixture !== "object" ||
    typeof fixture.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(fixture.artifactSha256)
  )
    throw new Error("Invalid conformance artifact declaration");
  const actual = sha256(await readFile(path));
  if (actual !== fixture.artifactSha256)
    throw new Error(
      `Fixture ${fixture.name} digest did not match its manifest`,
    );
  return { path, sha256: actual };
};
