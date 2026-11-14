import { valid } from "semver";
import { z } from "zod";
import { readMergedReleasePullRequest } from "./release-pull-request.mjs";
import {
  releaseInventorySchema,
  verifyInventoryHistory,
  verifyReleaseNotes,
} from "./release-notes.mjs";

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);

/** Read the reviewed Git snapshot and live PR before Release Please can mutate tags. */
export async function verifyNotesPublication(run, options) {
  const repo = repository.parse(options.repository);
  const source = sha.parse(
    (
      await run("git", [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${options.source}^{commit}`,
      ])
    ).trim(),
  );
  const read = (path) => run("git", ["show", `${source}:${path}`]);
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(await read("package.json")));
  if (valid(version) !== version || version.includes("+"))
    throw new Error("Invalid reviewed package version");
  const pr = await readMergedReleasePullRequest(run, { ...options, source });
  if (pr === undefined)
    throw new Error(
      "Expected exactly one merged Release Please PR for the reviewed source",
    );
  if (pr.body === null)
    throw new Error("The merged release PR has no release notes body");
  const path = `docs/releases/${version}.contributions.json`;
  const present =
    (
      await run("git", ["ls-tree", "--name-only", source, "--", path])
    ).trim() === path;
  if (!present) {
    if (pr.labels.some((label) => label.name === "rea:release-notes-finalized"))
      throw new Error(
        "Finalized release PR is missing its contribution inventory",
      );
    return { status: "legacy", version, pullRequest: pr.number };
  }
  const inventory = releaseInventorySchema.parse(JSON.parse(await read(path)));
  if (
    inventory.version !== version ||
    inventory.repository.toLowerCase() !== repo.toLowerCase()
  )
    throw new Error(
      "Contribution inventory differs from the reviewed release version or repository",
    );
  const baseline = z
    .object({ ".": z.string() })
    .parse(
      JSON.parse(
        await run("git", ["show", `${source}^1:.release-please-manifest.json`]),
      ),
    )["."];
  if (valid(baseline) !== baseline || baseline.includes("+"))
    throw new Error("Invalid release baseline version");
  const baselineSha = (
    await run("git", ["rev-parse", `refs/tags/rea-agents-${baseline}^{commit}`])
  ).trim();
  if (inventory.base !== baselineSha)
    throw new Error(
      "Contribution inventory does not start at the published baseline tag",
    );
  await verifyInventoryHistory(run, inventory, source);
  return {
    status: "verified",
    ...verifyReleaseNotes(inventory, await read("CHANGELOG.md"), pr.body),
  };
}
