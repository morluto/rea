import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { valid } from "semver";
import { registryPublicationState } from "../../.github/actions/publish-mcp/registry-state.mjs";
import { readMergedReleasePullRequest } from "../lib/release-pull-request.mjs";
import { readNpmRelease } from "./npm-release.mjs";

const execute = promisify(execFile);
const manifest = ".release-please-manifest.json";

async function command(program, args) {
  return (await execute(program, args)).stdout.trim();
}

function commit(value) {
  if (!/^[a-f0-9]{40}$/u.test(value ?? ""))
    throw new Error("Expected a full release commit SHA");
  return value;
}

/** Both decisions create the same Git ref. Its target identifies the winner. */
export async function recordReleaseAttempt(api, source, parent, decision) {
  commit(source);
  commit(parent);
  if (source === parent || !["abandon", "publish"].includes(decision))
    throw new Error("Invalid release attempt decision");
  const shortRef = `tags/rea-release-attempt/${source}`;
  const ref = `refs/${shortRef}`;
  const target = decision === "publish" ? source : parent;
  const inspect = async () => {
    const response = await api(`git/ref/${shortRef}`);
    if (response.status === 404) return false;
    if (!response.ok)
      throw new Error(`Release attempt lookup failed: HTTP ${response.status}`);
    const value = await response.json();
    if (value?.ref !== ref || value.object?.type !== "commit")
      throw new Error("Malformed release attempt ref");
    const recorded = commit(value.object.sha);
    if (recorded === target) return true;
    if (recorded === parent)
      throw new Error("This release attempt was abandoned");
    if (recorded === source)
      throw new Error(
        "npm publication was authorized; resume the original release",
      );
    throw new Error("Release attempt ref points to an unexpected commit");
  };

  if (await inspect()) return;
  const created = await api("git/refs", { ref, sha: target });
  if (created.status !== 201 && created.status !== 422)
    throw new Error(`Release attempt claim failed: HTTP ${created.status}`);
  if (!(await inspect()))
    throw new Error(
      `Release attempt claim was not recorded: HTTP ${created.status}`,
    );
}

export function githubApi(repository, token) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !token)
    throw new Error("Expected GITHUB_REPOSITORY and GH_TOKEN");
  return (path, body, method = body === undefined ? "GET" : "POST") => {
    const pathname = `/repos/${repository}/${path}`;
    const url = new URL("https://api.github.com");
    url.pathname = pathname;
    if (url.origin !== "https://api.github.com" || url.pathname !== pathname)
      throw new Error("Invalid GitHub API path");
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  };
}

async function versionAt(source) {
  const version = JSON.parse(
    await command("git", ["show", `${source}:${manifest}`]),
  )["."];
  if (
    typeof version !== "string" ||
    valid(version) !== version ||
    version.includes("+")
  )
    throw new Error("Expected an exact release version in the manifest");
  return version;
}

async function requireUnpublished(api, source, version) {
  const tag = `rea-agents-${version}`;
  for (const path of [`git/ref/tags/${tag}`, `releases/tags/${tag}`]) {
    const response = await api(path);
    if (response.status !== 404)
      throw new Error(
        `Cannot confirm GitHub release absence for ${tag}: HTTP ${response.status}`,
      );
  }
  if ((await readNpmRelease(version)).status !== "absent")
    throw new Error(`rea-agents@${version} is already on npm`);
  const server = JSON.parse(
    await command("git", ["show", `${source}:server.json`]),
  );
  if (
    server?.version !== version ||
    (await registryPublicationState(server)) !== "absent"
  )
    throw new Error(`Cannot confirm MCP Registry absence for ${version}`);
}

/** Inspect the final GitHub release without starting a fresh release attempt. */
export async function inspectGithubRelease(api, tag, source) {
  const release = await api(`releases/tags/${tag}`);
  if (release.status !== 404) {
    if (!release.ok)
      throw new Error(`GitHub release lookup failed: HTTP ${release.status}`);
    const value = await release.json();
    if (value?.tag_name !== tag || value.draft !== false)
      throw new Error("Unexpected GitHub release identity or visibility");
  }
  const ref = await api(`git/ref/tags/${tag}`);
  if (release.status === 404 && ref.status === 404) return false;
  if (!ref.ok) throw new Error(`Release tag lookup failed: HTTP ${ref.status}`);
  const value = await ref.json();
  if (value?.ref !== `refs/tags/${tag}`)
    throw new Error("Unexpected GitHub release ref");
  let object = value.object;
  if (object?.type === "tag") {
    const annotated = await api(`git/tags/${commit(object.sha)}`);
    if (!annotated.ok)
      throw new Error(
        `Annotated release tag lookup failed: HTTP ${annotated.status}`,
      );
    object = (await annotated.json())?.object;
  }
  if (object?.type !== "commit" || commit(object.sha) !== commit(source))
    throw new Error(
      "The existing release tag differs from the qualified revision",
    );
  return release.status !== 404;
}

