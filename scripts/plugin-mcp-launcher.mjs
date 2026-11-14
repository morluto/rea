#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Release Please owns the scalar pin in each client declaration. The runtime
// and skill come from the same installed artifact, without another npx child.
const [version, ...extra] = process.argv.slice(2);

// A plugin starts with whatever `node` the client finds, and `rea doctor` does
// not see plugin installs, so the launcher is the one place to name an
// unsupported runtime. It reads the published `engines.node` grammar
// (`^X.Y.Z` and `>=X.Y.Z` clauses joined by `||`) without loading
// dependencies; any other clause leaves support unknown and does not block.
// A prerelease suffix is read as its release, so a nightly is not refused here.
const releaseOf = (text) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(text);
  return match === null ? undefined : match.slice(1, 4).map(Number);
};
const compareReleases = (left, right) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
const clauseAdmits = (release, clause) => {
  const match = /^(\^|>=)\s*v?(\d+)\.(\d+)\.(\d+)$/u.exec(clause.trim());
  if (match === null) return undefined;
  const floor = match.slice(2, 5).map(Number);
  if (compareReleases(release, floor) < 0) return false;
  if (match[1] === ">=") return true;
  if (floor[0] !== 0) return release[0] === floor[0];
  if (floor[1] !== 0) return release[0] === 0 && release[1] === floor[1];
  return release[0] === 0 && release[1] === 0 && release[2] === floor[2];
};
const rangeAdmits = (versionText, range) => {
  const release = releaseOf(versionText);
  if (release === undefined) return undefined;
  let isKnown = true;
  for (const clause of range.split("||")) {
    const admits = clauseAdmits(release, clause);
    if (admits === true) return true;
    if (admits === undefined) isKnown = false;
  }
  return isKnown ? false : undefined;
};
try {
  if (
    extra.length !== 0 ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version ?? "")
  )
    throw new Error("requires one exact rea-agents@VERSION pin");

  const bundledPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (
    bundledPackage.name !== "rea-agents" ||
    bundledPackage.version !== version
  )
    throw new Error(
      "version pin does not match its installed rea-agents package; reinstall the plugin",
    );

  // Bun reports its Node.js compatibility version here too, as doctor reads it.
  const supportedRange = bundledPackage.engines?.node;
  if (
    typeof supportedRange === "string" &&
    rangeAdmits(process.versions.node, supportedRange) === false
  )
    throw new Error(
      `requires Node.js ${supportedRange}, but the client started it with ${process.versions.node} at ${process.execPath}; put a supported Node.js first on the PATH the client starts with, then restart the client`,
    );

  await access(new URL("../dist/mcp/main.js", import.meta.url)).catch(
    (cause) => {
      if (cause?.code !== "ENOENT") throw cause;
      throw new Error(
        "runtime is missing; reinstall the plugin, or run npm ci && npm run build:cached in a source checkout",
        { cause },
      );
    },
  );
} catch (cause) {
  process.stderr.write(`REA plugin ${cause.message}.\n`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  process.argv = [
    process.execPath,
    fileURLToPath(new URL("./rea.mjs", import.meta.url)),
    "mcp",
  ];
  await import("./rea.mjs");
}
