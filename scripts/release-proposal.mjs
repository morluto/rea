#!/usr/bin/env node
import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import {
  applyReleasePleasePatch,
  createReleaseProposal,
  describeReleaseProposalError,
} from "./lib/release-proposal.mjs";

const execute = promisify(execFile);

async function main() {
  const { values } = parseArgs({
    options: {
      "target-branch": { type: "string" },
      "source-sha": { type: "string" },
    },
  });
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (
    !repository ||
    !/^[\w.-]+\/[\w.-]+$/u.test(repository) ||
    !token ||
    !values["target-branch"]
  ) {
    throw new Error("Expected GITHUB_REPOSITORY, GH_TOKEN and --target-branch");
  }
  const [owner, repo] = repository.split("/");
  const branch = values["target-branch"];
  const result = await createReleaseProposal(
    async (command, args) =>
      (
        await execute(command, args, {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout,
    {
      repository,
      targetBranch: branch,
      sourceSha: values["source-sha"],
      eventName: process.env.GITHUB_EVENT_NAME,
    },
    async (depth) => {
      // Patch before import: publication uses the pinned action separately.
      await applyReleasePleasePatch();
      const { GitHub, Manifest } = await import("release-please");
      const github = await GitHub.create({
        owner,
        repo,
        token,
        defaultBranch: branch,
      });
      return Manifest.fromManifest(github, branch, undefined, undefined, {
        commitSearchDepth: depth,
      });
    },
  );
  if (result.kind === "release-merge") {
    const message = `Release PR #${result.pullRequest} merged at ${values["source-sha"]}; the release workflow owns publication. Proposal generation resumes on the next main push.\n`;
    process.stdout.write(message);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
  }
  const prs = result.kind === "proposal" ? result.pullRequests : [];
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `prs_created=${prs.length > 0}\n${prs.length ? `pr=${JSON.stringify(prs[0])}\n` : ""}`,
    );
  }
}

await main().catch((error) => {
  process.stderr.write(
    `Release proposal failed: ${describeReleaseProposalError(error)}\n`,
  );
  process.exitCode = 1;
});
