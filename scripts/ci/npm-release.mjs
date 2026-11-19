import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { prerelease, valid } from "semver";
import { releaseNpmTag } from "../release-npm-tag.mjs";
import {
  NpmRegistryResponseError,
  readQualifiedNpmRelease,
  requireMatchingNpmRelease,
} from "./npm-release-state.mjs";

/** Read-only callers derive the channel through the canonical SemVer owner. */
export async function readNpmRelease(version, request = fetch) {
  return readQualifiedNpmRelease(version, releaseNpmTag(version), request);
}

/** REA update follows stable latest even when the candidate is published on next. */
export function stableUpdateVersion(version, published) {
  if (published.status !== "published" || published.taggedVersion !== version)
    throw new Error(`npm does not select ${version} on its release channel`);
  const stable = published.stableVersion;
  if (
    typeof stable !== "string" ||
    valid(stable) !== stable ||
    prerelease(stable) !== null
  )
    throw new Error(
      "npm latest does not select a stable release for the update canary",
    );
  return stable;
}

/** Allow propagation and a bounded number of consecutive gateway failures. */
export async function waitForNpmRelease(
  version,
  lookup = readNpmRelease,
  pause = setTimeout,
) {
  const attempts = 120;
  let gatewayFailures = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const published = await lookup(version);
      if (published.status === "published") return published;
      gatewayFailures = 0;
    } catch (error) {
      if (
        !(error instanceof NpmRegistryResponseError) ||
        ![502, 503, 504].includes(error.status)
      )
        throw error;
      gatewayFailures += 1;
      if (gatewayFailures === 3 || attempt === attempts) throw error;
    }
    if (attempt < attempts) await pause(15_000);
  }
  throw new Error(
    `rea-agents@${version} was not visible on npm after 120 attempts over 30 minutes`,
  );
}

async function main() {
  const [operation, tarball, version, ...extra] = process.argv.slice(2);
  if (
    operation !== "verify" ||
    tarball === undefined ||
    version === undefined ||
    extra.length
  )
    throw new Error(
      "Usage: node scripts/ci/npm-release.mjs verify <qualified-tarball> <version>",
    );
  const published = await waitForNpmRelease(version);
  await requireMatchingNpmRelease(tarball, version, published);
  if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `npm: rea-agents@${version} is published, matches the qualified tarball, and is selected by ${published.tag}.\n`,
    );
  }
  process.stdout.write(`${JSON.stringify({ version, ...published })}\n`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
