import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

/** Execute a fixture command while retaining its output and native exit status. */
export const executeWorkflowFixture = promisify(execFile);

/**
 * The host environment without the GitHub Actions and REA CI context a
 * workflow script reads. A runner sets GITHUB_EVENT_NAME and friends for its
 * own job, so inheriting them would make a fixture simulate that job (for
 * example a scheduled sweep) instead of the context the test declares.
 */
export const workflowFixtureEnvironment = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("GITHUB_") && !name.startsWith("CI_"),
    ),
  ),
  ...overrides,
});

/** Run fixture Git commands with deterministic dates and no workstation hooks. */
export async function workflowGit(
  directory: string,
  args: readonly string[],
  date = "2026-01-04T00:00:00Z",
) {
  const result = await executeWorkflowFixture(
    "git",
    [
      "-c",
      "user.name=REA fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${join(directory, "no-hooks")}`,
      ...args,
    ],
    {
      cwd: directory,
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  );
  return result.stdout.trim();
}
