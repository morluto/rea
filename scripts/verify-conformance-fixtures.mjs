import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import {
  generateLargeFixture,
  sha256,
  sourceDigest,
} from "./lib/conformance-fixtures.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const verifierRun = createVerifierRun();
const manifestPath = await realpath(
  resolve(process.argv[2] ?? "build/conformance/manifest.json"),
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 1 ||
  !Array.isArray(manifest.fixtures) ||
  (manifest.platform !== "darwin" && manifest.platform !== "linux")
)
  throw new Error("Unsupported conformance manifest");
if (manifest.platform !== process.platform)
  throw new Error(
    `Conformance manifest platform ${manifest.platform} does not match ${process.platform}`,
  );
const root = dirname(manifestPath);
const fileMarker = manifest.platform === "darwin" ? "Mach-O" : "ELF";
const nmArguments = manifest.platform === "darwin" ? ["-gU"] : ["-g"];

for (const fixture of manifest.fixtures) await verifyFixture(fixture);

const v1 = manifest.fixtures.find(({ name }) => name === "version-v1");
const v2 = manifest.fixtures.find(({ name }) => name === "version-v2");
if (v1 === undefined || v2 === undefined)
  throw new Error("Conformance manifest omitted the version pair");
if (v1.artifactSha256 === v2.artifactSha256)
  throw new Error("Version-pair artifacts unexpectedly have equal hashes");
process.stdout.write(
  `${JSON.stringify({ verifier_run: await completeVerifierRun(verifierRun), verified: manifest.fixtures.length, manifestPath, platform: manifest.platform })}\n`,
);

async function verifyFixture(fixture) {
  const artifactPath = await confinedPath(root, fixture.artifact);
  const sources = [];
  for (const source of fixture.sources ?? []) {
    if (typeof source.path !== "string" || typeof source.sha256 !== "string")
      throw new Error(`${fixture.name}: invalid source declaration`);
    const content =
      source.path === "generated/large.c"
        ? generateLargeFixture()
        : await readFile(
            await confinedPath(
              resolve(process.cwd(), "tests/conformance"),
              source.path,
            ),
          );
    if (sha256(content) !== source.sha256)
      throw new Error(
        `${fixture.name}: source hash mismatch for ${source.path}`,
      );
    sources.push({ path: source.path, content });
  }
  if (sourceDigest(sources) !== fixture.sourceSha256)
    throw new Error(`${fixture.name}: source manifest digest mismatch`);
  const artifact = await readFile(artifactPath);
  if (sha256(artifact) !== fixture.artifactSha256)
    throw new Error(`${fixture.name}: artifact hash mismatch`);
  const fileOutput = (await exec("file", [artifactPath])).stdout;
  if (!fileOutput.includes(fileMarker))
    throw new Error(`${fixture.name}: not ${fileMarker}`);
  const symbols = (
    await exec("nm", [...nmArguments, artifactPath], {
      maxBuffer: 20 * 1024 * 1024,
    })
  ).stdout;
  const strings = (
    await exec("strings", [artifactPath], { maxBuffer: 20 * 1024 * 1024 })
  ).stdout;
  const expectations = fixture.expectations ?? {};
  for (const symbol of expectations.symbols ?? [])
    if (!symbols.includes(symbol))
      throw new Error(`${fixture.name}: missing symbol ${symbol}`);
  for (const value of expectations.strings ?? [])
    if (!strings.includes(value))
      throw new Error(`${fixture.name}: missing string ${value}`);
  verifyCount(
    symbols,
    expectations.symbolPrefix,
    expectations.symbolCount,
    fixture.name,
  );
  verifyCount(
    strings,
    expectations.stringPrefix,
    expectations.stringCount,
    fixture.name,
  );
}

async function confinedPath(rootPath, declaredPath) {
  if (typeof declaredPath !== "string")
    throw new Error("Conformance manifest path is invalid");
  const path = await realpath(resolve(rootPath, declaredPath));
  const relation = relative(rootPath, path);
  if (
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  )
    throw new Error(`Conformance path escapes its root: ${declaredPath}`);
  return path;
}

function verifyCount(output, prefix, expected, fixture) {
  if (prefix === undefined || expected === undefined) return;
  const count = output
    .split("\n")
    .filter((line) => line.includes(prefix)).length;
  if (count !== expected)
    throw new Error(
      `${fixture}: expected ${expected} ${prefix} records, received ${count}`,
    );
}
