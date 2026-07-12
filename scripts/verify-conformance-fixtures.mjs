import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./lib/conformance-fixtures.mjs";

const exec = promisify(execFile);
const manifestPath = resolve(
  process.argv[2] ?? "build/conformance/manifest.json",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.fixtures))
  throw new Error("Unsupported conformance manifest");
const root = dirname(manifestPath);

for (const fixture of manifest.fixtures) {
  const artifactPath = join(root, fixture.artifact);
  const artifact = await readFile(artifactPath);
  if (sha256(artifact) !== fixture.artifactSha256)
    throw new Error(`${fixture.name}: artifact hash mismatch`);
  const fileOutput = (await exec("file", [artifactPath])).stdout;
  if (!fileOutput.includes("Mach-O"))
    throw new Error(`${fixture.name}: not Mach-O`);
  const symbols = (
    await exec("nm", ["-gU", artifactPath], { maxBuffer: 20 * 1024 * 1024 })
  ).stdout;
  const strings = (
    await exec("strings", [artifactPath], { maxBuffer: 20 * 1024 * 1024 })
  ).stdout;
  for (const symbol of fixture.expectations.symbols ?? [])
    if (!symbols.includes(symbol))
      throw new Error(`${fixture.name}: missing symbol ${symbol}`);
  for (const value of fixture.expectations.strings ?? [])
    if (!strings.includes(value))
      throw new Error(`${fixture.name}: missing string ${value}`);
  verifyCount(
    symbols,
    fixture.expectations.symbolPrefix,
    fixture.expectations.symbolCount,
    fixture.name,
  );
  verifyCount(
    strings,
    fixture.expectations.stringPrefix,
    fixture.expectations.stringCount,
    fixture.name,
  );
}

const v1 = manifest.fixtures.find(({ name }) => name === "version-v1");
const v2 = manifest.fixtures.find(({ name }) => name === "version-v2");
if (v1?.artifactSha256 === v2?.artifactSha256)
  throw new Error("Version-pair artifacts unexpectedly have equal hashes");
process.stdout.write(
  `${JSON.stringify({ verified: manifest.fixtures.length, manifestPath })}\n`,
);

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
