import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/u);
const pullRequest = z.object({
  number: z.number().int().positive(),
  body: z.string().nullable(),
  merged_at: z.string().nullable(),
  merge_commit_sha: sha.nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  labels: z.array(z.object({ name: z.string() })),
});

/** Own REST release-PR identity for proposal admission and publication checks. */
export async function readMergedReleasePullRequest(run, options) {
  const repo = repository.parse(options.repository);
  const source = sha.parse(options.source);
  let candidates;
  if (options.pr !== undefined) {
    const number = z.coerce.number().int().positive().parse(options.pr);
    candidates = [
      pullRequest.parse(
        JSON.parse(await run("gh", ["api", `repos/${repo}/pulls/${number}`])),
      ),
    ];
  } else {
    candidates = z
      .array(z.array(pullRequest))
      .parse(
        JSON.parse(
          await run("gh", [
            "api",
            "--paginate",
            "--slurp",
            `repos/${repo}/commits/${source}/pulls?per_page=100`,
          ]),
        ),
      )
      .flat();
  }
  const matching = candidates.filter(
    (pr) =>
      pr.merged_at !== null &&
      pr.merge_commit_sha === source &&
      pr.head.repo?.full_name.toLowerCase() === repo.toLowerCase() &&
      pr.head.ref.startsWith("release-please--branches--") &&
      (options.targetBranch === undefined ||
        (pr.base.ref === options.targetBranch &&
          pr.head.ref.startsWith(
            `release-please--branches--${options.targetBranch}--`,
          ))),
  );
  if (matching.length > 1)
    throw new Error("Multiple merged Release Please PRs match the source");
  return matching[0];
}