export async function verifyFrozenReleaseBranch(api, branch, source) {
  if (!/^release\/[A-Za-z0-9.-]+$/u.test(branch))
    throw new Error("Expected a frozen release branch");
  const response = await api(`git/ref/heads/${branch}`);
  if (!response.ok)
    throw new Error(`Frozen branch lookup failed: HTTP ${response.status}`);
  const value = await response.json();
  if (
    value?.ref !== `refs/heads/${branch}` ||
    value.object?.type !== "commit" ||
    commit(value.object.sha) !== commit(source)
  )
    throw new Error(
      "The frozen release branch moved; refusing publication at a different source",
    );
}

export async function requireCurrentMainCheckpoint(run, api, source) {
  const branch = await api("git/ref/heads/main");
  if (!branch.ok)
    throw new Error(`Cannot read current main: HTTP ${branch.status}`);
  const value = await branch.json();
  if (value?.ref !== "refs/heads/main" || value.object?.type !== "commit")
    throw new Error("Unexpected current main ref");
  const mainTip = commit(value.object.sha);
  await run("git", [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    "origin",
    mainTip,
  ]);
  const boundary = await run("git", [
    "log",
    "-1",
    "--first-parent",
    "--format=%H",
    mainTip,
    "--",
    manifest,
  ]);
  if (boundary !== source)
    throw new Error(
      "The source is not the current main release metadata checkpoint",
    );
}

async function main() {
  const [decision, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !["abandon", "publish", "inspect-github", "verify-github"].includes(
      decision,
    )
  )
    throw new Error(
      "Usage: node scripts/ci/release-attempt.mjs abandon|publish|inspect-github|verify-github",
    );
  const {
    GITHUB_REPOSITORY,
    GITHUB_REF,
    GITHUB_SHA,
    GH_TOKEN,
    RELEASE_BRANCH,
    RELEASE_SOURCE,
  } = process.env;
  const api = githubApi(GITHUB_REPOSITORY, GH_TOKEN);
  const requestedSource =
    decision === "abandon" ? RELEASE_SOURCE : (RELEASE_SOURCE ?? GITHUB_SHA);
  const source = commit(decision === "publish" ? GITHUB_SHA : requestedSource);
  if (decision === "inspect-github" || decision === "verify-github") {
    const tag = `rea-agents-${await versionAt(source)}`;
    const published = await inspectGithubRelease(api, tag, source);
    if (decision === "inspect-github") {
      if (!published) {
        if (RELEASE_BRANCH)
          await verifyFrozenReleaseBranch(api, RELEASE_BRANCH, source);
        else await requireCurrentMainCheckpoint(command, api, source);
      }
      process.stdout.write(`published=${published}\n`);
    } else if (!published) {
      throw new Error(`GitHub release ${tag} is not public`);
    }
    return;
  }
  const parent = commit(await command("git", ["rev-parse", `${source}^1`]));
  if (decision === "publish") {
    if (RELEASE_BRANCH)
      await verifyFrozenReleaseBranch(api, RELEASE_BRANCH, source);
    else await requireCurrentMainCheckpoint(command, api, source);
    await recordReleaseAttempt(api, source, parent, decision);
    return;
  }
  if (GITHUB_REF !== "refs/heads/main")
    throw new Error("Run release abandonment from main");
  // Only revisions with this protocol can be safely fenced from an original rerun.
  await command("git", [
    "cat-file",
    "-e",
    `${source}:scripts/ci/release-attempt.mjs`,
  ]);
  await requireCurrentMainCheckpoint(command, api, source);
  const pr = await readMergedReleasePullRequest(command, {
    repository: GITHUB_REPOSITORY,
    source,
    targetBranch: "main",
  });
  if (!pr) throw new Error("The source is not a merged main release PR");
  const version = await versionAt(source);
  if (version === (await versionAt(parent)))
    throw new Error("The candidate did not advance the release version");
  await requireUnpublished(api, source, version);
  await recordReleaseAttempt(api, source, parent, decision);
  const pending = "autorelease: pending";
  if (pr.labels.some(({ name }) => name === pending)) {
    const removed = await api(
      `issues/${pr.number}/labels/${encodeURIComponent(pending)}`,
      undefined,
      "DELETE",
    );
    if (removed.status !== 204 && removed.status !== 404)
      throw new Error(
        `Cannot retire the abandoned release PR: HTTP ${removed.status}`,
      );
    const current = await readMergedReleasePullRequest(command, {
      repository: GITHUB_REPOSITORY,
      source,
      targetBranch: "main",
      pr: pr.number,
    });
    if (!current || current.labels.some(({ name }) => name === pending))
      throw new Error(
        "The abandoned release PR still has pending publication authority",
      );
  }
  console.log(
    `Release ${version} at ${source} is abandoned. Revert its release metadata through a reviewed pull request and retain Release-As: ${version} when recutting.`,
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
